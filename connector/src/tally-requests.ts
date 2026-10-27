// ─────────────────────────────────────────────────────────────────────────────
// What the connector asks TallyPrime for.
//
// Tally answers XML posted to its data port. Each request here is a small
// report written in TDL — Tally's own language — that walks one collection
// (companies, groups, ledgers, stock items, voucher types, vouchers, or a
// voucher's ledger entries) and writes each object as a row of numbered tags:
// <F01>…</F01><F02>…</F02>, one F01 per row.
//
// The shape follows the approach the open-source tally-database-loader has
// run against real TallyPrime installations for years: amounts come back
// signed with debits negative, dates as YYYY-MM-DD, yes/no as 1/0, and an
// empty date as character 241 so it cannot be mistaken for a real one.
//
// Framework-neutral: nothing here touches the network or the portal.
// ─────────────────────────────────────────────────────────────────────────────

/** What an empty date is written as, so it cannot be confused with text. */
export const NULL_MARK = String.fromCharCode(241);

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-04-01" → "1-Apr-2026", the form Tally reads a period in. */
export function tdlDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}-${MONTHS[Number(m) - 1]}-${y}`;
}

/** TDL expressions that write a method's value in a form that parses without guessing. */
export const expr = {
  text: (m: string) => `$${m}`,
  /** A parent of "Primary" is no parent. */
  parent: () => 'if $$IsEqual:$Parent:$$SysName:Primary then "" else $Parent',
  logical: (m: string) => `if $${m} then 1 else 0`,
  date: (m: string) => `if $$IsEmpty:$${m} then $$StrByCharCode:241 else $$PyrlYYYYMMDDFormat:$${m}:"-"`,
  number: (m: string) => `if $$IsEmpty:$${m} then "0" else $$StringFindAndReplace:($$String:$${m}):"(-)":"-"`,
  /** Signed, debits negative — Tally's own convention. */
  amount: (m: string) => `$$StringFindAndReplace:(if $$IsDebit:$${m} then -$$NumValue:$${m} else $$NumValue:$${m}):"(-)":"-"`,
  /** Inward quantities positive; the unit is dropped. */
  quantity: (m: string) =>
    `$$StringFindAndReplace:(if $$IsInwards:$${m} then $$Number:$$String:$${m}:"TailUnits" else -$$Number:$$String:$${m}:"TailUnits"):"(-)":"-"`,
};

export interface ReportSpec {
  /** The report's name. The stand-in Tally recognises a request by it. */
  id: string;
  /** A collection, or a route into one — "Voucher.AllLedgerEntries". */
  collection: string;
  /** Names for the columns, in order: what each F-tag holds. */
  columns: readonly string[];
  /** One TDL expression per column. */
  fields: readonly string[];
  fetch?: readonly string[];
  filters?: readonly string[];
  company?: string;
  from?: string;
  to?: string;
}

const tag = (prefix: string, n: number) => `${prefix}${String(n).padStart(2, '0')}`;

/** The XML for one report: a collection walked, one line of numbered fields per object. */
export function reportRequest(spec: ReportSpec): string {
  if (spec.columns.length !== spec.fields.length) throw new Error(`${spec.id}: columns and fields differ in length.`);
  const statics = [
    '<SVEXPORTFORMAT>XML (Data Interchange)</SVEXPORTFORMAT>',
    spec.from ? `<SVFROMDATE>${tdlDate(spec.from)}</SVFROMDATE>` : '',
    spec.to ? `<SVTODATE>${tdlDate(spec.to)}</SVTODATE>` : '',
    spec.company ? `<SVCURRENTCOMPANY>${xmlEscape(spec.company)}</SVCURRENTCOMPANY>` : '',
  ].join('');

  // A route like Voucher.AllLedgerEntries becomes nested parts: the outer one
  // walks vouchers, the inner one walks each voucher's entries.
  const [base, ...inner] = spec.collection.split('.');
  const routes = ['RkCollection', ...inner];
  let parts = '';
  let lines = '';
  routes.forEach((route, i) => {
    parts += `<PART NAME="${tag('RkPart', i + 1)}"><LINES>${tag('RkLine', i + 1)}</LINES><REPEAT>${tag('RkLine', i + 1)} : ${route}</REPEAT><SCROLLED>Vertical</SCROLLED></PART>`;
    if (i < routes.length - 1) {
      lines += `<LINE NAME="${tag('RkLine', i + 1)}"><FIELDS>RkBlank</FIELDS><EXPLODE>${tag('RkPart', i + 2)}</EXPLODE></LINE>`;
    }
  });
  const fieldNames = spec.fields.map((_, i) => tag('RkFld', i + 1)).join(',');
  lines += `<LINE NAME="${tag('RkLine', routes.length)}"><FIELDS>${fieldNames}</FIELDS></LINE>`;
  const fields = spec.fields
    .map((f, i) => `<FIELD NAME="${tag('RkFld', i + 1)}"><SET>${xmlEscape(f)}</SET><XMLTAG>${tag('F', i + 1)}</XMLTAG></FIELD>`)
    .join('');

  const filterNames = (spec.filters ?? []).map((_, i) => tag('RkFilter', i + 1));
  const collection =
    `<COLLECTION NAME="RkCollection"><TYPE>${base}</TYPE>` +
    (spec.fetch?.length ? `<FETCH>${spec.fetch.join(',')}</FETCH>` : '') +
    (filterNames.length ? `<FILTER>${filterNames.join(',')}</FILTER>` : '') +
    '</COLLECTION>';
  const formulae = (spec.filters ?? [])
    .map((f, i) => `<SYSTEM TYPE="Formulae" NAME="${filterNames[i]}">${xmlEscape(f)}</SYSTEM>`)
    .join('');

  return (
    '<?xml version="1.0" encoding="utf-16"?>' +
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${spec.id}</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES>${statics}</STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<REPORT NAME="${spec.id}"><FORMS>RkForm</FORMS></REPORT><FORM NAME="RkForm"><PARTS>RkPart01</PARTS></FORM>` +
    parts +
    lines +
    fields +
    '<FIELD NAME="RkBlank"><SET>""</SET></FIELD>' +
    collection +
    formulae +
    '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  );
}

// ── The requests ─────────────────────────────────────────────────────────────

const spec = <C extends readonly string[]>(s: Omit<ReportSpec, 'columns'> & { columns: C }) => s;

export const requests = {
  /** The companies open in TallyPrime right now. */
  companies: () =>
    spec({
      id: 'RekonzaCompanies',
      collection: 'Company',
      columns: ['guid', 'name', 'booksFrom', 'startingFrom', 'altMstId', 'altVchId'] as const,
      fields: [expr.text('Guid'), expr.text('Name'), expr.date('BooksFrom'), expr.date('StartingFrom'), expr.number('AltMstId'), expr.number('AltVchId')],
    }),

  groups: (company: string) =>
    spec({
      id: 'RekonzaGroups',
      collection: 'Group',
      company,
      columns: ['guid', 'name', 'parent', 'isRevenue', 'isDeemedPositive', 'affectsGrossProfit'] as const,
      fields: [expr.text('Guid'), expr.text('Name'), expr.parent(), expr.logical('IsRevenue'), expr.logical('IsDeemedPositive'), expr.logical('AffectsGrossProfit')],
    }),

  /** Balances depend on the period: closing as at `to`, counted from `from`. */
  ledgers: (company: string, from: string, to: string) =>
    spec({
      id: 'RekonzaLedgers',
      collection: 'Ledger',
      company,
      from,
      to,
      columns: ['guid', 'name', 'parent', 'opening', 'closing', 'gstin', 'state'] as const,
      fields: [
        expr.text('Guid'),
        expr.text('Name'),
        expr.parent(),
        expr.amount('OpeningBalance'),
        expr.amount('ClosingBalance'),
        'if $$IsEmpty:$PartyGSTIN then $LedGSTRegDetails[Last].GSTIN else $PartyGSTIN',
        expr.text('LedStateName'),
      ],
    }),

  stockItems: (company: string, from: string, to: string) =>
    spec({
      id: 'RekonzaStockItems',
      collection: 'StockItem',
      company,
      from,
      to,
      fetch: ['GstDetails'],
      columns: ['guid', 'name', 'parent', 'unit', 'hsn', 'openingQty', 'openingValue', 'closingQty', 'closingValue'] as const,
      fields: [
        expr.text('Guid'),
        expr.text('Name'),
        expr.parent(),
        'if $$IsEqual:$BaseUnits:$$SysName:NotApplicable then "" else $BaseUnits',
        expr.text('InfGSTHSNCode'),
        expr.quantity('OpeningBalance'),
        expr.amount('OpeningValue'),
        expr.quantity('ClosingBalance'),
        expr.amount('ClosingValue'),
      ],
    }),

  voucherTypes: (company: string) =>
    spec({
      id: 'RekonzaVoucherTypes',
      collection: 'VoucherType',
      company,
      columns: ['name', 'parent'] as const,
      fields: [expr.text('Name'), expr.text('Parent')],
    }),

  /** Vouchers in a period changed since an AlterID. */
  vouchers: (company: string, from: string, to: string, afterAlterId: number) =>
    spec({
      id: 'RekonzaVouchers',
      collection: 'Voucher',
      company,
      from,
      to,
      fetch: ['Narration', 'PartyLedgerName', 'Reference'],
      filters: [`$AlterID > ${Math.max(0, Math.floor(afterAlterId))}`],
      columns: ['guid', 'alterId', 'type', 'date', 'number', 'party', 'narration', 'reference', 'cancelled', 'optional'] as const,
      fields: [
        expr.text('Guid'),
        expr.number('AlterID'),
        expr.text('VoucherTypeName'),
        expr.date('Date'),
        expr.text('VoucherNumber'),
        expr.text('PartyLedgerName'),
        expr.text('Narration'),
        expr.text('Reference'),
        expr.logical('IsCancelled'),
        expr.logical('IsOptional'),
      ],
    }),

  /** The ledger entries of the same vouchers, each tagged with its voucher's GUID. */
  entries: (company: string, from: string, to: string, afterAlterId: number) =>
    spec({
      id: 'RekonzaEntries',
      collection: 'Voucher.AllLedgerEntries',
      company,
      from,
      to,
      fetch: ['AllLedgerEntries'],
      filters: [`$AlterID > ${Math.max(0, Math.floor(afterAlterId))}`, '$$NumItems:AllLedgerEntries > 0'],
      columns: ['guid', 'ledger', 'amount'] as const,
      fields: [expr.text('Guid'), expr.text('LedgerName'), expr.amount('Amount')],
    }),

  /**
   * Every voucher GUID in a period, however old: what lets deletions in Tally
   * be noticed. The date comes too, because Tally does not always keep to the
   * period it was given — see the note on windows in the connector's sync.
   */
  voucherGuids: (company: string, from: string, to: string) =>
    spec({
      id: 'RekonzaVoucherGuids',
      collection: 'Voucher',
      company,
      from,
      to,
      columns: ['guid', 'date'] as const,
      fields: [expr.text('Guid'), expr.date('Date')],
    }),
};
