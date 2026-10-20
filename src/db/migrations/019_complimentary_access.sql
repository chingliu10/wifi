BEGIN;

ALTER TABLE subscriptions
    ALTER COLUMN package_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS access_source VARCHAR(30) NOT NULL DEFAULT 'paid',
    ADD COLUMN IF NOT EXISTS granted_by_user_id BIGINT REFERENCES platform_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS grant_note TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'subscriptions_access_source_check'
    ) THEN
        ALTER TABLE subscriptions
            ADD CONSTRAINT subscriptions_access_source_check
            CHECK (access_source IN ('paid', 'complimentary'));
    END IF;
END $$;

UPDATE subscriptions
SET access_source = 'paid'
WHERE access_source IS NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_complimentary_lookup
    ON subscriptions(site_id, device_id, expires_at)
    WHERE status = 'active'
      AND access_source = 'complimentary';

COMMIT;
