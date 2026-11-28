import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Payment batches: the week's supplier payments, released together.
//
//   draft      bills chosen, amounts set; nothing has happened yet
//   pending    submitted; a payment-batch approval rule wants a second person
//   approved   released: the bank file can be downloaded and uploaded
//   paid       the bank has made the transfers; a payment is recorded for each
//              supplier, settling the bills in the batch
//
// With no rule, submitting releases the batch at once: nothing changes for a
// business that has not asked for a checker. With one, the person who made the
// batch cannot release it, as for a big invoice or bill.
//
// The bank file is one transfer per supplier, not per bill, and the payment
// recorded for that supplier is the same one transfer, so the bank statement
// line and the payment match one to one when the statement is reconciled.
// Transfers of ₹2 lakh and above go by RTGS, the rest by NEFT, as the RBI
// sets them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise, RoleName } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { allocateNumber } from '../ledger/posting';
import { badRequest, conflict, forbidden, notFound } from '../http';
import { makePayment } from './payments';
import { mayApprove, recordApprovalAction, ruleFor } from './approvals';
import { fyLabelFor } from './sales';
import { seal, unseal } from '../crypto/fields';
import { plain, recordDeletion, unlinkDocument } from './doc-delete';
import { BANK_FORMATS, bankUploadFile, readBankReply, type BankFormat, type UploadTransfer } from './bank-upload';

/** RTGS carries ₹2 lakh and above; below that a transfer goes by NEFT. */
export const RTGS_FROM: Paise = 2_00_000_00;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const LIVE = ['draft', 'pending', 'approved'] as const;
const rupees = (p: Paise) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const ymd = (v: unknown) => String(v).slice(0, 10);

export interface PayableBill {
  id: string;
  number: string;
  vendorInvoiceNo: string;
  vendorId: string;
  vendorName: string;
  billDate: string;
  dueDate: string;
  balancePaise: Paise;
  isMsme: boolean;
  hasBankDetails: boolean;
  /** The live batch the bill is already in, if any. */
  inBatch: string | null;
}

/** Bills that can go in a batch: posted, in rupees, not disputed, with something left to pay. */
export async function payableBills(ex: Executor, orgId: number, opts: { dueBy?: string | null } = {}): Promise<PayableBill[]> {
  let q = ex.selectFrom('bills as b').innerJoin('contacts as c', 'c.id', 'b.vendor_id')
    .select(['b.id', 'b.internal_no', 'b.vendor_invoice_no', 'b.vendor_id', 'b.bill_date', 'b.due_date', 'b.total', 'b.amount_paid',
      'c.display_name', 'c.is_msme', 'c.bank_account_no', 'c.bank_ifsc'])
    .where('b.org_id', '=', orgId).where('b.status', 'in', ['open', 'overdue', 'partially_paid'])
    .where('b.currency', '=', 'INR').where('b.match_status', '!=', 'exception');
  if (opts.dueBy) q = q.where('b.due_date', '<=', opts.dueBy);
  const rows = await q.orderBy('b.due_date').orderBy('b.id').execute();
  const live = rows.length
    ? await ex.selectFrom('payment_batch_lines as l').innerJoin('payment_batches as p', 'p.id', 'l.batch_id')
      .select(['l.bill_id', 'p.number']).where('l.org_id', '=', orgId).where('p.status', 'in', [...LIVE])
      .where('l.bill_id', 'in', rows.map((r) => r.id)).execute()
    : [];
  const inBatch = new Map(live.map((l) => [l.bill_id, l.number]));
  return rows
    .map((r) => ({
      id: String(r.id), number: r.internal_no, vendorInvoiceNo: r.vendor_invoice_no, vendorId: String(r.vendor_id), vendorName: r.display_name,
      billDate: ymd(r.bill_date), dueDate: ymd(r.due_date),
      balancePaise: toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid),
      isMsme: !!r.is_msme,
      hasBankDetails: !!r.bank_account_no && IFSC.test((r.bank_ifsc ?? '').toUpperCase()),
      inBatch: inBatch.get(r.id) ?? null,
    }))
    .filter((r) => r.balancePaise > 0);
}

/** A bill as it stands, checked fit to pay this much. */
async function payable(trx: Trx, orgId: number, billId: number, amountPaise: Paise, exceptBatch?: number) {
  const b = await trx.selectFrom('bills').select(['id', 'internal_no', 'vendor_id', 'status', 'currency', 'match_status', 'total', 'amount_paid'])
    .where('id', '=', billId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!b) throw notFound(`Bill ${billId} was not found.`);
  if (!['open', 'overdue', 'partially_paid'].includes(b.status)) throw badRequest(`${b.internal_no} is ${b.status.replace('_', ' ')}; only an open bill is paid.`);
  if (b.currency !== 'INR') throw badRequest(`${b.internal_no} is in ${b.currency}. A payment abroad is a remittance, not a bulk transfer.`);
  if (b.match_status === 'exception') throw badRequest(`${b.internal_no} does not agree with its order or receipt; accept it before paying it.`);
  const balance = toPaiseFromSql(b.total) - toPaiseFromSql(b.amount_paid);
  if (!(amountPaise > 0)) throw badRequest(`Pay something above zero on ${b.internal_no}.`);
  if (amountPaise > balance) throw badRequest(`${b.internal_no} has ${rupees(balance)} left to pay, less than ${rupees(amountPaise)}.`);
  let other = trx.selectFrom('payment_batch_lines as l').innerJoin('payment_batches as p', 'p.id', 'l.batch_id')
    .select('p.number').where('l.bill_id', '=', billId).where('p.status', 'in', [...LIVE]);
  if (exceptBatch) other = other.where('p.id', '!=', exceptBatch);
  const clash = await other.executeTakeFirst();
  if (clash) throw conflict(`${b.internal_no} is already in batch ${clash.number}.`);
  return b;
}

export interface BatchInput {
  branchId: number;
  bankAccountId: number;
  payDate: string;
  notes?: string | null;
  lines: { billId: number; amountPaise: Paise }[];
}

export async function createBatch(trx: Trx, orgId: number, userId: number | null, input: BatchInput) {
  if (!input.lines.length) throw badRequest('Choose at least one bill to pay.');
  if (new Set(input.lines.map((l) => l.billId)).size !== input.lines.length) throw badRequest('A bill appears twice in the batch.');
  const bank = await trx.selectFrom('bank_accounts').select(['id', 'kind', 'is_active', 'account_number'])
    .where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank || bank.kind !== 'bank' || !bank.is_active) throw badRequest('Pay from one of your bank accounts.');

  const lines = [];
  for (const l of input.lines) {
    const b = await payable(trx, orgId, l.billId, l.amountPaise);
    lines.push({ billId: b.id, vendorId: b.vendor_id, amountPaise: l.amountPaise });
  }
  const total = lines.reduce((t, l) => t + l.amountPaise, 0);
  const number = await allocateNumber(trx, orgId, input.branchId, 'PB', fyLabelFor(input.payDate), { prefix: 'PB' });
  const id = Number((await trx.insertInto('payment_batches').values({
    org_id: orgId, branch_id: input.branchId, number, bank_account_id: bank.id, pay_date: input.payDate,
    total_amount: toSqlFromPaise(total), notes: input.notes ?? null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  await trx.insertInto('payment_batch_lines').values(lines.map((l) => ({
    batch_id: id, org_id: orgId, vendor_id: l.vendorId, bill_id: l.billId, amount: toSqlFromPaise(l.amountPaise),
  }))).execute();
  return { id, number, totalPaise: total };
}

async function load(trx: Trx, orgId: number, id: number) {
  const b = await trx.selectFrom('payment_batches').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!b) throw notFound('That payment batch was not found.');
  return b;
}

/**
 * Check every bill is still payable and every supplier can be paid by bank,
 * then copy the supplier's bank details onto the lines: the file pays what
 * the approver saw.
 */
async function freeze(trx: Trx, orgId: number, batchId: number) {
  const lines = await trx.selectFrom('payment_batch_lines as l').innerJoin('contacts as c', 'c.id', 'l.vendor_id')
    .select(['l.id', 'l.bill_id', 'l.amount', 'c.display_name', 'c.bank_account_name', 'c.bank_account_no', 'c.bank_ifsc'])
    .where('l.batch_id', '=', batchId).execute();
  const missing = [...new Set(lines.filter((l) => !l.bank_account_no || !IFSC.test((l.bank_ifsc ?? '').toUpperCase())).map((l) => l.display_name))];
  if (missing.length) throw badRequest(`No usable bank account and IFSC for ${missing.join(', ')}. Add them on the supplier before releasing the batch.`);
  for (const l of lines) {
    await payable(trx, orgId, l.bill_id, toPaiseFromSql(l.amount), batchId);
    await trx.updateTable('payment_batch_lines').set({
      beneficiary_name: (l.bank_account_name || l.display_name).slice(0, 200),
      account_no: seal((unseal(l.bank_account_no) ?? '').replace(/\s/g, '')),
      ifsc: (l.bank_ifsc ?? '').toUpperCase(),
    }).where('id', '=', l.id).execute();
  }
}

/** Submit a draft: released at once with no rule, or held for the rule's approver. */
export async function submitBatch(trx: Trx, orgId: number, userId: number | null, id: number) {
  const b = await load(trx, orgId, id);
  if (b.status !== 'draft' && b.status !== 'rejected') throw conflict(`${b.number} is ${b.status}, not a draft.`);
  await freeze(trx, orgId, id);
  const rule = await ruleFor(trx, orgId, 'payment_batch', toPaiseFromSql(b.total_amount));
  if (rule) {
    await trx.updateTable('payment_batches').set({ status: 'pending', submitted_at: new Date(), rejection_reason: null }).where('id', '=', id).execute();
    await recordApprovalAction(trx, orgId, 'payment_batch', id, 'submitted', userId);
    return { status: 'pending' as const, approverRole: rule.approverRole };
  }
  await trx.updateTable('payment_batches').set({
    status: 'approved', submitted_at: new Date(), approved_by_user_id: userId, approved_at: new Date(), rejection_reason: null,
  }).where('id', '=', id).execute();
  return { status: 'approved' as const };
}

export async function approveBatch(trx: Trx, orgId: number, user: { userId: number; role: RoleName }, id: number, note?: string | null) {
  const b = await load(trx, orgId, id);
  if (b.status !== 'pending') throw conflict(`${b.number} is not waiting for approval.`);
  if (b.created_by_user_id === user.userId) throw forbidden(`You made ${b.number}. Someone else has to release it.`);
  const rule = await ruleFor(trx, orgId, 'payment_batch', toPaiseFromSql(b.total_amount));
  if (rule && !mayApprove(user.role, rule.approverRole)) {
    throw forbidden(`${b.number} needs approval by ${rule.approverRole === 'admin' ? 'an admin' : `an ${rule.approverRole}`}.`);
  }
  await freeze(trx, orgId, id);
  await trx.updateTable('payment_batches').set({ status: 'approved', approved_by_user_id: user.userId, approved_at: new Date() }).where('id', '=', id).execute();
  await recordApprovalAction(trx, orgId, 'payment_batch', id, 'approved', user.userId, note);
}

export async function rejectBatch(trx: Trx, orgId: number, user: { userId: number; role: RoleName }, id: number, reason: string) {
  const b = await load(trx, orgId, id);
  if (b.status !== 'pending') throw conflict(`${b.number} is not waiting for approval.`);
  if (!reason.trim()) throw badRequest('Say why it is being sent back.');
  const rule = await ruleFor(trx, orgId, 'payment_batch', toPaiseFromSql(b.total_amount));
  if (rule && !mayApprove(user.role, rule.approverRole) && b.created_by_user_id !== user.userId) {
    throw forbidden(`Only ${rule.approverRole === 'admin' ? 'an admin' : `an ${rule.approverRole}`} can send ${b.number} back.`);
  }
  await trx.updateTable('payment_batches').set({ status: 'rejected', rejection_reason: reason.trim() }).where('id', '=', id).execute();
  await recordApprovalAction(trx, orgId, 'payment_batch', id, 'rejected', user.userId, reason);
}

/** Withdraw a batch that has not been paid. Its bills are free for another. */
export async function cancelBatch(trx: Trx, orgId: number, id: number) {
  const b = await load(trx, orgId, id);
  if (b.status === 'paid' || b.status === 'cancelled') throw conflict(`${b.number} is ${b.status}.`);
  await trx.updateTable('payment_batches').set({ status: 'cancelled' }).where('id', '=', id).execute();
}

// ── Edit and Delete ─────────────────────────────────────────────────────────
//
// A batch is a list of bills to pay; it posts nothing until it is marked paid,
// when a payment is recorded for each supplier. So it can be edited freely
// while it is a draft or sent back, and deleted until it is released. Once
// released its file may already be with the bank: cancel it first. Once paid
// the payments stand (they are changed in Payments made, not here).

const STATE: Record<string, string> = { pending: 'waiting for approval', approved: 'released', paid: 'paid', cancelled: 'cancelled', rejected: 'sent back', draft: 'a draft' };

/** Edit a draft or sent-back batch: its bank, date, note and bills. It is a draft again, to be released afresh. */
export async function updateBatch(trx: Trx, orgId: number, id: number, input: Omit<BatchInput, 'branchId'>) {
  const b = await load(trx, orgId, id);
  if (b.status !== 'draft' && b.status !== 'rejected') {
    throw conflict(`${b.number} is ${STATE[b.status] ?? b.status}; only a draft or a batch sent back can be edited.` +
      (b.status === 'pending' || b.status === 'approved' ? ' Cancel it and make a new one.' : ''));
  }
  if (!input.lines.length) throw badRequest('Choose at least one bill to pay.');
  if (new Set(input.lines.map((l) => l.billId)).size !== input.lines.length) throw badRequest('A bill appears twice in the batch.');
  const bank = await trx.selectFrom('bank_accounts').select(['id', 'kind', 'is_active'])
    .where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank || bank.kind !== 'bank' || !bank.is_active) throw badRequest('Pay from one of your bank accounts.');
  const lines = [];
  for (const l of input.lines) {
    const bill = await payable(trx, orgId, l.billId, l.amountPaise, id);
    lines.push({ billId: bill.id, vendorId: bill.vendor_id, amountPaise: l.amountPaise });
  }
  const before = { ...b, lines: await trx.selectFrom('payment_batch_lines').selectAll().where('batch_id', '=', id).execute() };
  const total = lines.reduce((t, l) => t + l.amountPaise, 0);
  await trx.deleteFrom('payment_batch_lines').where('batch_id', '=', id).execute();
  await trx.insertInto('payment_batch_lines').values(lines.map((l) => ({
    batch_id: id, org_id: orgId, vendor_id: l.vendorId, bill_id: l.billId, amount: toSqlFromPaise(l.amountPaise),
  }))).execute();
  await trx.updateTable('payment_batches').set({
    bank_account_id: bank.id, pay_date: input.payDate, notes: input.notes ?? null, total_amount: toSqlFromPaise(total),
    status: 'draft', rejection_reason: null,
  }).where('id', '=', id).execute();
  const after = {
    ...(await trx.selectFrom('payment_batches').selectAll().where('id', '=', id).executeTakeFirstOrThrow()),
    lines: await trx.selectFrom('payment_batch_lines').selectAll().where('batch_id', '=', id).execute(),
  };
  return { id, number: b.number, totalPaise: total, before, after };
}

/** Delete a batch that has not been released or paid; its bills are free for another. The record is kept. */
export async function deleteBatch(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const b = await load(trx, orgId, id);
  if (b.status === 'paid') {
    throw conflict(`${b.number} is paid: the bank made the transfers and a payment is recorded for each supplier. Those stand, so the batch does too.`);
  }
  if (b.status === 'approved') throw conflict(`${b.number} has been released, and its bank file may be with the bank. Cancel it first, then delete it.`);
  const lines = await trx.selectFrom('payment_batch_lines').selectAll().where('batch_id', '=', id).execute();
  await unlinkDocument(trx, orgId, 'payment_batch', id);
  await recordDeletion(trx, {
    orgId, userId, docType: 'payment_batch', docId: id, number: b.number, date: ymd(b.pay_date),
    totalPaise: toPaiseFromSql(b.total_amount), branchId: b.branch_id, reason,
    snapshot: { batch: plain(b), lines: lines.map(plain) },
  });
  await trx.deleteFrom('payment_batch_lines').where('batch_id', '=', id).execute();
  await trx.deleteFrom('payment_batches').where('id', '=', id).where('org_id', '=', orgId).execute();
  return { number: b.number };
}

interface Transfer { vendorId: number; beneficiary: string; accountNo: string; ifsc: string; amountPaise: Paise; bills: { lineId: number; billId: number; number: string; amountPaise: Paise }[] }

async function transfers(ex: Executor, batchId: number): Promise<Transfer[]> {
  const lines = await ex.selectFrom('payment_batch_lines as l').innerJoin('bills as b', 'b.id', 'l.bill_id')
    .select(['l.id', 'l.vendor_id', 'l.bill_id', 'l.amount', 'l.beneficiary_name', 'l.account_no', 'l.ifsc', 'b.vendor_invoice_no'])
    .where('l.batch_id', '=', batchId).orderBy('l.id').execute();
  const by = new Map<number, Transfer>();
  for (const l of lines) {
    const t = by.get(l.vendor_id) ?? { vendorId: l.vendor_id, beneficiary: l.beneficiary_name ?? '', accountNo: unseal(l.account_no) ?? '', ifsc: l.ifsc ?? '', amountPaise: 0, bills: [] };
    const amount = toPaiseFromSql(l.amount);
    t.amountPaise += amount;
    t.bills.push({ lineId: l.id, billId: l.bill_id, number: l.vendor_invoice_no, amountPaise: amount });
    by.set(l.vendor_id, t);
  }
  return [...by.values()];
}

export const FILE_COLUMNS = [
  'Payment type', 'Beneficiary name', 'Beneficiary account no', 'IFSC', 'Amount', 'Value date', 'Debit account no', 'Remarks', 'Bills paid',
] as const;

/**
 * The bulk-upload rows: one transfer per supplier. Most banks' corporate
 * portals take these columns, perhaps in another order; the remark is cut to
 * the 30 characters NEFT carries to the beneficiary.
 */
export async function bankFile(trx: Trx, orgId: number, id: number) {
  const b = await load(trx, orgId, id);
  if (b.status !== 'approved' && b.status !== 'paid') throw conflict(`${b.number} has not been released; the file is made once it is.`);
  const bank = await trx.selectFrom('bank_accounts').select(['account_number', 'name']).where('id', '=', b.bank_account_id).executeTakeFirstOrThrow();
  const [y, m, d] = ymd(b.pay_date).split('-');
  const rows = (await transfers(trx, id)).map((t) => [
    t.amountPaise >= RTGS_FROM ? 'RTGS' : 'NEFT', t.beneficiary, t.accountNo, t.ifsc, (t.amountPaise / 100).toFixed(2), `${d}/${m}/${y}`,
    (bank.account_number ?? '').replace(/\s/g, ''), `${b.number} ${t.bills.map((x) => x.number).join(' ')}`.slice(0, 30),
    t.bills.map((x) => x.number).join(', '),
  ]);
  if (!b.file_downloaded_at) await trx.updateTable('payment_batches').set({ file_downloaded_at: new Date() }).where('id', '=', id).execute();
  return { number: b.number, bankName: bank.name, debitAccountMissing: !bank.account_number, columns: [...FILE_COLUMNS], rows };
}

/**
 * The bank has made the transfers: record one payment per supplier, settling
 * the batch's bills. A transfer the bank bounced is left out (`failedVendorIds`)
 * and its bills are free for the next batch. `references` carries the UTRs.
 */
export async function markBatchPaid(
  trx: Trx, orgId: number, userId: number | null, id: number,
  opts: { references?: Record<string, string>; failedVendorIds?: number[] } = {},
) {
  const b = await load(trx, orgId, id);
  if (b.status !== 'approved') throw conflict(`${b.number} is ${b.status}; only a released batch is marked paid.`);
  const failed = new Set(opts.failedVendorIds ?? []);
  const paid = [];
  for (const t of await transfers(trx, id)) {
    if (failed.has(t.vendorId)) continue;
    const payment = await makePayment(trx, orgId, userId, {
      branchId: b.branch_id, contactId: t.vendorId, date: ymd(b.pay_date), mode: t.amountPaise >= RTGS_FROM ? 'rtgs' : 'neft',
      amountPaise: t.amountPaise, bankAccountId: b.bank_account_id,
      reference: opts.references?.[String(t.vendorId)]?.trim() || b.number,
      allocations: t.bills.map((x) => ({ targetType: 'bill' as const, targetId: x.billId, amountPaise: x.amountPaise })),
      notes: `Payment batch ${b.number}`,
    });
    await trx.updateTable('payment_batch_lines').set({ payment_id: payment.id }).where('id', 'in', t.bills.map((x) => x.lineId)).execute();
    paid.push({ vendorId: t.vendorId, paymentId: payment.id, number: payment.number, amountPaise: t.amountPaise });
  }
  if (!paid.length) throw badRequest('Every transfer is marked as failed; cancel the batch instead.');
  await trx.updateTable('payment_batches').set({ status: 'paid', paid_at: new Date() }).where('id', '=', id).execute();
  return paid;
}

export interface BatchRow {
  id: string;
  number: string;
  status: 'draft' | 'pending' | 'approved' | 'paid' | 'rejected' | 'cancelled';
  payDate: string;
  bankAccountId: string;
  bankName: string;
  totalPaise: Paise;
  notes: string | null;
  createdBy: string | null;
  createdById: string | null;
  approvedBy: string | null;
  rejectionReason: string | null;
  fileDownloadedAt: string | null;
  transfers: { vendorId: string; vendorName: string; accountNo: string | null; ifsc: string | null; amountPaise: Paise; mode: 'RTGS' | 'NEFT'; paymentNumber: string | null; bills: { billId: string; number: string; vendorInvoiceNo: string; amountPaise: Paise }[];
    /** What the bank's reply said (migration 131): pending until it is read. */
    bankStatus: 'pending' | 'paid' | 'failed'; utr: string | null; failureReason: string | null; reference: string }[];
  /** The bank layout the file was made in. */
  bankFormat: string | null;
}

export async function listBatches(ex: Executor, orgId: number): Promise<BatchRow[]> {
  const batches = await ex.selectFrom('payment_batches as p').innerJoin('bank_accounts as a', 'a.id', 'p.bank_account_id')
    .leftJoin('users as u', 'u.id', 'p.created_by_user_id').leftJoin('users as v', 'v.id', 'p.approved_by_user_id')
    .select(['p.id', 'p.number', 'p.status', 'p.pay_date', 'p.bank_account_id', 'a.name as bank_name', 'p.total_amount', 'p.notes',
      'u.name as created_by', 'p.created_by_user_id', 'v.name as approved_by', 'p.rejection_reason', 'p.file_downloaded_at', 'p.bank_format'])
    .where('p.org_id', '=', orgId).orderBy('p.id', 'desc').limit(200).execute();
  const lines = batches.length
    ? await ex.selectFrom('payment_batch_lines as l').innerJoin('contacts as c', 'c.id', 'l.vendor_id').innerJoin('bills as b', 'b.id', 'l.bill_id')
      .leftJoin('payments as pay', 'pay.id', 'l.payment_id')
      .select(['l.batch_id', 'l.vendor_id', 'c.display_name', 'c.bank_account_no', 'c.bank_ifsc', 'l.account_no', 'l.ifsc', 'l.amount',
        'l.bill_id', 'b.internal_no', 'b.vendor_invoice_no', 'pay.number as payment_number', 'l.bank_status', 'l.utr', 'l.failure_reason'])
      .where('l.batch_id', 'in', batches.map((b) => b.id)).orderBy('l.id').execute()
    : [];
  return batches.map((b) => {
    const by = new Map<number, BatchRow['transfers'][number]>();
    for (const l of lines.filter((x) => x.batch_id === b.id)) {
      const t = by.get(l.vendor_id) ?? {
        vendorId: String(l.vendor_id), vendorName: l.display_name, accountNo: unseal(l.account_no ?? l.bank_account_no), ifsc: l.ifsc ?? l.bank_ifsc,
        amountPaise: 0, mode: 'NEFT' as const, paymentNumber: l.payment_number, bills: [],
        bankStatus: l.bank_status, utr: l.utr, failureReason: l.failure_reason, reference: transferRef(b.number, l.vendor_id),
      };
      t.amountPaise += toPaiseFromSql(l.amount);
      t.mode = t.amountPaise >= RTGS_FROM ? 'RTGS' : 'NEFT';
      t.bills.push({ billId: String(l.bill_id), number: l.internal_no, vendorInvoiceNo: l.vendor_invoice_no, amountPaise: toPaiseFromSql(l.amount) });
      by.set(l.vendor_id, t);
    }
    return {
      id: String(b.id), number: b.number, status: b.status, payDate: ymd(b.pay_date), bankAccountId: String(b.bank_account_id), bankName: b.bank_name,
      totalPaise: toPaiseFromSql(b.total_amount), notes: b.notes, createdBy: b.created_by,
      createdById: b.created_by_user_id ? String(b.created_by_user_id) : null, approvedBy: b.approved_by, rejectionReason: b.rejection_reason,
      fileDownloadedAt: b.file_downloaded_at ? new Date(b.file_downloaded_at).toISOString() : null,
      bankFormat: b.bank_format ?? null,
      transfers: [...by.values()],
    };
  });
}

// ── Bank upload files and the bank's reply (status review 7, item 6) ────────

/** Our reference on a transfer, echoed back in the bank's status file: "<batch>/<vendor>". */
function transferRef(batchNumber: string, vendorId: number) { return `${batchNumber}/${vendorId}`; }

/**
 * The bulk payment file of a released batch, in one bank's layout
 * (services/bank-upload.ts). Remembered on the batch, with when it was first
 * downloaded, so the reply is read in the same terms.
 */
export async function batchUploadFile(trx: Trx, orgId: number, id: number, format: BankFormat) {
  const b = await load(trx, orgId, id);
  if (b.status !== 'approved' && b.status !== 'paid') throw conflict(`${b.number} has not been released; the file is made once it is.`);
  const bank = await trx.selectFrom('bank_accounts').select(['account_number', 'name']).where('id', '=', b.bank_account_id).executeTakeFirstOrThrow();
  const list: UploadTransfer[] = (await transfers(trx, id)).map((t) => ({
    vendorId: t.vendorId, beneficiary: t.beneficiary, accountNo: t.accountNo, ifsc: t.ifsc, amountPaise: t.amountPaise,
    mode: t.amountPaise >= RTGS_FROM ? 'RTGS' : 'NEFT', reference: transferRef(b.number, t.vendorId),
    remarks: `${b.number} ${t.bills.map((x) => x.number).join(' ')}`, bills: t.bills.map((x) => x.number).join(', '),
  }));
  const file = bankUploadFile(format, { number: b.number, payDate: ymd(b.pay_date), debitAccountNo: bank.account_number ?? '' }, list);
  await trx.updateTable('payment_batches').set({ bank_format: format, ...(b.file_downloaded_at ? {} : { file_downloaded_at: new Date() }) }).where('id', '=', id).execute();
  return { ...file, number: b.number, bankName: bank.name, debitAccountMissing: !bank.account_number, transfers: list.length, format: BANK_FORMATS.find((f) => f.id === format)! };
}

/**
 * The bank's status file for a released batch, applied: each transfer the
 * bank paid gets its payment recorded with the UTR (markBatchPaid), each it
 * returned is left out with the bank's reason, and its bills are free for the
 * next batch. A line matches a transfer by our reference, else by the
 * beneficiary account and amount. Lines that match nothing are reported.
 */
export async function applyBankReply(trx: Trx, orgId: number, userId: number | null, id: number, grid: unknown[][]) {
  const b = await load(trx, orgId, id);
  if (b.status !== 'approved') throw conflict(`${b.number} is ${b.status}; only a released batch takes the bank's reply.`);
  const reply = readBankReply(grid);
  if (reply.problem) throw badRequest(reply.problem);
  const list = await transfers(trx, id);
  const key = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const result = new Map<number, { status: 'paid' | 'failed'; utr: string | null; reason: string | null }>();
  const unmatched: { row: number; why: string }[] = [];
  for (const line of reply.lines) {
    const t = list.find((x) => line.reference && key(line.reference) === key(transferRef(b.number, x.vendorId)))
      ?? list.find((x) => line.accountNo && key(line.accountNo) === key(x.accountNo) && (line.amountPaise === null || line.amountPaise === x.amountPaise));
    if (!t) { unmatched.push({ row: line.row, why: `matches no transfer of ${b.number}${line.reference ? ` (reference ${line.reference})` : ''}` }); continue; }
    if (line.status === 'unknown') { unmatched.push({ row: line.row, why: 'its status says neither paid nor failed' }); continue; }
    if (line.amountPaise !== null && line.amountPaise !== t.amountPaise) {
      unmatched.push({ row: line.row, why: `the bank's amount ₹${(line.amountPaise / 100).toFixed(2)} is not the transfer's ₹${(t.amountPaise / 100).toFixed(2)}` });
      continue;
    }
    result.set(t.vendorId, { status: line.status, utr: line.utr, reason: line.reason });
  }
  const missing = list.filter((t) => !result.has(t.vendorId));
  if (missing.length) {
    throw badRequest(`The bank's file does not say what happened to ${missing.length} transfer(s)${missing.length <= 3 ? `: ${missing.map((m) => m.beneficiary).join(', ')}` : ''}. ` +
      `Each transfer needs a line with its reference (${transferRef(b.number, missing[0].vendorId)}) and a status.${unmatched.length ? ` Lines not used: ${unmatched.map((u) => `row ${u.row} ${u.why}`).join('; ')}.` : ''}`);
  }
  for (const t of list) {
    const r = result.get(t.vendorId)!;
    await trx.updateTable('payment_batch_lines').set({ bank_status: r.status, utr: r.utr?.slice(0, 40) ?? null, failure_reason: r.status === 'failed' ? (r.reason ?? 'Returned by the bank').slice(0, 300) : null })
      .where('batch_id', '=', id).where('vendor_id', '=', t.vendorId).execute();
  }
  const failed = list.filter((t) => result.get(t.vendorId)!.status === 'failed').map((t) => t.vendorId);
  const references = Object.fromEntries(list.filter((t) => result.get(t.vendorId)!.utr).map((t) => [String(t.vendorId), result.get(t.vendorId)!.utr!]));
  let paid: Awaited<ReturnType<typeof markBatchPaid>> = [];
  if (failed.length < list.length) paid = await markBatchPaid(trx, orgId, userId, id, { references, failedVendorIds: failed });
  else await trx.updateTable('payment_batches').set({ status: 'cancelled' }).where('id', '=', id).execute();
  return {
    paid: paid.map((p) => ({ ...p, utr: references[String(p.vendorId)] ?? null })),
    failed: list.filter((t) => failed.includes(t.vendorId)).map((t) => ({ vendorId: t.vendorId, beneficiary: t.beneficiary, amountPaise: t.amountPaise, reason: result.get(t.vendorId)!.reason ?? 'Returned by the bank' })),
    unmatched,
  };
}
