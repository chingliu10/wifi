BEGIN;

CREATE TABLE IF NOT EXISTS platform_users (
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL CHECK (role IN ('super_admin', 'client_owner')),
    full_name VARCHAR(120) NOT NULL,
    username VARCHAR(120) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT platform_users_role_scope_check CHECK (
        (role = 'super_admin' AND organization_id IS NULL)
        OR
        (role = 'client_owner' AND organization_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_platform_users_organization_id
    ON platform_users(organization_id);

CREATE TABLE IF NOT EXISTS platform_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_sessions_user_id
    ON platform_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_platform_sessions_expires_at
    ON platform_sessions(expires_at);

COMMIT;
