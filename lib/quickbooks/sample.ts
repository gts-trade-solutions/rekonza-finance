// ─────────────────────────────────────────────────────────────────────────────
// A small QuickBooks file to try the import with: an IIF file as QuickBooks
// Desktop exports one (File → Utilities → Export), with its chart of
// accounts, customers, vendors, items and a week of transactions for a
// spare-parts trader. Dates are this week's, written day first as QuickBooks
// India writes them, so they fall in an open period of any book.
// ─────────────────────────────────────────────────────────────────────────────

const ddmmyyyy = (today: string, back: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  const iso = d.toISOString().slice(0, 10);
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
};

export const QB_SAMPLE_CUSTOMER = 'Kaveri Motors';

/** The sample IIF file, dated around `today` (yyyy-mm-dd). */
export function quickBooksSampleIif(today: string): string {
  const d = (n: number) => ddmmyyyy(today, n);
  const rows: string[][] = [
    ['!ACCNT', 'NAME', 'ACCNTTYPE', 'DESC', 'ACCNUM', 'OBAMOUNT'],
    ['ACCNT', 'ICICI Current Account', 'BANK', 'Main operating account', '1010', '0'],
    ['ACCNT', 'Petty Cash', 'BANK', 'Shop cash', '1020', '0'],
    ['ACCNT', 'Accounts Receivable', 'AR', '', '1100', '0'],
    ['ACCNT', 'Accounts Payable', 'AP', '', '2000', '0'],
    ['ACCNT', 'Input CGST', 'OCASSET', 'GST paid on purchases', '1310', '0'],
    ['ACCNT', 'Input SGST', 'OCASSET', 'GST paid on purchases', '1320', '0'],
    ['ACCNT', 'Output CGST', 'OCLIAB', 'GST collected on sales', '2210', '0'],
    ['ACCNT', 'Output SGST', 'OCLIAB', 'GST collected on sales', '2220', '0'],
    ['ACCNT', 'Spare Parts Sales', 'INC', 'Sales of parts', '4010', '0'],
    ['ACCNT', 'Parts Purchased', 'COGS', 'Purchases for resale', '5010', '0'],
    ['ACCNT', 'Electricity Charges', 'EXP', '', '6110', '0'],
    ['ACCNT', 'Bank Charges', 'EXP', '', '6120', '0'],
    ['!CUST', 'NAME', 'BADDR1', 'BADDR2', 'PHONE1', 'EMAIL'],
    ['CUST', QB_SAMPLE_CUSTOMER, '14 Anna Salai', 'Chennai 600002', '9841055501', 'accounts@kaverimotors.example'],
    ['!VEND', 'NAME', 'ADDR1', 'ADDR2', 'PHONE1', 'EMAIL'],
    ['VEND', 'Sundaram Auto Components', '22 Industrial Estate', 'Hosur 635126', '9443022210', 'billing@sundaram.example'],
    ['!INVITEM', 'NAME', 'INVITEMTYPE', 'DESC', 'PRICE', 'COST', 'ACCNT'],
    ['INVITEM', 'Radiator Hose', 'INVENTORY', 'Radiator hose, universal', '450', '300', 'Spare Parts Sales'],
    ['INVITEM', 'Fitting Labour', 'SERV', 'Fitting, per hour', '600', '0', 'Spare Parts Sales'],
    ['!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'],
    ['!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'],
    ['!ENDTRNS'],
    ['TRNS', '101', 'BILL', d(6), 'Accounts Payable', 'Sundaram Auto Components', '-7080', 'SAC-778', 'Radiator hoses, 20 nos'],
    ['SPL', '1011', 'BILL', d(6), 'Parts Purchased', '', '6000', 'SAC-778', ''],
    ['SPL', '1012', 'BILL', d(6), 'Input CGST', '', '540', 'SAC-778', ''],
    ['SPL', '1013', 'BILL', d(6), 'Input SGST', '', '540', 'SAC-778', ''],
    ['ENDTRNS'],
    ['TRNS', '102', 'INVOICE', d(5), 'Accounts Receivable', QB_SAMPLE_CUSTOMER, '10620', 'KM-0091', 'Hoses and fitting'],
    ['SPL', '1021', 'INVOICE', d(5), 'Spare Parts Sales', '', '-9000', 'KM-0091', ''],
    ['SPL', '1022', 'INVOICE', d(5), 'Output CGST', '', '-810', 'KM-0091', ''],
    ['SPL', '1023', 'INVOICE', d(5), 'Output SGST', '', '-810', 'KM-0091', ''],
    ['ENDTRNS'],
    ['TRNS', '103', 'PAYMENT', d(3), 'ICICI Current Account', QB_SAMPLE_CUSTOMER, '10620', '', 'NEFT against KM-0091'],
    ['SPL', '1031', 'PAYMENT', d(3), 'Accounts Receivable', QB_SAMPLE_CUSTOMER, '-10620', '', ''],
    ['ENDTRNS'],
    ['TRNS', '104', 'BILLPMT', d(2), 'ICICI Current Account', 'Sundaram Auto Components', '-7080', '', 'Paid SAC-778'],
    ['SPL', '1041', 'BILLPMT', d(2), 'Accounts Payable', 'Sundaram Auto Components', '7080', '', ''],
    ['ENDTRNS'],
    ['TRNS', '105', 'CHECK', d(1), 'ICICI Current Account', 'TNEB', '-2350', '000412', 'Electricity for the month'],
    ['SPL', '1051', 'CHECK', d(1), 'Electricity Charges', 'TNEB', '2350', '000412', ''],
    ['ENDTRNS'],
    ['TRNS', '106', 'GENERAL JOURNAL', d(1), 'Bank Charges', '', '118', 'JE-7', 'Bank charges for the month'],
    ['SPL', '1061', 'GENERAL JOURNAL', d(1), 'ICICI Current Account', '', '-118', 'JE-7', ''],
    ['ENDTRNS'],
  ];
  return rows.map((r) => r.join('\t')).join('\r\n') + '\r\n';
}
