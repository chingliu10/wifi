BEGIN;

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(80);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_device_customer
  ON payment_transactions(device_id, created_at DESC)
  WHERE customer_name IS NOT NULL;

COMMIT;
