BEGIN;

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS client_ip VARCHAR(64),
  ADD COLUMN IF NOT EXISTS omada_portal_authorized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS omada_portal_auth_error TEXT;

COMMIT;
