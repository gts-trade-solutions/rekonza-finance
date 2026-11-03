-- A customer may deduct TDS from us, or a vendor be paid under, more than one
-- section (194C for a job, 194J for professional fees). tds_section now holds
-- them as a comma-separated list; the first is the default a new bill takes
-- (lib/tax/tds.ts parseSections / joinSections).
ALTER TABLE contacts MODIFY COLUMN tds_section VARCHAR(100) NULL;
