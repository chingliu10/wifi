BEGIN;

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_access_source_check;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_access_source_check
  CHECK (access_source IN ('paid', 'complimentary', 'voucher'));

CREATE INDEX IF NOT EXISTS idx_subscriptions_voucher_lookup
  ON subscriptions(site_id, device_id, expires_at)
  WHERE status = 'active'
    AND access_source = 'voucher';

CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_subscription_unique
  ON vouchers(subscription_id)
  WHERE subscription_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_voucher_redemption_scope()
RETURNS TRIGGER AS $voucher_redemption_scope$
DECLARE
  subscription_site_id BIGINT;
  subscription_device_id BIGINT;
  subscription_package_id BIGINT;
  batch_package_id BIGINT;
BEGIN
  IF NEW.status <> 'redeemed' THEN
    RETURN NEW;
  END IF;

  SELECT
    site_id,
    device_id,
    package_id
  INTO
    subscription_site_id,
    subscription_device_id,
    subscription_package_id
  FROM subscriptions
  WHERE id = NEW.subscription_id;

  SELECT package_id
  INTO batch_package_id
  FROM voucher_batches
  WHERE id = NEW.batch_id;

  IF subscription_site_id IS NULL
     OR subscription_device_id IS NULL
     OR batch_package_id IS NULL THEN
    RAISE EXCEPTION 'Voucher redemption references missing records';
  END IF;

  IF subscription_site_id <> NEW.site_id
     OR subscription_device_id <> NEW.redeemed_device_id
     OR subscription_package_id <> batch_package_id THEN
    RAISE EXCEPTION 'Voucher redemption scope does not match subscription';
  END IF;

  RETURN NEW;
END;
$voucher_redemption_scope$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_voucher_redemption_scope ON vouchers;

CREATE TRIGGER trg_voucher_redemption_scope
BEFORE INSERT OR UPDATE OF status, redeemed_device_id, subscription_id, batch_id, site_id
ON vouchers
FOR EACH ROW
EXECUTE FUNCTION enforce_voucher_redemption_scope();

COMMIT;
