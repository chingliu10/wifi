BEGIN;

CREATE TABLE IF NOT EXISTS payout_transactions (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by_user_id BIGINT REFERENCES platform_users(id) ON DELETE SET NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'splashpay',
  reference VARCHAR(150) NOT NULL UNIQUE,
  provider_reference VARCHAR(150),
  recipient_phone VARCHAR(20) NOT NULL,
  recipient_name VARCHAR(160) NOT NULL,
  network VARCHAR(40) NOT NULL,
  amount_tzs NUMERIC(18,2) NOT NULL CHECK (amount_tzs > 0),
  fee_tzs NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (fee_tzs >= 0),
  total_amount_tzs NUMERIC(18,2) NOT NULL CHECK (total_amount_tzs > 0),
  status VARCHAR(20) NOT NULL CHECK (
    status IN ('pending', 'processing', 'paid', 'failed', 'cancelled')
  ),
  remarks TEXT,
  error_code VARCHAR(100),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_transactions_provider_reference_unique
  ON payout_transactions(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payout_transactions_org_created
  ON payout_transactions(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payout_transactions_org_status
  ON payout_transactions(organization_id, status);

ALTER TABLE wallet_entries
  ADD COLUMN IF NOT EXISTS payout_transaction_id BIGINT REFERENCES payout_transactions(id) ON DELETE SET NULL;

ALTER TABLE wallet_entries
  DROP CONSTRAINT IF EXISTS wallet_entries_entry_type_check;

ALTER TABLE wallet_entries
  ADD CONSTRAINT wallet_entries_entry_type_check CHECK (
    entry_type IN (
      'payment_credit',
      'gateway_fee',
      'platform_fee',
      'payout_debit',
      'payout_fee',
      'adjustment'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_entries_payout_type_unique
  ON wallet_entries(payout_transaction_id, entry_type)
  WHERE payout_transaction_id IS NOT NULL;

COMMIT;
