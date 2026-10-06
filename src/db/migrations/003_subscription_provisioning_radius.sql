BEGIN;

ALTER TABLE payment_transactions
    ADD COLUMN IF NOT EXISTS provisioning_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS provisioning_error TEXT,
    ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'payment_transactions_provisioning_status_check'
    ) THEN
        ALTER TABLE payment_transactions
            ADD CONSTRAINT payment_transactions_provisioning_status_check
            CHECK (provisioning_status IN ('pending', 'active', 'failed'));
    END IF;
END $$;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS payment_transaction_id BIGINT
        REFERENCES payment_transactions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS client_mac VARCHAR(17);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'subscriptions_status_check'
    ) THEN
        ALTER TABLE subscriptions
            DROP CONSTRAINT subscriptions_status_check;
    END IF;
END $$;

ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_status_check
    CHECK (status IN ('active', 'expired', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_payment_transaction_unique
    ON subscriptions(payment_transaction_id)
    WHERE payment_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_client_mac
    ON subscriptions(client_mac);

DO $$
BEGIN
    IF to_regclass('public.radcheck') IS NULL THEN
        CREATE TABLE radcheck (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(64) NOT NULL,
            attribute VARCHAR(64) NOT NULL,
            op VARCHAR(2) NOT NULL DEFAULT ':=',
            value VARCHAR(253) NOT NULL
        );

        CREATE UNIQUE INDEX idx_radcheck_username_attribute_unique
            ON radcheck(username, attribute);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS radius_authorizations (
    id BIGSERIAL PRIMARY KEY,
    subscription_id BIGINT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    client_mac VARCHAR(17) NOT NULL,
    username VARCHAR(64) NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'expired', 'cancelled')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT radius_authorizations_valid_time
        CHECK (expires_at > starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_radius_authorizations_subscription_unique
    ON radius_authorizations(subscription_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_radius_authorizations_client_mac_unique
    ON radius_authorizations(client_mac);

COMMIT;
