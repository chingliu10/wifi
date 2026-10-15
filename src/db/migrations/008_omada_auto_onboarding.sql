BEGIN;

ALTER TABLE sites
    ADD COLUMN IF NOT EXISTS portal_key VARCHAR(80),
    ADD COLUMN IF NOT EXISTS portal_connected_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_portal_seen_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_portal_key_unique
    ON sites(portal_key)
    WHERE portal_key IS NOT NULL;

ALTER TABLE network_devices
    ADD COLUMN IF NOT EXISTS ssid_name VARCHAR(150),
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_network_devices_last_seen_at
    ON network_devices(last_seen_at);

COMMIT;
