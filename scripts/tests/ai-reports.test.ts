// The detailed reports under an answer, and what downloading one costs.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/ai-reports.test.ts
//
// The rules first — the markup, the builders, the spreadsheet — then a whole
// question and the download receipts against a real database, inside
// transactions that are rolled back.

import test from 'node:test';
import assert from 'node:assert/strict';

import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { MC_PER_CREDIT, REPORT_DOWNLOAD_CREDITS } from '../../lib/billing/catalog';
import { reportToCsv, safeText } from '../../lib/ai/report-csv';
import { formatFigure, reportFileName, type AiReport } from '../../lib/ai/reports';
import { priceFor, withReportMarkup } from '../../lib/server/ai/pricing';
import { ageingReport, profitAndLossReport, reportKey } from '../../lib/server/ai/reports';
import { runAgent } from '../../lib/server/ai/agent';
import { StandinProvider } from '../../lib/server/ai/standin';
import { grantCredits, walletView } from '../../lib/server/billing/wallet';
import { quoteDownload, takeDownload, type DownloadScope } from '../../lib/server/ai/downloads';

const BANDS = ['Current', '1–15', '16–30', '31–45', '46–60', '60+'];

// ── The rules ────────────────────────────────────────────────────────────────

test('an answer with a report costs 15% more, at least a tenth of a credit, never past the hold', () => {
  assert.equal(withReportMarkup(2_000, 20_000), 2_300);
  assert.equal(withReportMarkup(300, 20_000), 400, 'the minimum surcharge');
  assert.equal(withReportMarkup(19_000, 20_000), 20_000, 'capped at the reservation');
  assert.equal(withReportMarkup(0, 20_000), 0, 'nothing consumed, nothing charged');
});

test('the receivables report ages what is owed, band by band', () => {
  const r = ageingReport({
    side: 'receivable',
    asOf: '2026-09-15',
    buckets: BANDS,
    totals: { Current: 100_00, '1–15': 50_00, '60+': 250_00 },
    rows: [
      { name: 'Apex Motors', totalPaise: 300_00, buckets: { Current: 50_00, '60+': 250_00 } },
      { name: 'Sharma Traders', totalPaise: 100_00, buckets: { Current: 50_00, '1–15': 50_00 } },
    ],
    owed: 400_00,
  });
  assert.equal(r.chart?.categories.length, 6);
  assert.deepEqual(r.chart?.series[0].values, [100_00, 50_00, 0, 0, 0, 250_00]);
  assert.equal(r.chart?.ordinal, true, 'age bands are ordered, and shaded that way');
  const overdue = r.kpis.find((k) => k.label === 'Overdue');
  assert.equal(overdue?.value, 300_00);
  assert.equal(overdue?.tone, 'bad', 'three quarters overdue');
  assert.equal(r.kpis.find((k) => k.label === 'Share overdue')?.value, 75);
  assert.deepEqual(r.table?.rows[0], ['Apex Motors', 300_00, 250_00, 250_00]);
  assert.ok(r.insights.some((s) => /more than 60 days/.test(s)));
});

test('profit and loss is set against the period before', () => {
  const r = profitAndLossReport({
    from: '2026-04-01',
    to: '2026-09-15',
    prev: { from: '2025-10-15', to: '2026-03-31' },
    now: { income: 1_000_00, expense: 600_00, gross: 700_00, net: 400_00 },
    before: { income: 800_00, expense: 600_00, net: 200_00 },
    expenseRows: [
      { name: 'Rent', balancePaise: 400_00 },
      { name: 'Salaries', balancePaise: 200_00 },
    ],
  });
  const net = r.kpis.find((k) => k.label === 'Net profit');
  assert.equal(net?.value, 400_00);
  assert.equal(net?.tone, 'good');
  assert.equal(net?.change?.pct, 100);
  assert.equal(r.chart?.series.length, 2, 'this period and the one before');
  assert.equal(r.table?.rows[0][2], (400_00 / 600_00) * 100, 'the share of expenses');
});

test('a report key is the same for the same lookup, and different for another', () => {
  assert.equal(reportKey('get_receivables', { as_of: '2026-09-15' }), reportKey('get_receivables', { as_of: '2026-09-15' }));
  assert.notEqual(reportKey('get_receivables', { as_of: '2026-09-15' }), reportKey('get_receivables', { as_of: '2026-08-31' }));
  assert.ok(reportKey('get_receivables', {}).startsWith('get_receivables:'));
});

test('figures read the Indian way, and files are named for their report', () => {
  assert.equal(formatFigure(12_34_567_00, 'inr'), '₹12,34,567');
  assert.equal(formatFigure(12.345, 'pct'), '12.3%');
  assert.equal(formatFigure(null, 'inr'), '—');
  assert.match(reportFileName({ title: 'What customers owe' }, 'csv'), /^rekonza-what-customers-owe-[0-9]{4}-[0-9]{2}-[0-9]{2}[.]csv$/);
});

test('a spreadsheet keeps every figure exact, and a name that looks like a formula stays text', () => {
  const report: AiReport = {
    key: 'k',
    title: 'What customers owe',
    subtitle: 'As at 15 Sep 2026',
    kpis: [{ label: 'Owed by customers', value: 1_234_56, unit: 'inr' }],
    chart: { kind: 'bar', unit: 'inr', categoryLabel: 'Days past due', categories: ['Not yet due'], series: [{ name: 'Owed', values: [1_234_56] }] },
    table: { columns: [{ label: 'Customer' }, { label: 'Owes', unit: 'inr' }], rows: [['=HYPERLINK("x")', 1_234_56], ['Apex, Chennai', 5]] },
    insights: ['Three customers owe most.'],
    source: { label: 'Receivables ageing', href: '/reports/ar-ageing' },
  };
  const csv = reportToCsv(report, { orgName: 'Acme Traders', generatedAt: new Date('2026-09-15T06:30:00Z'), origin: 'https://books.example' });
  assert.equal(csv.charCodeAt(0), 0xfeff, 'marked as UTF-8 for Excel');
  assert.ok(csv.includes('1234.56'), 'rupees to the paisa, not the rounded card figure');
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'the formula is written as text, and quoted');
  assert.ok(csv.includes('"Apex, Chennai",0.05'), 'a comma is quoted');
  assert.ok(csv.includes('https://books.example/reports/ar-ageing'));
  assert.equal(safeText('-5 days'), "'-5 days");
  assert.equal(safeText('Rent'), 'Rent');
});

// ── Against the database ─────────────────────────────────────────────────────

async function withOrg(fn: (ctx: { trx: Trx; orgId: number; branchId: number; acc: Record<string, number> }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations').values({ name: 'Report Test Co', pan: 'AAAAA0000A' }).executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);
      const branch = await trx
        .insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', gstin: null, is_primary: 1 })
        .executeTakeFirstOrThrow();
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await fn({ trx, orgId, branchId: Number(branch.insertId), acc });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('a question about a balance comes with its report, and the summary leaves the rows to it', async () => {
  await withOrg(async ({ trx, orgId, branchId, acc }) => {
    await postEntry(trx, {
      orgId, branchId, date: '2026-09-01', sourceType: 'manual', memo: 'Capital introduced',
      lines: [
        { accountId: acc[CODE.CASH], debit: 5_000_00 },
        { accountId: acc[CODE.CAPITAL], credit: 5_000_00 },
      ],
    });
    const result = await runAgent({
      provider: new StandinProvider({ delayMs: 0 }),
      tools: { ex: trx, orgId, userId: 1, role: 'admin', today: '2026-09-12', fyStart: '2026-04-01' },
      prompt: { orgName: 'Report Test Co', userName: 'Asha', role: 'admin', today: '2026-09-12', fyStart: '2026-04-01', hidden: [] },
      history: [],
      question: 'What is the closing balance of Cash in Hand?',
      holdMc: 20_000,
      price: priceFor('stand-in').price,
      creditCostUsd: 0.003,
      signal: new AbortController().signal,
      emit: () => {},
    });
    assert.equal(result.reports.length, 1);
    const [report] = result.reports;
    assert.ok(report.key.startsWith('get_account_balance:'));
    const closing = report.kpis.find((k) => k.label === 'Closing balance');
    assert.deepEqual([closing?.value, closing?.side], [5_000_00, 'Dr']);
    assert.equal(report.source.href, '/reports/general-ledger');
    assert.ok(!result.content.includes('|'), 'no table in the summary: the report carries it');
    assert.match(result.content, /₹5,000\.00 Dr/);
  });
});

const REPORT = (key: string): AiReport => ({
  key,
  title: `Report ${key}`,
  subtitle: 'As at 15 Sep 2026',
  kpis: [],
  chart: null,
  table: null,
  insights: [],
  source: { label: 'Trial balance', href: '/reports/trial-balance' },
});

test('the first download is free, a new report costs a credit, and the same one again is free', async () => {
  await withOrg(async ({ trx, orgId }) => {
    await grantCredits(trx, { orgId, source: 'topup', mc: 3 * MC_PER_CREDIT, expiresAt: null, grantKey: 't', note: 't' });
    const conv = await trx.insertInto('ai_conversations').values({ org_id: orgId, user_id: 7, title: 'Balances' }).executeTakeFirstOrThrow();
    const keys = ['a:1', 'b:2', 'c:3', 'd:4', 'e:5'];
    const msg = await trx
      .insertInto('ai_messages')
      .values({
        conversation_id: Number(conv.insertId),
        org_id: orgId,
        role: 'assistant',
        content: 'Here it is.',
        reports_json: JSON.stringify(keys.map(REPORT)),
      })
      .executeTakeFirstOrThrow();
    const messageId = Number(msg.insertId);
    const asha: DownloadScope = { orgId, userId: 7, isDemo: false, sessionKey: null, monthlyCapMc: null };
    const price = REPORT_DOWNLOAD_CREDITS * MC_PER_CREDIT;

    const firstQuote = await quoteDownload(trx, asha, messageId, 'a:1');
    assert.deepEqual([firstQuote.free, firstQuote.priceMc], [true, 0]);
    const first = await takeDownload(trx, asha, messageId, 'a:1', 'png');
    assert.deepEqual([first.free, first.chargedMc], [true, 0]);
    const again = await takeDownload(trx, asha, messageId, 'a:1', 'csv');
    assert.deepEqual([again.owned, again.chargedMc], [true, 0], 'the same report, in the other format, is free');

    const secondQuote = await quoteDownload(trx, asha, messageId, 'b:2');
    assert.deepEqual([secondQuote.free, secondQuote.priceMc], [false, price]);
    const second = await takeDownload(trx, asha, messageId, 'b:2', 'csv');
    assert.equal(second.chargedMc, price);
    assert.equal((await walletView(trx, orgId)).availableMc, 2 * MC_PER_CREDIT);

    const usage = await trx.selectFrom('ai_usage').select(['provider', 'charged_mc', 'status']).where('org_id', '=', orgId).execute();
    assert.deepEqual(usage.map((u) => [u.provider, Number(u.charged_mc), u.status]), [['download', price, 'settled']]);
    const ledger = await trx.selectFrom('ai_credit_ledger').select(['kind', 'delta_mc', 'note']).where('org_id', '=', orgId).where('kind', '=', 'usage').execute();
    assert.equal(Number(ledger[0]?.delta_mc), -price);
    assert.match(ledger[0]?.note ?? '', /Report download/);

    // Someone else gets their own free first download — and cannot reach this one's answer.
    const ravi: DownloadScope = { ...asha, userId: 8 };
    await assert.rejects(quoteDownload(trx, ravi, messageId, 'b:2'), (err: { status?: number }) => err.status === 404);

    await takeDownload(trx, asha, messageId, 'c:3', 'png');
    await takeDownload(trx, asha, messageId, 'd:4', 'png');
    assert.equal((await walletView(trx, orgId)).availableMc, 0);
    await assert.rejects(
      takeDownload(trx, asha, messageId, 'e:5', 'png'),
      (err: { status?: number; code?: string }) => err.status === 402 && err.code === 'out_of_credits',
    );
  });
});

test.after(async () => {
  await db.destroy();
});
