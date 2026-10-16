BEGIN;

ALTER TABLE packages
    DROP CONSTRAINT IF EXISTS packages_price_tzs_check;

ALTER TABLE packages
    ADD CONSTRAINT packages_price_tzs_check
    CHECK (price_tzs >= 500);

COMMIT;
