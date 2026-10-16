BEGIN;

-- Keep every payment transaction attached to the organization that owns
-- the package/site. Do not trust organization_id or site_id supplied by callers.
CREATE OR REPLACE FUNCTION enforce_payment_transaction_tenant_scope()
RETURNS TRIGGER AS $$
DECLARE
  expected_site_id BIGINT;
  expected_organization_id BIGINT;
BEGIN
  SELECT
    p.site_id,
    s.organization_id
  INTO
    expected_site_id,
    expected_organization_id
  FROM packages p
  JOIN sites s ON s.id = p.site_id
  WHERE p.id = NEW.package_id;

  IF expected_site_id IS NULL OR expected_organization_id IS NULL THEN
    RAISE EXCEPTION 'Payment package % is not attached to an active tenant scope', NEW.package_id;
  END IF;

  NEW.site_id := expected_site_id;
  NEW.organization_id := expected_organization_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_transaction_tenant_scope
  ON payment_transactions;

CREATE TRIGGER trg_payment_transaction_tenant_scope
BEFORE INSERT OR UPDATE OF package_id, site_id, organization_id
ON payment_transactions
FOR EACH ROW
EXECUTE FUNCTION enforce_payment_transaction_tenant_scope();


-- A tenant wallet entry may only reference payment/payout records owned
-- by that same tenant. This gives us DB-level protection even if application
-- code is changed incorrectly later.
CREATE OR REPLACE FUNCTION enforce_wallet_entry_tenant_scope()
RETURNS TRIGGER AS $$
DECLARE
  source_organization_id BIGINT;
BEGIN
  IF NEW.payment_transaction_id IS NOT NULL
     AND NEW.payout_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Wallet entry cannot reference both a payment and a payout';
  END IF;

  IF NEW.payment_transaction_id IS NOT NULL THEN
    SELECT organization_id
    INTO source_organization_id
    FROM payment_transactions
    WHERE id = NEW.payment_transaction_id;

    IF source_organization_id IS NULL THEN
      RAISE EXCEPTION
        'Payment transaction % has no tenant organization',
        NEW.payment_transaction_id;
    END IF;

    IF source_organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION
        'Wallet/payment tenant mismatch: wallet org %, payment org %',
        NEW.organization_id,
        source_organization_id;
    END IF;
  END IF;

  IF NEW.payout_transaction_id IS NOT NULL THEN
    SELECT organization_id
    INTO source_organization_id
    FROM payout_transactions
    WHERE id = NEW.payout_transaction_id;

    IF source_organization_id IS NULL THEN
      RAISE EXCEPTION
        'Payout transaction % has no tenant organization',
        NEW.payout_transaction_id;
    END IF;

    IF source_organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION
        'Wallet/payout tenant mismatch: wallet org %, payout org %',
        NEW.organization_id,
        source_organization_id;
    END IF;
  END IF;

  IF NEW.entry_type IN ('payment_credit', 'gateway_fee')
     AND NEW.payment_transaction_id IS NULL THEN
    RAISE EXCEPTION
      '% wallet entries must reference a payment transaction',
      NEW.entry_type;
  END IF;

  IF NEW.entry_type IN ('payout_debit', 'payout_fee')
     AND NEW.payout_transaction_id IS NULL THEN
    RAISE EXCEPTION
      '% wallet entries must reference a payout transaction',
      NEW.entry_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallet_entry_tenant_scope
  ON wallet_entries;

CREATE TRIGGER trg_wallet_entry_tenant_scope
BEFORE INSERT OR UPDATE
ON wallet_entries
FOR EACH ROW
EXECUTE FUNCTION enforce_wallet_entry_tenant_scope();


-- Client-owner payout requests must belong to the same organization as the user.
-- Super-admin requests remain valid because super-admin users intentionally
-- have organization_id = NULL.
CREATE OR REPLACE FUNCTION enforce_payout_requester_tenant_scope()
RETURNS TRIGGER AS $$
DECLARE
  requester_role VARCHAR(30);
  requester_organization_id BIGINT;
BEGIN
  IF NEW.requested_by_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    role,
    organization_id
  INTO
    requester_role,
    requester_organization_id
  FROM platform_users
  WHERE id = NEW.requested_by_user_id;

  IF requester_role = 'client_owner'
     AND requester_organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION
      'Payout requester tenant mismatch: payout org %, user org %',
      NEW.organization_id,
      requester_organization_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payout_requester_tenant_scope
  ON payout_transactions;

CREATE TRIGGER trg_payout_requester_tenant_scope
BEFORE INSERT OR UPDATE OF organization_id, requested_by_user_id
ON payout_transactions
FOR EACH ROW
EXECUTE FUNCTION enforce_payout_requester_tenant_scope();


ALTER TABLE payout_transactions
  DROP CONSTRAINT IF EXISTS payout_transactions_total_matches_amount_fee;

ALTER TABLE payout_transactions
  ADD CONSTRAINT payout_transactions_total_matches_amount_fee
  CHECK (
    ABS(total_amount_tzs - (amount_tzs + fee_tzs)) < 0.01
  );

COMMIT;
