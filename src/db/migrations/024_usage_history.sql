BEGIN;

-- Optional reporting tables only. No changes to access, vouchers or money records.
CREATE TABLE IF NOT EXISTS usage_sites (
  site_id BIGINT PRIMARY KEY REFERENCES sites(id) ON DELETE RESTRICT,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_by BIGINT REFERENCES platform_users(id) ON DELETE RESTRICT,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ,
  history_supported BOOLEAN,
  last_error_code VARCHAR(60),
  UNIQUE (site_id, organization_id)
);

CREATE OR REPLACE FUNCTION enforce_usage_site_scope() RETURNS TRIGGER AS $usage_scope$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id AND organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Usage site is outside organization';
  END IF;
  RETURN NEW;
END;
$usage_scope$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_usage_site_scope ON usage_sites;
CREATE TRIGGER trg_usage_site_scope BEFORE INSERT OR UPDATE ON usage_sites
FOR EACH ROW EXECUTE FUNCTION enforce_usage_site_scope();

CREATE TABLE IF NOT EXISTS usage_clients (
  site_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  client_mac VARCHAR(17) NOT NULL CHECK (client_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  client_name VARCHAR(120),
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ,
  history_synced_at TIMESTAMPTZ,
  PRIMARY KEY (site_id, client_mac),
  UNIQUE (site_id, organization_id, client_mac),
  FOREIGN KEY (site_id, organization_id) REFERENCES usage_sites(site_id, organization_id)
);
CREATE INDEX IF NOT EXISTS usage_clients_sync_idx ON usage_clients(site_id, history_synced_at NULLS FIRST);

CREATE TABLE IF NOT EXISTS usage_sessions (
  id BIGSERIAL PRIMARY KEY,
  site_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  client_mac VARCHAR(17) NOT NULL,
  controller_id VARCHAR(160),
  started_at TIMESTAMPTZ NOT NULL,
  last_counter_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  download_counter BIGINT NOT NULL DEFAULT 0 CHECK (download_counter >= 0),
  upload_counter BIGINT NOT NULL DEFAULT 0 CHECK (upload_counter >= 0),
  download_total BIGINT NOT NULL DEFAULT 0 CHECK (download_total >= 0),
  upload_total BIGINT NOT NULL DEFAULT 0 CHECK (upload_total >= 0),
  history_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  has_gap BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (site_id, client_mac, started_at),
  UNIQUE (id, organization_id, site_id),
  FOREIGN KEY (site_id, organization_id, client_mac)
    REFERENCES usage_clients(site_id, organization_id, client_mac)
);
CREATE INDEX IF NOT EXISTS usage_sessions_controller_idx ON usage_sessions(site_id, client_mac, controller_id)
WHERE controller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_sessions_client_idx ON usage_sessions(organization_id, site_id, client_mac, started_at DESC);

CREATE TABLE IF NOT EXISTS usage_days (
  session_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  site_id BIGINT NOT NULL,
  usage_date DATE NOT NULL,
  download_bytes BIGINT NOT NULL DEFAULT 0 CHECK (download_bytes >= 0),
  upload_bytes BIGINT NOT NULL DEFAULT 0 CHECK (upload_bytes >= 0),
  estimated BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (session_id, usage_date),
  FOREIGN KEY (session_id, organization_id, site_id) REFERENCES usage_sessions(id, organization_id, site_id)
);
CREATE INDEX IF NOT EXISTS usage_days_date_idx ON usage_days(organization_id, usage_date, site_id);

COMMIT;
