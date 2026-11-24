import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' recurring invoice profile, as its form and record have it
// (recorded 2026-11-23, migration 123): Repeat Every (Week, 2 Weeks, Month,
// 2/3/6 Months, Year, 2/3 Years, or Custom every N days/weeks/months/years),
// Start On and Ends On / Never Expires, Payment Terms, Order Number,
// Salesperson, the item table, Customer Notes, Terms & Conditions and "Create
// Invoices as Drafts" — and the record's figures: the invoices it has raised,
// the next date and what is left of its cycles.
//
// The line template is stored as written, with its own rates (a contract is a
// contract); runRecurringInvoice (recurring.ts) raises each invoice from it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { badRequest, notFound } from '../http';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { roundToRupee } from '../../money';
import { advancePeriod, type Frequency, type TemplateLine } from './recurring';
import { registrationOn } from './statutory';

export { REPEAT_CHOICES, repeatLabel } from '../../recurring-repeat';
import { repeatLabel } from '../../recurring-repeat';

/** Zoho's Entity type: the profile raises invoices or bills of supply. */
export type EntityType = 'invoice' | 'bill_of_supply';
/** Zoho's Rounding Off Preference: "No Rounding", or round the total to the nearest whole number. */
export type RoundOff = 'none' | 'whole';

export interface ProfileInput {
  branchId: number;
  customerId: number;
  name: string;
  entityType?: EntityType;
  /** The totals' Shipping Charges, on every invoice raised. */
  shippingChargePaise?: number;
  /** The adjustment row: its label and an amount that may be negative. */
  adjustmentPaise?: number;
  adjustmentLabel?: string | null;
  roundOff?: RoundOff;
  orderNumber?: string | null;
  frequency: Frequency;
  every: number;
  startDate: string;
  endDate?: string | null;
  paymentTerms?: string | null;
  salespersonId?: number | null;
  lines: TemplateLine[];
  notes?: string | null;
  terms?: string | null;
  /** Zoho's Select Price List: the list the rates were taken from (the rates themselves are on the lines). */
  priceListId?: number | null;
  /** Zoho's Associate Project(s) Hours: projects whose unbilled hours go on each invoice. */
  projectIds?: number[];
  /** Zoho's Associate Payment Options: a payment link on each issued invoice. */
  paymentLink?: boolean;
  createAsDraft?: boolean;
  autoSend?: boolean;
  autoRun?: boolean;
}

/**
 * What a profile's next invoice comes to: its lines (after their discounts),
 * their tax (none on a bill of supply), the Shipping Charges and adjustment,
 * and the Rounding Off Preference. The list's AMOUNT and the record show this.
 */
export function profileAmount(p: {
  lines: TemplateLine[]; entityType: EntityType; shippingPaise: number; adjustmentPaise: number; roundOff: RoundOff;
}): { subTotalPaise: number; taxPaise: number; roundOffPaise: number; totalPaise: number } {
  const net = (l: TemplateLine) => Math.round(l.ratePaise * l.qty * (1 - (l.discountPct ?? 0) / 100));
  const sub = p.lines.reduce((t, l) => t + net(l), 0);
  const tax = p.entityType === 'bill_of_supply' ? 0 : p.lines.reduce((t, l) => t + Math.round((net(l) * l.gstRatePct) / 100), 0);
  const gross = sub + tax + p.shippingPaise + p.adjustmentPaise;
  const r = p.roundOff === 'whole' ? roundToRupee(gross) : { rounded: gross, roundOff: 0 };
  return { subTotalPaise: sub, taxPaise: tax, roundOffPaise: r.roundOff, totalPaise: r.rounded };
}

/** Zoho's checks, in Zoho's words, before anything is saved. */
export async function checkProfile(ex: Executor, orgId: number, input: ProfileInput): Promise<void> {
  if (!input.customerId) throw badRequest('Select a customer.');
  if (!input.name.trim()) throw badRequest('Enter the profile name.');
  if (!(input.every >= 1 && input.every <= 999)) throw badRequest('Repeat every 1 to 999 periods.');
  if (input.endDate && input.endDate < input.startDate) throw badRequest('The end date cannot be before the start date.');
  if (!input.lines.length || input.lines.every((l) => !l.itemId && !l.description?.trim())) throw badRequest('Enter the valid item name or description.');
  if (input.lines.some((l) => !(l.qty > 0))) throw badRequest('Enter a quantity above zero on every line.');
  const c = await ex.selectFrom('contacts').select('id').where('id', '=', input.customerId).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw badRequest('That customer does not exist.');
  if (input.lines.some((l) => (l.discountPct ?? 0) < 0 || (l.discountPct ?? 0) > 100)) throw badRequest('A discount is 0% to 100%.');
  if ((input.shippingChargePaise ?? 0) < 0) throw badRequest('Shipping charges cannot be below zero.');
  if (Math.abs(input.adjustmentPaise ?? 0) > 1_000_000_000_00) throw badRequest('That adjustment is too large.');
  // A bill of supply carries no tax: as on the invoice (services/sales.ts), a
  // regular dealer raises one only for exempt, nil-rated or non-GST goods.
  if (input.entityType === 'bill_of_supply' && input.lines.some((l) => l.gstRatePct > 0)
      && (await registrationOn(ex, orgId, input.startDate)) === 'regular') {
    throw badRequest('A bill of supply carries no tax: every line must be exempt, nil-rated or non-GST (0%). Raise a tax invoice for taxable goods.');
  }
  if (input.priceListId) {
    const pl = await ex.selectFrom('price_lists').select(['id', 'is_active']).where('id', '=', input.priceListId).where('org_id', '=', orgId).executeTakeFirst();
    if (!pl) throw badRequest('That price list does not exist.');
    if (!pl.is_active) throw badRequest('That price list is inactive.');
  }
  for (const pid of input.projectIds ?? []) {
    const p = await ex.selectFrom('projects').select(['id', 'customer_id', 'name']).where('id', '=', pid).where('org_id', '=', orgId).executeTakeFirst();
    if (!p) throw badRequest('One of the projects does not exist.');
    if (p.customer_id && p.customer_id !== input.customerId) throw badRequest(`${p.name} is another customer's project.`);
  }
}

const values = (input: ProfileInput) => ({
  branch_id: input.branchId,
  profile_name: input.name.trim(),
  entity_type: input.entityType ?? 'invoice',
  order_number: input.orderNumber?.trim() || null,
  customer_id: input.customerId,
  salesperson_id: input.salespersonId ?? null,
  frequency: input.frequency,
  repeat_every: input.every,
  start_date: input.startDate,
  end_date: input.endDate ?? null,
  payment_terms: input.paymentTerms ?? 'due_on_receipt',
  template: JSON.stringify(input.lines),
  notes: input.notes?.trim() || null,
  terms: input.terms?.trim() || null,
  shipping_charge: toSqlFromPaise(input.shippingChargePaise ?? 0),
  adjustment: toSqlFromPaise(input.adjustmentPaise ?? 0),
  adjustment_label: input.adjustmentLabel?.trim() || null,
  // Left as it is when an edit does not say; a new profile starts on Zoho's "No Rounding" (createProfile).
  ...(input.roundOff ? { round_off: input.roundOff } : {}),
  price_list_id: input.priceListId ?? null,
  project_ids: input.projectIds?.length ? JSON.stringify([...new Set(input.projectIds)]) : null,
  payment_link: input.paymentLink ? 1 : 0,
  create_as_draft: input.createAsDraft ? 1 : 0,
  auto_send: input.autoSend ? 1 : 0,
});

export async function createProfile(ex: Executor, orgId: number, input: ProfileInput): Promise<number> {
  await checkProfile(ex, orgId, input);
  const r = await ex.insertInto('recurring_invoices')
    .values({ org_id: orgId, round_off: 'none' as const, ...values(input), next_run: input.startDate, auto_run: input.autoRun ? 1 : 0, is_active: 1 })
    .executeTakeFirstOrThrow();
  return Number(r.insertId);
}

/**
 * Zoho's Edit: the profile's terms change from the next invoice on. One that
 * has not raised anything yet starts again from its (new) start date.
 */
export async function updateProfile(ex: Executor, orgId: number, id: number, input: ProfileInput): Promise<void> {
  const p = await ex.selectFrom('recurring_invoices').select(['id', 'last_generated_at', 'next_run'])
    .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!p) throw notFound('That recurring invoice does not exist.');
  await checkProfile(ex, orgId, input);
  const next = p.last_generated_at
    ? advancePeriod(String(p.last_generated_at).slice(0, 10), input.frequency, input.every)
    : input.startDate;
  await ex.updateTable('recurring_invoices').set({ ...values(input), next_run: next, last_error: null }).where('id', '=', id).execute();
}

export interface ProfileDetail {
  id: string; name: string; orderNumber: string | null; branchId: string;
  entityType: EntityType;
  shippingChargePaise: number; adjustmentPaise: number; adjustmentLabel: string; roundOff: RoundOff;
  /** The next invoice's figures: what its lines come to, its tax, and the paise the rounding moves. */
  subTotalPaise: number; taxPaise: number; roundOffPaise: number;
  customerId: string; customerName: string; customerEmail: string | null;
  salespersonId: string | null; salespersonName: string | null;
  frequency: Frequency; every: number; repeatLabel: string;
  startDate: string; endDate: string | null; nextRun: string | null; lastGeneratedAt: string | null;
  paymentTerms: string | null; lines: TemplateLine[]; notes: string | null; terms: string | null;
  priceListId: string | null; priceListName: string | null;
  projects: { id: string; name: string }[];
  paymentLink: boolean;
  createAsDraft: boolean; autoSend: boolean; autoRun: boolean; isActive: boolean; lastError: string | null;
  /** Zoho's Profile Status: Active, Stopped or Expired. */
  status: 'active' | 'stopped' | 'expired';
  amountPaise: number;
  /** What is left of its cycles when it has an end date; null when it never expires. */
  remainingCycles: number | null;
  invoices: { id: string; number: string; date: string; status: string; totalPaise: number; balancePaise: number }[];
  unpaidPaise: number;
  /** Zoho's Recent Activities: the profile's own trail (created, edited, stopped, invoices created). */
  activities: { at: string; actor: string | null; action: string; detail: string | null }[];
}

export async function profileDetail(ex: Executor, orgId: number, id: number, today: string): Promise<ProfileDetail> {
  const p = await ex.selectFrom('recurring_invoices as r').innerJoin('contacts as c', 'c.id', 'r.customer_id')
    .leftJoin('users as u', 'u.id', 'r.salesperson_id')
    .select(['r.id', 'r.profile_name', 'r.order_number', 'r.branch_id', 'r.customer_id', 'c.display_name', 'c.email', 'r.salesperson_id', 'u.name as salesperson',
      'r.frequency', 'r.repeat_every', 'r.start_date', 'r.end_date', 'r.next_run', 'r.last_generated_at', 'r.payment_terms', 'r.template',
      'r.notes', 'r.terms', 'r.create_as_draft', 'r.auto_send', 'r.auto_run', 'r.is_active', 'r.last_error', 'r.price_list_id', 'r.project_ids', 'r.payment_link',
      'r.entity_type', 'r.shipping_charge', 'r.adjustment', 'r.adjustment_label', 'r.round_off'])
    .where('r.id', '=', id).where('r.org_id', '=', orgId).executeTakeFirst();
  if (!p) throw notFound('That recurring invoice does not exist.');
  const lines = (typeof p.template === 'string' ? JSON.parse(p.template) : p.template) as TemplateLine[];
  const freq = p.frequency as Frequency;
  const every = Number(p.repeat_every) || 1;
  const end = p.end_date ? String(p.end_date).slice(0, 10) : null;
  const next = String(p.next_run).slice(0, 10);
  const expired = !!end && next > end;
  let remaining: number | null = null;
  if (end) {
    remaining = 0;
    for (let d = next; d <= end && remaining < 1000; d = advancePeriod(d, freq, every)) remaining++;
  }
  const invoices = await ex.selectFrom('invoices').select(['id', 'number', 'invoice_date', 'status', 'total', 'amount_paid'])
    .where('org_id', '=', orgId).where(sql<boolean>`source_doc_type = 'recurring'`).where(sql<boolean>`source_doc_id = ${id}`)
    .orderBy('invoice_date', 'desc').orderBy('id', 'desc').limit(100).execute();
  const entityType = (p.entity_type ?? 'invoice') as EntityType;
  const shipping = toPaiseFromSql(p.shipping_charge ?? '0');
  const adjustment = toPaiseFromSql(p.adjustment ?? '0');
  const roundOff = (p.round_off ?? 'whole') as RoundOff;
  const amount = profileAmount({ lines, entityType, shippingPaise: shipping, adjustmentPaise: adjustment, roundOff });
  const projectIds = (typeof p.project_ids === 'string' ? JSON.parse(p.project_ids) : p.project_ids ?? []) as number[];
  const projects = projectIds.length
    ? await ex.selectFrom('projects').select(['id', 'name']).where('org_id', '=', orgId).where('id', 'in', projectIds.map(Number)).execute()
    : [];
  const priceList = p.price_list_id
    ? await ex.selectFrom('price_lists').select(['id', 'name']).where('id', '=', p.price_list_id).where('org_id', '=', orgId).executeTakeFirst()
    : undefined;
  const children = invoices.map((i) => ({
    id: String(i.id), number: i.number, date: String(i.invoice_date).slice(0, 10), status: i.status,
    totalPaise: toPaiseFromSql(i.total), balancePaise: toPaiseFromSql(i.total) - toPaiseFromSql(i.amount_paid),
  }));
  void today;
  const trail = await ex.selectFrom('audit_log').select(['created_at', 'actor_name', 'action', 'detail'])
    .where('org_id', '=', orgId).where('target_type', '=', 'recurring_invoice').where('target_id', '=', String(id))
    .orderBy('id', 'desc').limit(50).execute();
  return {
    id: String(p.id), name: p.profile_name, orderNumber: p.order_number ?? null, branchId: String(p.branch_id),
    entityType, shippingChargePaise: shipping, adjustmentPaise: adjustment, adjustmentLabel: p.adjustment_label || 'Adjustment', roundOff,
    subTotalPaise: amount.subTotalPaise, taxPaise: amount.taxPaise, roundOffPaise: amount.roundOffPaise,
    customerId: String(p.customer_id), customerName: p.display_name, customerEmail: p.email ?? null,
    salespersonId: p.salesperson_id ? String(p.salesperson_id) : null, salespersonName: p.salesperson ?? null,
    frequency: freq, every, repeatLabel: repeatLabel(freq, every),
    startDate: String(p.start_date).slice(0, 10), endDate: end, nextRun: expired ? null : next,
    lastGeneratedAt: p.last_generated_at ? String(p.last_generated_at).slice(0, 10) : null,
    paymentTerms: p.payment_terms ?? null, lines, notes: p.notes ?? null, terms: p.terms ?? null,
    priceListId: priceList ? String(priceList.id) : null, priceListName: priceList?.name ?? null,
    projects: projects.map((x) => ({ id: String(x.id), name: x.name })),
    paymentLink: !!p.payment_link,
    createAsDraft: !!p.create_as_draft, autoSend: !!p.auto_send, autoRun: !!p.auto_run, isActive: !!p.is_active, lastError: p.last_error ?? null,
    status: expired ? 'expired' : p.is_active ? 'active' : 'stopped',
    amountPaise: amount.totalPaise,
    remainingCycles: remaining,
    invoices: children,
    unpaidPaise: children.filter((c) => c.status !== 'void' && c.status !== 'draft').reduce((t, c) => t + Math.max(0, c.balancePaise), 0),
    activities: trail.map((a) => ({ at: new Date(a.created_at).toISOString(), actor: a.actor_name, action: a.action, detail: a.detail })),
  };
}
