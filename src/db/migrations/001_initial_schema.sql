BEGIN;

CREATE TABLE IF NOT EXISTS sites (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    timezone VARCHAR(100) NOT NULL DEFAULT 'Africa/Dar_es_Salaam',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS network_devices (
    id BIGSERIAL PRIMARY KEY,
    site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    nas_identifier VARCHAR(150),
    brand VARCHAR(100),
    model VARCHAR(100),
    management_ip INET,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT network_devices_site_nas_unique
        UNIQUE (site_id, nas_identifier)
);

CREATE TABLE IF NOT EXISTS devices (
    id BIGSERIAL PRIMARY KEY,
    mac_address VARCHAR(17) NOT NULL UNIQUE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS packages (
    id BIGSERIAL PRIMARY KEY,
    site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    price_tzs INTEGER NOT NULL CHECK (price_tzs > 0),
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    package_id BIGINT NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,

    phone_number VARCHAR(20) NOT NULL,
    amount_tzs INTEGER NOT NULL CHECK (amount_tzs > 0),

    provider VARCHAR(50) NOT NULL,
    provider_reference VARCHAR(150),

    status VARCHAR(20) NOT NULL CHECK (
        status IN (
            'pending',
            'paid',
            'failed',
            'cancelled',
            'expired'
        )
    ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,

    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id BIGSERIAL PRIMARY KEY,
    site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    package_id BIGINT NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
    payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,

    starts_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (
        status IN (
            'active',
            'cancelled'
        )
    ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT subscriptions_valid_time
        CHECK (expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_network_devices_site_id
    ON network_devices(site_id);

CREATE INDEX IF NOT EXISTS idx_packages_site_id
    ON packages(site_id);

CREATE INDEX IF NOT EXISTS idx_packages_active
    ON packages(active);

CREATE INDEX IF NOT EXISTS idx_payments_device_id
    ON payments(device_id);

CREATE INDEX IF NOT EXISTS idx_payments_site_id
    ON payments(site_id);

CREATE INDEX IF NOT EXISTS idx_payments_status
    ON payments(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_reference_unique
    ON payments(provider, provider_reference)
    WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_device_id
    ON subscriptions(device_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_site_id
    ON subscriptions(site_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at
    ON subscriptions(expires_at);

CREATE INDEX IF NOT EXISTS idx_subscriptions_active_lookup
    ON subscriptions(device_id, expires_at)
    WHERE status = 'active';

INSERT INTO sites (
    name,
    slug,
    timezone
)
VALUES (
    'Small Garden',
    'small-garden',
    'Africa/Dar_es_Salaam'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO packages (
    site_id,
    name,
    price_tzs,
    duration_seconds,
    sort_order
)
SELECT
    id,
    '7 Hours',
    500,
    25200,
    1
FROM sites
WHERE slug = 'small-garden'
AND NOT EXISTS (
    SELECT 1
    FROM packages p
    WHERE p.site_id = sites.id
      AND p.name = '7 Hours'
);

INSERT INTO packages (
    site_id,
    name,
    price_tzs,
    duration_seconds,
    sort_order
)
SELECT
    id,
    '24 Hours',
    1000,
    86400,
    2
FROM sites
WHERE slug = 'small-garden'
AND NOT EXISTS (
    SELECT 1
    FROM packages p
    WHERE p.site_id = sites.id
      AND p.name = '24 Hours'
);

INSERT INTO packages (
    site_id,
    name,
    price_tzs,
    duration_seconds,
    sort_order
)
SELECT
    id,
    '30 Days',
    9000,
    2592000,
    3
FROM sites
WHERE slug = 'small-garden'
AND NOT EXISTS (
    SELECT 1
    FROM packages p
    WHERE p.site_id = sites.id
      AND p.name = '30 Days'
);

COMMIT;