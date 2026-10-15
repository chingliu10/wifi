BEGIN;

CREATE TABLE IF NOT EXISTS organizations (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    slug VARCHAR(120) NOT NULL UNIQUE,
    owner_name VARCHAR(120),
    owner_phone VARCHAR(30),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sites
    ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS brand_name VARCHAR(120),
    ADD COLUMN IF NOT EXISTS support_phone VARCHAR(30),
    ADD COLUMN IF NOT EXISTS primary_color VARCHAR(20) NOT NULL DEFAULT '#0B6B47',
    ADD COLUMN IF NOT EXISTS external_portal_site_id VARCHAR(160),
    ADD COLUMN IF NOT EXISTS logo_url TEXT;

ALTER TABLE network_devices
    ADD COLUMN IF NOT EXISTS ap_mac VARCHAR(17),
    ADD COLUMN IF NOT EXISTS device_type VARCHAR(40) NOT NULL DEFAULT 'omada';

CREATE UNIQUE INDEX IF NOT EXISTS idx_network_devices_ap_mac_unique
    ON network_devices(ap_mac)
    WHERE ap_mac IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_external_portal_site_id_unique
    ON sites(external_portal_site_id)
    WHERE external_portal_site_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sites_organization_id
    ON sites(organization_id);

ALTER TABLE payment_transactions
    ADD COLUMN IF NOT EXISTS site_id BIGINT REFERENCES sites(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL;

UPDATE payment_transactions pt
SET
    site_id = p.site_id,
    organization_id = s.organization_id
FROM packages p
JOIN sites s ON s.id = p.site_id
WHERE p.id = pt.package_id
  AND (pt.site_id IS NULL OR pt.organization_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_site_id
    ON payment_transactions(site_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_organization_id
    ON payment_transactions(organization_id);

CREATE TABLE IF NOT EXISTS wallet_entries (
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    payment_transaction_id BIGINT REFERENCES payment_transactions(id) ON DELETE SET NULL,
    entry_type VARCHAR(30) NOT NULL CHECK (
        entry_type IN ('payment_credit', 'gateway_fee', 'platform_fee', 'payout_debit', 'adjustment')
    ),
    amount_tzs BIGINT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_entries_organization_id
    ON wallet_entries(organization_id, created_at DESC);

COMMIT;
