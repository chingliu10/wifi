BEGIN;

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS site_id BIGINT REFERENCES sites(id) ON DELETE RESTRICT;

ALTER TABLE platform_users
  DROP CONSTRAINT IF EXISTS platform_users_role_check;

ALTER TABLE platform_users
  DROP CONSTRAINT IF EXISTS platform_users_role_scope_check;

ALTER TABLE platform_users
  ADD CONSTRAINT platform_users_role_check
  CHECK (role IN ('super_admin', 'client_owner', 'cashier'));

ALTER TABLE platform_users
  ADD CONSTRAINT platform_users_role_scope_check
  CHECK (
    (role = 'super_admin' AND organization_id IS NULL AND site_id IS NULL)
    OR
    (role = 'client_owner' AND organization_id IS NOT NULL AND site_id IS NULL)
    OR
    (role = 'cashier' AND organization_id IS NOT NULL AND site_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION enforce_platform_user_site_scope()
RETURNS TRIGGER AS $cashier_site_scope$
DECLARE
  site_organization_id BIGINT;
BEGIN
  IF NEW.role <> 'cashier' THEN
    RETURN NEW;
  END IF;

  SELECT organization_id
  INTO site_organization_id
  FROM sites
  WHERE id = NEW.site_id
    AND active = TRUE;

  IF site_organization_id IS NULL THEN
    RAISE EXCEPTION 'Cashier site % does not exist or is inactive', NEW.site_id;
  END IF;

  IF site_organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION
      'Cashier site % does not belong to organization %',
      NEW.site_id,
      NEW.organization_id;
  END IF;

  RETURN NEW;
END;
$cashier_site_scope$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_user_site_scope ON platform_users;

CREATE TRIGGER trg_platform_user_site_scope
BEFORE INSERT OR UPDATE OF role, organization_id, site_id
ON platform_users
FOR EACH ROW
EXECUTE FUNCTION enforce_platform_user_site_scope();


ALTER TABLE voucher_batches
  ADD COLUMN IF NOT EXISTS batch_type VARCHAR(20) NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS cashier_user_id BIGINT
    REFERENCES platform_users(id) ON DELETE RESTRICT;

ALTER TABLE voucher_batches
  DROP CONSTRAINT IF EXISTS voucher_batches_batch_type_check;

ALTER TABLE voucher_batches
  ADD CONSTRAINT voucher_batches_batch_type_check
  CHECK (batch_type IN ('admin', 'cashier'));

ALTER TABLE voucher_batches
  DROP CONSTRAINT IF EXISTS voucher_batches_cashier_scope_check;

ALTER TABLE voucher_batches
  ADD CONSTRAINT voucher_batches_cashier_scope_check
  CHECK (
    (batch_type = 'admin' AND cashier_user_id IS NULL)
    OR
    (batch_type = 'cashier' AND cashier_user_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_voucher_batches_cashier_pool
  ON voucher_batches(
    organization_id,
    site_id,
    package_id,
    cashier_user_id,
    created_at DESC
  )
  WHERE batch_type = 'cashier'
    AND active = TRUE;


CREATE TABLE IF NOT EXISTS voucher_sales (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  site_id BIGINT NOT NULL
    REFERENCES sites(id) ON DELETE RESTRICT,
  package_id BIGINT NOT NULL
    REFERENCES packages(id) ON DELETE RESTRICT,
  voucher_id BIGINT NOT NULL UNIQUE
    REFERENCES vouchers(id) ON DELETE RESTRICT,
  cashier_user_id BIGINT NOT NULL
    REFERENCES platform_users(id) ON DELETE RESTRICT,
  package_name_snapshot VARCHAR(100) NOT NULL,
  package_duration_seconds_snapshot INTEGER NOT NULL
    CHECK (package_duration_seconds_snapshot > 0),
  sale_price_tzs INTEGER NOT NULL CHECK (sale_price_tzs >= 0),
  sale_status VARCHAR(20) NOT NULL DEFAULT 'issued'
    CHECK (sale_status IN ('issued', 'voided')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id BIGINT REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voucher_sales_cashier_issued
  ON voucher_sales(cashier_user_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_voucher_sales_org_site_issued
  ON voucher_sales(organization_id, site_id, issued_at DESC);

CREATE OR REPLACE FUNCTION enforce_voucher_sale_scope()
RETURNS TRIGGER AS $voucher_sale_scope$
DECLARE
  voucher_organization_id BIGINT;
  voucher_site_id BIGINT;
  batch_package_id BIGINT;
  cashier_organization_id BIGINT;
  cashier_site_id BIGINT;
  cashier_role VARCHAR(30);
BEGIN
  SELECT
    v.organization_id,
    v.site_id,
    vb.package_id
  INTO
    voucher_organization_id,
    voucher_site_id,
    batch_package_id
  FROM vouchers v
  JOIN voucher_batches vb ON vb.id = v.batch_id
  WHERE v.id = NEW.voucher_id;

  SELECT
    organization_id,
    site_id,
    role
  INTO
    cashier_organization_id,
    cashier_site_id,
    cashier_role
  FROM platform_users
  WHERE id = NEW.cashier_user_id
    AND active = TRUE;

  IF voucher_organization_id IS NULL
     OR cashier_organization_id IS NULL THEN
    RAISE EXCEPTION 'Voucher sale references missing records';
  END IF;

  IF cashier_role <> 'cashier' THEN
    RAISE EXCEPTION 'Voucher sale user % is not a cashier', NEW.cashier_user_id;
  END IF;

  IF NEW.organization_id <> voucher_organization_id
     OR NEW.site_id <> voucher_site_id
     OR NEW.package_id <> batch_package_id
     OR NEW.organization_id <> cashier_organization_id
     OR NEW.site_id <> cashier_site_id THEN
    RAISE EXCEPTION 'Voucher sale tenant/site/package scope mismatch';
  END IF;

  RETURN NEW;
END;
$voucher_sale_scope$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_voucher_sale_scope ON voucher_sales;

CREATE TRIGGER trg_voucher_sale_scope
BEFORE INSERT OR UPDATE OF
  organization_id,
  site_id,
  package_id,
  voucher_id,
  cashier_user_id
ON voucher_sales
FOR EACH ROW
EXECUTE FUNCTION enforce_voucher_sale_scope();

DROP TRIGGER IF EXISTS trg_no_delete_voucher_sales ON voucher_sales;

CREATE TRIGGER trg_no_delete_voucher_sales
BEFORE DELETE ON voucher_sales
FOR EACH ROW EXECUTE FUNCTION prevent_audit_hard_delete();

COMMIT;
