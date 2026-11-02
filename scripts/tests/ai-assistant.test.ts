// The assistant across the whole book: the lookups beyond the ledger, the
// stand-in's reading of a question, a whole question through OpenAI's
// streaming API (against a stand-in server), and the online demo's playback.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/ai-assistant.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { receivePayment } from '../../lib/server/services/payments';
import { postEntry } from '../../lib/server/ledger/posting';
import { runTool, toolSpecsFor, hiddenAreas, type ToolContext } from '../../lib/server/ai/tools';
import { extractItem, extractParty, extractPeriod, isGreeting, isHelp, planTools, StandinProvider, todayFromMessages } from '../../lib/server/ai/standin';
import { buildSystemPrompt } from '../../lib/server/ai/prompt';
import { runAgent } from '../../lib/server/ai/agent';
import { OpenAiProvider } from '../../lib/server/ai/openai';
import { priceFor } from '../../lib/server/ai/pricing';
import { playLookup, type AiRecording } from '../../lib/server/ai/demo-playback';
import { demoChat, demoConversation, demoReportDownload, demoReportQuote } from '../../lib/server/ai/demo-chat';

const TODAY = '2026-10-31';
const FY = '2026-04-01';

interface Book { trx: Trx; orgId: number; branchId: number; customer: number; vendor: number; bankId: number; ctx: ToolContext }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Assistant Co', address: '9 Mount Road, Chennai' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCA6666A1Z1' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const contact = (kind: string, name: string) => trx.insertInto('contacts')
        .values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const customer = await contact('customer', 'Kumar Stores');
      await contact('customer', 'Kumaran Traders');
      const vendor = await contact('vendor', 'Steel Supply');
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      const ctx: ToolContext = { ex: trx, orgId, userId: 0, role: 'admin', today: TODAY, fyStart: FY };
      await fn({ trx, orgId, branchId, customer, vendor, bankId, ctx });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const ask = async (ctx: ToolContext, name: string, args: Record<string, unknown> = {}) => {
  const out = await runTool(ctx, { id: 't', name, arguments: JSON.stringify(args) });
  return { ...out, data: JSON.parse(out.content) };
};

// ── The lookups ──────────────────────────────────────────────────────────────

test('every area has a lookup, and a role is offered only the areas it sees', () => {
  const admin = toolSpecsFor('admin').map((t) => t.name);
  for (const t of ['get_stock', 'get_party_statement', 'search_payments', 'get_tds_summary', 'get_compliance_calendar', 'get_bank_reconciliation',
    'get_projects', 'get_payroll_summary', 'get_fixed_assets', 'get_budget_vs_actual', 'get_open_orders', 'get_collections', 'get_pending_payments']) {
    assert.ok(admin.includes(t), `admin is offered ${t}`);
  }
  const sales = toolSpecsFor('sales').map((t) => t.name);
  assert.ok(sales.includes('get_stock') && sales.includes('get_collections') && sales.includes('get_party_statement'));
  for (const t of ['get_payroll_summary', 'get_fixed_assets', 'get_budget_vs_actual', 'get_tds_summary', 'get_bank_reconciliation']) {
    assert.ok(!sales.includes(t), `sales is not offered ${t}`);
  }
  assert.ok(!toolSpecsFor('viewer').some((t) => t.name === 'get_payroll_summary'), 'salaries stay with admins and accountants');
  assert.ok(hiddenAreas('sales').includes('salaries and payroll'));
  assert.deepEqual(hiddenAreas('admin'), []);
});

test('a statement, payments and what one named customer owes come from the books', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, bankId, ctx }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-09-01', dueDate: '2026-09-15', status: 'approved',
      lines: [{ description: 'Goods', qty: 1, ratePaise: 5_000_00, gstRatePct: 0 }],
    });
    await receivePayment(trx, orgId, null, {
      branchId, contactId: customer, date: '2026-09-20', mode: 'upi', amountPaise: 2_000_00, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 2_000_00 }],
    });

    const st = await ask(ctx, 'get_party_statement', { party: 'Kumar Stores' });
    assert.equal(st.data.party, 'Kumar Stores');
    assert.equal(st.data.closing_balance, '₹3,000.00');
    assert.match(st.data.meaning, /owes the business/);
    assert.equal(st.report?.title, 'Statement · Kumar Stores');

    const vague = await ask(ctx, 'get_party_statement', { party: 'Kumar' });
    assert.equal(vague.data.found, false, 'two customers start with Kumar: asked, not guessed');
    assert.equal(vague.data.candidates.length, 2);

    const paid = await ask(ctx, 'search_payments', { direction: 'received', mode: 'upi' });
    assert.equal(paid.data.payments, 1);
    assert.equal(paid.data.total, '₹2,000.00');

    const owes = await ask(ctx, 'get_receivables', { customer: 'Kumar Stores' });
    assert.equal(owes.data.customers[0].owes, '₹3,000.00');
    assert.equal(owes.data.open_invoices.length, 1);
    const nobody = await ask(ctx, 'get_receivables', { customer: 'Kumaran Traders' });
    assert.match(nobody.data.note, /no balance outstanding/);
    const stranger = await ask(ctx, 'get_receivables', { customer: 'Nobody Ltd' });
    assert.match(stranger.data.note, /No customer matches/);

    const chase = await ask(ctx, 'get_collections');
    assert.equal(chase.data.customers_overdue, 1);
    assert.equal(chase.data.customers[0].customer, 'Kumar Stores');
  });
});

test('pending payments are what is still owed, both ways, and tie to the ageing reports', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, vendor, bankId, ctx }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-09-01', dueDate: '2026-09-15', status: 'approved',
      lines: [{ description: 'Goods', qty: 1, ratePaise: 5_000_00, gstRatePct: 0 }],
    });
    await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-10-28', dueDate: '2026-11-04', status: 'approved',
      lines: [{ description: 'Goods', qty: 1, ratePaise: 1_000_00, gstRatePct: 0 }],
    });
    await receivePayment(trx, orgId, null, {
      branchId, contactId: customer, date: '2026-09-20', mode: 'upi', amountPaise: 2_000_00, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 2_000_00 }],
    });
    await createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: 'SS-9', date: '2026-10-01', dueDate: '2026-10-20', status: 'open',
      lines: [{ description: 'Steel', qty: 1, ratePaise: 4_000_00, gstRatePct: 0 }],
    });
    // A customer balance with no invoice behind it: an opening balance by journal.
    const acc = await accountIds(trx, orgId);
    const other = Number((await trx.selectFrom('contacts').select('id').where('org_id', '=', orgId).where('display_name', '=', 'Kumaran Traders').executeTakeFirstOrThrow()).id);
    await postEntry(trx, { orgId, branchId, date: '2026-04-01', memo: 'Opening', sourceType: 'manual', lines: [
      { accountId: acc[CODE.AR], debit: 750_00, contactId: other }, { accountId: acc[CODE.OPENING_BALANCE_EQUITY], credit: 750_00 },
    ] });

    const all = await ask(ctx, 'get_pending_payments');
    const r = all.data.to_receive_from_customers;
    const p = all.data.to_pay_to_suppliers;
    assert.equal(r.total, '₹4,000.00', '3,000 left on the September invoice and 1,000 not yet due');
    assert.equal(r.overdue, '₹3,000.00');
    assert.equal(r.due_next_7_days, '₹1,000.00', 'due on 4 November');
    assert.equal(r.invoices[0].days_overdue, 46);
    assert.equal(p.total, '₹4,000.00');
    assert.equal(p.overdue, '₹4,000.00');
    assert.equal(all.data.net_position, '₹0.00');
    assert.deepEqual(r.ledger.not_on_any_document, [{ customer: 'Kumaran Traders', amount: '₹750.00' }], 'the journal balance is named, not lost');
    assert.equal(r.ledger.total_as_in_the_ageing_report, '₹4,750.00');
    assert.equal(all.report?.title, 'Pending payments');

    const overdue = await ask(ctx, 'get_pending_payments', { due: 'overdue', side: 'receive' });
    assert.equal(overdue.data.to_receive_from_customers.total, '₹3,000.00');
    assert.equal(overdue.data.to_pay_to_suppliers, undefined);
    const week = await ask(ctx, 'get_pending_payments', { due: 'next_7_days', side: 'pay' });
    assert.equal(week.data.to_pay_to_suppliers.documents, 0, 'nothing new falls due this week');
    assert.equal(week.data.to_pay_to_suppliers.already_overdue, '₹4,000.00', 'but the overdue bill is said too');
    const steel = await ask(ctx, 'get_pending_payments', { party: 'Steel' });
    assert.equal(steel.data.to_receive_from_customers.documents, 0);
    assert.equal(steel.data.to_pay_to_suppliers.bills[0].supplier, 'Steel Supply');

    const sales = await runTool({ ...ctx, role: 'sales' }, { id: 's', name: 'get_pending_payments', arguments: '{}' });
    const sd = JSON.parse(sales.content);
    assert.ok(sd.to_receive_from_customers, 'sales sees what customers owe');
    assert.equal(sd.to_pay_to_suppliers, undefined, 'and not what is owed to suppliers');
    assert.match(sd.note, /does not include suppliers/);
  });
});

test('stock, budgets, orders, TDS, compliance, reconciliation, projects, payroll and assets all answer', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, vendor, ctx }) => {
    await trx.insertInto('items').values({
      org_id: orgId, name: 'Brake Pad Set', sku: 'BP-1', kind: 'goods', track_inventory: 1, uqc: 'NOS',
      opening_stock_qty: '10', opening_stock_rate: '100.0000', min_level: '12', sale_price: '150.0000', purchase_price: '100.0000',
    } as never).execute();
    const acc = await accountIds(trx, orgId);
    await trx.insertInto('budgets').values({ org_id: orgId, fy_label: '2026-27', account_id: acc[CODE.RENT], amount: '120000.0000' } as never).execute();
    await createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: 'S-1', date: '2026-10-01', dueDate: '2026-10-30',
      lines: [{ accountId: acc[CODE.RENT], description: 'Rent', qty: 1, ratePaise: 30_000_00, gstRatePct: 0 }],
    });
    await trx.insertInto('projects').values({ org_id: orgId, name: 'Showroom fit-out', customer_id: customer, status: 'active' } as never).execute();

    const stock = await ask(ctx, 'get_stock');
    assert.equal(stock.data.stock_value, '₹1,000.00');
    assert.equal(stock.data.below_minimum_level[0].item, 'Brake Pad Set');
    const item = await ask(ctx, 'get_stock', { item: 'brake pad' });
    assert.equal(item.data.on_hand, '10 NOS');
    assert.equal(item.data.below_minimum, true);
    const salesView = await ask({ ...ctx, role: 'sales' }, 'get_stock');
    assert.equal(salesView.data.stock_value, undefined, 'sales sees quantities, not cost');
    assert.equal((await ask({ ...ctx, role: 'sales' }, 'get_stock', { view: 'ageing' })).data.error !== undefined, true);

    const budget = await ask(ctx, 'get_budget_vs_actual');
    assert.equal(budget.data.accounts[0].actual, '₹30,000.00');
    assert.equal(budget.data.total_budget, '₹1,20,000.00');

    const orders = await ask(ctx, 'get_open_orders');
    assert.equal(orders.data.sales_orders.open, 0);
    assert.equal((await ask({ ...ctx, role: 'sales' }, 'get_open_orders', { kind: 'purchase_orders' })).data.error, 'This role cannot see those documents.');

    const tds = await ask(ctx, 'get_tds_summary');
    assert.match(tds.data.quarter, /^Q3 of FY 2026-27/);
    const cal = await ask(ctx, 'get_compliance_calendar');
    assert.ok(cal.data.items.some((i: { what: string }) => /GSTR-3B/.test(i.what)), 'a regular GST book owes GSTR-3B');
    const rec = await ask(ctx, 'get_bank_reconciliation');
    assert.equal(rec.data.accounts[0].statement_imported_to, 'no statement imported yet');
    const projects = await ask(ctx, 'get_projects');
    assert.equal(projects.data.projects[0].project, 'Showroom fit-out');
    assert.equal((await ask(ctx, 'get_payroll_summary')).data.runs.length, 0);
    assert.equal((await ask(ctx, 'get_fixed_assets')).data.assets, 0);
  });
});

// ── The stand-in ─────────────────────────────────────────────────────────────

test('periods are read relative to today, and names are not mistaken for months', () => {
  assert.deepEqual(extractPeriod('profit this month', TODAY), { from: '2026-10-01', to: TODAY, month: '2026-10' });
  assert.deepEqual(extractPeriod('sales last month', TODAY), { from: '2026-09-01', to: '2026-09-30', month: '2026-09' });
  assert.deepEqual(extractPeriod('expenses this quarter', TODAY), { from: '2026-10-01', to: TODAY });
  assert.deepEqual(extractPeriod('expenses last quarter', TODAY), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(extractPeriod('profit for FY 2025-26', TODAY), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(extractPeriod('profit last financial year', TODAY), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(extractPeriod('sales in September', TODAY), { from: '2026-09-01', to: '2026-09-30', month: '2026-09' });
  assert.deepEqual(extractPeriod('sales in December', TODAY), { from: '2025-12-01', to: '2025-12-31', month: '2025-12' }, 'a month not yet come is last year’s');
  assert.equal(extractPeriod('statement for Marina Car Care', TODAY), null, 'Marina is not March');
  assert.equal(extractPeriod('what is our net margin', TODAY), null, 'nor is margin');
  assert.equal(extractPeriod('may I see the profit', TODAY), null, '"may" as a verb');
  assert.equal(todayFromMessages([{ role: 'system', content: buildSystemPrompt({ orgName: 'A', userName: 'B', role: 'admin', today: TODAY, fyStart: FY, hidden: [] }) }]), TODAY);
});

test('names and items are lifted out of the question', () => {
  assert.equal(extractParty('How much does Apex owe us?'), 'Apex');
  assert.equal(extractParty('What do we owe Bosch Automotive this year?'), 'Bosch Automotive');
  assert.equal(extractParty('Statement for Apex Motors Pvt Ltd'), 'Apex Motors Pvt Ltd');
  assert.equal(extractParty('payments received from Hosur Auto Agencies last month'), 'Hosur Auto Agencies');
  assert.equal(extractParty('Who owes us money?'), null);
  assert.equal(extractItem('How many brake pads do we have?'), 'brake pad');
  assert.equal(extractItem('stock of Engine Oil 5W-30'), 'Engine Oil 5W-30');
  assert.equal(extractItem('How much stock do we have?'), null);
  assert.ok(isGreeting('hello there!') && isGreeting('Good morning') && !isGreeting('hello, what is our cash?'));
  assert.ok(isHelp('What can you do?') && !isHelp('What do we owe suppliers?'));
});

test('the stand-in reaches for the lookup a model would', () => {
  const admin = new Set(toolSpecsFor('admin').map((t) => t.name));
  const plan = (q: string, offered = admin) => planTools(q, offered, TODAY).map((p) => `${p.name}${Object.keys(p.args).length ? JSON.stringify(p.args) : ''}`);
  const first = (q: string) => planTools(q, admin, TODAY)[0];
  assert.deepEqual(plan('How much cash do we have today?'), ['get_cash_position']);
  assert.deepEqual(plan('What is the closing balance of Cash in Hand?'), ['get_account_balance{"account":"Cash in Hand"}'], '"in hand" is not stock');
  assert.deepEqual(first('How much does Apex owe us?'), { name: 'get_receivables', args: { customer: 'Apex' } });
  assert.deepEqual(first('What do we owe Bosch?'), { name: 'get_payables', args: { vendor: 'Bosch' } });
  // "Pending payments" are what is still owed, never the payments already made.
  for (const q of ['what all are the pending payments', 'Show pending payments', 'outstanding payments', 'pending dues', 'total pending amount', 'what payments are due']) {
    assert.deepEqual(plan(q), ['get_pending_payments'], q);
  }
  assert.deepEqual(first('who has not paid?'), { name: 'get_pending_payments', args: { side: 'receive' } });
  assert.deepEqual(first('payments to be received'), { name: 'get_pending_payments', args: { side: 'receive' } });
  assert.deepEqual(first('what payments do we have to make'), { name: 'get_pending_payments', args: { side: 'pay' } });
  assert.deepEqual(first('payment pending from Apex'), { name: 'get_pending_payments', args: { side: 'receive', party: 'Apex' } });
  assert.deepEqual(first('pending payment to Bosch'), { name: 'get_pending_payments', args: { side: 'pay', party: 'Bosch' } });
  assert.deepEqual(first('overdue payments'), { name: 'get_pending_payments', args: { due: 'overdue' } });
  assert.deepEqual(first('pending payments due this week'), { name: 'get_pending_payments', args: { due: 'next_7_days' } });
  assert.deepEqual(plan('What payments did we receive this month?')[0], 'search_payments{"direction":"received","from":"2026-10-01","to":"2026-10-31"}', 'payments received are still a payments search');
  assert.deepEqual(first('How much does Bosch Automotive want from us?'), { name: 'get_payables', args: { vendor: 'Bosch Automotive' } });
  assert.deepEqual(first('How much do we have to pay Lakshmi Auto?'), { name: 'get_payables', args: { vendor: 'Lakshmi Auto' } });
  assert.deepEqual(plan('What is our GST payable this month?'), ['get_gst_summary{"month":"2026-10"}'], '"GST payable" is tax, not suppliers');
  assert.deepEqual(plan('Show the payables'), ['get_payables']);
  assert.deepEqual(first('Statement for Apex Motors'), { name: 'get_party_statement', args: { party: 'Apex Motors' } });
  assert.deepEqual(first('What was our profit last month?'), { name: 'get_profit_and_loss', args: { from: '2026-09-01', to: '2026-09-30' } });
  assert.deepEqual(first('Which items sell best?')?.args.group_by, 'item');
  assert.deepEqual(first('Show monthly sales trend')?.args.group_by, 'month');
  assert.deepEqual(first('How many brake pads do we have?'), { name: 'get_stock', args: { item: 'brake pad' } });
  assert.deepEqual(first('Which stock is slow moving?'), { name: 'get_stock', args: { view: 'ageing' } });
  assert.deepEqual(first('Payments made by NEFT'), { name: 'search_payments', args: { direction: 'made', mode: 'neft' } });
  assert.deepEqual(first('How much GST do we pay for last month?'), { name: 'get_gst_summary', args: { month: '2026-09' } });
  assert.deepEqual(plan('How much TDS is still to deposit?'), ['get_tds_summary']);
  assert.deepEqual(plan('What returns are due this month?'), ['get_compliance_calendar']);
  assert.deepEqual(plan('Are our bank accounts reconciled?'), ['get_bank_reconciliation']);
  assert.deepEqual(plan('Who should we chase for payment today?'), ['get_collections']);
  assert.deepEqual(first('Any open purchase orders?'), { name: 'get_open_orders', args: { kind: 'purchase_orders' } });
  assert.deepEqual(plan('How are we doing against the budget?'), ['get_budget_vs_actual']);
  assert.deepEqual(plan("What did last month's payroll cost?"), ['get_payroll_summary']);
  assert.deepEqual(plan('What is the book value of our fixed assets?'), ['get_fixed_assets'], '"fixed" is not "fix"');
  assert.deepEqual(first('Show overdue bills'), { name: 'search_bills', args: { status: 'overdue', limit: 8 } });
  assert.deepEqual(first('List unpaid invoices'), { name: 'search_invoices', args: { status: 'unpaid', limit: 8 } });
  assert.deepEqual(plan('How is the business doing?'), ['get_profit_and_loss', 'get_cash_position', 'get_receivables']);
  assert.deepEqual(plan('What needs my attention?'), ['get_attention_items']);
  const sales = new Set(toolSpecsFor('sales').map((t) => t.name));
  assert.deepEqual(plan('What did last month\'s payroll cost?', sales), [], 'not answered with a different question the role can see');
});

test('a greeting, a request for help and a question it cannot place are each answered as such', async () => {
  const offered = toolSpecsFor('admin');
  const say = async (q: string) => new StandinProvider({ delayMs: 0 }).chat({ messages: [{ role: 'user', content: q }], tools: offered, toolChoice: 'auto', maxOutputTokens: 1000 });
  const help = await say('What can you do?');
  assert.equal(help.toolCalls.length, 0);
  assert.match(help.text, /stock, customer and supplier statements/);
  const hi = await say('hi');
  assert.equal(hi.toolCalls[0]?.name, 'get_attention_items');
});

// ── A whole question through OpenAI ──────────────────────────────────────────

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new ReadableStream({
    start(ctrl) {
      // In pieces, mid-line, the way a network delivers it.
      const bytes = new TextEncoder().encode(body);
      for (let i = 0; i < bytes.length; i += 37) ctrl.enqueue(bytes.slice(i, i + 37));
      ctrl.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('a question through OpenAI: tools called in fragments, run on the books, then answered', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, ctx }) => {
    await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-09-01', dueDate: '2026-09-15', status: 'approved',
      lines: [{ description: 'Goods', qty: 1, ratePaise: 5_000_00, gstRatePct: 0 }],
    });
    const requests: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      if (requests.length === 1) {
        return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_receivables', arguments: '{"custo' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mer":"Kumar Stores"}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'get_compliance_calendar', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 3000, completion_tokens: 40 } },
        ]);
      }
      return sse([
        { choices: [{ delta: { content: 'Kumar Stores owes **₹5,000.00**, all of it overdue.' } }] },
        { choices: [{ delta: { content: '\n\n```followups\n- Who should we chase today?\n```' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 3600, completion_tokens: 60 } },
      ]);
    }) as unknown as typeof fetch;

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5-mini', baseUrl: 'https://api.openai.test/v1', reasoningEffort: 'low' }, fakeFetch);
    const tools: string[] = [];
    const result = await runAgent({
      provider,
      tools: ctx,
      prompt: { orgName: 'Assistant Co', userName: 'Asha', role: 'admin', today: TODAY, fyStart: FY, hidden: [] },
      history: [],
      question: 'How much does Kumar Stores owe, and what is due?',
      holdMc: 20_000,
      price: priceFor('gpt-5-mini').price,
      creditCostUsd: 0.003,
      signal: new AbortController().signal,
      emit: (e) => { if (e.type === 'tool') tools.push(e.name); },
    });

    assert.equal(result.outcome, 'answered');
    assert.deepEqual(tools, ['get_receivables', 'get_compliance_calendar'], 'both calls, reassembled from fragments');
    assert.equal(result.modelCalls, 2);
    assert.equal(result.content, 'Kumar Stores owes **₹5,000.00**, all of it overdue.');
    assert.deepEqual(result.followups, ['Who should we chase today?']);
    assert.deepEqual(result.reports.map((r) => r.title), ['What customers owe', 'Compliance calendar']);
    assert.ok(result.costMicroUsd > 0, 'priced from the usage the API reported');

    const [first, second] = requests;
    assert.equal(first.model, 'gpt-5-mini');
    assert.equal(first.reasoning_effort, 'low');
    assert.equal(first.stream_options.include_usage, true);
    assert.ok(first.tools.some((t: { function: { name: string } }) => t.function.name === 'get_stock'), 'the new lookups are offered');
    assert.match(first.messages[0].content, /\(2026-10-31\)/, 'today, as a date the model can pass to a tool');
    const toolMsgs = second.messages.filter((m: { role: string }) => m.role === 'tool');
    assert.deepEqual(toolMsgs.map((m: { tool_call_id: string }) => m.tool_call_id), ['call_a', 'call_b'], 'every call answered by its id');
    assert.match(toolMsgs[0].content, /"owes":"₹5,000.00"/, 'the model is shown the figure from the books');
    assert.equal(second.messages.find((m: { role: string }) => m.role === 'assistant').tool_calls[0].function.arguments, '{"customer":"Kumar Stores"}');
  });
});

// ── The online demo ──────────────────────────────────────────────────────────

const REC: AiRecording = {
  recordedAt: '2026-10-31T00:00:00Z', today: TODAY, fyStart: FY, orgName: 'Demo Co', userName: 'Demo', role: 'admin',
  accounts: [{ id: 1, code: '1211', name: 'HDFC Bank – Current', type: 'asset' }, { id: 2, code: '5100', name: 'Rent', type: 'expense' }],
  banks: [{ name: 'HDFC Bank – Current', bank_name: 'HDFC Bank', ledger_account_id: 1 }],
  tools: {
    get_profit_and_loss: [
      { args: {}, content: '{"period":"fy"}', sources: [], report: null },
      { args: { from: '2026-09-01', to: '2026-09-30' }, content: '{"period":"sep"}', sources: [], report: null },
    ],
    get_receivables: [
      { args: {}, content: '{"who":"all"}', sources: [], report: null },
      { args: { customer: 'Apex Motors Pvt Ltd' }, content: '{"who":"apex"}', sources: [], report: null },
    ],
    get_sales_summary: [
      { args: { group_by: 'customer' }, content: '{"by":"customer"}', sources: [], report: null },
      { args: { group_by: 'item' }, content: '{"by":"item"}', sources: [], report: null },
    ],
    get_account_balance: [{ args: { account: '1211' }, content: '{"acct":"hdfc"}', sources: [], report: null }],
    get_party_statement: [
      { args: { party: 'Bharat Petroleum (Fuel Card)', side: 'vendor' }, content: '{"who":"bpcl"}', sources: [], report: null },
      { args: { party: 'Marina Car Care', side: 'customer' }, content: '{"who":"marina"}', sources: [], report: null },
    ],
  },
};
const play = (name: string, args: Record<string, unknown> = {}) => JSON.parse(playLookup(REC, { id: 'x', name, arguments: JSON.stringify(args) }).content);

test('the demo answers a lookup with the recording that fits it best, and never with someone else’s', () => {
  assert.equal(play('get_profit_and_loss', { from: '2026-09-01', to: '2026-09-30' }).period, 'sep');
  assert.equal(play('get_profit_and_loss', { from: '2026-08-01', to: '2026-08-31' }).period, 'sep', 'the nearest period, which carries its own dates');
  assert.equal(play('get_profit_and_loss').period, 'fy');
  assert.equal(play('get_profit_and_loss', { from: FY, to: TODAY }).period, 'fy', 'the year so far, said or not');
  assert.equal(play('get_receivables', { customer: 'apex' }).who, 'apex');
  assert.equal(play('get_receivables').who, 'all');
  const stranger = play('get_receivables', { customer: 'Zenith Motors' });
  assert.equal(stranger.found, false, 'a name the sample company does not have is said to be missing');
  assert.equal(play('get_sales_summary').by, 'customer', 'grouping by customer is the default');
  assert.equal(play('get_sales_summary', { group_by: 'item' }).by, 'item');
  assert.equal(play('get_account_balance', { account: 'HDFC Bank' }).acct, 'hdfc', 'an account found by the words used');
  assert.equal(play('get_account_balance', { account: 'Salaries' }).found, false);
  assert.equal(play('get_party_statement', { party: 'Marina Car Care' }).who, 'marina', 'a statement fits whichever side was recorded');
  assert.match(play('get_payroll_summary').error, /not part of the online demo/);
});

async function readEvents(res: Response) {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => {
    const [ev, data] = b.split('\n');
    return { type: ev.slice(7), data: JSON.parse(data.slice(6)) };
  });
}

test('the demo chat streams a whole answer from its recording, and holds the conversation', async () => {
  const post = (body: unknown) => demoChat(new Request('http://demo/api/ai/chat', { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': '203.0.113.9' } }));
  const one = await readEvents(await post({ message: 'How much stock do we have?' }));
  const start = one.find((e) => e.type === 'start')!.data;
  assert.equal(start.isNew, true);
  assert.ok(one.some((e) => e.type === 'tool' && e.data.name === 'get_stock'));
  const done = one.find((e) => e.type === 'done')!.data;
  assert.equal(done.status, 'complete');
  assert.equal(done.chargedMc, 0, 'nothing is charged on the demo');
  assert.equal(done.reports[0]?.title, 'Stock on hand');
  assert.match(done.content, /Stock on hand is worth/);
  assert.equal((await demoReportQuote().json()).priceMc, 0, 'downloads are free on the demo');
  const file = await demoReportDownload(new Request('http://demo/api/ai/reports/download', { method: 'POST', body: JSON.stringify({ messageId: done.messageId, key: done.reports[0].key, format: 'csv' }) }));
  assert.equal((await file.json()).report.title, 'Stock on hand', 'the file is made from the answer the server holds');

  const two = await readEvents(await post({ conversationId: start.conversationId, message: 'Which customers are overdue?' }));
  assert.equal(two.find((e) => e.type === 'start')!.data.isNew, false);
  const held = await demoConversation(start.conversationId).json();
  assert.equal(held.messages.length, 4, 'two questions and two answers');
  assert.equal((await demoConversation('demo-gone').json()).code, 'not_found');

  const profit = await readEvents(await post({ message: 'What is the profit for Apex Motors?' }));
  assert.match(profit.find((e) => e.type === 'done')!.data.content, /not for Apex Motors alone/, 'the whole business’s profit is not passed off as one customer’s');

  const bad = await post({ message: '' });
  assert.equal(bad.status, 400);
});

test.after(() => db.destroy());
