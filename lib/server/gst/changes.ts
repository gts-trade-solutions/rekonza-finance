import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Edit and Delete on what is entered or posted from the GST & Taxes screens
// (the client, 2026-11-25: "wherever we need edit and delete you should give"):
// TDS and TCS challans, the certificates around the TDS return, goods back from
// job work, the ITC reversals of Rules 37, 42 and 43, the composition tax booked
// for a CMP-08, and a month's GSTR-2B brought in.
//
// The rules are the book's own:
//
//   - A posting is never erased. Deleting one reverses its entry on its own
//     date, and a numbered record (a challan) is kept in deleted_documents; an
//     edit reverses and posts again on the same record (services/doc-delete.ts).
//   - A challan's payment matched to a bank statement line is unmatched in
//     Banking first, as for any payment.
//   - What something else leans on stays: a lower-deduction certificate bills
//     were deducted under is withdrawn, not deleted, and its rate is fixed; a
//     Rule 37 reversal stays while credit has been taken back against it; a
//     month's Rule 42 reversal stays while the year's true-up counts it.
//   - The returns themselves (GSTR-1, 3B, 9, 9C, IFF, ITC-04, CMP-08, GSTR-4)
//     are worked out from the documents each time; they are corrected by
//     correcting the documents, so there is nothing of theirs to edit here.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { bankLineMatched, plain, recordDeletion, reverseForChange, unlinkDocument } from '../services/doc-delete';
import { jobWorkLines } from '../services/job-work';
import { usedUnder } from '../tax/tds-certificates';
import { monthLabel } from '../../date-range';

const p = toPaiseFromSql;
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const because = (reason?: string | null) => (reason?.trim() ? ` — ${reason.trim()}` : '');
const BANK_MATCHED = 'is matched to a line of the bank statement. Undo that match in Banking first, then change it here.';

// ── TDS and TCS challans ─────────────────────────────────────────────────────

export interface ChallanChange {
  kind: 'tds' | 'tcs'; forMonth: string; date: string; bsrCode: string; serial: string;
  taxPaise: Paise; interestPaise?: Paise; feePaise?: Paise; bankAccountId: number; notes?: string | null;
}

async function lockedChallan(trx: Trx, orgId: number, id: number) {
  const c = await trx.selectFrom('tds_challans').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That challan was not found.');
  if (c.journal_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', c.journal_entry_id)) {
    throw conflict(`Challan ${c.bsr_code}/${c.challan_serial} ${BANK_MATCHED}`);
  }
  return c;
}

/**
 * Correct a challan: its entry is reversed and the deposit posted again as it
 * is now, on the same record, so the quarter's return reads the corrected
 * figures and serial.
 */
export async function updateChallan(trx: Trx, orgId: number, userId: number | null, id: number, input: ChallanChange) {
  const c = await lockedChallan(trx, orgId, id);
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
  const old = c.journal_entry_id
    ? await trx.selectFrom('journal_entries').select('branch_id').where('id', '=', c.journal_entry_id).executeTakeFirst()
    : null;
  const branchId = old?.branch_id
    ?? (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;

  await reverseForChange(trx, orgId, c.journal_entry_id, { memo: `Challan ${c.bsr_code}/${c.challan_serial} changed`, userId, module: 'banking' });
  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId, branchId, date: input.date, userId, module: 'banking',
    memo: `${input.kind.toUpperCase()} deposit for ${monthLabel(input.forMonth)} — challan ${input.bsrCode}/${input.serial}`,
    sourceType: 'tds_challan', sourceId: id,
    lines: [
      { accountId: requireAccount(acc, input.kind === 'tds' ? CODE.TDS_PAYABLE : CODE.TCS_PAYABLE), debit: input.taxPaise },
      { accountId: requireAccount(acc, CODE.TAX_INTEREST), debit: interest + fee },
      { accountId: bank.ledger_account_id, credit: total, description: `Paid from ${bank.name}` },
    ],
  });
  await trx.updateTable('tds_challans').set({
    kind: input.kind, for_month: input.forMonth, challan_date: input.date, bsr_code: input.bsrCode, challan_serial: input.serial,
    tax: toSqlFromPaise(input.taxPaise), interest: toSqlFromPaise(interest), fee: toSqlFromPaise(fee), total: toSqlFromPaise(total),
    bank_account_id: bank.id, journal_entry_id: entry.id, notes: input.notes ?? null,
  }).where('id', '=', id).execute();
  return { totalPaise: total, journalEntryId: entry.id };
}

/** Delete a challan entered in error: its entry is reversed and it is kept in deleted_documents. */
export async function deleteChallan(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const c = await lockedChallan(trx, orgId, id);
  const label = `${c.bsr_code}/${c.challan_serial}`;
  const reversal = await reverseForChange(trx, orgId, c.journal_entry_id, { memo: `Challan ${label} deleted${because(reason)}`, userId, module: 'banking' });
  await recordDeletion(trx, {
    orgId, userId, docType: 'tds_challan', docId: id, number: label, date: day(c.challan_date), totalPaise: p(c.total),
    journalEntryId: c.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(c),
  });
  await unlinkDocument(trx, orgId, 'tds_challan', id);
  await trx.deleteFrom('tds_challans').where('id', '=', id).execute();
  return { label, kind: c.kind };
}

// ── Certificates (Form 131 / 16A) ────────────────────────────────────────────

/** Correct a certificate's number, date, tax or note. */
export async function updateCertificate(trx: Trx, orgId: number, id: number, input: {
  certificateNo: string; issuedOn: string; taxPaise: Paise; notes?: string | null;
}) {
  const c = await trx.selectFrom('tds_certificates').select(['id']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That certificate was not found.');
  const no = input.certificateNo.trim().toUpperCase();
  if (!/^[A-Z0-9/-]{4,30}$/.test(no)) throw badRequest('Give the certificate number as printed on it.');
  if (!(input.taxPaise >= 0)) throw badRequest('Give the tax the certificate covers.');
  await trx.updateTable('tds_certificates').set({ certificate_no: no, issued_on: input.issuedOn, tax: toSqlFromPaise(input.taxPaise), notes: input.notes ?? null })
    .where('id', '=', id).execute();
  return { certificateNo: no };
}

/** Delete a certificate recorded in error. Its PDF stays in Documents, unattached. */
export async function deleteCertificate(trx: Trx, orgId: number, id: number) {
  const c = await trx.selectFrom('tds_certificates').select(['certificate_no']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That certificate was not found.');
  await unlinkDocument(trx, orgId, 'tds_certificate', id);
  await trx.deleteFrom('tds_certificates').where('id', '=', id).execute();
  return { certificateNo: c.certificate_no };
}

// ── Lower-deduction certificates ─────────────────────────────────────────────

/**
 * Correct a lower-deduction certificate. Until a bill is deducted under it,
 * everything can change. After, the vendor, section and rate are fixed —
 * those bills were deducted at that rate and the return reports them so — and
 * its limit cannot fall below what has been used; its number (a typing slip),
 * dates and notes can still be put right.
 */
export async function updateLowerCertificate(trx: Trx, orgId: number, id: number, input: {
  contactId: number; sectionCode: string; certificateNo: string; ratePct: number; validFrom: string; validTo: string;
  limitPaise?: Paise | null; notes?: string | null;
}) {
  const c = await trx.selectFrom('tds_lower_certificates').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That certificate is not on file.');
  if (c.is_cancelled) throw conflict('It was withdrawn. Add the certificate again if it is still good.');
  const no = input.certificateNo.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(no)) throw badRequest('A certificate number is 6 to 20 letters and digits, as printed on it.');
  if (input.validTo < input.validFrom) throw badRequest('The certificate cannot end before it starts.');
  if (!(input.ratePct >= 0 && input.ratePct <= 100)) throw badRequest('Give the rate on the certificate, 0 to 100.');
  if (input.limitPaise != null && input.limitPaise <= 0) throw badRequest('Leave the limit empty if the certificate names none.');
  const used = await usedUnder(trx, id);
  const bills = Number((await trx.selectFrom('bills').select(sql<string>`COUNT(*)`.as('n')).where('tds_lower_cert_id', '=', id).executeTakeFirst())?.n ?? 0);
  if (bills > 0) {
    if (input.contactId !== c.contact_id || input.sectionCode !== c.section_code || input.ratePct !== Number(c.rate_pct)) {
      throw conflict(`${bills} bill(s) were deducted under it at ${Number(c.rate_pct)}%, so its vendor, section and rate stay. Withdraw it and add the right one for later bills.`);
    }
    if (input.limitPaise != null && input.limitPaise < used) throw badRequest(`₹${(used / 100).toLocaleString('en-IN')} has been used under it; the limit cannot be less.`);
  }
  const overlap = await trx.selectFrom('tds_lower_certificates').select('certificate_no')
    .where('org_id', '=', orgId).where('contact_id', '=', input.contactId).where('section_code', '=', input.sectionCode)
    .where('is_cancelled', '=', 0).where('id', '<>', id).where('valid_from', '<=', input.validTo).where('valid_to', '>=', input.validFrom)
    .executeTakeFirst();
  if (overlap) throw conflict(`Certificate ${overlap.certificate_no} already covers part of that period for ${input.sectionCode}.`);
  await trx.updateTable('tds_lower_certificates').set({
    contact_id: input.contactId, section_code: input.sectionCode, certificate_no: no, rate_pct: String(input.ratePct),
    valid_from: input.validFrom, valid_to: input.validTo, amount_limit: input.limitPaise == null ? null : toSqlFromPaise(input.limitPaise),
    notes: input.notes ?? null,
  }).where('id', '=', id).execute();
  return { certificateNo: no };
}

/** Delete one no bill has used; one that has been used is withdrawn instead. */
export async function deleteLowerCertificate(trx: Trx, orgId: number, id: number) {
  const c = await trx.selectFrom('tds_lower_certificates').select(['certificate_no']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That certificate is not on file.');
  const bills = Number((await trx.selectFrom('bills').select(sql<string>`COUNT(*)`.as('n')).where('tds_lower_cert_id', '=', id).executeTakeFirst())?.n ?? 0);
  if (bills > 0) {
    throw conflict(`${bills} bill(s) were deducted under ${c.certificate_no}, and the return reports it against them, so it cannot be deleted. Withdraw it instead: later bills are deducted at the normal rate.`);
  }
  await trx.deleteFrom('tds_lower_certificates').where('id', '=', id).execute();
  return { certificateNo: c.certificate_no };
}

// ── Job work: goods back ─────────────────────────────────────────────────────

/** Each receipt of goods back from a job worker, with what came back on each challan line. */
export async function jobWorkReceipts(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('job_work_receipts as r').innerJoin('delivery_challans as d', 'd.id', 'r.challan_id')
    .select(['r.id', 'r.challan_id', 'd.number', 'r.received_date', 'r.job_worker_challan_no', 'r.job_worker_challan_date', 'r.nature_of_job', 'r.notes'])
    .where('r.org_id', '=', orgId).orderBy('r.received_date', 'desc').orderBy('r.id', 'desc').limit(500).execute();
  const lines = rows.length
    ? await ex.selectFrom('job_work_receipt_lines').select(['receipt_id', 'challan_line_id', 'qty_received', 'qty_waste'])
      .where('receipt_id', 'in', rows.map((r) => r.id)).execute()
    : [];
  return rows.map((r) => ({
    id: String(r.id), challanId: String(r.challan_id), challanNumber: r.number, date: day(r.received_date)!,
    jobWorkerChallanNo: r.job_worker_challan_no, jobWorkerChallanDate: day(r.job_worker_challan_date), natureOfJob: r.nature_of_job, notes: r.notes,
    lines: lines.filter((l) => l.receipt_id === r.id).map((l) => ({
      challanLineId: String(l.challan_line_id), qtyReceived: Number(l.qty_received), qtyWaste: Number(l.qty_waste),
    })),
  }));
}

/** After a receipt changes, the challan is returned only while nothing is still out. */
async function settleChallanStatus(trx: Trx, orgId: number, challanId: number) {
  const open = await jobWorkLines(trx, orgId, challanId);
  const challan = await trx.selectFrom('delivery_challans').select('status').where('id', '=', challanId).executeTakeFirst();
  const allBack = open.length > 0 && open.every((l) => l.outstanding <= 0);
  if (allBack && challan?.status !== 'returned') {
    await trx.updateTable('delivery_challans').set({ status: 'returned' }).where('id', '=', challanId).execute();
  } else if (!allBack && challan?.status === 'returned') {
    await trx.updateTable('delivery_challans').set({ status: 'open' }).where('id', '=', challanId).execute();
  }
}

/**
 * Correct a receipt of goods back: its date, the job worker's challan and the
 * quantities, within what was sent less what other receipts brought back.
 */
export async function updateJobWorkReceipt(trx: Trx, orgId: number, id: number, input: {
  date: string; jobWorkerChallanNo?: string | null; jobWorkerChallanDate?: string | null; natureOfJob?: string | null; notes?: string | null;
  lines: { challanLineId: number; qtyReceived: number; qtyWaste?: number }[];
}) {
  const r = await trx.selectFrom('job_work_receipts as r').innerJoin('delivery_challans as d', 'd.id', 'r.challan_id')
    .select(['r.id', 'r.challan_id', 'd.challan_date', 'd.status']).where('r.id', '=', id).where('r.org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That receipt was not found.');
  if (r.status === 'cancelled') throw conflict('Its challan is cancelled.');
  if (input.date < day(r.challan_date)!) throw badRequest('Goods cannot come back before they went.');
  const lines = input.lines.filter((l) => l.qtyReceived > 0 || (l.qtyWaste ?? 0) > 0);
  if (!lines.length) throw badRequest('Enter what came back, or what was wasted. To take the receipt off, delete it.');
  // What is out leaving this receipt aside: its own quantities come back first.
  const own = await trx.selectFrom('job_work_receipt_lines').select(['challan_line_id', 'qty_received', 'qty_waste']).where('receipt_id', '=', id).execute();
  const open = await jobWorkLines(trx, orgId, r.challan_id);
  for (const l of lines) {
    const o = open.find((x) => x.lineId === String(l.challanLineId));
    if (!o) throw notFound('One of the lines is not on that challan.');
    if (l.qtyReceived < 0 || (l.qtyWaste ?? 0) < 0) throw badRequest('Quantities cannot be negative.');
    const mine = own.filter((x) => x.challan_line_id === l.challanLineId).reduce((t, x) => t + Number(x.qty_received) + Number(x.qty_waste), 0);
    if (l.qtyReceived + (l.qtyWaste ?? 0) > o.outstanding + mine + 1e-9) {
      throw badRequest(`Only ${o.outstanding + mine} of ${o.description ?? 'that line'} was with the job worker.`);
    }
  }
  await trx.updateTable('job_work_receipts').set({
    received_date: input.date, job_worker_challan_no: input.jobWorkerChallanNo ?? null, job_worker_challan_date: input.jobWorkerChallanDate ?? null,
    nature_of_job: input.natureOfJob ?? null, notes: input.notes ?? null,
  }).where('id', '=', id).execute();
  await trx.deleteFrom('job_work_receipt_lines').where('receipt_id', '=', id).execute();
  await trx.insertInto('job_work_receipt_lines').values(lines.map((l) => ({
    receipt_id: id, challan_line_id: l.challanLineId, qty_received: String(l.qtyReceived), qty_waste: String(l.qtyWaste ?? 0),
  }))).execute();
  await settleChallanStatus(trx, orgId, r.challan_id);
  return { challanId: r.challan_id };
}

/** Delete a receipt entered in error: the goods count as still with the job worker. */
export async function deleteJobWorkReceipt(trx: Trx, orgId: number, id: number) {
  const r = await trx.selectFrom('job_work_receipts').select(['id', 'challan_id', 'job_worker_challan_no']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!r) throw notFound('That receipt was not found.');
  await unlinkDocument(trx, orgId, 'job_work_receipt', id);
  await trx.deleteFrom('job_work_receipts').where('id', '=', id).execute();
  await settleChallanStatus(trx, orgId, r.challan_id);
  return { label: r.job_worker_challan_no ?? `receipt ${id}` };
}

// ── ITC reversals (Rules 37, 42, 43) ─────────────────────────────────────────

/** What has been posted, month by month, so each can be undone. */
export async function postedItcReversals(ex: Executor, orgId: number) {
  const rev = await ex.selectFrom('itc_reversals')
    .select(['rule', 'period', sql<string>`SUM(cgst + sgst + igst + cess)`.as('amount'), sql<number>`COUNT(*)`.as('n'),
      sql<string>`SUM(reclaimed_cgst + reclaimed_sgst + reclaimed_igst + reclaimed_cess)`.as('reclaimed')])
    .where('org_id', '=', orgId).groupBy(['rule', 'period']).orderBy('period', 'desc').execute();
  const reclaims = await ex.selectFrom('itc_reclaims as c').leftJoin('itc_reclaim_lines as l', 'l.reclaim_id', 'c.id')
    .select(['c.period', sql<string>`COALESCE(SUM(l.cgst + l.sgst + l.igst + l.cess), 0)`.as('amount'), sql<number>`COUNT(DISTINCT c.id)`.as('n')])
    .where('c.org_id', '=', orgId).groupBy('c.period').orderBy('c.period', 'desc').execute();
  return {
    rule37: rev.filter((r) => r.rule === '37').map((r) => ({ period: r.period, bills: Number(r.n), amountPaise: p(r.amount), reclaimedPaise: p(r.reclaimed) })),
    reclaims37: reclaims.map((r) => ({ period: r.period, times: Number(r.n), amountPaise: p(r.amount) })),
    common: [...new Set(rev.filter((r) => r.rule === '42' || r.rule === '43').map((r) => r.period))].map((period) => ({
      period, amountPaise: rev.filter((r) => r.period === period && (r.rule === '42' || r.rule === '43')).reduce((t, r) => t + p(r.amount), 0),
    })),
    annual: rev.filter((r) => r.rule === '42-annual').map((r) => ({ fy: Number(r.period), amountPaise: p(r.amount) })),
  };
}

/**
 * Undo a month's Rule 37 reversal: its entry reversed and the bills back to
 * due. Refused while credit has been taken back against it — those reclaims
 * are undone first — because the reclaim was worked out on this reversal.
 */
export async function undoRule37(trx: Trx, orgId: number, userId: number | null, month: string, reason?: string | null) {
  const rows = await trx.selectFrom('itc_reversals').selectAll().where('org_id', '=', orgId).where('rule', '=', '37').where('period', '=', month).forUpdate().execute();
  if (!rows.length) throw notFound(`Nothing was reversed under Rule 37 for ${monthLabel(month)}.`);
  const later = await trx.selectFrom('itc_reclaim_lines as l').innerJoin('itc_reclaims as c', 'c.id', 'l.reclaim_id')
    .select('c.period').where('l.reversal_id', 'in', rows.map((r) => r.id)).orderBy('c.period').execute();
  if (later.length) {
    throw conflict(`Credit was taken back against it in ${[...new Set(later.map((x) => monthLabel(x.period)))].join(', ')}. Delete ${later.length === 1 ? 'that reclaim' : 'those reclaims'} first.`);
  }
  if (rows.some((r) => p(r.reclaimed_cgst) + p(r.reclaimed_sgst) + p(r.reclaimed_igst) + p(r.reclaimed_cess) > 0)) {
    throw conflict('Credit was taken back against it before reclaims were kept one by one, so it stays as it is.');
  }
  for (const entryId of [...new Set(rows.map((r) => r.journal_entry_id).filter((x): x is number => !!x))]) {
    await reverseForChange(trx, orgId, entryId, { memo: `Rule 37 reversal for ${monthLabel(month)} undone${because(reason)}`, userId, module: 'purchases' });
  }
  await trx.deleteFrom('itc_reversals').where('id', 'in', rows.map((r) => r.id)).execute();
  return { bills: rows.length };
}

/** Undo the credit taken back in a month under Rule 37: its entries reversed, the bills reclaimable again. */
export async function undoReclaim37(trx: Trx, orgId: number, userId: number | null, month: string, reason?: string | null) {
  const reclaims = await trx.selectFrom('itc_reclaims').selectAll().where('org_id', '=', orgId).where('period', '=', month).forUpdate().execute();
  if (!reclaims.length) throw notFound(`No credit was taken back under Rule 37 in ${monthLabel(month)}, or it was taken back before reclaims were kept one by one.`);
  const lines = await trx.selectFrom('itc_reclaim_lines').selectAll().where('reclaim_id', 'in', reclaims.map((r) => r.id)).execute();
  for (const r of reclaims) {
    await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `Rule 37 reclaim for ${monthLabel(month)} undone${because(reason)}`, userId, module: 'purchases' });
  }
  for (const l of lines) {
    await trx.updateTable('itc_reversals').set((eb) => ({
      reclaimed_cgst: eb('reclaimed_cgst', '-', l.cgst), reclaimed_sgst: eb('reclaimed_sgst', '-', l.sgst),
      reclaimed_igst: eb('reclaimed_igst', '-', l.igst), reclaimed_cess: eb('reclaimed_cess', '-', l.cess),
    })).where('id', '=', l.reversal_id).execute();
  }
  await trx.deleteFrom('itc_reclaims').where('id', 'in', reclaims.map((r) => r.id)).execute();
  return { bills: new Set(lines.map((l) => l.reversal_id)).size };
}

/** Undo a month's Rule 42 and 43 reversal; refused while the year's true-up counts it. */
export async function undoCommonCredit(trx: Trx, orgId: number, userId: number | null, month: string, reason?: string | null) {
  const rows = await trx.selectFrom('itc_reversals').selectAll().where('org_id', '=', orgId).where('rule', 'in', ['42', '43']).where('period', '=', month).forUpdate().execute();
  if (!rows.length) throw notFound(`Nothing was reversed under Rules 42 and 43 for ${monthLabel(month)}.`);
  const [y, m] = month.split('-').map(Number);
  const fy = m >= 4 ? y : y - 1;
  const trueUp = await trx.selectFrom('itc_reversals').select('id').where('org_id', '=', orgId).where('rule', '=', '42-annual').where('period', '=', String(fy)).executeTakeFirst();
  if (trueUp) throw conflict(`The true-up for FY ${fy}-${String(fy + 1).slice(2)} counts this month. Delete the true-up first.`);
  for (const entryId of [...new Set(rows.map((r) => r.journal_entry_id).filter((x): x is number => !!x))]) {
    await reverseForChange(trx, orgId, entryId, { memo: `Rules 42/43 reversal for ${monthLabel(month)} undone${because(reason)}`, userId, module: 'purchases' });
  }
  await trx.deleteFrom('itc_reversals').where('id', 'in', rows.map((r) => r.id)).execute();
  return { rows: rows.length };
}

/** Undo the year's Rule 42(2) true-up. */
export async function undoCommonCreditYear(trx: Trx, orgId: number, userId: number | null, fy: number, reason?: string | null) {
  const row = await trx.selectFrom('itc_reversals').selectAll().where('org_id', '=', orgId).where('rule', '=', '42-annual').where('period', '=', String(fy)).forUpdate().executeTakeFirst();
  if (!row) throw notFound(`No true-up is posted for FY ${fy}-${String(fy + 1).slice(2)}.`);
  await reverseForChange(trx, orgId, row.journal_entry_id, { memo: `Rule 42(2) true-up for FY ${fy}-${String(fy + 1).slice(2)} undone${because(reason)}`, userId, module: 'purchases' });
  await trx.deleteFrom('itc_reversals').where('id', '=', row.id).execute();
}

// ── Composition: CMP-08 ──────────────────────────────────────────────────────

/** Undo the tax booked for a quarter's CMP-08: its entry reversed, the quarter ready to book again. */
export async function undoCmp08(trx: Trx, orgId: number, userId: number | null, fy: number, quarter: number, reason?: string | null) {
  const row = await trx.selectFrom('composition_returns').selectAll().where('org_id', '=', orgId).where('fy', '=', fy).where('quarter', '=', quarter).forUpdate().executeTakeFirst();
  if (!row) throw notFound('That quarter has not been booked.');
  const label = `CMP-08 for Q${quarter} of FY ${fy}-${String(fy + 1).slice(2)}`;
  const reversal = await reverseForChange(trx, orgId, row.journal_entry_id, { memo: `${label} undone${because(reason)}`, userId, module: 'accountant' });
  await recordDeletion(trx, {
    orgId, userId, docType: 'composition_return', docId: row.id, number: label, date: null, totalPaise: p(row.cgst) + p(row.sgst),
    journalEntryId: row.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(row),
  });
  await trx.deleteFrom('composition_returns').where('id', '=', row.id).execute();
  return { label };
}

// ── GSTR-2B brought in ───────────────────────────────────────────────────────

/**
 * Take out a month's GSTR-2B: the wrong file, or one to bring in again from
 * scratch. The IMS actions recorded on its lines go with them, so the
 * reconciliation goes back to the books alone for that month.
 */
export async function deleteGstr2bPeriod(trx: Trx, orgId: number, returnPeriod: string, gstin?: string) {
  if (!/^\d{6}$/.test(returnPeriod)) throw badRequest('Give the return period as mmyyyy.');
  const r = await trx.deleteFrom('gstr2b_entries').where('org_id', '=', orgId).where('return_period', '=', returnPeriod)
    .$if(!!gstin, (qb) => qb.where('recipient_gstin', '=', gstin!)).executeTakeFirst();
  const n = Number(r.numDeletedRows ?? 0);
  if (!n) throw notFound('No GSTR-2B is held for that month.');
  return { lines: n };
}
