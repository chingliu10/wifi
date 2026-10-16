BEGIN;

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS omada_reauth_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS omada_reauth_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS omada_reauth_error TEXT;

COMMIT;
