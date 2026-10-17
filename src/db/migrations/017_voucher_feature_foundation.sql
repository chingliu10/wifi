BEGIN;

-- Voucher rollout is deliberately disabled for every existing and future tenant.
-- The portal flag is separate so voucher administration can be tested before
-- customers ever see a voucher option.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS vouchers_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voucher_portal_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_voucher_portal_requires_feature;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_voucher_portal_requires_feature
  CHECK (voucher_portal_enabled = FALSE OR vouchers_enabled = TRUE);


-- A batch snapshots the commercial/package terms at the moment vouchers are
-- generated. Later edits to the package cannot rewrite already-issued vouchers.
CREATE TABLE IF NOT EXISTS voucher_batches (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  package_id BIGINT NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  created_by_user_id BIGINT REFERENCES platform_users(id) ON DELETE RESTRICT,
  batch_reference VARCHAR(80) NOT NULL UNIQUE,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 10000),
  package_name_snapshot VARCHAR(100) NOT NULL,
  package_price_tzs_snapshot INTEGER NOT NULL CHECK (package_price_tzs_snapshot > 0),
  package_duration_seconds_snapshot INTEGER NOT NULL CHECK (package_duration_seconds_snapshot > 0),
  redeemable_until TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voucher_batches_org_created
  ON voucher_batches(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_voucher_batches_site
  ON voucher_batches(site_id, created_at DESC);


CREATE TABLE IF NOT EXISTS vouchers (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  batch_id BIGINT NOT NULL REFERENCES voucher_batches(id) ON DELETE RESTRICT,
  code_hash CHAR(64) NOT NULL UNIQUE,
  code_last4 CHAR(4) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'unused' CHECK (
    status IN ('unused', 'redeemed', 'expired', 'cancelled')
  ),
  redeemed_device_id BIGINT REFERENCES devices(id) ON DELETE RESTRICT,
  subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE RESTRICT,
  redeemed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT vouchers_redemption_state_check CHECK (
    (
      status = 'redeemed'
      AND redeemed_device_id IS NOT NULL
      AND subscription_id IS NOT NULL
      AND redeemed_at IS NOT NULL
    )
    OR
    (
      status <> 'redeemed'
      AND subscription_id IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_vouchers_org_status
  ON vouchers(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vouchers_site_status
  ON vouchers(site_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vouchers_batch
  ON vouchers(batch_id, id);


-- Enforce tenant/site/package ownership in the database, not only in Node.
CREATE OR REPLACE FUNCTION enforce_voucher_batch_scope()
RETURNS TRIGGER AS $voucher_batch_scope$
DECLARE
  expected_organization_id BIGINT;
BEGIN
  SELECT s.organization_id
  INTO expected_organization_id
  FROM packages p
  JOIN sites s ON s.id = p.site_id
  WHERE p.id = NEW.package_id
    AND p.site_id = NEW.site_id;

  IF expected_organization_id IS NULL THEN
    RAISE EXCEPTION
      'Voucher batch package % does not belong to site %',
      NEW.package_id,
      NEW.site_id;
  END IF;

  IF expected_organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION
      'Voucher batch tenant mismatch: batch org %, site org %',
      NEW.organization_id,
      expected_organization_id;
  END IF;

  RETURN NEW;
END;
$voucher_batch_scope$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_voucher_batch_scope ON voucher_batches;

CREATE TRIGGER trg_voucher_batch_scope
BEFORE INSERT OR UPDATE OF organization_id, site_id, package_id
ON voucher_batches
FOR EACH ROW
EXECUTE FUNCTION enforce_voucher_batch_scope();


CREATE OR REPLACE FUNCTION enforce_voucher_scope()
RETURNS TRIGGER AS $voucher_scope$
DECLARE
  batch_organization_id BIGINT;
  batch_site_id BIGINT;
BEGIN
  SELECT organization_id, site_id
  INTO batch_organization_id, batch_site_id
  FROM voucher_batches
  WHERE id = NEW.batch_id;

  IF batch_organization_id IS NULL THEN
    RAISE EXCEPTION 'Voucher batch % does not exist', NEW.batch_id;
  END IF;

  IF NEW.organization_id <> batch_organization_id
     OR NEW.site_id <> batch_site_id THEN
    RAISE EXCEPTION
      'Voucher tenant/site does not match its batch';
  END IF;

  RETURN NEW;
END;
$voucher_scope$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_voucher_scope ON vouchers;

CREATE TRIGGER trg_voucher_scope
BEFORE INSERT OR UPDATE OF organization_id, site_id, batch_id
ON vouchers
FOR EACH ROW
EXECUTE FUNCTION enforce_voucher_scope();


-- Voucher audit records are retained permanently. Operational removal will use
-- status/active fields rather than physical DELETE.
DROP TRIGGER IF EXISTS trg_no_delete_voucher_batches ON voucher_batches;
CREATE TRIGGER trg_no_delete_voucher_batches
BEFORE DELETE ON voucher_batches
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_vouchers ON vouchers;
CREATE TRIGGER trg_no_delete_vouchers
BEFORE DELETE ON vouchers
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

COMMIT;
