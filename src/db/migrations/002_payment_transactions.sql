BEGIN;

CREATE TABLE IF NOT EXISTS payment_transactions (
    id BIGSERIAL PRIMARY KEY,
    reference VARCHAR(80) NOT NULL UNIQUE,
    phone VARCHAR(20) NOT NULL,
    package_id BIGINT NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
    client_mac VARCHAR(17) NOT NULL,
    device_id BIGINT NOT NULL,
    amount_tzs INTEGER NOT NULL CHECK (amount_tzs > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending',
            'paid',
            'failed',
            'cancelled',
            'expired'
        )
    ),
    provider VARCHAR(50),
    provider_reference VARCHAR(150),
    site VARCHAR(150),
    ap_mac VARCHAR(17),
    ssid_name VARCHAR(150),
    redirect_url TEXT,
    radio_id VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_package_id
    ON payment_transactions(package_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_client_mac
    ON payment_transactions(client_mac);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_device_id
    ON payment_transactions(device_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_status
    ON payment_transactions(status);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_created_at
    ON payment_transactions(created_at);

COMMIT;
