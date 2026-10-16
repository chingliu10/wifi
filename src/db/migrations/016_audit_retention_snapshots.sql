BEGIN;

-- Preserve exactly what the customer bought even if package/site details are
-- edited later. Existing rows are backfilled from the current related records;
-- future rows are snapshotted at creation time.
ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS package_name_snapshot VARCHAR(100),
  ADD COLUMN IF NOT EXISTS package_price_tzs_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS package_duration_seconds_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS site_name_snapshot VARCHAR(100),
  ADD COLUMN IF NOT EXISTS site_brand_name_snapshot VARCHAR(120);

UPDATE payment_transactions pt
SET
  package_name_snapshot = COALESCE(pt.package_name_snapshot, p.name),
  package_price_tzs_snapshot = COALESCE(pt.package_price_tzs_snapshot, p.price_tzs),
  package_duration_seconds_snapshot = COALESCE(
    pt.package_duration_seconds_snapshot,
    p.duration_seconds
  ),
  site_name_snapshot = COALESCE(pt.site_name_snapshot, s.name),
  site_brand_name_snapshot = COALESCE(
    pt.site_brand_name_snapshot,
    s.brand_name,
    s.name || ' WiFi'
  )
FROM packages p
JOIN sites s ON s.id = p.site_id
WHERE p.id = pt.package_id
  AND (
    pt.package_name_snapshot IS NULL
    OR pt.package_price_tzs_snapshot IS NULL
    OR pt.package_duration_seconds_snapshot IS NULL
    OR pt.site_name_snapshot IS NULL
    OR pt.site_brand_name_snapshot IS NULL
  );

ALTER TABLE payment_transactions
  ALTER COLUMN package_name_snapshot SET NOT NULL,
  ALTER COLUMN package_price_tzs_snapshot SET NOT NULL,
  ALTER COLUMN package_duration_seconds_snapshot SET NOT NULL,
  ALTER COLUMN site_name_snapshot SET NOT NULL,
  ALTER COLUMN site_brand_name_snapshot SET NOT NULL;

CREATE OR REPLACE FUNCTION snapshot_payment_transaction_audit_fields()
RETURNS TRIGGER AS $$
DECLARE
  package_row RECORD;
BEGIN
  SELECT
    p.name AS package_name,
    p.price_tzs AS package_price_tzs,
    p.duration_seconds AS package_duration_seconds,
    s.name AS site_name,
    COALESCE(s.brand_name, s.name || ' WiFi') AS site_brand_name
  INTO package_row
  FROM packages p
  JOIN sites s ON s.id = p.site_id
  WHERE p.id = NEW.package_id;

  IF package_row.package_name IS NULL THEN
    RAISE EXCEPTION 'Cannot snapshot missing package %', NEW.package_id;
  END IF;

  NEW.package_name_snapshot := package_row.package_name;
  NEW.package_price_tzs_snapshot := package_row.package_price_tzs;
  NEW.package_duration_seconds_snapshot := package_row.package_duration_seconds;
  NEW.site_name_snapshot := package_row.site_name;
  NEW.site_brand_name_snapshot := package_row.site_brand_name;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_transaction_audit_snapshot
  ON payment_transactions;

CREATE TRIGGER trg_payment_transaction_audit_snapshot
BEFORE INSERT
ON payment_transactions
FOR EACH ROW
EXECUTE FUNCTION snapshot_payment_transaction_audit_fields();


-- Snapshot fields are historical facts. Status/provider/provisioning fields may
-- change as a transaction progresses, but the purchased product snapshot may not.
CREATE OR REPLACE FUNCTION preserve_payment_transaction_audit_snapshot()
RETURNS TRIGGER AS $
BEGIN
  IF NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.amount_tzs IS DISTINCT FROM OLD.amount_tzs
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.client_mac IS DISTINCT FROM OLD.client_mac
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.customer_name IS DISTINCT FROM OLD.customer_name THEN
    RAISE EXCEPTION
      'Payment transaction identity/purchase fields are immutable after creation (reference %).',
      OLD.reference;
  END IF;

  NEW.package_name_snapshot := OLD.package_name_snapshot;
  NEW.package_price_tzs_snapshot := OLD.package_price_tzs_snapshot;
  NEW.package_duration_seconds_snapshot := OLD.package_duration_seconds_snapshot;
  NEW.site_name_snapshot := OLD.site_name_snapshot;
  NEW.site_brand_name_snapshot := OLD.site_brand_name_snapshot;

  RETURN NEW;
END;
$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_preserve_payment_transaction_audit_snapshot
  ON payment_transactions;

CREATE TRIGGER trg_preserve_payment_transaction_audit_snapshot
BEFORE UPDATE
ON payment_transactions
FOR EACH ROW
EXECUTE FUNCTION preserve_payment_transaction_audit_snapshot();


-- Record who removed a package from sale. The package row itself is retained.
ALTER TABLE packages
  ADD COLUMN IF NOT EXISTS deleted_by_user_id BIGINT
    REFERENCES platform_users(id) ON DELETE RESTRICT;


-- Legacy package deletions predate actor tracking, so their actor may be
-- unknown. From this migration onward, every new soft-delete must identify
-- the platform user who performed it.
CREATE OR REPLACE FUNCTION enforce_package_soft_delete_actor()
RETURNS TRIGGER AS $
BEGIN
  IF OLD.deleted_at IS NULL
     AND NEW.deleted_at IS NOT NULL
     AND NEW.deleted_by_user_id IS NULL THEN
    RAISE EXCEPTION
      'Package soft delete requires deleted_by_user_id (package %).',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_package_soft_delete_actor ON packages;

CREATE TRIGGER trg_package_soft_delete_actor
BEFORE UPDATE OF deleted_at, deleted_by_user_id
ON packages
FOR EACH ROW
EXECUTE FUNCTION enforce_package_soft_delete_actor();


-- Audit-critical records are never physically deleted. Operational removal must
-- use active/deleted_at/status fields instead.
CREATE OR REPLACE FUNCTION prevent_audit_hard_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Hard delete blocked for audit-protected table %. Use deactivation/soft delete instead.',
    TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_no_delete_organizations ON organizations;
CREATE TRIGGER trg_no_delete_organizations
BEFORE DELETE ON organizations
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_sites ON sites;
CREATE TRIGGER trg_no_delete_sites
BEFORE DELETE ON sites
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_packages ON packages;
CREATE TRIGGER trg_no_delete_packages
BEFORE DELETE ON packages
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_platform_users ON platform_users;
CREATE TRIGGER trg_no_delete_platform_users
BEFORE DELETE ON platform_users
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_devices ON devices;
CREATE TRIGGER trg_no_delete_devices
BEFORE DELETE ON devices
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_payments ON payments;
CREATE TRIGGER trg_no_delete_payments
BEFORE DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_payment_transactions ON payment_transactions;
CREATE TRIGGER trg_no_delete_payment_transactions
BEFORE DELETE ON payment_transactions
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_payout_transactions ON payout_transactions;
CREATE TRIGGER trg_no_delete_payout_transactions
BEFORE DELETE ON payout_transactions
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_subscriptions ON subscriptions;
CREATE TRIGGER trg_no_delete_subscriptions
BEFORE DELETE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();


-- Ledger rows are append-only: neither update nor delete is allowed. Corrections
-- must be represented by a new compensating entry, preserving the audit trail.
CREATE OR REPLACE FUNCTION prevent_wallet_entry_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Wallet ledger is append-only. Create a compensating entry instead of updating/deleting row %.',
    OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallet_entries_append_only ON wallet_entries;
CREATE TRIGGER trg_wallet_entries_append_only
BEFORE UPDATE OR DELETE ON wallet_entries
FOR EACH ROW
EXECUTE FUNCTION prevent_wallet_entry_mutation();

COMMIT;
