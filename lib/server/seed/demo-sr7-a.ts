// ─────────────────────────────────────────────────────────────────────────────
// Status review 7, builder A: the demo book's records for the five items the
// auditors marked "Not Resolved", so each screen they open shows real data.
//
//   1. Consolidation: a second demo company, Race Auto Exports Pvt Ltd, with
//      the same demo users; the demo book owns 75% of it (paid ₹8,00,000 for
//      75% of ₹10,00,000 share capital: ₹50,000 goodwill). The demo book sells
//      it brake pads; it enters the bill, sells some on and still holds the
//      rest (unrealised profit), and pays part of what it owes.
//   2. Audit trail: the chain seals the seeded trail when it is first opened.
//   4. Voucher reversal: an accrual reversed on the 1st, a duplicate journal
//      reversed with its reason, an auto-reversal due next month, and a
//      reversal waiting for a second person's approval.
//  12. Budgets: "Original" monthly budget from this year's run rate, a
//      "Revised" clone at +5%, and the workshop cost centre's own budget.
//  13. Custom report filters: a Region reporting tag on invoices, a project
//      on two invoices, and two saved custom reports, shared.
//
// Called once from scripts/seed.ts; --fresh wipes both demo companies
// (is_demo) and rebuilds them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { logAudit } from '../audit';
import { bootstrap, type IdMap } from './bootstrap';
import { DEMO_TODAY } from './demo-book';
import { CODE, accountIds } from '../ledger/chart-of-accounts';
import { postEntry } from '../ledger/posting';
import { createInvoice } from '../services/sales';
import { createBill } from '../services/purchases';
import { makePayment, receivePayment } from '../services/payments';
import { postManualJournal } from '../services/journals';
import { postReversal } from '../services/voucher-reversals';
import { recordApprovalAction } from '../services/approvals';
import { saveGroup } from '../reports/consolidated';
import { actualsForPlan, clonePlan, savePlan } from '../reports/budget-plans';
import { fyLabelFor } from '../reports/budgets';
import { toSqlFromPaise } from '../money-sql';

const R = (rupees: number) => Math.round(rupees * 100);
/** n days before the book's date (a negative n is after it). */
const day = (n: number) => {
  const [y, m, d] = DEMO_TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};

export async function seedDemoSr7A(trx: Trx, ids: IdMap): Promise<void> {
  const org = ids.orgId;
  const chennai = ids.branches.br_chennai;
  const admin = ids.users.u_arun;
  const accountant = ids.users.u_priya;
  const acc = ids.accounts;
  const fy = fyLabelFor(DEMO_TODAY);
  const fyFrom = `${fy.slice(0, 4)}-04-01`;

  // ── 2. Audit log export ────────────────────────────────────────────────────
  // The auditors' quarter-end export of the trail, as the screen records one
  // (app/api/audit/export): the demo's Auditor Review then has it to show.
  await logAudit({
    trx, orgId: org, actorUserId: accountant, actorName: 'Priya Raman', action: 'export', targetType: 'output', targetId: 'audit-trail',
    targetLabel: 'Audit trail', detail: `Exported the audit trail: every event from ${fyFrom} to ${day(1)}, as Excel, for the statutory auditors`,
  });

  // ── 4. Voucher reversals ───────────────────────────────────────────────────
  const accrual = await postManualJournal(trx, org, accountant, {
    branchId: chennai, date: day(30), memo: 'Electricity for last month, bill not yet received (accrual)', reverseOn: day(29),
    lines: [{ accountId: acc[CODE.UTILITIES], debitPaise: R(18_500) }, { accountId: acc[CODE.PROVISIONS], creditPaise: R(18_500) }],
  });
  void accrual;
  const duplicate = await postManualJournal(trx, org, accountant, {
    branchId: chennai, date: day(22), memo: 'Showroom rent for the month',
    lines: [{ accountId: acc[CODE.RENT], debitPaise: R(45_000) }, { accountId: acc[CODE.BANK_DEFAULT], creditPaise: R(45_000) }],
  });
  await postReversal(trx, org, duplicate.id, {
    date: day(21), reason: 'Rent for the month entered twice; the bank statement shows one payment', kind: 'manual',
    requestedBy: admin, approvedBy: null, postedBy: admin,
  });
  // A provision that reverses itself next month: due, not yet posted.
  await postManualJournal(trx, org, accountant, {
    branchId: chennai, date: day(2), memo: 'Provision for statutory audit fee (reverses next month)', reverseOn: day(-10),
    lines: [{ accountId: acc[CODE.PROFESSIONAL], debitPaise: R(60_000) }, { accountId: acc[CODE.PROVISIONS], creditPaise: R(60_000) }],
  });
  // A reversal waiting for a second person: asked for by the accountant.
  const freight = await postManualJournal(trx, org, admin, {
    branchId: chennai, date: day(9), memo: 'Freight on the MRF consignment',
    lines: [{ accountId: acc[CODE.FREIGHT], debitPaise: R(12_400) }, { accountId: acc[CODE.BANK_DEFAULT], creditPaise: R(12_400) }],
  });
  const lines = await trx.selectFrom('journal_lines').select(['account_id', 'debit', 'credit', 'description', 'contact_id', 'cost_centre_id']).where('entry_id', '=', freight.id).execute();
  const held = Number((await trx.insertInto('held_journals').values({
    org_id: org, branch_id: chennai, kind: 'approval', entry_date: day(3), memo: `Reversal of #${freight.entryNo}: Freight belongs in the purchase cost, per the auditor's note`,
    entry_lines: JSON.stringify(lines.map((l) => ({ accountId: l.account_id, debitPaise: Math.round(Number(l.credit) * 100), creditPaise: Math.round(Number(l.debit) * 100), description: l.description, contactId: l.contact_id, costCentreId: l.cost_centre_id }))),
    total_amount: toSqlFromPaise(R(12_400)), created_by_user_id: accountant, reverses_entry_id: freight.id,
    reason: "Freight belongs in the purchase cost, per the auditor's note",
  }).executeTakeFirstOrThrow()).insertId);
  await recordApprovalAction(trx, org, 'journal', held, 'submitted', accountant, "Freight belongs in the purchase cost, per the auditor's note");

  // ── 13. A reporting tag, a project, saved custom reports ───────────────────
  const tag = Number((await trx.insertInto('reporting_tags').values({ org_id: org, name: 'Region' }).executeTakeFirstOrThrow()).insertId);
  const south = Number((await trx.insertInto('reporting_tag_options').values({ org_id: org, tag_id: tag, value: 'South' }).executeTakeFirstOrThrow()).insertId);
  const north = Number((await trx.insertInto('reporting_tag_options').values({ org_id: org, tag_id: tag, value: 'North' }).executeTakeFirstOrThrow()).insertId);
  const invoices = await trx.selectFrom('invoices').select(['id', 'branch_id', 'customer_id']).where('org_id', '=', org).where('status', 'not in', ['draft', 'void'])
    .where('doc_kind' as never, '=', 'invoice' as never).orderBy('invoice_date', 'desc').limit(16).execute();
  for (const i of invoices) {
    await trx.insertInto('reporting_tag_links').values({ org_id: org, tag_id: tag, option_id: i.branch_id === chennai ? south : north, entity: 'invoice', entity_id: i.id }).execute();
  }
  const fleetCustomer = invoices[0]?.customer_id;
  if (fleetCustomer) {
    const project = Number((await trx.insertInto('projects').values({ org_id: org, customer_id: fleetCustomer, name: 'Fleet maintenance contract', billing_method: 'fixed', fixed_amount: '250000' } as never).executeTakeFirstOrThrow()).insertId);
    const theirs = invoices.filter((i) => i.customer_id === fleetCustomer).slice(0, 2).map((i) => i.id);
    if (theirs.length) await trx.updateTable('invoices').set({ project_id: project }).where('id', 'in', theirs).execute();
  }
  const workshop = (await trx.selectFrom('cost_centres').select('id').where('org_id', '=', org).where('code', '=', 'SERVICE').executeTakeFirst())?.id ?? null;
  await trx.insertInto('saved_views').values([
    {
      org_id: org, user_id: admin, list: 'report-profit-and-loss', name: 'Workshop P&L by month', is_shared: 1,
      filters: JSON.stringify({ report: 'profit-and-loss', from: fyFrom, to: DEMO_TODAY, basis: 'accrual', reportBy: 'month', compareMode: 'none', accounts: 'non_zero', filter: { costCentreIds: workshop ? [String(workshop)] : [] } }),
    },
    {
      org_id: org, user_id: admin, list: 'report-profit-and-loss', name: 'Sales by region: North', is_shared: 1,
      filters: JSON.stringify({ report: 'profit-and-loss', from: fyFrom, to: DEMO_TODAY, basis: 'accrual', reportBy: 'total', compareMode: 'none', accounts: 'non_zero', filter: { tagOptionIds: [String(north)] } }),
    },
    {
      org_id: org, user_id: accountant, list: 'report-trial-balance', name: 'Trial balance, every account', is_shared: 1,
      filters: JSON.stringify({ report: 'trial-balance', from: fyFrom, to: DEMO_TODAY, basis: 'accrual', reportBy: 'total', compareMode: 'none', accounts: 'all', filter: {}, columns: { net: true, type: true } }),
    },
  ]).execute();

  // ── 12. Budgets: Original, Revised (+5%), and the workshop's own ───────────
  const run = await actualsForPlan(trx, org, { fyLabel: fy, period: 'monthly', accountIds: [], sourceFy: fy });
  const types = new Map((await trx.selectFrom('accounts').select(['id', 'type']).where('org_id', '=', org).execute()).map((a) => [String(a.id), a.type]));
  const monthsGone = Math.max(1, Number(DEMO_TODAY.slice(5, 7)) >= 4 ? Number(DEMO_TODAY.slice(5, 7)) - 3 : Number(DEMO_TODAY.slice(5, 7)) + 9);
  const original = run.lines
    .filter((l) => types.get(l.accountId) === 'income' || types.get(l.accountId) === 'expense')
    .map((l) => {
      const avg = l.amountsPaise.reduce((t, a) => t + a, 0) / monthsGone;
      // A plan a little ahead of the run rate on income and a little below it on costs, rounded to ₹1,000.
      const target = Math.max(0, Math.round((avg * (types.get(l.accountId) === 'income' ? 1.08 : 0.95)) / 1_000_00) * 1_000_00);
      return { accountId: Number(l.accountId), amountsPaise: Array(12).fill(target) };
    })
    .filter((l) => l.amountsPaise[0] > 0);
  if (original.length) {
    const id = await savePlan(trx, org, admin, { name: 'Original', fyLabel: fy, period: 'monthly', isPrimary: true, notes: 'Approved by the board in April', lines: original });
    await clonePlan(trx, org, admin, id, { name: 'Revised', adjustPct: 5 });
  }
  if (workshop) {
    const ws = await actualsForPlan(trx, org, { fyLabel: fy, period: 'quarterly', accountIds: [], sourceFy: fy, costCentreId: workshop });
    const lines = ws.lines.filter((l) => l.amountsPaise.some((a) => a > 0)).map((l) => ({ accountId: Number(l.accountId), amountsPaise: l.amountsPaise.map((a, i) => (a > 0 ? a : (ws.lines.find((x) => x.accountId === l.accountId)!.amountsPaise[Math.max(0, i - 1)] || 0))).map((a) => Math.round((a * 1.1) / 1_000_00) * 1_000_00) }));
    if (lines.length) await savePlan(trx, org, admin, { name: 'Workshop and fitment', fyLabel: fy, period: 'quarterly', costCentreId: workshop, notes: 'Cost centre budget', lines });
  }

  // ── 1. A second group company, 75% owned ───────────────────────────────────
  const sub = await bootstrap(trx, {
    isDemo: true, minimal: true,
    org: { name: 'Race Auto Exports Pvt Ltd', pan: 'AAGCR4232G', email: 'accounts@raceautoexports.in', gstRegistrationType: 'regular' },
    branch: { name: 'Chennai — Race Auto Exports', stateCode: '33', gstin: '33AAGCR4232G1ZD', address: 'Plot 14, SIDCO Industrial Estate, Ambattur, Chennai', city: 'Chennai', pincode: '600098' },
    admin: { name: 'Arun Kumar', email: 'arun@raceautospares.in', password: 'replaced below' },
  });
  const subOrg = sub.orgId;
  const subBranch = Object.values(sub.branches)[0];
  const subAcc = await accountIds(trx, subOrg);
  const subAdmin = Object.values(sub.users)[0];
  // The demo book's people, with their own passwords and roles there too (a person is a user in each company).
  const people = await trx.selectFrom('users').select(['name', 'email', 'role', 'password_hash']).where('org_id', '=', org).execute();
  for (const u of people) {
    if (u.email === 'arun@raceautospares.in') await trx.updateTable('users').set({ password_hash: u.password_hash }).where('id', '=', subAdmin).execute();
    else await trx.insertInto('users').values({ org_id: subOrg, name: u.name, email: u.email, role: u.role, password_hash: u.password_hash, home_branch_id: subBranch, is_active: 1 } as never).execute();
  }
  const subBank = Number((await trx.insertInto('bank_accounts').values({
    org_id: subOrg, kind: 'bank', name: 'HDFC Bank – Current', bank_name: 'HDFC Bank', account_last4: '7781', ledger_account_id: subAcc[CODE.BANK_DEFAULT], opening_balance: '0', is_primary: 0, is_active: 1,
  } as never).executeTakeFirstOrThrow()).insertId);
  // Each knows the other by PAN.
  const subAsCustomer = Number((await trx.insertInto('contacts').values({ org_id: org, kind: 'customer', display_name: 'Race Auto Exports Pvt Ltd', pan: 'AAGCR4232G', gstin: '33AAGCR4232G1ZD', gst_treatment: 'registered', state_code: '33' } as never).executeTakeFirstOrThrow()).insertId);
  const parentAsVendor = Number((await trx.insertInto('contacts').values({ org_id: subOrg, kind: 'vendor', display_name: 'Race Auto Spares Pvt Ltd', pan: 'AAGCR4231F', gst_treatment: 'registered', state_code: '33' } as never).executeTakeFirstOrThrow()).insertId);
  const kovai = Number((await trx.insertInto('contacts').values({ org_id: subOrg, kind: 'customer', display_name: 'Kovai Motors', gst_treatment: 'unregistered', state_code: '33' } as never).executeTakeFirstOrThrow()).insertId);
  // The same brake pads, by name and SKU, in both books.
  const pad = await trx.selectFrom('items').select(['id', 'name', 'sku', 'hsn_sac', 'sale_price']).where('org_id', '=', org).where('sku', '=', 'BP-SW-101').executeTakeFirst()
    ?? await trx.selectFrom('items').select(['id', 'name', 'sku', 'hsn_sac', 'sale_price']).where('org_id', '=', org).where('kind', '=', 'goods').where('track_inventory', '=', 1).orderBy('id').executeTakeFirstOrThrow();
  const subPad = Number((await trx.insertInto('items').values({
    org_id: subOrg, name: pad.name, sku: pad.sku, hsn_sac: pad.hsn_sac, kind: 'goods', track_inventory: 1, purchase_price: '1450', sale_price: '1950', gst_rate_pct: '18', uqc: 'NOS',
  } as never).executeTakeFirstOrThrow()).insertId);
  // Share capital, and the parent's investment in it.
  const capitalDate = `${fy.slice(0, 4)}-10-01` <= DEMO_TODAY ? `${fy.slice(0, 4)}-10-01` : day(40);
  await postEntry(trx, { orgId: subOrg, branchId: subBranch, date: capitalDate, sourceType: 'manual', memo: 'Equity shares issued: 1,00,000 of ₹10', userId: subAdmin, module: 'accountant', lines: [
    { accountId: subAcc[CODE.BANK_DEFAULT], debit: R(10_00_000) }, { accountId: subAcc[CODE.CAPITAL], credit: R(10_00_000) }] });
  await postEntry(trx, { orgId: org, branchId: chennai, date: capitalDate, sourceType: 'manual', memo: '75,000 equity shares of Race Auto Exports Pvt Ltd (75%)', userId: admin, module: 'accountant', lines: [
    { accountId: acc[CODE.INVESTMENTS], debit: R(8_00_000) }, { accountId: acc[CODE.BANK_DEFAULT], credit: R(8_00_000) }] });
  // The demo book sells it 40 sets; it bills them; sells 15 on; pays ₹40,000.
  const sale = await createInvoice(trx, org, accountant, {
    branchId: chennai, customerId: subAsCustomer, date: day(20), dueDate: day(-10), status: 'approved',
    lines: [{ itemId: pad.id, description: pad.name, hsnSac: pad.hsn_sac, qty: 40, ratePaise: R(1_450), gstRatePct: 18 }],
  } as never);
  await createBill(trx, subOrg, subAdmin, {
    branchId: subBranch, vendorId: parentAsVendor, vendorInvoiceNo: sale.number, date: day(18), dueDate: day(-12), status: 'open',
    lines: [{ itemId: subPad, description: pad.name, qty: 40, ratePaise: R(1_450), gstRatePct: 18 }],
  } as never);
  await createInvoice(trx, subOrg, subAdmin, {
    branchId: subBranch, customerId: kovai, date: day(12), dueDate: day(12), status: 'approved',
    lines: [{ itemId: subPad, description: pad.name, hsnSac: pad.hsn_sac, qty: 15, ratePaise: R(1_950), gstRatePct: 18 }],
  } as never);
  await makePayment(trx, subOrg, subAdmin, { branchId: subBranch, contactId: parentAsVendor, date: day(6), mode: 'neft', amountPaise: R(40_000), bankAccountId: subBank, reference: 'NEFT HDFCN26112' });
  const parentBank = (await trx.selectFrom('bank_accounts').select('id').where('org_id', '=', org).where('kind', '=', 'bank').orderBy('id').executeTakeFirstOrThrow()).id;
  await receivePayment(trx, org, accountant, { branchId: chennai, contactId: subAsCustomer, date: day(6), mode: 'neft', amountPaise: R(40_000), bankAccountId: Number(parentBank), reference: 'NEFT HDFCN26112' });
  // The group: 75% owned since the shares were issued; the investment in 1700.
  await saveGroup(trx, 'arun@raceautospares.in', admin, {
    parentOrgId: String(org), name: 'Race Auto group',
    members: [{ orgId: String(subOrg), ownershipPct: 75, acquiredOn: capitalDate, investmentAccountId: String(acc[CODE.INVESTMENTS]) }],
    links: [],
  });
}
