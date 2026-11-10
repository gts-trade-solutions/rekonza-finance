// ─────────────────────────────────────────────────────────────────────────────
// A small Tally file to try the import with, written the way TallyPrime
// exports one (data interchange XML): masters and a week of vouchers for an
// auto-parts trader.
//
// It is built in the browser with this week's dates, so its vouchers fall
// after any company's books start and inside an open period, whichever book
// it is tried on. It has a sales and a purchase invoice with stock lines, a
// receipt, a payment, a contra, a journal — and a cancelled voucher and a
// sales order, which the import rightly leaves out.
// ─────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (today: string, back: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};
/** Rupees as Tally writes them: a debit negative. */
const amt = (rupees: number, debit: boolean) => (debit ? -rupees : rupees).toFixed(2);

const ledger = (name: string, parent: string, extra = '') =>
  `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST>` +
  `<PARENT>${esc(parent)}</PARENT>${extra}<OPENINGBALANCE>0.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>`;

const entry = (name: string, rupees: number, debit: boolean) =>
  `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
  `<AMOUNT>${amt(rupees, debit)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;

/** A stock line, with the sales or purchase ledger it is allocated to inside it, as Tally writes an invoice. */
const stock = (item: string, qty: number, rate: number, ledgerName: string, debit: boolean) =>
  `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${esc(item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
  `<RATE>${rate.toFixed(2)}/Nos</RATE><AMOUNT>${amt(qty * rate, debit)}</AMOUNT><ACTUALQTY> ${qty} Nos</ACTUALQTY><BILLEDQTY> ${qty} Nos</BILLEDQTY>` +
  `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${esc(ledgerName)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
  `<AMOUNT>${amt(qty * rate, debit)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;

const voucher = (o: { guid: string; type: string; no: string; date: string; narration: string; party?: string; body: string; cancelled?: boolean }) =>
  `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${o.guid}" VCHTYPE="${esc(o.type)}" ACTION="Create">` +
  `<DATE>${o.date}</DATE><GUID>${o.guid}</GUID><VOUCHERTYPENAME>${esc(o.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(o.no)}</VOUCHERNUMBER>` +
  (o.party ? `<PARTYLEDGERNAME>${esc(o.party)}</PARTYLEDGERNAME>` : '') +
  `<NARRATION>${esc(o.narration)}</NARRATION><ISCANCELLED>${o.cancelled ? 'Yes' : 'No'}</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>` +
  `${o.body}</VOUCHER></TALLYMESSAGE>`;

export const SAMPLE_COMPANY = 'Sri Balaji Auto Parts (sample)';

/** The sample file, dated around `today` (yyyy-mm-dd). */
export function tallySampleXml(today: string): string {
  const C = 'Sri Murugan Auto Stores';
  const V = 'Annai Spares Distributors';
  const BANK = 'Canara Bank - Current A/c';
  const CASH = 'Cash';
  const id = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}-tally-sample`;
  const masters = [
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="Chennai Debtors" ACTION="Create"><NAME.LIST><NAME>Chennai Debtors</NAME></NAME.LIST><PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>`,
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHERTYPE NAME="GST Sales" ACTION="Create"><PARENT>Sales</PARENT></VOUCHERTYPE></TALLYMESSAGE>`,
    ledger(C, 'Chennai Debtors', '<LEDSTATENAME>Tamil Nadu</LEDSTATENAME><LEDGERPHONE>9840012345</LEDGERPHONE><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD><ISBILLWISEON>Yes</ISBILLWISEON>'),
    ledger(V, 'Sundry Creditors', '<LEDSTATENAME>Tamil Nadu</LEDSTATENAME><BILLCREDITPERIOD>45 Days</BILLCREDITPERIOD><ISBILLWISEON>Yes</ISBILLWISEON>'),
    ledger('Sales @ 18%', 'Sales Accounts'),
    ledger('Purchase @ 18%', 'Purchase Accounts'),
    ledger('CGST', 'Duties & Taxes', '<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>Central Tax</GSTDUTYHEAD>'),
    ledger('SGST', 'Duties & Taxes', '<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>State Tax</GSTDUTYHEAD>'),
    ledger(BANK, 'Bank Accounts'),
    ledger(CASH, 'Cash-in-Hand'),
    ledger('Shop Rent', 'Indirect Expenses'),
    ledger('Audit Fees', 'Indirect Expenses'),
    ledger('Audit Fees Payable', 'Current Liabilities'),
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="Clutch Plate Assembly" ACTION="Create"><BASEUNITS>Nos</BASEUNITS>` +
      `<GSTDETAILS.LIST><HSNCODE>87089300</HSNCODE><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>` +
      `<OPENINGBALANCE>0 Nos</OPENINGBALANCE><OPENINGVALUE>0.00</OPENINGVALUE></STOCKITEM></TALLYMESSAGE>`,
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="Brake Shoe Set" ACTION="Create"><BASEUNITS>Nos</BASEUNITS>` +
      `<GSTDETAILS.LIST><HSNCODE>87083000</HSNCODE><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>` +
      `<OPENINGBALANCE>0 Nos</OPENINGBALANCE><OPENINGVALUE>0.00</OPENINGVALUE></STOCKITEM></TALLYMESSAGE>`,
  ];
  const vouchers = [
    voucher({ guid: id(1), type: 'Purchase', no: 'AS/1187', date: day(today, 6), narration: 'Brake shoe sets, bill AS/1187', party: V,
      body: stock('Brake Shoe Set', 20, 250, 'Purchase @ 18%', true) + entry('CGST', 450, true) + entry('SGST', 450, true) + entry(V, 5900, false) }),
    voucher({ guid: id(2), type: 'GST Sales', no: 'SB/0042', date: day(today, 5), narration: 'Clutch plates to Sri Murugan', party: C,
      body: entry(C, 11800, true) + stock('Clutch Plate Assembly', 10, 1000, 'Sales @ 18%', false) + entry('CGST', 900, false) + entry('SGST', 900, false) }),
    voucher({ guid: id(3), type: 'Receipt', no: '17', date: day(today, 4), narration: 'NEFT from Sri Murugan against SB/0042', party: C,
      body: entry(BANK, 11800, true) + entry(C, 11800, false) }),
    voucher({ guid: id(4), type: 'Contra', no: '5', date: day(today, 3), narration: 'Cash withdrawn for the shop', body: entry(CASH, 5000, true) + entry(BANK, 5000, false) }),
    voucher({ guid: id(5), type: 'Payment', no: '31', date: day(today, 2), narration: 'Shop rent for the month', body: entry('Shop Rent', 4500, true) + entry(CASH, 4500, false) }),
    voucher({ guid: id(6), type: 'Payment', no: '32', date: day(today, 2), narration: 'Paid Annai Spares, bill AS/1187', party: V,
      body: entry(V, 5900, true) + entry(BANK, 5900, false) }),
    voucher({ guid: id(7), type: 'Journal', no: '9', date: day(today, 1), narration: 'Audit fee provided for the year', body: entry('Audit Fees', 2500, true) + entry('Audit Fees Payable', 2500, false) }),
    // Left out by the import: cancelled in Tally, and an order that posts nothing.
    voucher({ guid: id(8), type: 'GST Sales', no: 'SB/0043', date: day(today, 1), narration: 'Raised in error', party: C, cancelled: true,
      body: entry(C, 1180, true) + entry('Sales @ 18%', 1000, false) + entry('CGST', 90, false) + entry('SGST', 90, false) }),
    voucher({ guid: id(9), type: 'Sales Order', no: 'SO/12', date: day(today, 1), narration: 'Order for 5 clutch plates', party: C,
      body: stock('Clutch Plate Assembly', 5, 1000, 'Sales @ 18%', false) }),
  ];
  return (
    '<?xml version="1.0" encoding="utf-8"?>\r\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>' +
    `<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(SAMPLE_COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>\r\n${[...masters, ...vouchers].join('\r\n')}\r\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\r\n`
  );
}
