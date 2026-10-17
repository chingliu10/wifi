BEGIN;

-- Voucher codes need to remain printable/exportable after generation.
-- Store only authenticated encryption plus a SHA-256 lookup hash; never plaintext.
ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS code_enc TEXT;

ALTER TABLE vouchers
  DROP CONSTRAINT IF EXISTS vouchers_code_enc_required;

ALTER TABLE vouchers
  ADD CONSTRAINT vouchers_code_enc_required
  CHECK (code_enc IS NOT NULL AND BTRIM(code_enc) <> '');

COMMIT;
