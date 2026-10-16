BEGIN;

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS gateway_fee_tzs NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS net_amount_tzs NUMERIC(18,2);

ALTER TABLE wallet_entries
  ALTER COLUMN amount_tzs TYPE NUMERIC(18,2)
  USING amount_tzs::NUMERIC(18,2);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_entries_payment_type_unique
  ON wallet_entries(payment_transaction_id, entry_type)
  WHERE payment_transaction_id IS NOT NULL;

-- One-time reconciliation for existing successful SplashPay collections
-- created before Solidus started persisting SplashPay's fee/net response.
-- The merchant account currently charges 1.5%, as confirmed by the
-- current SplashPay settlement totals. Future payments use provider values.
UPDATE payment_transactions
SET
  gateway_fee_tzs = ROUND(amount_tzs::NUMERIC * 0.015, 2),
  net_amount_tzs = amount_tzs::NUMERIC - ROUND(amount_tzs::NUMERIC * 0.015, 2)
WHERE provider = 'splashpay'
  AND status = 'paid'
  AND gateway_fee_tzs IS NULL
  AND net_amount_tzs IS NULL;

INSERT INTO wallet_entries (
  organization_id,
  payment_transaction_id,
  entry_type,
  amount_tzs,
  description
)
SELECT
  pt.organization_id,
  pt.id,
  'payment_credit',
  pt.net_amount_tzs + pt.gateway_fee_tzs,
  'Customer payment ' || pt.reference
FROM payment_transactions pt
WHERE pt.status = 'paid'
  AND pt.organization_id IS NOT NULL
  AND pt.gateway_fee_tzs IS NOT NULL
  AND pt.net_amount_tzs IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO wallet_entries (
  organization_id,
  payment_transaction_id,
  entry_type,
  amount_tzs,
  description
)
SELECT
  pt.organization_id,
  pt.id,
  'gateway_fee',
  -pt.gateway_fee_tzs,
  'Gateway fee for ' || pt.reference
FROM payment_transactions pt
WHERE pt.status = 'paid'
  AND pt.organization_id IS NOT NULL
  AND pt.gateway_fee_tzs IS NOT NULL
  AND pt.net_amount_tzs IS NOT NULL
  AND pt.gateway_fee_tzs <> 0
ON CONFLICT DO NOTHING;

COMMIT;
