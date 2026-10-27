// A Tally company read into the portal: pairing, sync, and the reports.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/tally.test.ts
//
// Against the real database, inside transactions that are rolled back. The
// company is the generated sample, so every report can be checked against
// figures worked out independently while the vouchers were made.

import test from 'node:test';
import assert from 'node:assert/strict';

import { db, type Trx } from '../../lib/server/db';
import {
  authenticateConnector, createPairingCode, normaliseCode, redeemPairingCode, revokeConnector,
} from '../../lib/server/tally/connectors';
import { applySync, voucherProblem } from '../../lib/server/tally/sync';
import {
  balanceSheet, companyFor, dayBook, fyStartFor, ledgerList, ledgerVouchers, profitAndLoss, stockSummary, trialBalance,
} from '../../lib/server/tally/reports';
import { SyncMessage, type TallyVoucher } from '../../lib/tally/protocol';
import { SAMPLE_COMPANY_GUID, SAMPLE_FY_FROM, sampleCompany } from '../tally/sample-company';

const AS_OF = '2026-09-15';
const sample = sampleCompany(AS_OF);

async function withOrg(fn: (ctx: { trx: Trx; orgId: number }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations').values({ name: 'Tally Test Co', pan: 'AAAAA0000A' }).executeTakeFirstOrThrow();
      await fn({ trx, orgId: Number(org.insertId) });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function paired(trx: Trx, orgId: number) {
  const { code } = await createPairingCode(trx, orgId, null);
  const { token } = await redeemPairingCode(trx, { code, machineName: 'TEST-PC', connectorVersion: '0.1.0' });
  return authenticateConnector(trx, `Bearer ${token}`);
}

/** The whole sample, pushed the way the connector pushes it. */
async function pushSample(trx: Trx, orgId: number) {
  const connector = await paired(trx, orgId);
  const hello = (await applySync(trx, connector, SyncMessage.parse(sample.hello))) as { companies: { companyId: string }[] };
  await applySync(trx, connector, SyncMessage.parse(sample.masters));
  for (let i = 0; i < sample.vouchers.length; i += 400) {
    await applySync(trx, connector, SyncMessage.parse({ kind: 'vouchers', companyGuid: SAMPLE_COMPANY_GUID, vouchers: sample.vouchers.slice(i, i + 400) }));
  }
  const company = await companyFor(trx, orgId, Number(hello.companies[0].companyId));
  return { connector, company };
}

// ── Pairing ──────────────────────────────────────────────────────────────────

test('a pairing code works once, in any spacing, and a revoked connector is refused', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const { code } = await createPairingCode(trx, orgId, null);
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(normaliseCode(code.toLowerCase().replace('-', ' ')), code.replace('-', ''));

    const first = await redeemPairingCode(trx, { code: code.toLowerCase(), machineName: 'PC-1', connectorVersion: '0.1.0' });
    assert.match(first.token, /^tly_/);
    await assert.rejects(
      redeemPairingCode(trx, { code, machineName: 'PC-2', connectorVersion: '0.1.0' }),
      (err: { status?: number }) => err.status === 401,
      'a used code does not work twice',
    );

    const me = await authenticateConnector(trx, `Bearer ${first.token}`);
    assert.equal(me.orgId, orgId);
    await revokeConnector(trx, orgId, me.connectorId);
    await assert.rejects(authenticateConnector(trx, `Bearer ${first.token}`), (err: { code?: string }) => err.code === 'connector_unpaired');
  });
});

test('an expired code is refused, and making a new code withdraws the old one', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const past = new Date(Date.now() - 20 * 60_000);
    const old = await createPairingCode(trx, orgId, null, past);
    await assert.rejects(redeemPairingCode(trx, { code: old.code, machineName: 'PC', connectorVersion: '1' }), (err: { status?: number }) => err.status === 401);

    const a = await createPairingCode(trx, orgId, null);
    const b = await createPairingCode(trx, orgId, null);
    await assert.rejects(redeemPairingCode(trx, { code: a.code, machineName: 'PC', connectorVersion: '1' }), (err: { status?: number }) => err.status === 401);
    const ok = await redeemPairingCode(trx, { code: b.code, machineName: 'PC', connectorVersion: '1' });
    assert.ok(ok.token);
  });
});

// ── Sync ─────────────────────────────────────────────────────────────────────

test('the sample company is coherent before it is sent', () => {
  for (const v of sample.vouchers) assert.equal(voucherProblem(v), null, `${v.number} balances`);
  const openings = sample.masters.ledgers.reduce((t, l) => t + l.openingPaise, 0);
  assert.equal(openings + sample.expected.openingStockPaise, 0, 'openings balance once opening stock is counted');
  assert.ok(sample.vouchers.length > 200, `${sample.vouchers.length} vouchers`);
});

test('vouchers: an unbalanced one is refused alone, a late retry is ignored, and the index removes deletions', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const connector = await paired(trx, orgId);
    const hello = (await applySync(trx, connector, SyncMessage.parse(sample.hello))) as { companies: { companyId: string }[] };
    const companyId = Number(hello.companies[0].companyId);
    await applySync(trx, connector, SyncMessage.parse(sample.masters));

    const good = sample.vouchers.find((v) => v.baseType === 'Receipt')!;
    const bad: TallyVoucher = { ...good, guid: 'bad-1', entries: [{ ledger: 'Cash', debitPaise: 100, creditPaise: 0 }] };
    const reply = (await applySync(trx, connector, SyncMessage.parse({ kind: 'vouchers', companyGuid: SAMPLE_COMPANY_GUID, vouchers: [good, bad] }))) as {
      stored: number; rejected: { guid: string }[];
    };
    assert.equal(reply.stored, 1);
    assert.deepEqual(reply.rejected.map((r) => r.guid), ['bad-1']);

    const edited: TallyVoucher = { ...good, alterId: good.alterId + 1000, narration: 'Edited in Tally' };
    await applySync(trx, connector, SyncMessage.parse({ kind: 'vouchers', companyGuid: SAMPLE_COMPANY_GUID, vouchers: [edited] }));
    await applySync(trx, connector, SyncMessage.parse({ kind: 'vouchers', companyGuid: SAMPLE_COMPANY_GUID, vouchers: [good] }));
    // Scoped to this company: the same sample GUIDs can exist in other books.
    const stored = await trx
      .selectFrom('tally_vouchers')
      .select(['narration', 'alter_id'])
      .where('company_id', '=', companyId)
      .where('guid', '=', good.guid)
      .executeTakeFirstOrThrow();
    assert.equal(stored.narration, 'Edited in Tally', 'the older copy did not overwrite the newer edit');

    const other = sample.vouchers.find((v) => v.baseType === 'Contra')!;
    await applySync(trx, connector, SyncMessage.parse({ kind: 'vouchers', companyGuid: SAMPLE_COMPANY_GUID, vouchers: [other] }));
    const idx = (await applySync(trx, connector, SyncMessage.parse({
      kind: 'voucher-index', companyGuid: SAMPLE_COMPANY_GUID, from: SAMPLE_FY_FROM, to: AS_OF, guids: [good.guid],
    }))) as { deleted: number };
    assert.equal(idx.deleted, 1, 'the contra Tally no longer holds is removed');
    const left = await trx
      .selectFrom('tally_vouchers')
      .select('guid')
      .where('company_id', '=', companyId)
      .where('guid', 'in', [good.guid, other.guid])
      .execute();
    assert.deepEqual(left.map((r) => r.guid), [good.guid]);
  });
});

test('a full masters message removes what Tally deleted', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const connector = await paired(trx, orgId);
    await applySync(trx, connector, SyncMessage.parse(sample.hello));
    await applySync(trx, connector, SyncMessage.parse(sample.masters));
    const fewer = { ...sample.masters, ledgers: sample.masters.ledgers.filter((l) => l.name !== 'Computers') };
    const reply = (await applySync(trx, connector, SyncMessage.parse(fewer))) as { removed: number };
    assert.equal(reply.removed, 1);
  });
});

// ── Reports ──────────────────────────────────────────────────────────────────

test('the trial balance agrees, with the opening stock Tally lists', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const { company } = await pushSample(trx, orgId);
    const tb = await trialBalance(trx, company);
    assert.equal(tb.differencePaise, 0, `debits ${tb.totalDebitPaise} against credits ${tb.totalCreditPaise}`);
    assert.equal(tb.rows[0].name, 'Opening Stock');
    const current = tb.rows.find((r) => r.name === 'Current Assets')!;
    const debtors = current.children.find((c) => c.name === 'Sundry Debtors')!;
    assert.ok(debtors.children.some((c) => c.name === 'Chennai Debtors' && c.kind === 'group'), 'a group of the company’s own sits in the tree');
  });
});

test('profit and loss and the balance sheet match the figures worked out with the vouchers', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const { company } = await pushSample(trx, orgId);
    const pl = await profitAndLoss(trx, company);
    assert.equal(pl.netProfitPaise, sample.expected.netProfitPaise);
    assert.equal(pl.stock.closingPaise, sample.expected.closingStockPaise);
    assert.equal(pl.trading.debit[0].name, 'Opening Stock');

    const bs = await balanceSheet(trx, company);
    assert.equal(bs.differencePaise, 0, `assets ${bs.totalAssetsPaise} against liabilities ${bs.totalLiabilitiesPaise}`);
    const plLine = bs.liabilities.find((l) => l.name === 'Profit & Loss A/c')!;
    assert.equal(plLine.amountPaise, 120_000_00 + sample.expected.netProfitPaise, 'brought forward plus this year');
    const current = bs.assets.find((a) => a.name === 'Current Assets')!;
    assert.equal(current.children[0].name, 'Closing Stock');
  });
});

test('a ledger’s vouchers run to the balance Tally reported, from any start date', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const { company } = await pushSample(trx, orgId);
    const list = await ledgerList(trx, company);
    const bank = list.rows.find((r) => r.name === 'HDFC Bank')!;

    const year = await ledgerVouchers(trx, company, Number(bank.id), SAMPLE_FY_FROM, AS_OF);
    assert.equal(year.openingPaise, 450_000_00);
    assert.equal(year.closingPaise, sample.expected.closing.get('HDFC Bank'));
    assert.equal(year.check?.matches, true);

    const august = await ledgerVouchers(trx, company, Number(bank.id), '2026-08-01', AS_OF);
    assert.equal(august.closingPaise, year.closingPaise, 'starting mid-year still ends at the same balance');

    const rent = list.rows.find((r) => r.name === 'Rent')!;
    const rentAug = await ledgerVouchers(trx, company, Number(rent.id), '2026-08-01', '2026-08-31');
    assert.equal(rentAug.ledger.revenue, true);
    assert.equal(rentAug.openingPaise, 4 * 25_000_00, 'April to July, counted from the start of the year');
    assert.equal(rentAug.rows[0]?.particulars, 'HDFC Bank');
  });
});

test('the day book lists every voucher of a day, optional and cancelled ones marked', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const { company } = await pushSample(trx, orgId);
    const date = sample.vouchers.find((v) => v.isOptional)!.date;
    const book = await dayBook(trx, company, date, date);
    const expected = sample.vouchers.filter((v) => v.date === date).length;
    assert.equal(book.rows.length, expected);
    assert.ok(book.rows.some((r) => r.isOptional));
    assert.ok(book.rows.some((r) => r.isCancelled && r.debitPaise === null));
    assert.ok(book.rows.some((r) => r.baseType === 'Sales Order' && r.entries.length === 0));

    const stock = await stockSummary(trx, company);
    assert.equal(stock.totalValuePaise, sample.expected.closingStockPaise);
  });
});

test('the year’s result is counted once, though Tally carries it in Profit & Loss A/c too', async () => {
  // How real TallyPrime reports it: the Profit & Loss A/c ledger closes at what
  // was brought forward plus the current period's result, while the income and
  // expense ledgers carry that same result. Counting both would report the year
  // twice — the trial balance would not agree and the balance sheet would be out
  // by the year's profit.
  await withOrg(async ({ trx, orgId }) => {
    const { connector, company } = await pushSample(trx, orgId);
    const asTallyReportsIt = {
      ...sample.masters,
      ledgers: sample.masters.ledgers.map((l) =>
        l.name === 'Profit & Loss A/c'
          ? { ...l, closingPaise: l.openingPaise - sample.expected.netProfitPaise }
          : l),
    };
    await applySync(trx, connector, SyncMessage.parse(asTallyReportsIt));

    const tb = await trialBalance(trx, company);
    assert.equal(tb.differencePaise, 0, 'the trial balance still agrees');
    const pl = tb.rows.find((r) => r.name === 'Profit & Loss A/c');
    assert.equal(
      (pl?.creditPaise ?? 0) - (pl?.debitPaise ?? 0),
      -sample.masters.ledgers.find((l) => l.name === 'Profit & Loss A/c')!.openingPaise,
      'it shows what was brought forward, as Tally’s own trial balance does',
    );

    const bs = await balanceSheet(trx, company);
    assert.equal(bs.totalAssetsPaise, bs.totalLiabilitiesPaise, 'and the balance sheet still balances');
    const plLine = bs.liabilities.find((l) => l.name === 'Profit & Loss A/c')!;
    assert.equal(
      plLine.amountPaise,
      -sample.masters.ledgers.find((l) => l.name === 'Profit & Loss A/c')!.openingPaise + sample.expected.netProfitPaise,
      'brought forward plus this year, not this year twice',
    );
  });
});

test('a financial year starts on the company’s own day', () => {
  assert.equal(fyStartFor('2026-08-15', '2026-04-01'), '2026-04-01');
  assert.equal(fyStartFor('2027-02-01', '2026-04-01'), '2026-04-01');
  assert.equal(fyStartFor('2027-04-01', '2026-04-01'), '2027-04-01');
});

test.after(async () => {
  await db.destroy();
});
