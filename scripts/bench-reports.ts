// How fast the reports are with a busy year in the books.
//
// Loads a throwaway company with a year of vouchers (1 lakh by default: sales,
// purchases, expenses, receipts and payments, three lines each), times the
// reports people open every day against it, and rolls the lot back: nothing
// is left behind. The target is every report in under 3 seconds.
//
//   npm run bench:reports            1,00,000 vouchers
//   npm run bench:reports -- 250000  any other number

import { sql } from 'kysely';
import { db } from '../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../lib/server/ledger/chart-of-accounts';
import { balanceSheet, generalLedger, profitAndLoss, trialBalance } from '../lib/server/reports/statements';
import { cashBook } from '../lib/server/reports/cash-book';

const VOUCHERS = Number(process.argv[2]) || 100_000;
const TARGET_MS = 3_000;
const BATCH = 2_000;

const day = (i: number) => {
  const d = new Date(Date.UTC(2026, 3, 1) + Math.floor((i / VOUCHERS) * 364) * 86_400_000);
  return d.toISOString().slice(0, 10);
};

async function main() {
  const rollback = Symbol('rollback');
  const results: { report: string; ms: number }[] = [];
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Benchmark (rolled back)' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      const customers = await Promise.all(Array.from({ length: 50 }, async (_, i) => Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: `Customer ${i + 1}`, state_code: '33', gst_treatment: 'unregistered',
      } as never).executeTakeFirstOrThrow()).insertId)));

      // The kinds of voucher a trading business posts, in a believable mix.
      const kinds = [
        { share: 0.40, lines: (a: number) => [[acc[CODE.AR], a * 1.18, 0], [acc[CODE.SALES], 0, a], [acc[CODE.GST_IGST], 0, a * 0.18]] },
        { share: 0.25, lines: (a: number) => [[acc[CODE.BANK_DEFAULT], a, 0], [acc[CODE.AR], 0, a]] },
        { share: 0.20, lines: (a: number) => [[acc[CODE.PURCHASES], a, 0], [acc[CODE.GST_IGST], a * 0.18, 0], [acc[CODE.AP], 0, a * 1.18]] },
        { share: 0.10, lines: (a: number) => [[acc[CODE.AP], a, 0], [acc[CODE.BANK_DEFAULT], 0, a]] },
        { share: 0.05, lines: (a: number) => [[acc[CODE.RENT], a, 0], [acc[CODE.BANK_DEFAULT], 0, a]] },
      ];
      const pick = (i: number) => { let r = (i * 7919 % 100) / 100; for (const k of kinds) { if (r < k.share) return k; r -= k.share; } return kinds[0]; };

      const { rows } = await sql<{ m: number | null }>`SELECT MAX(id) AS m FROM journal_entries`.execute(trx);
      const base = Number(rows[0].m ?? 0) + 10_000_000;
      const started = Date.now();
      for (let start = 0; start < VOUCHERS; start += BATCH) {
        const entries = [];
        const lines: Record<string, unknown>[] = [];
        for (let i = start; i < Math.min(VOUCHERS, start + BATCH); i++) {
          const id = base + i;
          const amount = 1_000 + (i * 37 % 9_000);
          const ls = pick(i).lines(amount).map(([accountId, debit, credit]) => [accountId, Math.round(debit * 100) / 100, Math.round(credit * 100) / 100]);
          const total = ls.reduce((t, l) => t + l[1], 0);
          entries.push({ id, org_id: orgId, branch_id: branchId, entry_no: i + 1, entry_date: day(i), memo: `Voucher ${i + 1}`, source_type: 'manual', total_debit: total.toFixed(2), total_credit: total.toFixed(2) });
          ls.forEach(([accountId, debit, credit], n) => lines.push({
            org_id: orgId, entry_id: id, line_no: n + 1, account_id: accountId, entry_date: day(i),
            debit: debit.toFixed(2), credit: credit.toFixed(2),
            contact_id: accountId === acc[CODE.AR] ? customers[i % customers.length] : null,
          }));
        }
        await trx.insertInto('journal_entries').values(entries as never).execute();
        await trx.insertInto('journal_lines').values(lines as never).execute();
      }
      console.log(`Loaded ${VOUCHERS.toLocaleString('en-IN')} vouchers in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

      const time = async (report: string, fn: () => Promise<unknown>) => {
        const runs: number[] = [];
        for (let k = 0; k < 3; k++) { const t = Date.now(); await fn(); runs.push(Date.now() - t); }
        results.push({ report, ms: runs.sort((a, b) => a - b)[1] });
      };
      await time('Trial balance, year end', () => trialBalance(trx, orgId, '2027-03-31'));
      await time('Profit and loss, the year', () => profitAndLoss(trx, orgId, '2026-04-01', '2027-03-31'));
      await time('Balance sheet, year end', () => balanceSheet(trx, orgId, '2027-03-31'));
      await time('Ledger: Sales, the year', () => generalLedger(trx, orgId, acc[CODE.SALES], '2026-04-01', '2027-03-31'));
      await time('Ledger: Receivables, one month', () => generalLedger(trx, orgId, acc[CODE.AR], '2026-10-01', '2026-10-31'));
      await time('Bank book, the year', () => cashBook(trx, orgId, bankId, '2026-04-01', '2027-03-31'));
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
  console.log('\nReport                              Time     Target 3s');
  for (const r of results) console.log(`${r.report.padEnd(36)}${`${(r.ms / 1000).toFixed(2)}s`.padEnd(9)}${r.ms <= TARGET_MS ? 'met' : 'NOT MET'}`);
  console.log('\nEverything loaded was rolled back.');
  await db.destroy();
}

void main();
