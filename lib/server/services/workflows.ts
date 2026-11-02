import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Workflow rules: when an event happens and the record meets the conditions,
// do something — tell people in the app, or send an email (migration 089).
//
//   "When an invoice is created and its total is over ₹5,00,000,
//    tell the admins."
//   "When a bill is created from an MSME vendor, email accounts@…"
//
// The events are the audit trail's (invoice.created, bill.voided …), the same
// ones webhooks send. A run is queued with the audit row, inside the change's
// own transaction, and carried out by the scheduler a moment later, reading
// the record as it then stands. Nothing a rule does can change the books: it
// only tells someone.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, type Executor, type Trx } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, notFound } from '../http';
import { notify, usersWhoCan } from './notifications';

export const WORKFLOW_EVENTS = [
  'invoice.created', 'invoice.sent', 'invoice.voided', 'bill.created', 'bill.voided', 'payment.created', 'expense.created',
  'estimate.created', 'sales_order.created', 'purchase_order.created', 'credit_note.created', 'contact.created',
] as const;
export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];

/** The fields a condition can test, by kind of record. Amounts are in rupees. */
export const WORKFLOW_FIELDS: Record<string, { key: string; label: string; type: 'number' | 'text' }[]> = {
  invoice: [{ key: 'total', label: 'Total (₹)', type: 'number' }, { key: 'balance', label: 'Balance (₹)', type: 'number' }, { key: 'customer', label: 'Customer', type: 'text' }, { key: 'state', label: 'Place of supply (state code)', type: 'text' }, { key: 'kind', label: 'Kind (invoice, debit_note)', type: 'text' }],
  bill: [{ key: 'total', label: 'Total (₹)', type: 'number' }, { key: 'vendor', label: 'Vendor', type: 'text' }, { key: 'msme', label: 'MSME vendor (yes/no)', type: 'text' }],
  payment: [{ key: 'amount', label: 'Amount (₹)', type: 'number' }, { key: 'mode', label: 'Mode (cash, upi …)', type: 'text' }, { key: 'kind', label: 'Received or made', type: 'text' }, { key: 'party', label: 'Party', type: 'text' }],
  expense: [{ key: 'total', label: 'Total (₹)', type: 'number' }, { key: 'account', label: 'Account', type: 'text' }],
  estimate: [{ key: 'total', label: 'Total (₹)', type: 'number' }, { key: 'customer', label: 'Customer', type: 'text' }],
  sales_order: [{ key: 'total', label: 'Total (₹)', type: 'number' }, { key: 'customer', label: 'Customer', type: 'text' }],
  purchase_order: [{ key: 'total', label: 'Total (₹)', type: 'number' }, { key: 'vendor', label: 'Vendor', type: 'text' }],
  credit_note: [{ key: 'total', label: 'Total (₹)', type: 'number' }, { key: 'customer', label: 'Customer', type: 'text' }],
  contact: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'kind', label: 'Customer or vendor', type: 'text' }, { key: 'state', label: 'State code', type: 'text' }],
};

export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
export interface Condition { field: string; op: Op; value: string }
export type Action =
  | { type: 'notify'; to: 'admins' | 'accountants' | 'approvers'; message?: string }
  | { type: 'email'; to: string; subject: string; body: string };

export interface RuleInput { id?: number | null; name: string; event: WorkflowEvent; conditions: Condition[]; actions: Action[]; isActive?: boolean }

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export async function saveRule(trx: Trx, orgId: number, input: RuleInput): Promise<number> {
  if (!input.name.trim()) throw badRequest('Give the rule a name.');
  if (!WORKFLOW_EVENTS.includes(input.event)) throw badRequest('Pick what the rule acts on.');
  const type = input.event.split('.')[0];
  const fields = WORKFLOW_FIELDS[type] ?? [];
  for (const c of input.conditions) {
    const f = fields.find((x) => x.key === c.field);
    if (!f) throw badRequest(`${c.field} is not something a ${type.replace('_', ' ')} has.`);
    if (f.type === 'number' && !Number.isFinite(Number(c.value))) throw badRequest(`${f.label} is compared with a number.`);
  }
  if (!input.actions.length) throw badRequest('A rule needs something to do.');
  for (const a of input.actions) {
    if (a.type === 'email' && a.to !== 'party' && !EMAIL.test(a.to)) throw badRequest(`${a.to} is not an email address.`);
    if (a.type === 'email' && (!a.subject.trim() || !a.body.trim())) throw badRequest('An email needs a subject and a message.');
  }
  const values = {
    name: input.name.trim().slice(0, 150), trigger_event: input.event, conditions: JSON.stringify(input.conditions),
    actions: JSON.stringify(input.actions), is_active: input.isActive === false ? 0 : 1,
  };
  if (input.id) {
    const r = await trx.updateTable('workflow_rules').set(values).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That rule does not exist.');
    return input.id;
  }
  return Number((await trx.insertInto('workflow_rules').values({ org_id: orgId, ...values }).executeTakeFirstOrThrow()).insertId);
}

const parse = <T>(v: unknown, fallback: T): T => (v == null ? fallback : (typeof v === 'string' ? JSON.parse(v) : v) as T);

export async function listRules(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('workflow_rules').selectAll().where('org_id', '=', orgId).orderBy('id').execute();
  return rows.map((r) => ({
    id: String(r.id), name: r.name, event: r.trigger_event, conditions: parse<Condition[]>(r.conditions, []),
    actions: parse<Action[]>(r.actions, []), isActive: !!r.is_active, runs: r.runs,
    lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
  }));
}

/** Called with the audit row: a queued run for each active rule on this event. */
export async function queueRuns(ex: Executor, orgId: number, event: string, targetType: string, targetId: number) {
  if (!(WORKFLOW_EVENTS as readonly string[]).includes(event) || !targetId) return 0;
  const rules = await ex.selectFrom('workflow_rules').select('id').where('org_id', '=', orgId).where('trigger_event', '=', event).where('is_active', '=', 1).execute();
  if (!rules.length) return 0;
  await ex.insertInto('workflow_runs').values(rules.map((r) => ({ org_id: orgId, rule_id: r.id, event, target_type: targetType, target_id: targetId }))).execute();
  return rules.length;
}

/** The record as a rule sees it: its fields, a label, where it opens, and its party's email. */
async function recordFor(ex: Executor, orgId: number, type: string, id: number):
  Promise<{ fields: Record<string, string | number>; label: string; href: string | null; partyEmail: string | null } | null> {
  const r = (x: string | null | undefined) => (x == null ? 0 : toPaiseFromSql(x) / 100);
  if (type === 'invoice' || type === 'credit_note' || type === 'estimate' || type === 'sales_order') {
    const table = type === 'invoice' ? 'invoices' : type === 'credit_note' ? 'credit_notes' : type === 'estimate' ? 'estimates' : 'sales_orders';
    const { rows } = await sql<{ number: string; total: string; paid: string | null; name: string; email: string | null; pos: string | null; kind: string | null }>`
      SELECT d.number, d.total, ${type === 'invoice' ? sql`d.amount_paid` : sql`NULL`} AS paid, c.display_name AS name, c.email,
             ${type === 'invoice' || type === 'credit_note' ? sql`d.place_of_supply` : sql`NULL`} AS pos,
             ${type === 'invoice' ? sql`d.doc_kind` : sql`NULL`} AS kind
        FROM ${sql.table(table)} d JOIN contacts c ON c.id = d.customer_id
       WHERE d.id = ${id} AND d.org_id = ${orgId}`.execute(ex);
    const d = rows[0];
    if (!d) return null;
    const href = type === 'invoice' ? `/sales/invoices/${id}` : type === 'credit_note' ? '/sales/credit-notes' : type === 'estimate' ? '/sales/estimates' : '/sales/sales-orders';
    return {
      fields: { total: r(d.total), balance: r(d.total) - r(d.paid), customer: d.name, state: d.pos ?? '', kind: d.kind ?? '' },
      label: `${d.number} · ${d.name}`, href, partyEmail: d.email,
    };
  }
  if (type === 'bill' || type === 'purchase_order') {
    const table = type === 'bill' ? 'bills' : 'purchase_orders';
    const num = type === 'bill' ? sql`d.internal_no` : sql`d.number`;
    const { rows } = await sql<{ number: string; total: string; name: string; email: string | null; msme: number }>`
      SELECT ${num} AS number, d.total, c.display_name AS name, c.email, c.is_msme AS msme
        FROM ${sql.table(table)} d JOIN contacts c ON c.id = d.vendor_id
       WHERE d.id = ${id} AND d.org_id = ${orgId}`.execute(ex);
    const d = rows[0];
    if (!d) return null;
    return { fields: { total: r(d.total), vendor: d.name, msme: d.msme ? 'yes' : 'no' }, label: `${d.number} · ${d.name}`, href: type === 'bill' ? `/purchases/bills/${id}` : '/purchases/purchase-orders', partyEmail: d.email };
  }
  if (type === 'payment') {
    const p = await ex.selectFrom('payments as p').innerJoin('contacts as c', 'c.id', 'p.contact_id')
      .select(['p.number', 'p.amount', 'p.mode', 'p.kind', 'c.display_name', 'c.email']).where('p.id', '=', id).where('p.org_id', '=', orgId).executeTakeFirst();
    if (!p) return null;
    return { fields: { amount: r(p.amount), mode: p.mode, kind: p.kind, party: p.display_name }, label: `${p.number} · ${p.display_name}`, href: p.kind === 'received' ? '/sales/payments' : '/purchases/payments', partyEmail: p.email };
  }
  if (type === 'expense') {
    const e = await ex.selectFrom('expenses as e').innerJoin('accounts as a', 'a.id', 'e.account_id')
      .select(['e.number', 'e.total', 'a.name']).where('e.id', '=', id).where('e.org_id', '=', orgId).executeTakeFirst();
    if (!e) return null;
    return { fields: { total: r(e.total), account: e.name }, label: `${e.number} · ${e.name}`, href: '/purchases/expenses', partyEmail: null };
  }
  if (type === 'contact') {
    const c = await ex.selectFrom('contacts').select(['display_name', 'kind', 'state_code', 'email']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!c) return null;
    return { fields: { name: c.display_name, kind: c.kind, state: c.state_code ?? '' }, label: c.display_name, href: c.kind === 'vendor' ? `/purchases/vendors/${id}` : `/sales/customers/${id}`, partyEmail: c.email };
  }
  return null;
}

export function meets(fields: Record<string, string | number>, conditions: Condition[]): boolean {
  return conditions.every((c) => {
    const v = fields[c.field];
    if (v === undefined) return false;
    if (typeof v === 'number') {
      const n = Number(c.value);
      return c.op === 'eq' ? v === n : c.op === 'ne' ? v !== n : c.op === 'gt' ? v > n : c.op === 'gte' ? v >= n
        : c.op === 'lt' ? v < n : c.op === 'lte' ? v <= n : String(v).includes(c.value);
    }
    const a = String(v).toLowerCase();
    const b = c.value.trim().toLowerCase();
    return c.op === 'eq' ? a === b : c.op === 'ne' ? a !== b : c.op === 'contains' ? a.includes(b) : false;
  });
}

const fill = (text: string, label: string, fields: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k === 'record' ? label : fields[k] !== undefined ? String(fields[k]) : m));

/** Carry out queued runs. Each is read against its record as it now stands; failures are kept on the run. */
export async function runWorkflows(limit = 50, ex: Executor = db): Promise<number> {
  const queued = await ex.selectFrom('workflow_runs as w').innerJoin('workflow_rules as r', 'r.id', 'w.rule_id')
    .select(['w.id', 'w.org_id', 'w.target_type', 'w.target_id', 'w.event', 'r.name', 'r.conditions', 'r.actions', 'r.id as rule_id'])
    .where('w.status', '=', 'queued').orderBy('w.id').limit(limit).execute();
  let done = 0;
  for (const w of queued) {
    const finish = (status: 'done' | 'skipped' | 'failed', detail: string) =>
      ex.updateTable('workflow_runs').set({ status, detail: detail.slice(0, 500), ran_at: new Date() }).where('id', '=', w.id).execute();
    try {
      const rec = await recordFor(ex, w.org_id, w.target_type, w.target_id);
      if (!rec) { await finish('skipped', 'The record is no longer there.'); continue; }
      if (!meets(rec.fields, parse<Condition[]>(w.conditions, []))) { await finish('skipped', 'The conditions were not met.'); continue; }
      const did: string[] = [];
      for (const a of parse<Action[]>(w.actions, [])) {
        if (a.type === 'notify') {
          const who = a.to === 'admins' ? await usersWhoCan(ex, w.org_id, 'settings', 'edit')
            : a.to === 'accountants' ? await usersWhoCan(ex, w.org_id, 'accountant', 'edit')
            : await usersWhoCan(ex, w.org_id, w.target_type === 'bill' || w.target_type === 'purchase_order' || w.target_type === 'expense' ? 'purchases' : 'sales', 'approve');
          const n = await notify(ex, w.org_id, who, { kind: 'workflow', title: `${w.name}: ${rec.label}`, body: a.message ? fill(a.message, rec.label, rec.fields) : null, href: rec.href });
          did.push(`told ${n} ${n === 1 ? 'person' : 'people'}`);
        } else {
          const to = a.to === 'party' ? rec.partyEmail : a.to;
          if (!to) { did.push('no email address to send to'); continue; }
          const { sendMail } = await import('../mail/mailer');
          await sendMail(w.org_id, { to: [to], subject: fill(a.subject, rec.label, rec.fields), text: fill(a.body, rec.label, rec.fields) },
            { docType: w.target_type, docId: w.target_id, ex });
          did.push(`emailed ${to}`);
        }
      }
      await finish('done', did.join('; ') || 'Nothing to do.');
      await ex.updateTable('workflow_rules').set((eb) => ({ runs: eb('runs', '+', 1), last_run_at: new Date() })).where('id', '=', w.rule_id).execute();
      done++;
    } catch (err) {
      await finish('failed', err instanceof Error ? err.message : String(err));
    }
  }
  return done;
}

export async function recentRuns(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('workflow_runs as w').innerJoin('workflow_rules as r', 'r.id', 'w.rule_id')
    .select(['w.id', 'w.event', 'w.target_type', 'w.target_id', 'w.status', 'w.detail', 'w.created_at', 'r.name'])
    .where('w.org_id', '=', orgId).orderBy('w.id', 'desc').limit(100).execute();
  return rows.map((r) => ({ id: String(r.id), rule: r.name, event: r.event, targetType: r.target_type, targetId: String(r.target_id), status: r.status, detail: r.detail, at: new Date(r.created_at).toISOString() }));
}
