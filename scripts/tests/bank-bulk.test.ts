// Bank statements in bulk: the file formats (lib/bank-formats.ts), mapping
// columns by hand (lib/bank-statement.ts), and the bulk actions, undo and
// suggestions on imported lines (lib/server/services/bank-bulk.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/bank-bulk.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { importStatement, categoriseTransaction } from '../../lib/server/services/banking';
import { bulkCategorise, deleteLines, narrationWords, setExcluded, suggestCategories, undoImport, acceptSuggestions } from '../../lib/server/services/bank-bulk';
import { accountInGrid, detectFormat, matchAccount, parseCamt, parseJsonStatement, parseMt940, parseOfx, parseQif } from '../../lib/bank-formats';
import { guessMapping, readStatementGrid, readWithMapping, statementDate } from '../../lib/bank-statement';

test.after(() => db.destroy());

// ── Formats ──────────────────────────────────────────────────────────────────

test('OFX, SGML or XML, reads each STMTTRN and the account', () => {
  const sgml = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>HDFC0001234<ACCTID>50100123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005120000<TRNAMT>-3200.00<FITID>F1<NAME>BHARAT PETRO<MEMO>FUEL OMR</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261006<TRNAMT>58500.00<FITID>F2<NAME>TRICHY SPARE POINT</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const p = parseOfx(sgml);
  assert.equal(p.accountHint, '50100123456789');
  assert.deepEqual(p.rows, [
    { date: '2026-10-05', narration: 'BHARAT PETRO · FUEL OMR', reference: 'F1', depositPaise: 0, withdrawalPaise: 320000 },
    { date: '2026-10-06', narration: 'TRICHY SPARE POINT', reference: 'F2', depositPaise: 5850000, withdrawalPaise: 0 },
  ]);
  assert.equal(detectFormat('statement.qfx', ''), 'ofx');
  assert.equal(detectFormat('x.txt', sgml), 'ofx');
});

test('QIF reads its records, day first unless the dates say otherwise', () => {
  const p = parseQif('!Type:Bank\nD05/10/2026\nT-3,200.00\nPBHARAT PETRO\n^\nD13/10/2026\nT58500\nPTRICHY SPARE POINT\nN1001\n^\n');
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].date, '2026-10-05');
  assert.equal(p.rows[0].withdrawalPaise, 320000);
  assert.equal(p.rows[1].reference, '1001');
  const us = parseQif("!Type:Bank\nD10/25'26\nT-10\nPX\n^\n");
  assert.equal(us.rows[0].date, '2026-10-25', 'a 25 in the second place means month first');
});

test('CAMT.053 reads each entry, credit or debit, and the account', () => {
  const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
  <Acct><Id><Othr><Id>918020012345678</Id></Othr></Id></Acct>
  <Ntry><Amt Ccy="INR">354.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-02</Dt></BookgDt><AcctSvcrRef>CHG9931</AcctSvcrRef>
    <NtryDtls><TxDtls><RmtInf><Ustrd>BANK CHARGES RTGS</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="INR">96000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-10-03</Dt></BookgDt><AddtlNtryInf>UPI CR HOSUR AUTO</AddtlNtryInf></Ntry>
  </Stmt></BkToCstmrStmt></Document>`;
  assert.equal(detectFormat('stmt.xml', xml), 'camt');
  const p = parseCamt(xml);
  assert.equal(p.accountHint, '918020012345678');
  assert.deepEqual(p.rows.map((r) => [r.date, r.narration, r.depositPaise, r.withdrawalPaise]), [
    ['2026-10-02', 'BANK CHARGES RTGS', 0, 35400],
    ['2026-10-03', 'UPI CR HOSUR AUTO', 9600000, 0],
  ]);
});

test('MT940 reads :61: lines with their :86: narrative', () => {
  const sta = `:20:STMT1
:25:50100123456789
:28C:1/1
:60F:C261001INR100000,00
:61:2610051005D3200,00NTRFPOS9912//X1
:86:BHARAT PETRO FUEL
OMR CHENNAI
:61:2610061006C58500,00NTRFN2026100601
:86:NEFT CR TRICHY SPARE POINT
:62F:C261006INR155300,00
-`;
  assert.equal(detectFormat('acct.sta', sta), 'mt940');
  const p = parseMt940(sta);
  assert.equal(p.accountHint, '50100123456789');
  assert.deepEqual(p.rows.map((r) => [r.date, r.narration, r.reference, r.depositPaise, r.withdrawalPaise]), [
    ['2026-10-05', 'BHARAT PETRO FUEL OMR CHENNAI', 'POS9912', 0, 320000],
    ['2026-10-06', 'NEFT CR TRICHY SPARE POINT', 'N2026100601', 5850000, 0],
  ]);
});

test('JSON lines are read with the same column guessing as a spreadsheet', () => {
  const p = parseJsonStatement(JSON.stringify({ rows: [
    { date: '2026-10-05', narration: 'BHARAT PETRO', withdrawal: 3200, deposit: null },
    { date: '2026-10-06', narration: 'TRICHY SPARE POINT', withdrawal: null, deposit: 58500 },
  ] }));
  assert.equal(p.problem, null);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[1].depositPaise, 5850000);
});

test('columns can be mapped by hand, dates month first, a signed amount column', () => {
  const grid = [
    ['Statement for', 'Account No: 50100123456789'],
    ['Posted', 'Payee', 'Value', 'Bal'],
    ['10/25/2026', 'BHARAT PETRO', '-3200', '96800'],
    ['10/26/2026', 'TRICHY SPARE POINT', '58500', '155300'],
  ];
  assert.equal(accountInGrid(grid), '50100123456789');
  assert.equal(guessMapping(grid), null, 'no recognisable header: the user maps it');
  const r = readWithMapping(grid, { headerAt: 1, date: 0, narration: 1, reference: -1, withdrawal: 2, deposit: 2, amount: -1, drcr: -1, balance: 3, dateOrder: 'mdy' });
  assert.equal(r.problem, null);
  assert.deepEqual(r.rows.map((x) => [x.date, x.withdrawalPaise, x.depositPaise, x.runningBalancePaise]), [
    ['2026-10-25', 320000, 0, 9680000],
    ['2026-10-26', 0, 5850000, 15530000],
  ]);
  assert.equal(statementDate('10/25/2026', 'mdy'), '2026-10-25');
  assert.equal(statementDate('25/10/2026'), '2026-10-25');
  // The old reader still works unchanged.
  assert.equal(readStatementGrid([['Date', 'Narration', 'Withdrawal', 'Deposit'], ['01/10/2026', 'X', '5', '']]).rows.length, 1);
  const accounts = [{ id: '1', name: 'HDFC', accountLast4: '6789' }, { id: '2', name: 'SBI', accountLast4: '1111' }];
  assert.equal(matchAccount(accounts, '50100123456789', 'x.csv')?.id, '1');
  assert.equal(matchAccount(accounts, null, 'SBI-1111-oct.csv')?.id, '2');
  assert.equal(matchAccount(accounts, null, 'statement.csv'), null);
});

// ── Bulk actions ─────────────────────────────────────────────────────────────

async function withBank(fn: (trx: Trx, orgId: number, bankId: number, acc: Record<string, number>) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Bank Bulk Co' }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCW7070G1Z7' }).execute();
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'HDFC Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      await fn(trx, orgId, bankId, acc);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const statement = [
  { date: '2026-10-01', narration: 'NEFT DR SHREE RAM ESTATES RENT OCT', reference: 'N1', depositPaise: 0, withdrawalPaise: 25_000_00 },
  { date: '2026-10-02', narration: 'POS BHARAT PETRO FUEL OMR 4412', reference: 'P1', depositPaise: 0, withdrawalPaise: 3_200_00 },
  { date: '2026-10-03', narration: 'POS BHARAT PETRO FUEL GUINDY 7781', reference: 'P2', depositPaise: 0, withdrawalPaise: 2_900_00 },
  { date: '2026-10-04', narration: 'BANK CHARGES RTGS', reference: 'C1', depositPaise: 0, withdrawalPaise: 354_00 },
  { date: '2026-11-01', narration: 'NEFT DR SHREE RAM ESTATES RENT NOV', reference: 'N2', depositPaise: 0, withdrawalPaise: 25_000_00 },
];

const ids = async (trx: Trx, orgId: number) => (await trx.selectFrom('bank_transactions').select(['id', 'narration', 'status']).where('org_id', '=', orgId).orderBy('txn_date').execute());

test('lines categorised in bulk each get one balanced entry', async () => {
  await withBank(async (trx, orgId, bankId, acc) => {
    await importStatement(trx, orgId, null, bankId, 'oct.csv', statement);
    const lines = await ids(trx, orgId);
    const fuel = lines.filter((l) => /PETRO/.test(l.narration)).map((l) => l.id);
    const r = await bulkCategorise(trx, orgId, null, fuel, { accountId: acc[CODE.FUEL] });
    assert.deepEqual(r, { categorised: 2, skipped: 0 });
    const again = await bulkCategorise(trx, orgId, null, fuel, { accountId: acc[CODE.FUEL] });
    assert.equal(again.categorised, 0, 'matched lines are left alone');
    const entries = await trx.selectFrom('journal_entries').select(['total_debit']).where('org_id', '=', orgId).where('source_type', '=', 'bank_txn').execute();
    assert.equal(entries.length, 2);
    assert.equal(entries.reduce((t, e) => t + Number(e.total_debit), 0), 6100);
  });
});

test('excluding, restoring, deleting and undoing an import', async () => {
  await withBank(async (trx, orgId, bankId, acc) => {
    const imp = await importStatement(trx, orgId, null, bankId, 'oct.csv', statement);
    const lines = await ids(trx, orgId);
    const charges = lines.find((l) => /CHARGES/.test(l.narration))!.id;
    assert.equal(await setExcluded(trx, orgId, [charges], true), 1);
    assert.equal(await setExcluded(trx, orgId, [charges], true), 0, 'already excluded');
    assert.equal(await setExcluded(trx, orgId, [charges], false), 1);

    // One line categorised; then delete it and another: only the free one goes.
    const rent = lines.find((l) => /RENT OCT/.test(l.narration))!.id;
    await categoriseTransaction(trx, orgId, null, rent, { accountId: acc[CODE.RENT] });
    assert.deepEqual(await deleteLines(trx, orgId, [rent, charges]), { deleted: 1, kept: 1 });

    // Undo: the three uncategorised lines left go; the categorised rent stays.
    const u = await undoImport(trx, orgId, imp.importId);
    assert.deepEqual(u, { removed: 3, kept: 1 });
    const left = await ids(trx, orgId);
    assert.deepEqual(left.map((l) => l.id), [rent]);
    const record = await trx.selectFrom('bank_statement_imports').select('rows_imported').where('id', '=', imp.importId).executeTakeFirst();
    assert.equal(record?.rows_imported, 1);
  });
});

test('suggestions are learnt from lines categorised before', async () => {
  await withBank(async (trx, orgId, bankId, acc) => {
    await importStatement(trx, orgId, null, bankId, 'oct.csv', statement);
    const lines = await ids(trx, orgId);
    // October's rent and one fuel line categorised by hand.
    await categoriseTransaction(trx, orgId, null, lines.find((l) => /RENT OCT/.test(l.narration))!.id, { accountId: acc[CODE.RENT] });
    await categoriseTransaction(trx, orgId, null, lines.find((l) => /OMR/.test(l.narration))!.id, { accountId: acc[CODE.FUEL] });

    const open = (await ids(trx, orgId)).filter((l) => l.status === 'unmatched');
    const s = await suggestCategories(trx, orgId, open.map((l) => ({ id: l.id, narration: l.narration, inflow: false })));
    const nov = open.find((l) => /RENT NOV/.test(l.narration))!;
    const guindy = open.find((l) => /GUINDY/.test(l.narration))!;
    const charges = open.find((l) => /CHARGES/.test(l.narration))!;
    assert.equal(s.get(nov.id)?.name, 'Rent', 'the November rent looks like October’s');
    assert.equal(s.get(guindy.id)?.name, 'Fuel & Vehicle Running');
    assert.ok((s.get(nov.id)?.confidence ?? 0) > 0.5);
    assert.equal(s.has(charges.id), false, 'nothing like it has been categorised');
    // Money in never borrows from money out.
    const inflow = await suggestCategories(trx, orgId, [{ id: nov.id, narration: nov.narration, inflow: true }]);
    assert.equal(inflow.size, 0);

    assert.equal(await acceptSuggestions(trx, orgId, null, [{ id: nov.id, accountId: Number(s.get(nov.id)!.accountId) }]), 1);
    assert.deepEqual([...narrationWords('NEFT DR SHREE RAM ESTATES RENT NOV N2026')], ['SHREE', 'RAM', 'ESTATES', 'RENT', 'NOV']);
  });
});
