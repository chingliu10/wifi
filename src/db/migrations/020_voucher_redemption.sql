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

COMMIT;
