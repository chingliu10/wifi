BEGIN;

CREATE TABLE IF NOT EXISTS accounting_expenses (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  site_id BIGINT
    REFERENCES sites(id) ON DELETE RESTRICT,
  category VARCHAR(40) NOT NULL CHECK (
    category IN (
      'bandwidth',
      'electricity',
      'site_rent',
      'voucher_commission',
      'hosting',
      'transport',
      'maintenance',
      'marketing',
      'staff',
      'licenses',
      'other'
    )
  ),
  description VARCHAR(180) NOT NULL,
  amount_tzs BIGINT NOT NULL CHECK (amount_tzs > 0),
  expense_date DATE NOT NULL,
  vendor VARCHAR(160),
  payment_method VARCHAR(30) NOT NULL DEFAULT 'cash' CHECK (
    payment_method IN (
      'cash',
      'mobile_money',
      'bank',
      'wallet',
      'other'
    )
  ),
  reference VARCHAR(160),
  cashier_user_id BIGINT
    REFERENCES platform_users(id) ON DELETE RESTRICT,
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'voided')
  ),
  created_by_user_id BIGINT NOT NULL
    REFERENCES platform_users(id) ON DELETE RESTRICT,
  voided_at TIMESTAMPTZ,
  voided_by_user_id BIGINT
    REFERENCES platform_users(id) ON DELETE RESTRICT,
  void_reason VARCHAR(250),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT accounting_expenses_void_state_check CHECK (
    (
      status = 'active'
      AND voided_at IS NULL
      AND voided_by_user_id IS NULL
    )
    OR
    (
      status = 'voided'
      AND voided_at IS NOT NULL
      AND voided_by_user_id IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_accounting_expenses_org_date
  ON accounting_expenses(organization_id, expense_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_accounting_expenses_org_site_date
  ON accounting_expenses(organization_id, site_id, expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_accounting_expenses_org_category_date
  ON accounting_expenses(organization_id, category, expense_date DESC);


CREATE TABLE IF NOT EXISTS accounting_assets (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  site_id BIGINT
    REFERENCES sites(id) ON DELETE RESTRICT,
  asset_type VARCHAR(40) NOT NULL CHECK (
    asset_type IN (
      'access_point',
      'router',
      'switch',
      'ups',
      'mast',
      'cabling',
      'computer',
      'power_equipment',
      'other'
    )
  ),
  name VARCHAR(180) NOT NULL,
  purchase_price_tzs BIGINT NOT NULL CHECK (purchase_price_tzs > 0),
  purchase_date DATE NOT NULL,
  vendor VARCHAR(160),
  reference VARCHAR(160),
  useful_life_months INTEGER CHECK (
    useful_life_months IS NULL OR useful_life_months > 0
  ),
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disposed')
  ),
  created_by_user_id BIGINT NOT NULL
    REFERENCES platform_users(id) ON DELETE RESTRICT,
  disposed_at TIMESTAMPTZ,
  disposed_by_user_id BIGINT
    REFERENCES platform_users(id) ON DELETE RESTRICT,
  disposal_note VARCHAR(250),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT accounting_assets_disposal_state_check CHECK (
    (
      status = 'active'
      AND disposed_at IS NULL
      AND disposed_by_user_id IS NULL
    )
    OR
    (
      status = 'disposed'
      AND disposed_at IS NOT NULL
      AND disposed_by_user_id IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_accounting_assets_org_date
  ON accounting_assets(organization_id, purchase_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_accounting_assets_org_site_date
  ON accounting_assets(organization_id, site_id, purchase_date DESC);


CREATE OR REPLACE FUNCTION enforce_accounting_expense_scope()
RETURNS TRIGGER AS $accounting_expense_scope$
DECLARE
  site_organization_id BIGINT;
  cashier_organization_id BIGINT;
  cashier_role VARCHAR(30);
  actor_organization_id BIGINT;
  actor_role VARCHAR(30);
BEGIN
  IF NEW.site_id IS NOT NULL THEN
    SELECT organization_id
    INTO site_organization_id
    FROM sites
    WHERE id = NEW.site_id;

    IF site_organization_id IS NULL
       OR site_organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION
        'Accounting expense site % does not belong to organization %',
        NEW.site_id,
        NEW.organization_id;
    END IF;
  END IF;

  IF NEW.cashier_user_id IS NOT NULL THEN
    SELECT organization_id, role
    INTO cashier_organization_id, cashier_role
    FROM platform_users
    WHERE id = NEW.cashier_user_id
      AND active = TRUE;

    IF cashier_organization_id IS NULL
       OR cashier_organization_id <> NEW.organization_id
       OR cashier_role <> 'cashier' THEN
      RAISE EXCEPTION
        'Accounting expense cashier % does not belong to organization %',
        NEW.cashier_user_id,
        NEW.organization_id;
    END IF;
  END IF;

  SELECT organization_id, role
  INTO actor_organization_id, actor_role
  FROM platform_users
  WHERE id = NEW.created_by_user_id
    AND active = TRUE;

  IF actor_role = 'super_admin' THEN
    NULL;
  ELSIF actor_organization_id IS NULL
        OR actor_organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION
      'Accounting expense creator % is outside organization %',
      NEW.created_by_user_id,
      NEW.organization_id;
  END IF;

  IF NEW.voided_by_user_id IS NOT NULL THEN
    SELECT organization_id, role
    INTO actor_organization_id, actor_role
    FROM platform_users
    WHERE id = NEW.voided_by_user_id
      AND active = TRUE;

    IF actor_role = 'super_admin' THEN
      NULL;
    ELSIF actor_organization_id IS NULL
          OR actor_organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION
        'Accounting expense void actor % is outside organization %',
        NEW.voided_by_user_id,
        NEW.organization_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$accounting_expense_scope$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounting_expense_scope
  ON accounting_expenses;

CREATE TRIGGER trg_accounting_expense_scope
BEFORE INSERT OR UPDATE OF
  organization_id,
  site_id,
  cashier_user_id,
  created_by_user_id,
  voided_by_user_id
ON accounting_expenses
FOR EACH ROW
EXECUTE FUNCTION enforce_accounting_expense_scope();


CREATE OR REPLACE FUNCTION enforce_accounting_asset_scope()
RETURNS TRIGGER AS $accounting_asset_scope$
DECLARE
  site_organization_id BIGINT;
  actor_organization_id BIGINT;
  actor_role VARCHAR(30);
BEGIN
  IF NEW.site_id IS NOT NULL THEN
    SELECT organization_id
    INTO site_organization_id
    FROM sites
    WHERE id = NEW.site_id;

    IF site_organization_id IS NULL
       OR site_organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION
        'Accounting asset site % does not belong to organization %',
        NEW.site_id,
        NEW.organization_id;
    END IF;
  END IF;

  SELECT organization_id, role
  INTO actor_organization_id, actor_role
  FROM platform_users
  WHERE id = NEW.created_by_user_id
    AND active = TRUE;

  IF actor_role = 'super_admin' THEN
    NULL;
  ELSIF actor_organization_id IS NULL
        OR actor_organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION
      'Accounting asset creator % is outside organization %',
      NEW.created_by_user_id,
      NEW.organization_id;
  END IF;

  IF NEW.disposed_by_user_id IS NOT NULL THEN
    SELECT organization_id, role
    INTO actor_organization_id, actor_role
    FROM platform_users
    WHERE id = NEW.disposed_by_user_id
      AND active = TRUE;

    IF actor_role = 'super_admin' THEN
      NULL;
    ELSIF actor_organization_id IS NULL
          OR actor_organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION
        'Accounting asset disposal actor % is outside organization %',
        NEW.disposed_by_user_id,
        NEW.organization_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$accounting_asset_scope$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounting_asset_scope
  ON accounting_assets;

CREATE TRIGGER trg_accounting_asset_scope
BEFORE INSERT OR UPDATE OF
  organization_id,
  site_id,
  created_by_user_id,
  disposed_by_user_id
ON accounting_assets
FOR EACH ROW
EXECUTE FUNCTION enforce_accounting_asset_scope();


DROP TRIGGER IF EXISTS trg_no_delete_accounting_expenses
  ON accounting_expenses;

CREATE TRIGGER trg_no_delete_accounting_expenses
BEFORE DELETE ON accounting_expenses
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_hard_delete();

DROP TRIGGER IF EXISTS trg_no_delete_accounting_assets
  ON accounting_assets;

CREATE TRIGGER trg_no_delete_accounting_assets
BEFORE DELETE ON accounting_assets
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_hard_delete();

COMMIT;
