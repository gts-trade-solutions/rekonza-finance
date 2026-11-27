-- GST return filing reports (status review 7, item 11): what the returns need
-- that the books did not yet record.
--
-- 1. A GST TDS deductor (CGST Act s.51: government departments, local
--    authorities, notified bodies) deducts 2% from what it pays a registered
--    supplier under a contract worth more than ₹2.5 lakh, and files GSTR-7.
--    An e-commerce operator (s.52) collects TCS on the supplies made through
--    it and files GSTR-8; under s.9(5) it pays the tax itself on notified
--    services (restaurant, passenger transport, accommodation). Either needs a
--    registration of its own (the TDS GSTIN has D in the 14th place, the TCS
--    one C), so each role carries its GSTIN; left empty, the primary branch's.
ALTER TABLE organizations
  ADD COLUMN gst_tds_deductor TINYINT(1)  NOT NULL DEFAULT 0,
  ADD COLUMN gst_tds_gstin    CHAR(15)    NULL,
  ADD COLUMN gst_eco_operator TINYINT(1)  NOT NULL DEFAULT 0,
  ADD COLUMN gst_eco_gstin    CHAR(15)    NULL;

-- 2. A sale made through an e-commerce operator. GSTR-1 table 14 lists it by
--    the operator's GSTIN: (a) where the operator collected TCS under s.52,
--    (b) where the operator pays the tax under s.9(5) — then this invoice
--    charges no GST and GSTR-3B reports its value in 3.1.1(ii).
ALTER TABLE invoices
  ADD COLUMN eco_gstin   CHAR(15)            NULL,
  ADD COLUMN eco_section ENUM('52', '9_5')   NULL;

-- 3. GST TDS deducted (GSTR-7 table 3). One row per deduction from a payment
--    made or credited to a supplier, usually against the supplier's bill; it
--    posts Dr Accounts Payable (the supplier) / Cr GST TDS Payable, and takes
--    the deduction off what the bill still owes, as a part settlement.
CREATE TABLE IF NOT EXISTS gst_tds_deductions (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  branch_id           BIGINT        NOT NULL,
  vendor_id           BIGINT        NOT NULL,
  deductee_gstin      CHAR(15)      NOT NULL,
  bill_id             BIGINT        NULL,
  -- The contract the payment is under: its reference and total value
  -- (excluding tax), which decides whether s.51 applies at all.
  contract_ref        VARCHAR(100)  NULL,
  contract_value      DECIMAL(19,4) NOT NULL DEFAULT 0,
  deduction_date      DATE          NOT NULL,
  -- The month of the return the deduction is reported in (YYYY-MM).
  period              VARCHAR(7)    NOT NULL,
  -- What was paid or credited, excluding GST: the base the 2% is on.
  taxable             DECIMAL(19,4) NOT NULL,
  rate_pct            DECIMAL(5,2)  NOT NULL DEFAULT 2.00,
  igst                DECIMAL(19,4) NOT NULL DEFAULT 0,
  cgst                DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst                DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- The GSTR-7A certificate number, once the portal has issued it.
  certificate_no      VARCHAR(30)   NULL,
  journal_entry_id    BIGINT        NULL,
  notes               VARCHAR(300)  NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_gtds_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_gtds_period (org_id, period),
  KEY idx_gtds_bill (bill_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Supplies made through this e-commerce operator, by supplier and month
--    (GSTR-8 table 3 for s.52; GSTR-3B 3.1.1(i) and GSTR-1 table 15 for s.9(5)).
--    Supplies to registered and unregistered buyers, and what came back, are
--    kept apart because GSTR-8 asks for them apart.
CREATE TABLE IF NOT EXISTS gst_eco_supplies (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id                BIGINT        NOT NULL,
  branch_id             BIGINT        NOT NULL,
  supplier_id           BIGINT        NOT NULL,
  supplier_gstin        CHAR(15)      NOT NULL,
  section               ENUM('52', '9_5') NOT NULL DEFAULT '52',
  period                VARCHAR(7)    NOT NULL,
  entry_date            DATE          NOT NULL,
  -- Where the supplies went; against the supplier's state it makes them
  -- intra-state (CGST + SGST) or inter-state (IGST).
  place_of_supply       CHAR(2)       NOT NULL,
  inter                 TINYINT(1)    NOT NULL DEFAULT 0,
  gross_registered      DECIMAL(19,4) NOT NULL DEFAULT 0,
  returns_registered    DECIMAL(19,4) NOT NULL DEFAULT 0,
  gross_unregistered    DECIMAL(19,4) NOT NULL DEFAULT 0,
  returns_unregistered  DECIMAL(19,4) NOT NULL DEFAULT 0,
  net_value             DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- TCS rate for s.52 (1%, 0.5% from 10 July 2024); the supply's own GST rate for s.9(5).
  rate_pct              DECIMAL(5,2)  NOT NULL,
  igst                  DECIMAL(19,4) NOT NULL DEFAULT 0,
  cgst                  DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst                  DECIMAL(19,4) NOT NULL DEFAULT 0,
  journal_entry_id      BIGINT        NULL,
  notes                 VARCHAR(300)  NULL,
  created_by_user_id    BIGINT        NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_geco_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  KEY idx_geco_period (org_id, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Tax paid with a return, and the credit set off against it: GSTR-3B
--    table 6.1 (the electronic credit ledger used in the order of s.49(5) and
--    Rule 88A, the rest in cash), GSTR-7 table 5 and GSTR-8's payment of TCS.
--    Recording it posts the set-off and the cash in the books: Dr the output
--    tax (or the TDS / TCS payable), Cr the input-tax ledgers for the credit
--    used, Cr the bank for the cash, with interest and late fee as expense —
--    so the GST ledgers come back to nil for the month once it is paid.
CREATE TABLE IF NOT EXISTS gst_tax_payments (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  branch_id           BIGINT        NOT NULL,
  return_type         ENUM('GSTR3B', 'GSTR7', 'GSTR8') NOT NULL,
  -- YYYY-MM, or YYYY-Qn for a quarterly GSTR-3B.
  period              VARCHAR(7)    NOT NULL,
  paid_on             DATE          NOT NULL,
  -- The challan's CPIN (14 digits) or CIN, as the portal shows it.
  cpin                VARCHAR(20)   NULL,
  -- Null when nothing was paid in cash: the credit met it all.
  bank_account_id     BIGINT        NULL,
  cash_igst           DECIMAL(19,4) NOT NULL DEFAULT 0,
  cash_cgst           DECIMAL(19,4) NOT NULL DEFAULT 0,
  cash_sgst           DECIMAL(19,4) NOT NULL DEFAULT 0,
  cash_cess           DECIMAL(19,4) NOT NULL DEFAULT 0,
  interest            DECIMAL(19,4) NOT NULL DEFAULT 0,
  late_fee            DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- Credit used, by the head of the credit and the head it met:
  -- {"IGST":{"IGST":0,"CGST":0,"SGST":0},"CGST":{...},"SGST":{...},"CESS":{"CESS":0}}.
  setoff              JSON          NULL,
  journal_entry_id    BIGINT        NULL,
  notes               VARCHAR(300)  NULL,
  created_by_user_id  BIGINT        NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_gtp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_gtp_period (org_id, branch_id, return_type, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. What a filed return said, document by document. Kept when a return is
--    marked filed, so that a document of a filed period changed afterwards is
--    seen: it goes in the next return as an amendment (GSTR-1 9A / 9C, GSTR-7
--    tdsa, GSTR-8 tcsa) with its original number, date and figures, and the
--    return screens warn about it. The latest version filed is the row with
--    the latest period for the document.
CREATE TABLE IF NOT EXISTS gst_filed_documents (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id       BIGINT        NOT NULL,
  return_type  VARCHAR(10)   NOT NULL,
  period       VARCHAR(7)    NOT NULL,
  gstin        CHAR(15)      NULL,
  doc_type     VARCHAR(20)   NOT NULL,
  doc_id       BIGINT        NOT NULL,
  number       VARCHAR(50)   NOT NULL,
  doc_date     DATE          NULL,
  -- The table it was in: b2b, b2cl, exp, cdnr, cdnur, b2cs; tds; tcs.
  section      VARCHAR(12)   NOT NULL,
  ctin         CHAR(15)      NULL,
  pos          CHAR(2)       NULL,
  value        DECIMAL(19,4) NOT NULL DEFAULT 0,
  taxable      DECIMAL(19,4) NOT NULL DEFAULT 0,
  igst         DECIMAL(19,4) NOT NULL DEFAULT 0,
  cgst         DECIMAL(19,4) NOT NULL DEFAULT 0,
  sgst         DECIMAL(19,4) NOT NULL DEFAULT 0,
  cess         DECIMAL(19,4) NOT NULL DEFAULT 0,
  -- Rate by rate, as the return file carried it.
  detail       JSON          NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_gfd_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_gfd_doc (org_id, return_type, period, doc_type, doc_id),
  KEY idx_gfd_doc (org_id, doc_type, doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. What was decided, bill by bill, after matching with GSTR-2B: claim the
--    credit in the bill's own month (accept), hold it back until the supplier
--    files (defer), or claim it in a named later month (claim later). Since
--    1 January 2022 credit may be taken only on what 2B shows (s.16(2)(aa)),
--    so GSTR-3B table 4(A)(5) follows these decisions, and GSTR-9 table 8C /
--    13 shows the credit of one year claimed in the next.
CREATE TABLE IF NOT EXISTS gst_itc_claims (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id              BIGINT        NOT NULL,
  bill_id             BIGINT        NOT NULL,
  decision            ENUM('accept', 'defer', 'claim_later') NOT NULL,
  claim_period        VARCHAR(7)    NULL,
  note                VARCHAR(300)  NULL,
  decided_by_user_id  BIGINT        NULL,
  decided_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_gic_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  UNIQUE KEY uq_gic_bill (org_id, bill_id),
  KEY idx_gic_claim (org_id, claim_period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. The two payables the withholding roles post to, for every book that
--    exists (new books get them from the standard chart).
INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '2260', 'GST TDS Payable (section 51)', 'liability', 'tax',
       'GST deducted at 2% from payments to suppliers under contracts above ₹2.5 lakh; paid with GSTR-7', 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '2260');

INSERT INTO accounts (org_id, code, name, type, subtype, description, is_system, is_active)
SELECT o.id, '2270', 'GST TCS Payable (section 52)', 'liability', 'tax',
       'GST collected at source by an e-commerce operator on supplies made through it; paid with GSTR-8', 1, 1
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '2270');
