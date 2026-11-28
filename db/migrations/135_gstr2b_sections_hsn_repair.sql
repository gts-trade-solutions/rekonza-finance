-- 135_gstr2b_sections_hsn_repair.sql
-- Two fixes from the independent auditor check of 2026-11-28 (item 11, GST return filing).
--
-- 1. GSTR-2B carries more than supplier invoices and notes. GSTN's GSTR-2B
--    JSON also lists credit distributed by an Input Service Distributor (ISD,
--    ISDA: GSTR-3B 4(A)(4)) and imports of goods by bill of entry (IMPG from
--    abroad, IMPGSEZ from a SEZ unit: GSTR-3B 4(A)(1)). The import now reads
--    them, so a line says which it is. An import from abroad has no supplier
--    GSTIN; its vendor_gstin is left empty and the bill of entry number is the
--    document number.
ALTER TABLE gstr2b_entries
  MODIFY COLUMN doc_type ENUM('invoice','credit_note','debit_note','isd','isd_credit','bill_of_entry') NOT NULL DEFAULT 'invoice';

-- 2. The demo seed (lib/server/seed/demo-sr7-d.ts) gave the demo book's
--    four-digit HSN codes their six digits, and its second pass, for lines
--    without an item, ran its UPDATE over every company in the database rather
--    than the demo book alone. Wherever the seed ran on a database holding a
--    real company, that company's lines were rewritten: an item saved with HSN
--    8708 showed 870899 on its bills and invoices, and GSTR-1 table 12 split one
--    item between 870899 (older documents) and 8708 (newer ones).
--
--    The seed is fixed to touch its own book only. Here, the lines it rewrote
--    in other companies are given back their item's own code. Only the exact
--    pairs the seed wrote are undone, and only on lines whose item still has
--    the four-digit code, so a code someone typed on purpose is left alone.
--    Lines without an item cannot be told apart from a code typed on purpose,
--    so they are not touched.
--
--    (The CGST Rules, rule 46(g), want the invoice to carry the HSN of the goods
--    as the business classifies them; the return must report the same code.)
UPDATE invoice_lines l
  JOIN items i ON i.id = l.item_id AND i.org_id = l.org_id
  JOIN organizations o ON o.id = l.org_id
   SET l.hsn_sac = i.hsn_sac
 WHERE o.is_demo = 0
   AND (i.hsn_sac, l.hsn_sac) IN (('8708','870899'),('8421','842123'),('8511','851110'),('8512','851220'),('2710','271019'),
                                  ('4011','401110'),('8507','850710'),('3820','382000'),('7009','700910'),('4010','401036'));

UPDATE credit_note_lines l
  JOIN items i ON i.id = l.item_id AND i.org_id = l.org_id
  JOIN organizations o ON o.id = l.org_id
   SET l.hsn_sac = i.hsn_sac
 WHERE o.is_demo = 0
   AND (i.hsn_sac, l.hsn_sac) IN (('8708','870899'),('8421','842123'),('8511','851110'),('8512','851220'),('2710','271019'),
                                  ('4011','401110'),('8507','850710'),('3820','382000'),('7009','700910'),('4010','401036'));

UPDATE bill_lines l
  JOIN items i ON i.id = l.item_id AND i.org_id = l.org_id
  JOIN organizations o ON o.id = l.org_id
   SET l.hsn_sac = i.hsn_sac
 WHERE o.is_demo = 0
   AND (i.hsn_sac, l.hsn_sac) IN (('8708','870899'),('8421','842123'),('8511','851110'),('8512','851220'),('2710','271019'),
                                  ('4011','401110'),('8507','850710'),('3820','382000'),('7009','700910'),('4010','401036'));

UPDATE estimate_lines l
  JOIN items i ON i.id = l.item_id AND i.org_id = l.org_id
  JOIN organizations o ON o.id = l.org_id
   SET l.hsn_sac = i.hsn_sac
 WHERE o.is_demo = 0
   AND (i.hsn_sac, l.hsn_sac) IN (('8708','870899'),('8421','842123'),('8511','851110'),('8512','851220'),('2710','271019'),
                                  ('4011','401110'),('8507','850710'),('3820','382000'),('7009','700910'),('4010','401036'));

UPDATE sales_order_lines l
  JOIN items i ON i.id = l.item_id AND i.org_id = l.org_id
  JOIN organizations o ON o.id = l.org_id
   SET l.hsn_sac = i.hsn_sac
 WHERE o.is_demo = 0
   AND (i.hsn_sac, l.hsn_sac) IN (('8708','870899'),('8421','842123'),('8511','851110'),('8512','851220'),('2710','271019'),
                                  ('4011','401110'),('8507','850710'),('3820','382000'),('7009','700910'),('4010','401036'));

UPDATE purchase_order_lines l
  JOIN items i ON i.id = l.item_id AND i.org_id = l.org_id
  JOIN organizations o ON o.id = l.org_id
   SET l.hsn_sac = i.hsn_sac
 WHERE o.is_demo = 0
   AND (i.hsn_sac, l.hsn_sac) IN (('8708','870899'),('8421','842123'),('8511','851110'),('8512','851220'),('2710','271019'),
                                  ('4011','401110'),('8507','850710'),('3820','382000'),('7009','700910'),('4010','401036'));

UPDATE vendor_credit_lines l
  JOIN items i ON i.id = l.item_id AND i.org_id = l.org_id
  JOIN organizations o ON o.id = l.org_id
   SET l.hsn_sac = i.hsn_sac
 WHERE o.is_demo = 0
   AND (i.hsn_sac, l.hsn_sac) IN (('8708','870899'),('8421','842123'),('8511','851110'),('8512','851220'),('2710','271019'),
                                  ('4011','401110'),('8507','850710'),('3820','382000'),('7009','700910'),('4010','401036'));
