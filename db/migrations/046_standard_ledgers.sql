-- The rest of the ledgers an Indian business expects to find on day one:
-- borrowings secured and unsecured, the bank overdraft, provisions, deposits
-- paid and received, investments, loans and advances, preliminary expenses not
-- yet written off, branch accounts, a suspense account, drawings, discount
-- received and TCS that sellers collected from us.
--
-- Each one's subtype places it on the right Schedule III line (schedule-iii.ts).
-- Added to every organisation that does not already have the code.

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, x.code, x.name, x.type, x.subtype, x.description, x.is_system, 1
  FROM organizations o
  JOIN (
    SELECT '1260' AS code, 'Security Deposits' AS name, 'asset' AS type, 'deposit' AS subtype,
           'Rent, electricity and other deposits paid, recoverable when the arrangement ends' AS description, 0 AS is_system
    UNION ALL SELECT '1270', 'Loans & Advances (Asset)', 'asset', 'advance',
           'Advances to staff and others, recoverable in cash or kind within the year', 0
    UNION ALL SELECT '1410', 'TCS Receivable', 'asset', 'tax',
           'Tax collected at source by our sellers; claimed against our own income tax', 1
    UNION ALL SELECT '1700', 'Investments', 'asset', 'investment',
           'Shares, bonds, mutual funds and deposits held for more than a year', 0
    UNION ALL SELECT '1710', 'Current Investments', 'asset', 'current_investment',
           'Investments to be realised within twelve months', 0
    UNION ALL SELECT '1800', 'Miscellaneous Expenses (Asset)', 'asset', 'misc_expense',
           'Preliminary and pre-operative expenses not yet written off', 0
    UNION ALL SELECT '1900', 'Branch / Divisions', 'asset', 'branch',
           'Inter-branch account; its balances across branches net to nil', 0
    UNION ALL SELECT '1990', 'Suspense Account', 'asset', 'suspense',
           'Holds an entry whose right ledger is not yet known. Should be nil before the books are closed', 1
    UNION ALL SELECT '2510', 'Bank Overdraft / Cash Credit', 'liability', 'bank_od',
           'Overdraft and cash-credit limits drawn; repayable on demand', 0
    UNION ALL SELECT '2600', 'Secured Loans', 'liability', 'loan',
           'Term loans and other borrowings against a charge on assets', 0
    UNION ALL SELECT '2650', 'Unsecured Loans', 'liability', 'loan',
           'Loans from directors, partners, relatives and others without security', 0
    UNION ALL SELECT '2700', 'Provisions', 'liability', 'provision',
           'Expenses incurred and not yet billed or paid: audit fee, bonus, gratuity', 0
    UNION ALL SELECT '2720', 'Provision for Income Tax', 'liability', 'provision',
           'Income tax for the year, net of advance tax once it is set off', 0
    UNION ALL SELECT '2800', 'Deposits Received', 'liability', 'deposit',
           'Security deposits taken from dealers, tenants and customers', 0
    UNION ALL SELECT '3150', 'Drawings', 'equity', 'drawings',
           'What a proprietor or partner takes out of the business; reduces their capital', 0
    UNION ALL SELECT '4450', 'Discount Received', 'income', NULL,
           'Cash and trade discounts given to us by suppliers', 0
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = x.code);

-- In a union territory without a legislature the state half of GST is UTGST.
-- Renamed only where the ledger still carries the name it was created with.
UPDATE accounts SET name = 'Output SGST/UTGST Payable' WHERE code = '2220' AND name = 'Output SGST Payable';
UPDATE accounts SET name = 'Input SGST/UTGST (ITC)' WHERE code = '1320' AND name = 'Input SGST (ITC)';
