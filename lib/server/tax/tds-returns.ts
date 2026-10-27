import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// TDS and TCS: depositing what was deducted, and the quarterly return.
//
// Every rupee deducted from a supplier is owed by the 7th of the following
// month (30 April for March) and is paid by challan. Each quarter the return
// lists every deduction, deductee by deductee, against the challan that paid
// it; TRACES matches the two, and a deduction with no challan behind it is a
// default notice.
//
// The forms were renumbered by the Income-tax Rules, 2026. For deductions from
// 1 April 2026 the return is Form 140 for residents (earlier 26Q), Form 144
// for non-residents (27Q) and Form 143 for TCS (27EQ); before that, the old
// forms. Certificates to deductees (Form 131, earlier 16A) are issued from
// TRACES, not by the deductor's software, so they are not produced here; which
// are due and which were sent is tracked in tds-certificates.ts.
//
// The return is laid out as rows to file through the government's Return
// Preparation Utility or a filing service. Producing the FVU text file itself
// is not done here: its layout is published by Protean and changes with them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { badRequest } from '../http';
import { ACT_2025_FROM, sectionLabel } from '../../tax/statutory-rates';
import { tcsRates, tdsRates } from './rates';

export type Quarter = 1 | 2 | 3 | 4;

/** Q1 April–June … Q4 January–March of the financial year starting `fy`. */
export function quarterRange(fy: number, q: Quarter): { from: string; to: string; months: string[] } {
  const startMonth = 4 + (q - 1) * 3; // 4, 7, 10, 13
  const months = [0, 1, 2].map((i) => {
    const m = startMonth + i;
    const y = m > 12 ? fy + 1 : fy;
    return `${y}-${String(((m - 1) % 12) + 1).padStart(2, '0')}`;
  });
  const [ly, lm] = months[2].split('-').map(Number);
  const last = new Date(ly, lm, 0).getDate();
  return { from: `${months[0]}-01`, to: `${months[2]}-${String(last).padStart(2, '0')}`, months };
}

/** Deposit due: the 7th of the next month, but 30 April for March. */
export function depositDueDate(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (m === 3) return `${y}-04-30`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-07`;
}

/** Return due: 31 July, 31 October, 31 January, 31 May. */
export function returnDueDate(fy: number, q: Quarter): string {
  return ({ 1: `${fy}-07-31`, 2: `${fy}-10-31`, 3: `${fy + 1}-01-31`, 4: `${fy + 1}-05-31` } as const)[q];
}

export function formFor(kind: 'resident' | 'non_resident' | 'tcs', date: string): string {
  const now = date >= ACT_2025_FROM;
  if (kind === 'tcs') return now ? 'Form 143' : 'Form 27EQ';
  if (kind === 'non_resident') return now ? 'Form 144' : 'Form 27Q';
  return now ? 'Form 140' : 'Form 26Q';
}

export interface DeducteeRow {
  docId: string;
  docNumber: string;
  date: string;
  partyId: string;
  partyName: string;
  pan: string | null;
  section: string;
  sectionLabel: string;
  amountPaise: Paise;
  taxPaise: Paise;
  ratePct: number;
  month: string;
  /** The lower-deduction certificate the deduction was made under, if any. */
  lowerCertificateNo?: string | null;
  /**
   * The return's reason for a deduction at other than the normal rate:
   * A — lower or nil under a certificate; C — higher, for want of a working PAN.
   */
  remark?: 'A' | 'C' | null;
}

export interface MonthDeposit {
  month: string;
  deductedPaise: Paise;
  depositedPaise: Paise;
  dueDate: string;
  /** Days the last deposit for the month was late, if it was. */
  daysLate: number;
  status: 'paid' | 'short' | 'unpaid' | 'nothing_due';
  challans: { id: string; date: string; bsrCode: string; serial: string; taxPaise: Paise }[];
}

export interface QuarterReturn {
  fy: number;
  quarter: Quarter;
  from: string;
  to: string;
  tan: string | null;
  /** The deductor and the person responsible for deduction, as the return's header reports them. */
  deductor: {
    type: string | null;
    responsible: { name: string | null; designation: string | null; pan: string | null; mobile: string | null; email: string | null };
  };
  returnDueDate: string;
  forms: {
    form: string;
    kind: 'resident' | 'non_resident' | 'tcs';
    rows: DeducteeRow[];
    totalTaxPaise: Paise;
  }[];
  deposits: { tds: MonthDeposit[]; tcs: MonthDeposit[] };
  issues: { level: 'error' | 'warning'; message: string }[];
}

export async function quarterReturn(ex: Executor, orgId: number, fy: number, q: Quarter): Promise<QuarterReturn> {
  const range = quarterRange(fy, q);
  const [org, bills, invoices, challans, tds, tcs] = await Promise.all([
    ex.selectFrom('organizations')
      .select(['tan', 'deductor_type', 'tds_rp_name', 'tds_rp_designation', 'tds_rp_pan', 'tds_rp_mobile', 'tds_rp_email'])
      .where('id', '=', orgId).executeTakeFirst(),
    ex.selectFrom('bills as b').innerJoin('contacts as c', 'c.id', 'b.vendor_id')
      .leftJoin('tds_lower_certificates as lc', 'lc.id', 'b.tds_lower_cert_id')
      .select(['b.id', 'b.internal_no', 'b.vendor_invoice_no', 'b.bill_date', 'b.subtotal', 'b.tds_amount', 'b.tds_section',
        'c.id as party_id', 'c.display_name', 'c.pan', 'c.pan_status', 'c.gst_treatment', 'lc.certificate_no'])
      .where('b.org_id', '=', orgId).where('b.status', 'not in', ['draft', 'void'])
      // A nil-rate certificate still has to be reported, with its number.
      .where((eb) => eb.or([eb('b.tds_amount', '>', '0'), eb('b.tds_lower_cert_id', 'is not', null)]))
      .where('b.bill_date', '>=', range.from).where('b.bill_date', '<=', range.to)
      .orderBy('b.bill_date').execute(),
    ex.selectFrom('invoices as i').innerJoin('contacts as c', 'c.id', 'i.customer_id')
      .select(['i.id', 'i.number', 'i.invoice_date', 'i.subtotal', 'i.cgst', 'i.sgst', 'i.igst', 'i.cess', 'i.tcs', 'i.tcs_code',
        'c.id as party_id', 'c.display_name', 'c.pan'])
      .where('i.org_id', '=', orgId).where('i.status', 'not in', ['draft', 'void'])
      .where('i.tcs', '>', '0')
      .where('i.invoice_date', '>=', range.from).where('i.invoice_date', '<=', range.to)
      .orderBy('i.invoice_date').execute(),
    ex.selectFrom('tds_challans').selectAll()
      .where('org_id', '=', orgId).where('for_month', 'in', range.months).orderBy('challan_date').execute(),
    tdsRates(ex, orgId),
    tcsRates(ex, orgId),
  ]);

  const p = toPaiseFromSql;
  const labelFor = (rows: { code: string; actRef: string | null }[], code: string, date: string) => {
    const r = rows.find((x) => x.code === code);
    return r ? sectionLabel(r, date) : code;
  };

  const deductees: (DeducteeRow & { nonResident: boolean })[] = bills.map((b) => {
    const date = String(b.bill_date).slice(0, 10);
    const amount = p(b.subtotal);
    const tax = p(b.tds_amount);
    const section = b.tds_section ?? '—';
    return {
      docId: String(b.id),
      docNumber: `${b.internal_no} (${b.vendor_invoice_no})`,
      date,
      partyId: String(b.party_id),
      partyName: b.display_name,
      pan: b.pan,
      section,
      sectionLabel: labelFor(tds.rows, section, date),
      amountPaise: amount,
      taxPaise: tax,
      ratePct: amount > 0 ? Math.round((tax / amount) * 10_000) / 100 : 0,
      month: date.slice(0, 7),
      nonResident: b.gst_treatment === 'overseas',
      lowerCertificateNo: b.certificate_no ?? null,
      remark: b.certificate_no ? 'A' : !b.pan || b.pan_status === 'inoperative' ? 'C' : null,
    };
  });

  const collectees: DeducteeRow[] = invoices.map((i) => {
    const date = String(i.invoice_date).slice(0, 10);
    // TCS is collected on what the buyer pays before it.
    const amount = p(i.subtotal) + p(i.cgst) + p(i.sgst) + p(i.igst) + p(i.cess);
    const tax = p(i.tcs);
    const section = i.tcs_code ?? '—';
    return {
      docId: String(i.id),
      docNumber: i.number,
      date,
      partyId: String(i.party_id),
      partyName: i.display_name,
      pan: i.pan,
      section,
      sectionLabel: labelFor(tcs.rows, section, date),
      amountPaise: amount,
      taxPaise: tax,
      ratePct: amount > 0 ? Math.round((tax / amount) * 10_000) / 100 : 0,
      month: date.slice(0, 7),
    };
  });

  const deposits = (kind: 'tds' | 'tcs', rows: DeducteeRow[]): MonthDeposit[] =>
    range.months.map((month) => {
      const deducted = rows.filter((r) => r.month === month).reduce((t, r) => t + r.taxPaise, 0);
      const mine = challans.filter((c) => c.kind === kind && c.for_month === month);
      const deposited = mine.reduce((t, c) => t + p(c.tax), 0);
      const due = depositDueDate(month);
      const last = mine.length ? String(mine[mine.length - 1].challan_date).slice(0, 10) : null;
      const daysLate = last && last > due
        ? Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000)
        : 0;
      return {
        month,
        deductedPaise: deducted,
        depositedPaise: deposited,
        dueDate: due,
        daysLate,
        status: deducted === 0 ? 'nothing_due' : deposited >= deducted ? 'paid' : deposited > 0 ? 'short' : 'unpaid',
        challans: mine.map((c) => ({
          id: String(c.id),
          date: String(c.challan_date).slice(0, 10),
          bsrCode: c.bsr_code,
          serial: c.challan_serial,
          taxPaise: p(c.tax),
        })),
      };
    });

  const strip = (r: DeducteeRow & { nonResident: boolean }): DeducteeRow => {
    const copy: Partial<typeof r> = { ...r };
    delete copy.nonResident;
    return copy as DeducteeRow;
  };
  const residents = deductees.filter((d) => !d.nonResident).map(strip);
  const nonResidents = deductees.filter((d) => d.nonResident).map(strip);
  const sum = (rows: DeducteeRow[]) => rows.reduce((t, r) => t + r.taxPaise, 0);

  const forms: QuarterReturn['forms'] = [];
  if (residents.length) forms.push({ form: formFor('resident', range.from), kind: 'resident', rows: residents, totalTaxPaise: sum(residents) });
  if (nonResidents.length) forms.push({ form: formFor('non_resident', range.from), kind: 'non_resident', rows: nonResidents, totalTaxPaise: sum(nonResidents) });
  if (collectees.length) forms.push({ form: formFor('tcs', range.from), kind: 'tcs', rows: collectees, totalTaxPaise: sum(collectees) });

  const tdsDeposits = deposits('tds', [...residents, ...nonResidents]);
  const tcsDeposits = deposits('tcs', collectees);

  const issues: QuarterReturn['issues'] = [];
  if (!org?.tan) issues.push({ level: 'error', message: 'The book has no TAN. Every TDS return and challan is filed under it — add it in Settings.' });
  if (forms.length && !(org?.tds_rp_name && org?.tds_rp_pan && org?.tds_rp_designation)) {
    issues.push({ level: 'error', message: 'The person responsible for deduction is not filled in: name, designation and PAN are part of every return. Add them in Settings → Statutory.' });
  }
  if (forms.length && !org?.deductor_type) {
    issues.push({ level: 'warning', message: 'The deductor type (company, firm, individual…) is not set; the return asks for it. Settings → Statutory.' });
  }
  const noPan = [...deductees, ...collectees].filter((r) => !r.pan);
  if (noPan.length) {
    issues.push({ level: 'warning', message: `${noPan.length} deduction(s) are for parties with no PAN. They must be reported at the higher no-PAN rate.` });
  }
  const inoperative = deductees.filter((r) => r.pan && r.remark === 'C');
  if (inoperative.length) {
    issues.push({ level: 'warning', message: `${inoperative.length} deduction(s) are for PANs recorded as inoperative; they are reported with remark C, at the higher rate.` });
  }
  for (const d of [...tdsDeposits, ...tcsDeposits]) {
    if (d.status === 'unpaid' || d.status === 'short') {
      issues.push({ level: 'error', message: `${d.month}: ₹${((d.deductedPaise - d.depositedPaise) / 100).toLocaleString('en-IN')} deducted but not deposited (due ${d.dueDate}).` });
    } else if (d.daysLate > 0) {
      issues.push({ level: 'warning', message: `${d.month}: deposited ${d.daysLate} day(s) after the due date; interest is payable for the delay.` });
    }
  }

  return {
    fy, quarter: q, from: range.from, to: range.to,
    tan: org?.tan ?? null,
    deductor: {
      type: org?.deductor_type ?? null,
      responsible: {
        name: org?.tds_rp_name ?? null, designation: org?.tds_rp_designation ?? null, pan: org?.tds_rp_pan ?? null,
        mobile: org?.tds_rp_mobile ?? null, email: org?.tds_rp_email ?? null,
      },
    },
    returnDueDate: returnDueDate(fy, q),
    forms,
    deposits: { tds: tdsDeposits, tcs: tcsDeposits },
    issues,
  };
}

export interface ChallanInput {
  kind: 'tds' | 'tcs';
  forMonth: string;
  date: string;
  bsrCode: string;
  serial: string;
  taxPaise: Paise;
  interestPaise?: Paise;
  feePaise?: Paise;
  bankAccountId: number;
  notes?: string | null;
}

/**
 * Record a deposit and post it: the tax clears the payable it was held in,
 * interest and fees are a cost, and the bank pays the lot.
 */
export async function recordChallan(trx: Trx, orgId: number, userId: number | null, branchId: number, input: ChallanInput) {
  if (!/^\d{7}$/.test(input.bsrCode)) throw badRequest('A BSR code is the bank branch’s 7 digits, printed on the challan.');
  if (!/^\d{1,5}$/.test(input.serial)) throw badRequest('The challan serial number is up to 5 digits.');
  if (!/^\d{4}-\d{2}$/.test(input.forMonth)) throw badRequest('Say which month’s deductions this pays for, as yyyy-mm.');
  const interest = input.interestPaise ?? 0;
  const fee = input.feePaise ?? 0;
  const total = input.taxPaise + interest + fee;
  if (total <= 0) throw badRequest('A challan pays something.');

  const bank = await trx.selectFrom('bank_accounts').select(['id', 'ledger_account_id', 'name'])
    .where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw badRequest('That bank account does not exist.');

  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId, branchId, date: input.date, userId, module: 'banking',
    memo: `${input.kind.toUpperCase()} deposit for ${input.forMonth} — challan ${input.bsrCode}/${input.serial}`,
    sourceType: 'tds_challan',
    lines: [
      { accountId: requireAccount(acc, input.kind === 'tds' ? CODE.TDS_PAYABLE : CODE.TCS_PAYABLE), debit: input.taxPaise },
      { accountId: requireAccount(acc, CODE.TAX_INTEREST), debit: interest + fee },
      { accountId: bank.ledger_account_id, credit: total, description: `Paid from ${bank.name}` },
    ],
  });

  const inserted = await trx.insertInto('tds_challans').values({
    org_id: orgId, kind: input.kind, for_month: input.forMonth, challan_date: input.date,
    bsr_code: input.bsrCode, challan_serial: input.serial,
    tax: toSqlFromPaise(input.taxPaise), interest: toSqlFromPaise(interest), fee: toSqlFromPaise(fee),
    total: toSqlFromPaise(total), bank_account_id: bank.id, journal_entry_id: entry.id,
    notes: input.notes ?? null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow();

  return { id: Number(inserted.insertId), journalEntryId: entry.id, totalPaise: total };
}
