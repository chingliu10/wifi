BEGIN;

ALTER TABLE sites
    ADD COLUMN IF NOT EXISTS omada_device_username VARCHAR(64),
    ADD COLUMN IF NOT EXISTS omada_device_password_enc TEXT,
    ADD COLUMN IF NOT EXISTS omada_provisioned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS omada_sync_error TEXT,
    ADD COLUMN IF NOT EXISTS omada_auto_adopt BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS omada_device_claims (
    id BIGSERIAL PRIMARY KEY,
    site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    ap_mac VARCHAR(17) NOT NULL,
    local_username VARCHAR(64),
    local_password_enc TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'discovered', 'adopting', 'connected', 'failed', 'expired')
    ),
    last_error TEXT,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    last_checked_at TIMESTAMPTZ,
    adopted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (site_id, ap_mac)
);

CREATE INDEX IF NOT EXISTS idx_omada_device_claims_active
    ON omada_device_claims(status, expires_at);

COMMIT;
