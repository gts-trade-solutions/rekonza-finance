// ─────────────────────────────────────────────────────────────────────────────
// A Tally company that does not exist, sent the way the connector would send a
// real one.
//
// An auto-parts trader in Chennai with Tally's own standard groups, parties in
// two states, GST on both sides, stock kept as items, and a financial year of
// vouchers: sales, purchases, receipts, payments, contras, a salary journal,
// plus one optional voucher, one cancelled voucher and a sales order — the
// cases a real day book always has.
//
// Everything is worked out the way Tally would: the openings balance once the
// opening stock is counted, every voucher balances, and each ledger's closing
// balance is its opening plus its vouchers. Deterministic, so the tests can
// check the reports against the same figures every run.
// ─────────────────────────────────────────────────────────────────────────────

import type { HelloMessage, MastersMessage, TallyVoucher, VoucherIndexMessage } from '../../lib/tally/protocol';

export const SAMPLE_COMPANY_GUID = 'sample-7d1c2e40-tally-kaveri-auto';
export const SAMPLE_COMPANY_NAME = 'Kaveri Auto Parts (Tally sample)';
export const SAMPLE_FY_FROM = '2026-04-01';

const R = (rupees: number) => Math.round(rupees * 100);

type Nature = 'assets' | 'liabilities' | 'income' | 'expenses';
const G = (name: string, parent: string | null, nature: Nature, affectsGrossProfit = false) => ({
  name, parent, nature, affectsGrossProfit, guid: `grp-${name}`,
});

/** Tally's predefined groups, with one of the company's own under Sundry Debtors. */
export const SAMPLE_GROUPS = [
  G('Branch / Divisions', null, 'liabilities'),
  G('Capital Account', null, 'liabilities'),
  G('Current Assets', null, 'assets'),
  G('Current Liabilities', null, 'liabilities'),
  G('Direct Expenses', null, 'expenses', true),
  G('Direct Incomes', null, 'income', true),
  G('Fixed Assets', null, 'assets'),
  G('Indirect Expenses', null, 'expenses'),
  G('Indirect Incomes', null, 'income'),
  G('Investments', null, 'assets'),
  G('Loans (Liability)', null, 'liabilities'),
  G('Misc. Expenses (ASSET)', null, 'assets'),
  G('Purchase Accounts', null, 'expenses', true),
  G('Sales Accounts', null, 'income', true),
  G('Suspense A/c', null, 'liabilities'),
  G('Bank Accounts', 'Current Assets', 'assets'),
  G('Bank OD A/c', 'Loans (Liability)', 'liabilities'),
  G('Cash-in-Hand', 'Current Assets', 'assets'),
  G('Deposits (Asset)', 'Current Assets', 'assets'),
  G('Duties & Taxes', 'Current Liabilities', 'liabilities'),
  G('Loans & Advances (Asset)', 'Current Assets', 'assets'),
  G('Provisions', 'Current Liabilities', 'liabilities'),
  G('Reserves & Surplus', 'Capital Account', 'liabilities'),
  G('Secured Loans', 'Loans (Liability)', 'liabilities'),
  G('Stock-in-Hand', 'Current Assets', 'assets'),
  G('Sundry Creditors', 'Current Liabilities', 'liabilities'),
  G('Sundry Debtors', 'Current Assets', 'assets'),
  G('Unsecured Loans', 'Loans (Liability)', 'liabilities'),
  G('Chennai Debtors', 'Sundry Debtors', 'assets'),
];

interface LedgerSeed {
  name: string;
  parent: string;
  opening: number;
  gstin?: string;
  stateName?: string;
}

/** Openings as at 1 April. Debits positive. With the opening stock they balance. */
const LEDGERS: LedgerSeed[] = [
  { name: 'Capital A/c', parent: 'Capital Account', opening: -R(920_000) },
  { name: 'Profit & Loss A/c', parent: 'Primary', opening: -R(120_000) },
  { name: 'Cash', parent: 'Cash-in-Hand', opening: R(60_000) },
  { name: 'HDFC Bank', parent: 'Bank Accounts', opening: R(450_000) },
  { name: 'Furniture & Fixtures', parent: 'Fixed Assets', opening: R(180_000) },
  { name: 'Computers', parent: 'Fixed Assets', opening: R(90_000) },
  { name: 'Security Deposit - Office', parent: 'Deposits (Asset)', opening: R(50_000) },
  { name: 'Apex Motors', parent: 'Chennai Debtors', opening: R(40_000), gstin: '33AAACA1111A1Z5', stateName: 'Tamil Nadu' },
  { name: 'Speedwell Garages', parent: 'Chennai Debtors', opening: R(25_000), gstin: '33AAACS2222B1Z5', stateName: 'Tamil Nadu' },
  { name: 'Velocity Auto Works', parent: 'Sundry Debtors', opening: 0, gstin: '33AAACV3333C1Z5', stateName: 'Tamil Nadu' },
  { name: 'Hosur Auto Agencies', parent: 'Sundry Debtors', opening: 0, gstin: '33AAACH4444D1Z5', stateName: 'Tamil Nadu' },
  { name: 'Deccan Wheels', parent: 'Sundry Debtors', opening: 0, gstin: '29AAACD5555E1Z5', stateName: 'Karnataka' },
  { name: 'Bosch Distributors', parent: 'Sundry Creditors', opening: -R(60_000), gstin: '33AAACB6666F1Z5', stateName: 'Tamil Nadu' },
  { name: 'Lakshmi Spares', parent: 'Sundry Creditors', opening: -R(35_000), gstin: '33AAACL7777G1Z5', stateName: 'Tamil Nadu' },
  { name: 'Kaveri Lubricants', parent: 'Sundry Creditors', opening: 0, gstin: '29AAACK8888H1Z5', stateName: 'Karnataka' },
  { name: 'Output CGST', parent: 'Duties & Taxes', opening: 0 },
  { name: 'Output SGST', parent: 'Duties & Taxes', opening: 0 },
  { name: 'Output IGST', parent: 'Duties & Taxes', opening: 0 },
  { name: 'Input CGST', parent: 'Duties & Taxes', opening: 0 },
  { name: 'Input SGST', parent: 'Duties & Taxes', opening: 0 },
  { name: 'Input IGST', parent: 'Duties & Taxes', opening: 0 },
  { name: 'Salary Payable', parent: 'Provisions', opening: 0 },
  { name: 'Sales - GST 18%', parent: 'Sales Accounts', opening: 0 },
  { name: 'Purchase - GST 18%', parent: 'Purchase Accounts', opening: 0 },
  { name: 'Freight Inward', parent: 'Direct Expenses', opening: 0 },
  { name: 'Rent', parent: 'Indirect Expenses', opening: 0 },
  { name: 'Salaries', parent: 'Indirect Expenses', opening: 0 },
  { name: 'Electricity', parent: 'Indirect Expenses', opening: 0 },
  { name: 'Bank Charges', parent: 'Indirect Expenses', opening: 0 },
  { name: 'Interest Received', parent: 'Indirect Incomes', opening: 0 },
];

const ITEMS = [
  { name: 'Brake Pad Set', parent: 'Brake Parts', unit: 'NOS', hsn: '870830', qty: 200, cost: 450 },
  { name: 'Clutch Plate', parent: 'Transmission', unit: 'NOS', hsn: '870893', qty: 100, cost: 900 },
  { name: 'Engine Oil 5L', parent: 'Lubricants', unit: 'NOS', hsn: '271019', qty: 60, cost: 1_000 },
];

const DEBTORS = ['Apex Motors', 'Speedwell Garages', 'Velocity Auto Works', 'Hosur Auto Agencies', 'Deccan Wheels'];
const CREDITORS = ['Bosch Distributors', 'Lakshmi Spares', 'Kaveri Lubricants'];
const INTER_STATE = new Set(['Deccan Wheels', 'Kaveri Lubricants']);

/** A small seeded generator, so every run makes the same company. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface SampleCompany {
  hello: HelloMessage;
  masters: MastersMessage;
  vouchers: TallyVoucher[];
  index: VoucherIndexMessage;
  /** Worked out alongside, for the tests to check the reports against. */
  expected: {
    openingStockPaise: number;
    closingStockPaise: number;
    closing: Map<string, number>;
    netProfitPaise: number;
  };
}

export function sampleCompany(asOf: string): SampleCompany {
  const random = rng(20260401);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const balance = new Map(LEDGERS.map((l) => [l.name, l.opening]));
  const stock = new Map(ITEMS.map((i) => [i.name, i.qty]));
  const vouchers: TallyVoucher[] = [];
  const counters = new Map<string, number>();
  let alterId = 0;

  const add = (
    date: string,
    baseType: string,
    entries: { ledger: string; debitPaise: number; creditPaise: number }[],
    extra: Partial<TallyVoucher> = {},
  ) => {
    const n = (counters.get(baseType) ?? 0) + 1;
    counters.set(baseType, n);
    const prefix = { Sales: 'KAP', Purchase: 'PUR', Receipt: 'RCT', Payment: 'PMT', Contra: 'CON', Journal: 'JRN' }[baseType] ?? 'ORD';
    alterId += 1;
    const v: TallyVoucher = {
      guid: `${SAMPLE_COMPANY_GUID}-vch-${alterId}`,
      alterId,
      voucherType: baseType,
      baseType,
      number: `${prefix}/26-27/${String(n).padStart(4, '0')}`,
      date,
      party: null,
      narration: null,
      reference: null,
      isCancelled: false,
      isOptional: false,
      entries,
      ...extra,
    };
    vouchers.push(v);
    if (!v.isCancelled && !v.isOptional) {
      for (const e of v.entries) balance.set(e.ledger, (balance.get(e.ledger) ?? 0) + e.debitPaise - e.creditPaise);
    }
    return v;
  };
  const dr = (ledger: string, paise: number) => ({ ledger, debitPaise: paise, creditPaise: 0 });
  const cr = (ledger: string, paise: number) => ({ ledger, debitPaise: 0, creditPaise: paise });

  const tax = (party: string, taxable: number, side: 'out' | 'in') => {
    const pre = side === 'out' ? 'Output' : 'Input';
    if (INTER_STATE.has(party)) return [{ ledger: `${pre} IGST`, paise: Math.round(taxable * 0.18) }];
    const half = Math.round(taxable * 0.09);
    return [
      { ledger: `${pre} CGST`, paise: half },
      { ledger: `${pre} SGST`, paise: half },
    ];
  };

  for (let date = SAMPLE_FY_FROM; date <= asOf; date = addDays(date, 1)) {
    const dom = Number(date.slice(8, 10));
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const working = weekday !== 0;

    if (dom === 1) {
      add(date, 'Payment', [dr('Rent', R(25_000)), cr('HDFC Bank', R(25_000))], { narration: 'Office and godown rent' });
      const salary = balance.get('Salary Payable') ?? 0;
      if (salary < 0) {
        add(date, 'Payment', [dr('Salary Payable', -salary), cr('HDFC Bank', -salary)], { narration: 'Salaries paid' });
      }
    }
    if (dom === 5) {
      const bill = R(6_000 + Math.floor(random() * 3_000));
      add(date, 'Payment', [dr('Electricity', bill), cr('Cash', bill)], { narration: 'TANGEDCO bill' });
    }
    if (dom === 10) add(date, 'Contra', [dr('Cash', R(30_000)), cr('HDFC Bank', R(30_000))], { narration: 'Cash withdrawn' });
    if (dom === 25) add(date, 'Contra', [dr('HDFC Bank', R(20_000)), cr('Cash', R(20_000))], { narration: 'Cash deposited' });
    if (dom === 28) {
      add(date, 'Journal', [dr('Salaries', R(60_000)), cr('Salary Payable', R(60_000))], { narration: 'Salaries for the month' });
      add(date, 'Payment', [dr('Bank Charges', R(590)), cr('HDFC Bank', R(590))], { narration: 'Account maintenance' });
    }
    if ((date.slice(5) === '06-30' || date.slice(5) === '09-15') && date <= asOf) {
      add(date, 'Receipt', [dr('HDFC Bank', R(4_500)), cr('Interest Received', R(4_500))], { narration: 'FD interest' });
    }

    if (working && random() < 0.85) {
      const party = pick(DEBTORS);
      const item = pick(ITEMS);
      const qty = Math.min(10 + Math.floor(random() * 36), stock.get(item.name) ?? 0);
      if (qty > 0) {
        stock.set(item.name, (stock.get(item.name) ?? 0) - qty);
        const taxable = R(qty * Math.round(item.cost * 1.6));
        const taxes = tax(party, taxable, 'out');
        const total = taxable + taxes.reduce((t, x) => t + x.paise, 0);
        add(date, 'Sales', [dr(party, total), cr('Sales - GST 18%', taxable), ...taxes.map((x) => cr(x.ledger, x.paise))], {
          party,
          narration: `${qty} × ${item.name}`,
        });
      }
    }

    if (working && random() < 0.14 && (stock.get(pick(ITEMS).name) ?? 0) < 400) {
      const party = pick(CREDITORS);
      const item = pick(ITEMS);
      const qty = 40 + Math.floor(random() * 90);
      stock.set(item.name, (stock.get(item.name) ?? 0) + qty);
      const taxable = R(qty * item.cost);
      const taxes = tax(party, taxable, 'in');
      const total = taxable + taxes.reduce((t, x) => t + x.paise, 0);
      add(date, 'Purchase', [dr('Purchase - GST 18%', taxable), ...taxes.map((x) => dr(x.ledger, x.paise)), cr(party, total)], {
        party,
        narration: `${qty} × ${item.name}`,
        reference: `INV-${Math.floor(random() * 90_000) + 10_000}`,
      });
      add(date, 'Payment', [dr('Freight Inward', R(1_500)), cr('Cash', R(1_500))], { narration: 'Transport charges' });
    }

    if (working && random() < 0.4) {
      const party = pick(DEBTORS);
      const owed = balance.get(party) ?? 0;
      if (owed > R(5_000)) {
        const amount = Math.round(owed * (0.4 + random() * 0.6));
        add(date, 'Receipt', [dr('HDFC Bank', amount), cr(party, amount)], { party, narration: 'NEFT received' });
      }
    }

    if (working && random() < 0.12) {
      const party = pick(CREDITORS);
      const owe = -(balance.get(party) ?? 0);
      // Never more than the bank can spare: a trader pays suppliers from what came in.
      const spare = (balance.get('HDFC Bank') ?? 0) - R(75_000);
      if (owe > R(5_000) && spare > R(5_000)) {
        const amount = Math.min(spare, Math.round(owe * (0.5 + random() * 0.5)));
        add(date, 'Payment', [dr(party, amount), cr('HDFC Bank', amount)], { party, narration: 'RTGS paid' });
      }
    }
  }

  // The cases every real day book has. None of them moves a balance.
  const aSale = vouchers.find((v) => v.baseType === 'Sales');
  if (aSale) {
    add(aSale.date, 'Sales', [dr('Apex Motors', R(11_800)), cr('Sales - GST 18%', R(10_000)), cr('Output CGST', R(900)), cr('Output SGST', R(900))], {
      party: 'Apex Motors',
      narration: 'Quotation held as an optional voucher',
      isOptional: true,
    });
    add(aSale.date, 'Sales', [], { party: 'Speedwell Garages', narration: 'Raised in error', isCancelled: true });
    add(aSale.date, 'Sales Order', [], { party: 'Velocity Auto Works', narration: '50 × Brake Pad Set, to deliver next week' });
  }

  const openingStock = ITEMS.reduce((t, i) => t + R(i.qty * i.cost), 0);
  const closingStock = ITEMS.reduce((t, i) => t + R((stock.get(i.name) ?? 0) * i.cost), 0);
  const revenueParents = new Set(['Sales Accounts', 'Purchase Accounts', 'Direct Expenses', 'Indirect Expenses', 'Indirect Incomes']);
  const revenueTotal = LEDGERS.filter((l) => revenueParents.has(l.parent)).reduce((t, l) => t + (balance.get(l.name) ?? 0), 0);

  return {
    hello: {
      kind: 'hello',
      protocol: 1,
      machineName: 'ACCOUNTS-PC (simulated)',
      connectorVersion: '0.1.0-sim',
      tallyVersion: 'TallyPrime 5.1 (simulated)',
      companies: [
        {
          guid: SAMPLE_COMPANY_GUID,
          name: SAMPLE_COMPANY_NAME,
          booksFrom: '2024-04-01',
          fyFrom: SAMPLE_FY_FROM,
          gstin: '33AAACK9999J1Z5',
          stateName: 'Tamil Nadu',
          maintainsInventory: true,
        },
      ],
    },
    masters: {
      kind: 'masters',
      companyGuid: SAMPLE_COMPANY_GUID,
      asOf,
      masterAlterId: 500,
      full: true,
      groups: SAMPLE_GROUPS,
      ledgers: LEDGERS.map((l) => ({
        name: l.name,
        parent: l.parent,
        openingPaise: l.opening,
        closingPaise: balance.get(l.name) ?? 0,
        gstin: l.gstin ?? null,
        stateName: l.stateName ?? null,
        guid: `led-${l.name}`,
      })),
      stockItems: ITEMS.map((i) => ({
        name: i.name,
        parent: i.parent,
        unit: i.unit,
        hsn: i.hsn,
        openingQty: i.qty,
        openingValuePaise: R(i.qty * i.cost),
        closingQty: stock.get(i.name) ?? 0,
        closingValuePaise: R((stock.get(i.name) ?? 0) * i.cost),
        guid: `stk-${i.name}`,
      })),
    },
    vouchers,
    index: { kind: 'voucher-index', companyGuid: SAMPLE_COMPANY_GUID, from: SAMPLE_FY_FROM, to: asOf, guids: vouchers.map((v) => v.guid) },
    expected: {
      openingStockPaise: openingStock,
      closingStockPaise: closingStock,
      closing: balance,
      netProfitPaise: -revenueTotal + closingStock - openingStock,
    },
  };
}
