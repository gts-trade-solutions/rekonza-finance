-- 046 renamed the SGST ledgers to SGST/UTGST. A book that has already sent
-- files to Tally made its SGST ledgers there under the old names, and a file
-- under the new one would create a second ledger beside each. For those books
-- the old names are pinned in the Tally map, unless someone already chose one.
INSERT INTO tally_ledger_map (org_id, account_id, ledger_name, parent_group, updated_by_user_id)
SELECT a.org_id, a.id,
       CASE a.code WHEN '2220' THEN 'Output SGST Payable' ELSE 'Input SGST (ITC)' END,
       'Duties & Taxes', NULL
  FROM accounts a
 WHERE a.code IN ('2220', '1320')
   AND a.name IN ('Output SGST/UTGST Payable', 'Input SGST/UTGST (ITC)')
   AND EXISTS (SELECT 1 FROM tally_exports e WHERE e.org_id = a.org_id)
   AND NOT EXISTS (SELECT 1 FROM tally_ledger_map m WHERE m.org_id = a.org_id AND m.account_id = a.id);
