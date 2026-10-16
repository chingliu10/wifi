BEGIN;

ALTER TABLE packages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_packages_not_deleted
  ON packages(site_id, active, sort_order, id)
  WHERE deleted_at IS NULL;

COMMIT;
