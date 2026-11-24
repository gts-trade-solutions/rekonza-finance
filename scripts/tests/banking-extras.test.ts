// What Zoho Books has in Banking that the first copy left out (migration 125):
// rules that record a Customer or Vendor Payment, duplicates kept as
// "Automatically Excluded", Banking Preferences, and statements that arrive by
// email (services/banking.ts, banking-preferences.ts, inbound-statements.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/banking-extras.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { applyRules, importStatement, matchEnteredPayments, DUPLICATE_REASON } from '../../lib/server/services/banking';
import { createRule } from '../../lib/server/services/bank-rules';
import { setExcluded } from '../../lib/server/services/bank-bulk';
import { createInvoice } from '../../lib/server/services/sales';
import { receivePayment } from '../../lib/server/services/payments';
import { bankingPreferences, saveBankingPreferences } from '../../lib/server/services/banking-preferences';
import {
  ensureInboundTokens, inboundAddress, inboundSecretOk, readInboundRequest, receiveInboundStatement, type InboundEmail,
} from '../../lib/server/services/inbound-statements';
import { readStatementFile } from '../../lib/server/statement-file';

const ENV = ['INBOUND_EMAIL_DOMAIN', 'INBOUND_WEBHOOK_SECRET', 'INBOUND_EMAIL_LOCAL'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
test.after(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await db.destroy();
});

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; vendorId: number; bankId: number; userEmail: string; acc: Record<string, number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Banking Extras Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (v: Record<string, unknown>) => Number((await trx.insertInto('contacts').values(v as never).executeTakeFirstOrThrow()).insertId);
      const customerId = await mk({ org_id: orgId, kind: 'customer', display_name: 'Bonita Skin Care', gst_treatment: 'registered', state_code: '33' });
      const vendorId = await mk({ org_id: orgId, kind: 'vendor', display_name: 'Petro Fuels', gst_treatment: 'unregistered', state_code: '33' });
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'ICICI Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      const userEmail = `owner-${orgId}@banking-extras.example`;
      await trx.insertInto('users').values({ org_id: orgId, email: userEmail, name: 'Owner', role: 'admin', password_hash: 'x' } as never).execute();
      await fn({ trx, orgId, branchId, customerId, vendorId, bankId, userEmail, acc: acc as unknown as Record<string, number> });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const sale = (f: Fixture, date: string, due: string, ratePaise: number) => createInvoice(f.trx, f.orgId, null, {
  branchId: f.branchId, customerId: f.customerId, date, dueDate: due, status: 'approved',
  lines: [{ itemId: null, description: 'Facial kits', qty: 1, ratePaise, gstRatePct: 0 }],
} as never);

test('a Customer Payment rule records the deposit from its customer, oldest invoice first, the rest as an advance', async () => {
  await withFixture(async (f) => {
    await assert.rejects(createRule(f.trx, f.orgId, {
      name: 'Bonita', applyTo: 'deposits', markAs: 'categorized', matchMode: 'any', criteria: [{ field: 'narration', op: 'contains', value: 'BONITA' }],
      recordAs: 'customer_payment', referenceMode: 'statement', scope: 'all',
    }), /Choose the customer\./);
    await assert.rejects(createRule(f.trx, f.orgId, {
      name: 'Bonita', applyTo: 'deposits', markAs: 'categorized', matchMode: 'any', criteria: [{ field: 'narration', op: 'contains', value: 'BONITA' }],
      recordAs: 'customer_payment', contactId: f.vendorId, referenceMode: 'statement', scope: 'all',
    }), /Choose a customer\./, 'a vendor cannot pay as a customer');
    const newer = await sale(f, '2026-11-10', '2026-12-10', 30_000);
    const older = await sale(f, '2026-11-01', '2026-11-15', 50_000);
    await createRule(f.trx, f.orgId, {
      name: 'Bonita', applyTo: 'deposits', markAs: 'categorized', matchMode: 'any', criteria: [{ field: 'narration', op: 'contains', value: 'BONITA' }],
      recordAs: 'customer_payment', contactId: f.customerId, referenceMode: 'statement', scope: 'all',
    });
    const r = await importStatement(f.trx, f.orgId, null, f.bankId, 'nov.csv', [
      { date: '2026-11-20', narration: 'NEFT CR BONITA SKIN CARE', reference: 'UTR1', depositPaise: 100_000 },
    ]);
    assert.equal(r.autoMatched, 1, 'the rule recorded it');
    const line = await f.trx.selectFrom('bank_transactions').select(['status', 'matched_type', 'matched_id']).where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.deepEqual([line.status, line.matched_type], ['matched', 'payment']);
    const pay = await f.trx.selectFrom('payments').select(['contact_id', 'amount', 'unapplied_amount', 'kind']).where('id', '=', Number(line.matched_id)).executeTakeFirstOrThrow();
    assert.deepEqual([pay.kind, pay.contact_id, Number(pay.amount), Number(pay.unapplied_amount)], ['received', f.customerId, 1000, 200], '₹800 settled, ₹200 kept as an advance');
    const inv = async (id: number) => (await f.trx.selectFrom('invoices').select(['status', 'amount_paid']).where('id', '=', id).executeTakeFirstOrThrow());
    assert.deepEqual([(await inv(Number(older.id))).status, Number((await inv(Number(older.id))).amount_paid)], ['paid', 500], 'the oldest due first');
    assert.deepEqual([(await inv(Number(newer.id))).status, Number((await inv(Number(newer.id))).amount_paid)], ['paid', 300]);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('a Vendor Payment rule pays its vendor; Recognized waits for a person, as Zoho does', async () => {
  await withFixture(async (f) => {
    await createRule(f.trx, f.orgId, {
      name: 'Fuel vendor', applyTo: 'withdrawals', markAs: 'recognized', matchMode: 'any', criteria: [{ field: 'narration', op: 'contains', value: 'PETRO' }],
      recordAs: 'vendor_payment', contactId: f.vendorId, referenceMode: 'none', scope: 'all',
    });
    await importStatement(f.trx, f.orgId, null, f.bankId, 'nov.csv', [{ date: '2026-11-21', narration: 'NEFT DR PETRO FUELS', withdrawalPaise: 45_000 }]);
    const line = await f.trx.selectFrom('bank_transactions').select(['id', 'status', 'applied_rule_id']).where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(line.status, 'unmatched', 'Recognized only: left for a person');
    assert.ok(line.applied_rule_id);
    const { applyRecognized } = await import('../../lib/server/services/banking');
    assert.deepEqual(await applyRecognized(f.trx, f.orgId, null, [line.id]), { applied: 1, skipped: 0 });
    const pay = await f.trx.selectFrom('payments').select(['kind', 'contact_id', 'amount', 'unapplied_amount']).where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.deepEqual([pay.kind, pay.contact_id, Number(pay.amount), Number(pay.unapplied_amount)], ['made', f.vendorId, 450, 450], 'no open bill: all of it an advance');
  });
});

test('a duplicate line is kept as Automatically Excluded once, can be restored, and is dropped when the preference is off', async () => {
  await withFixture(async (f) => {
    const rows = [
      { date: '2026-11-02', narration: 'BANK CHARGES QTR', withdrawalPaise: 590 },
      { date: '2026-11-03', narration: 'UPI CR MARINA', depositPaise: 48_000 },
    ];
    const first = await importStatement(f.trx, f.orgId, null, f.bankId, 'a.csv', rows);
    assert.deepEqual([first.imported, first.duplicates, first.autoExcluded], [2, 0, 0]);
    const again = await importStatement(f.trx, f.orgId, null, f.bankId, 'b.csv', rows);
    assert.deepEqual([again.imported, again.duplicates, again.autoExcluded], [0, 2, 2]);
    const third = await importStatement(f.trx, f.orgId, null, f.bankId, 'c.csv', rows);
    assert.deepEqual([third.duplicates, third.autoExcluded], [2, 0], 'no pile of copies on a third import');
    const kept = await f.trx.selectFrom('bank_transactions').select(['id', 'status', 'exclude_reason', 'auto_excluded']).where('org_id', '=', f.orgId).where('auto_excluded', '=', 1).execute();
    assert.equal(kept.length, 2);
    assert.ok(kept.every((k) => k.status === 'excluded' && k.exclude_reason === DUPLICATE_REASON));
    assert.equal(await setExcluded(f.trx, f.orgId, [kept[0].id], false), 1);
    const back = await f.trx.selectFrom('bank_transactions').select(['status', 'auto_excluded', 'exclude_reason']).where('id', '=', kept[0].id).executeTakeFirstOrThrow();
    assert.deepEqual([back.status, back.auto_excluded, back.exclude_reason], ['unmatched', 0, null], 'restored as an ordinary line');
    await saveBankingPreferences(f.trx, f.orgId, { keepDuplicates: false });
    const off = await importStatement(f.trx, f.orgId, null, f.bankId, 'd.csv', [{ date: '2026-11-09', narration: 'ATM', withdrawalPaise: 200_000 }, { date: '2026-11-09', narration: 'ATM', withdrawalPaise: 200_000 }]);
    assert.equal(off.imported, 2, 'two identical lines in one file are two real withdrawals');
    const offAgain = await importStatement(f.trx, f.orgId, null, f.bankId, 'e.csv', [{ date: '2026-11-09', narration: 'ATM', withdrawalPaise: 200_000 }]);
    assert.deepEqual([offAgain.duplicates, offAgain.autoExcluded], [1, 0], 'preference off: dropped, as before');
  });
});

test('Banking Preferences: checked when saved, and obeyed on import and in matching', async () => {
  await withFixture(async (f) => {
    assert.deepEqual(await bankingPreferences(f.trx, f.orgId), {
      applyRulesOnImport: true, autoMatchOnImport: true, matchWindowDays: 3, defaultExpenseAccountId: null, defaultIncomeAccountId: null,
      showPaymentClearing: true, keepDuplicates: true, inboundEnabled: true, inboundSenders: [],
    }, 'no row: the defaults');
    await assert.rejects(saveBankingPreferences(f.trx, f.orgId, { matchWindowDays: 45 }), /0 to 30 days/);
    await assert.rejects(saveBankingPreferences(f.trx, f.orgId, { defaultIncomeAccountId: String(f.acc[CODE.BANK_DEFAULT]) }), /Choose an income account/);
    await assert.rejects(saveBankingPreferences(f.trx, f.orgId, { inboundSenders: ['not an email'] }), /not an email address/);
    const saved = await saveBankingPreferences(f.trx, f.orgId, { applyRulesOnImport: false, matchWindowDays: 10, inboundSenders: ['Statements@ICICIBank.com', '@hdfcbank.net'] });
    assert.deepEqual(saved.inboundSenders, ['statements@icicibank.com', '@hdfcbank.net']);
    assert.equal((await bankingPreferences(f.trx, f.orgId)).matchWindowDays, 10, 'kept');
    // Rules off on import: the line waits, though a rule catches it; Run rules now still runs it.
    await createRule(f.trx, f.orgId, {
      name: 'Charges', applyTo: 'withdrawals', markAs: 'categorized', matchMode: 'any', criteria: [{ field: 'narration', op: 'contains', value: 'CHARGES' }],
      recordAs: 'expense', accountId: f.acc[CODE.BANK_CHARGES], referenceMode: 'statement', scope: 'all',
    });
    const r = await importStatement(f.trx, f.orgId, null, f.bankId, 'x.csv', [{ date: '2026-11-14', narration: 'BANK CHARGES', withdrawalPaise: 590 }]);
    assert.equal(r.autoMatched, 0, 'rules are not run on import');
    assert.equal(await applyRules(f.trx, f.orgId, null, f.bankId), 1, 'but Run rules now runs them');
    // A payment 8 days from its line: matched with a 10-day window, not with 3.
    await receivePayment(f.trx, f.orgId, null, { branchId: f.branchId, contactId: f.customerId, date: '2026-11-01', mode: 'neft', amountPaise: 77_700, bankAccountId: f.bankId, allocations: [] });
    await saveBankingPreferences(f.trx, f.orgId, { applyRulesOnImport: true, autoMatchOnImport: false });
    await importStatement(f.trx, f.orgId, null, f.bankId, 'y.csv', [{ date: '2026-11-09', narration: 'NEFT CR BONITA', depositPaise: 77_700 }]);
    assert.equal(await matchEnteredPayments(f.trx, f.orgId, null, f.bankId, 3), 0, 'eight days apart: not within three');
    assert.equal(await matchEnteredPayments(f.trx, f.orgId, null, f.bankId, 10), 1, 'within ten');
  });
});

test('a statement file is read on the server as Import Statement reads it', async () => {
  const csv = 'Date,Narration,Ref No,Withdrawal,Deposit,Balance\n05/11/2026,NEFT CR SHARMA,UTR9,,2150.00,12150.00\n06/11/2026,ATM WDL,,500.00,,11650.00\n';
  const r = await readStatementFile('icici.csv', new TextEncoder().encode(csv));
  assert.equal(r.format, 'csv');
  assert.deepEqual(r.rows.map((x) => [x.date, x.narration, x.depositPaise, x.withdrawalPaise]), [['2026-11-05', 'NEFT CR SHARMA', 215_000, 0], ['2026-11-06', 'ATM WDL', 0, 50_000]]);
  const ofx = '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261107<TRNAMT>100.00<FITID>A1<NAME>INTEREST</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  const o = await readStatementFile('x.ofx', new TextEncoder().encode(ofx));
  assert.equal(o.rows.length, 1);
  assert.equal(o.rows[0].depositPaise, 10_000);
  const bad = await readStatementFile('notes.txt', new TextEncoder().encode('hello\nworld'));
  assert.equal(bad.rows.length, 0);
  assert.match(bad.problem ?? '', /No header row/);
});

test('the inbound webhook reads Mailgun, SendGrid and Postmark, and only with the secret', async () => {
  process.env.INBOUND_WEBHOOK_SECRET = 's3cret-inbound';
  process.env.INBOUND_EMAIL_DOMAIN = 'in.example.com';
  assert.equal(inboundSecretOk('s3cret-inbound'), true);
  assert.equal(inboundSecretOk('wrong'), false);
  assert.equal(inboundSecretOk(null), false);
  assert.equal(inboundAddress('abc123def456'), 'statements+abc123def456@in.example.com');
  const csv = new Blob(['Date,Narration,Deposit\n2026-11-05,NEFT CR X,10\n'], { type: 'text/csv' });

  const mg = new FormData();
  mg.set('recipient', 'statements+abc123def456@in.example.com'); mg.set('sender', 'Owner <owner@x.example>'); mg.set('subject', 'Statement');
  mg.set('attachment-count', '1'); mg.set('attachment-1', csv, 'nov.csv');
  const m = await readInboundRequest(new Request('http://x/api/inbound/statements', { method: 'POST', body: mg }));
  assert.deepEqual([m.provider, m.recipients, m.sender, m.attachments.length, m.attachments[0].filename], ['mailgun', ['statements+abc123def456@in.example.com'], 'owner@x.example', 1, 'nov.csv']);

  const sg = new FormData();
  sg.set('to', 'Bank <statements+abc123def456@in.example.com>'); sg.set('from', 'owner@x.example');
  sg.set('envelope', JSON.stringify({ to: ['statements+abc123def456@in.example.com'], from: 'owner@x.example' })); sg.set('attachments', '1'); sg.set('attachment1', csv, 'nov.csv');
  const s = await readInboundRequest(new Request('http://x/api/inbound/statements', { method: 'POST', body: sg }));
  assert.deepEqual([s.provider, s.recipients, s.sender, s.attachments.length], ['sendgrid', ['statements+abc123def456@in.example.com'], 'owner@x.example', 1]);

  const pm = await readInboundRequest(new Request('http://x/api/inbound/statements', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ From: 'Owner <owner@x.example>', OriginalRecipient: 'statements+abc123def456@in.example.com', Subject: 'S',
      Attachments: [{ Name: 'nov.csv', ContentType: 'text/csv', Content: Buffer.from('Date,Narration,Deposit\n').toString('base64') }] }),
  }));
  assert.deepEqual([pm.provider, pm.recipients, pm.sender, pm.attachments[0].filename], ['postmark', ['statements+abc123def456@in.example.com'], 'owner@x.example', 'nov.csv']);
});

test('a forwarded statement is imported into the account its address belongs to, from allowed senders only', async () => {
  process.env.INBOUND_EMAIL_DOMAIN = 'in.example.com';
  await withFixture(async (f) => {
    const [acct] = (await ensureInboundTokens(f.orgId, { trx: f.trx })).filter((a) => a.id === f.bankId);
    assert.match(acct.token, /^[a-z0-9]{12}$/);
    const again = (await ensureInboundTokens(f.orgId, { trx: f.trx })).find((a) => a.id === f.bankId)!;
    assert.equal(again.token, acct.token, 'the address stays the same');
    const to = inboundAddress(acct.token)!;
    const file = (body: string, name = 'nov.csv') => ({ filename: name, contentType: 'text/csv', data: new TextEncoder().encode(body) });
    const email = (o: Partial<InboundEmail>): InboundEmail => ({ provider: 'mailgun', recipients: [to], sender: f.userEmail, subject: 'Statement', attachments: [], ...o });
    const csv = 'Date,Narration,Ref No,Withdrawal,Deposit\n05/11/2026,NEFT CR SHARMA,UTR9,,2150.00\n06/11/2026,ATM WDL,,500.00,\n';

    const nobody = await receiveInboundStatement(email({ recipients: ['statements+zzzzzzzzzzzz@in.example.com'], attachments: [file(csv)] }), { trx: f.trx });
    assert.equal(nobody.results[0].status, 'refused');
    assert.equal((await f.trx.selectFrom('inbound_statements').select('id').where('org_id', '=', f.orgId).execute()).length, 0, 'nothing written for an address nobody owns');

    const stranger = await receiveInboundStatement(email({ sender: 'mallory@evil.example', attachments: [file(csv)] }), { trx: f.trx });
    assert.equal(stranger.results[0].status, 'refused');
    assert.match(stranger.results[0].reason ?? '', /may not send statements/);

    const noFile = await receiveInboundStatement(email({ attachments: [file('x', 'photo.png')] }), { trx: f.trx });
    assert.match(noFile.results[0].reason ?? '', /No statement was attached/);

    const ok = await receiveInboundStatement(email({ attachments: [file(csv)] }), { trx: f.trx });
    assert.deepEqual([ok.account, ok.results[0].status, ok.results[0].imported], ['ICICI Current', 'imported', 2]);
    const lines = await f.trx.selectFrom('bank_transactions').select(['narration', 'deposit']).where('bank_account_id', '=', f.bankId).orderBy('txn_date').execute();
    assert.deepEqual(lines.map((l) => [l.narration, Number(l.deposit)]), [['NEFT CR SHARMA', 2150], ['ATM WDL', 0]]);

    await saveBankingPreferences(f.trx, f.orgId, { inboundSenders: ['@icicibank.com'] });
    const bank = await receiveInboundStatement(email({ sender: 'alerts@icicibank.com', attachments: [file(csv)] }), { trx: f.trx });
    assert.deepEqual([bank.results[0].status, bank.results[0].imported, bank.results[0].duplicates], ['imported', 0, 2], 'the bank itself, by its @domain; the same lines are duplicates');

    const broken = await receiveInboundStatement(email({ attachments: [file('hello\nthere')] }), { trx: f.trx });
    assert.equal(broken.results[0].status, 'failed');

    await saveBankingPreferences(f.trx, f.orgId, { inboundEnabled: false });
    const off = await receiveInboundStatement(email({ attachments: [file(csv)] }), { trx: f.trx });
    assert.match(off.results[0].reason ?? '', /switched off/);
    const log = await f.trx.selectFrom('inbound_statements').select(['status']).where('org_id', '=', f.orgId).orderBy('id').execute();
    assert.deepEqual(log.map((l) => l.status), ['refused', 'refused', 'imported', 'imported', 'failed', 'refused'], 'every email written down');
  });
});
