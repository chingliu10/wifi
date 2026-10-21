BEGIN;

CREATE TABLE IF NOT EXISTS voucher_redemption_attempts (
  organization_id BIGINT NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  site_id BIGINT NOT NULL
    REFERENCES sites(id) ON DELETE RESTRICT,
  device_id BIGINT NOT NULL
    REFERENCES devices(id) ON DELETE RESTRICT,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, site_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_voucher_redemption_attempts_blocked
  ON voucher_redemption_attempts(blocked_until)
  WHERE blocked_until IS NOT NULL;

COMMIT;
