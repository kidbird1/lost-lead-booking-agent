-- 2026-10-18: commercial / industrial callers.
ALTER TABLE leads ADD COLUMN property_type TEXT;  -- home | business | industrial
ALTER TABLE leads ADD COLUMN company TEXT;
