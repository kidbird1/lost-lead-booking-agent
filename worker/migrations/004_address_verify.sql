-- 2026-10-18: exact address verification.
ALTER TABLE area_checks ADD COLUMN verified TEXT;  -- verified | not_found | street_only | no_number | error
ALTER TABLE area_checks ADD COLUMN matched TEXT;   -- the address as the map knows it
ALTER TABLE leads ADD COLUMN address_verified TEXT;
ALTER TABLE leads ADD COLUMN address_matched TEXT;
