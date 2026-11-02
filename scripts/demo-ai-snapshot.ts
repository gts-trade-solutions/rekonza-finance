// Records what the assistant's lookups return for the demo book, for the
// online demo (lib/server/ai/demo-playback.ts), which has no database.
//
//   npx tsx --conditions=react-server --env-file=.env.local scripts/demo-ai-snapshot.ts
//
// Reads only: every lookup is read-only, and nothing here writes. Run it
// whenever the demo snapshot is recorded again (scripts/demo-snapshot.ts), so
// the assistant and the screens show the same figures.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../lib/server/db';
import { runTool, type AccountRow, type ToolContext } from '../lib/server/ai/tools';
import { extractPeriod } from '../lib/server/ai/standin';
import { fyStartOf, istDate } from '../lib/server/ai/time';
import type { AiRecording, RecordedRun } from '../lib/server/ai/demo-playback';

const OUT = join(process.cwd(), 'lib', 'server', 'ai', 'demo-recording.json');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

async function main() {
  const org = await db.selectFrom('organizations').select(['id', 'name', 'legal_name']).where('is_demo', '=', 1).orderBy('id').executeTakeFirstOrThrow();
  const admin = await db.selectFrom('users').select(['id', 'name']).where('org_id', '=', org.id).where('role', '=', 'admin').orderBy('id').executeTakeFirstOrThrow();
  const today = istDate();
  const fyStart = fyStartOf(today);
  const ctx: ToolContext = { ex: db, orgId: org.id, userId: admin.id, role: 'admin', today, fyStart };

  // The periods a question is likely to name, as the stand-in reads them.
  const phrases = ['this month', 'last month', 'this quarter', 'last quarter', 'last financial year'];
  for (let d = fyStart; d.slice(0, 7) <= today.slice(0, 7); ) {
    phrases.push(`in ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`);
    const [y, m] = d.split('-').map(Number);
    d = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  const periods: Record<string, unknown>[] = [{}];
  const months: string[] = [];
  for (const p of phrases) {
    const r = extractPeriod(p, today);
    if (!r) continue;
    periods.push({ from: r.from, to: r.to });
    if (r.month && !months.includes(r.month)) months.push(r.month);
  }

  const [contacts, items, accounts, banks] = await Promise.all([
    db.selectFrom('contacts').select(['display_name', 'kind']).where('org_id', '=', org.id).where('is_archived', '=', 0).orderBy('display_name').execute(),
    db.selectFrom('items').select(['name']).where('org_id', '=', org.id).where('is_archived', '=', 0).where('track_inventory', '=', 1).orderBy('name').execute(),
    db.selectFrom('accounts').select(['id', 'code', 'name', 'type']).where('org_id', '=', org.id).where('is_active', '=', 1).orderBy('code').execute(),
    db.selectFrom('bank_accounts').select(['name', 'bank_name', 'ledger_account_id']).where('org_id', '=', org.id).execute(),
  ]);
  const customers = contacts.filter((c) => c.kind !== 'vendor').map((c) => c.display_name);
  const vendors = contacts.filter((c) => c.kind !== 'customer').map((c) => c.display_name);
  // Only accounts that have moved: the rest answer "nothing posted" the same way.
  const moved = await db.selectFrom('journal_lines').select('account_id').distinct().where('org_id', '=', org.id).execute();
  const movedIds = new Set(moved.map((r) => r.account_id));

  const calls: [string, Record<string, unknown>][] = [];
  const add = (name: string, args: Record<string, unknown> = {}) => calls.push([name, args]);

  for (const p of periods) {
    add('get_profit_and_loss', p);
    for (const g of ['customer', 'item', 'salesperson', 'month']) add('get_sales_summary', { group_by: g, ...p });
    add('get_expense_summary', p);
    add('get_business_ratios', p);
    add('get_cash_flow', p);
    add('search_payments', { direction: 'received', ...p });
    add('search_payments', { direction: 'made', ...p });
  }
  for (const m of ['cash', 'cheque', 'neft', 'rtgs', 'imps', 'upi', 'card']) {
    add('search_payments', { direction: 'received', mode: m });
    add('search_payments', { direction: 'made', mode: m });
  }
  for (const c of customers) add('search_payments', { direction: 'received', party: c });
  for (const v of vendors) add('search_payments', { direction: 'made', party: v });

  add('get_gst_summary');
  for (const m of months) add('get_gst_summary', { month: m });

  for (const a of accounts) if (movedIds.has(a.id)) add('get_account_balance', { account: a.code });
  add('list_accounts');
  for (const t of ['asset', 'liability', 'equity', 'income', 'expense']) add('list_accounts', { type: t });
  add('get_trial_balance');
  add('get_balance_sheet');
  add('get_cash_position');
  add('get_attention_items');

  add('get_receivables');
  for (const c of customers) add('get_receivables', { customer: c });
  add('get_payables');
  for (const v of vendors) add('get_payables', { vendor: v });
  for (const c of contacts) add('get_party_statement', { party: c.display_name, side: c.kind === 'vendor' ? 'vendor' : 'customer' });
  for (const c of contacts.filter((x) => x.kind === 'both')) add('get_party_statement', { party: c.display_name, side: 'vendor' });

  for (const s of ['unpaid', 'overdue', 'paid', 'draft', 'any']) {
    add('search_invoices', { status: s });
    add('search_bills', { status: s });
  }
  for (const c of customers) for (const s of ['unpaid', 'any']) add('search_invoices', { status: s, customer: c });
  for (const v of vendors) for (const s of ['unpaid', 'any']) add('search_bills', { status: s, vendor: v });

  add('get_stock');
  add('get_stock', { view: 'ageing' });
  for (const i of items) add('get_stock', { item: i.name });

  add('get_tds_summary');
  const fy = Number(fyStart.slice(0, 4));
  for (const q of [1, 2, 3, 4]) add('get_tds_summary', { fy, quarter: q });
  add('get_compliance_calendar');
  add('get_bank_reconciliation');
  for (const s of ['active', 'completed', 'all']) add('get_projects', { status: s });
  add('get_payroll_summary');
  add('get_fixed_assets');
  add('get_budget_vs_actual');
  for (const k of ['all', 'quotes', 'sales_orders', 'purchase_orders']) add('get_open_orders', { kind: k });
  add('get_collections');
  for (const c of customers) add('get_collections', { customer: c });
  for (const side of ['both', 'receive', 'pay']) for (const due of ['all', 'overdue', 'next_7_days', 'this_month']) add('get_pending_payments', { side, due });
  for (const c of customers) add('get_pending_payments', { side: 'receive', party: c });
  for (const v of vendors) add('get_pending_payments', { side: 'pay', party: v });
  for (const c of contacts) add('get_pending_payments', { party: c.display_name });

  const tools: Record<string, RecordedRun[]> = {};
  let failed = 0;
  for (const [name, args] of calls) {
    const out = await runTool(ctx, { id: 'rec', name, arguments: JSON.stringify(args) });
    if (!out.ok && !/"found":false/.test(out.content)) {
      failed++;
      console.warn(`  ! ${name} ${JSON.stringify(args)}: ${out.content.slice(0, 160)}`);
    }
    // The key is put back at playback, from the arguments the model used.
    const report = out.report ? (Object.fromEntries(Object.entries(out.report).filter(([k]) => k !== 'key')) as RecordedRun['report']) : null;
    (tools[name] ??= []).push({ args, content: out.content, sources: out.sources, report });
  }

  const recording: AiRecording = {
    recordedAt: new Date().toISOString(),
    today,
    fyStart,
    orgName: org.legal_name || org.name,
    userName: admin.name,
    role: 'admin',
    accounts: accounts as AccountRow[],
    banks,
    tools,
  };
  const json = JSON.stringify(recording);
  writeFileSync(OUT, json);
  console.log(`Recorded ${calls.length} lookups (${failed} failed) for ${org.name}, as at ${today}: ${(json.length / 1024).toFixed(0)} KB → ${OUT}`);
  await db.destroy();
}

main().catch(async (err) => {
  console.error(err);
  await db.destroy();
  process.exit(1);
});
