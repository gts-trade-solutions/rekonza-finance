// The AI assistant and the credits that pay for it.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/ai-billing.test.ts
//
// The pure rules first — pricing, the stream reader, signatures, the tax split,
// the calendar — and then the wallet and the whole question loop against a
// real database, inside transactions that are rolled back. No network: OpenAI
// is replaced by a recorded stream, and the question loop by the stand-in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import {
  MC_PER_CREDIT, formatCharge, formatCredits, packByCode, planByCode, withGst,
} from '../../lib/billing/catalog';
import { rupeesInWords, indianWords } from '../../lib/billing/words';
import { splitFollowups, visibleWhileStreaming } from '../../lib/ai/followups';
import {
  FALLBACK_PRICE, MIN_CHARGE_MC, chargeFor, costMicroUsd, millicreditsFor, priceFor,
} from '../../lib/server/ai/pricing';
import { addMonthsClamped, fyStartOf, istDate, previousMonth, wholeMonthsBetween } from '../../lib/server/ai/time';
import { OpenAiProvider, isReasoningModel, readChatStream } from '../../lib/server/ai/openai';
import { ProviderError, NO_USAGE } from '../../lib/server/ai/types';
import { StandinProvider, extractAccount, planTools } from '../../lib/server/ai/standin';
import { hiddenAreas, runTool, toolSpecsFor } from '../../lib/server/ai/tools';
import { buildSystemPrompt } from '../../lib/server/ai/prompt';
import { runAgent } from '../../lib/server/ai/agent';
import {
  grantCredits, holdCredits, prepareWallet, settleUsage, walletView,
} from '../../lib/server/billing/wallet';
import { verifyPaymentSignature, verifySubscriptionSignature, verifyWebhookSignature } from '../../lib/server/billing/razorpay';
import { fyShort, splitGst } from '../../lib/server/billing/invoices';
import { markTopupPaid } from '../../lib/server/billing/service';

// ── Pricing ──────────────────────────────────────────────────────────────────

test('a model is priced by its longest matching name, and an unknown one at the safe fallback', () => {
  const env = {};
  assert.equal(priceFor('gpt-5-mini', env).price.input, 0.25);
  assert.equal(priceFor('gpt-5-mini-2025-08-07', env).price.input, 0.25, 'a dated snapshot is its family, not gpt-5');
  assert.equal(priceFor('gpt-5', env).price.output, 10);
  const unknown = priceFor('some-new-model', env);
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.price, FALLBACK_PRICE);
  const override = priceFor('anything', { OPENAI_PRICE_INPUT: '1', OPENAI_PRICE_OUTPUT: '4' });
  assert.deepEqual(override.price, { input: 1, cached: 1, output: 4 });
});

test('cached input is part of the input, billed at its own rate', () => {
  const price = { input: 0.25, cached: 0.025, output: 2 };
  // 10,000 input of which 4,000 cached, 1,500 out:
  // 6,000 × 0.25 + 4,000 × 0.025 + 1,500 × 2 = 1,500 + 100 + 3,000 = 4,600 micro-dollars
  assert.equal(costMicroUsd({ inputTokens: 10_000, cachedTokens: 4_000, outputTokens: 1_500 }, price), 4_600);
});

test('a question is charged what it cost, at least the minimum, never more than was held', () => {
  // $0.0062 at $0.003 a credit is 2.067 credits.
  assert.equal(millicreditsFor(6_200, 0.003), 2_067);
  assert.equal(chargeFor(6_200, 0.003, 20_000), 2_067);
  assert.equal(chargeFor(0, 0.003, 20_000), 0, 'nothing consumed, nothing charged');
  assert.equal(chargeFor(10, 0.003, 20_000), MIN_CHARGE_MC);
  assert.equal(chargeFor(1_000_000, 0.003, 5_000), 5_000, 'capped at the reservation');
});

test('credits read to one decimal, charges round up to the tenth', () => {
  assert.equal(formatCredits(312_400), '312.4');
  assert.equal(formatCredits(500_000), '500');
  assert.equal(formatCredits(960), '0.9', 'rounded down: never promise a question that cannot be paid for');
  assert.equal(formatCharge(40), '0.1');
  assert.equal(formatCharge(2_067), '2.1');
});

test('GST is added to catalogue prices, and packs and plans exist as priced', () => {
  assert.deepEqual(withGst(149_00, 18), { taxablePaise: 149_00, gstPaise: 26_82, totalPaise: 175_82 });
  assert.equal(packByCode('pack_500')?.credits, 500);
  assert.equal(planByCode('growth')?.creditsPerMonth, 1_500);
  const starter = planByCode('starter')!;
  assert.equal(starter.yearlyPaise, starter.monthlyPaise * 10, 'a year is ten months');
});

// ── Follow-ups ───────────────────────────────────────────────────────────────

test('follow-up questions are lifted out of the answer', () => {
  const text = 'Cash is **₹5,000.00**.\n\n```followups\n- How about last month?\n- Which bank?\n- x\n```';
  const { body, followups } = splitFollowups(text);
  assert.equal(body, 'Cash is **₹5,000.00**.');
  assert.deepEqual(followups, ['How about last month?', 'Which bank?'], 'too-short lines are dropped');
  assert.deepEqual(splitFollowups('No block here.'), { body: 'No block here.', followups: [] });
});

test('a follow-up block never flickers onto the screen while streaming', () => {
  assert.equal(visibleWhileStreaming('Answer.\n\n```fol'), 'Answer.');
  assert.equal(visibleWhileStreaming('Answer.\n\n```followups\n- one'), 'Answer.');
  assert.equal(visibleWhileStreaming('Answer.\n\n```'), 'Answer.');
  assert.equal(visibleWhileStreaming('Code: ```js\nx'), 'Code: ```js\nx', 'an ordinary code block is left alone');
});

// ── The OpenAI stream ────────────────────────────────────────────────────────

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

function streamOf(text: string, pieceSize = 7): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      // Deliberately cut mid-line and mid-character-sequence, the way a real
      // network delivers it.
      for (let i = 0; i < text.length; i += pieceSize) c.enqueue(enc.encode(text.slice(i, i + pieceSize)));
      c.close();
    },
  });
}

const RECORDED =
  sse({ choices: [{ delta: { content: 'Let me ' } }] }) +
  sse({ choices: [{ delta: { content: 'check.' } }] }) +
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_account_balance', arguments: '{"acc' } }] } }] }) +
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ount":"Cash"}' } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
  ': keep-alive\n\n' +
  sse({
    choices: [],
    usage: {
      prompt_tokens: 1_200,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 1_024 },
      completion_tokens_details: { reasoning_tokens: 32 },
    },
  }) +
  'data: [DONE]\n\n';

test('the stream reader reassembles text, tool calls and the usage report', async () => {
  const deltas: string[] = [];
  const out = await readChatStream(streamOf(RECORDED), (t) => deltas.push(t));
  assert.equal(out.text, 'Let me check.');
  assert.equal(deltas.join(''), 'Let me check.');
  assert.deepEqual(out.toolCalls, [{ id: 'call_1', name: 'get_account_balance', arguments: '{"account":"Cash"}' }]);
  assert.equal(out.finishReason, 'tool_calls');
  assert.deepEqual(out.usage, { inputTokens: 1_200, cachedTokens: 1_024, outputTokens: 80, reasoningTokens: 32, estimated: false });
});

test('a stream with no usage report says so, rather than inventing one', async () => {
  const out = await readChatStream(streamOf(sse({ choices: [{ delta: { content: 'Hi' } }] }) + 'data: [DONE]\n\n'));
  assert.equal(out.usage, null);
});

test('the provider sends a well-formed request, with reasoning effort only where it applies', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(streamOf(RECORDED), { status: 200 });
  }) as typeof fetch;

  const reasoning = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5-mini', baseUrl: 'https://example.test/v1', reasoningEffort: 'low' }, fake);
  const r = await reasoning.chat({
    messages: [{ role: 'user', content: 'Cash?' }],
    tools: [{ name: 'get_account_balance', description: 'x', parameters: { type: 'object', properties: {} } }],
    maxOutputTokens: 900,
  });
  assert.equal(r.toolCalls[0].name, 'get_account_balance');
  const b = bodies[0] as { model: string; stream: boolean; stream_options: { include_usage: boolean }; max_completion_tokens: number; reasoning_effort?: string; tools: { type: string }[]; tool_choice: string };
  assert.equal(b.model, 'gpt-5-mini');
  assert.equal(b.stream, true);
  assert.equal(b.stream_options.include_usage, true);
  assert.equal(b.max_completion_tokens, 900);
  assert.equal(b.reasoning_effort, 'low');
  assert.equal(b.tools[0].type, 'function');
  assert.equal(b.tool_choice, 'auto');

  const classic = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-4.1-mini', baseUrl: 'https://example.test/v1', reasoningEffort: 'low' }, fake);
  await classic.chat({ messages: [{ role: 'user', content: 'Cash?' }], maxOutputTokens: 500 });
  assert.equal((bodies[1] as { reasoning_effort?: string }).reasoning_effort, undefined, 'a non-reasoning model would reject it');
  assert.equal(isReasoningModel('o4-mini'), true);
  assert.equal(isReasoningModel('gpt-5-chat-latest'), false);
});

test('our provider account running dry is reported as such, and not retried', async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'quota' } }), { status: 429 });
  }) as typeof fetch;
  const p = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5-mini', baseUrl: 'https://example.test/v1' }, fake);
  await assert.rejects(p.chat({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 100 }), (err: unknown) => err instanceof ProviderError && err.kind === 'quota');
  assert.equal(calls, 1);
});

test('a server error at the door is retried once before failing', async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return calls === 1 ? new Response('upstream down', { status: 503 }) : new Response(streamOf(RECORDED), { status: 200 });
  }) as typeof fetch;
  const p = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5-mini', baseUrl: 'https://example.test/v1' }, fake);
  const r = await p.chat({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 100 });
  assert.equal(calls, 2);
  assert.equal(r.text, 'Let me check.');
});

// ── Razorpay signatures ──────────────────────────────────────────────────────

test('payment, subscription and webhook signatures verify, and forgeries do not', () => {
  const secret = 'test_secret_123';
  const sig = createHmac('sha256', secret).update('order_ABC|pay_XYZ').digest('hex');
  assert.equal(verifyPaymentSignature({ orderId: 'order_ABC', paymentId: 'pay_XYZ', signature: sig }, secret), true);
  assert.equal(verifyPaymentSignature({ orderId: 'order_ABC', paymentId: 'pay_OTHER', signature: sig }, secret), false);
  assert.equal(verifyPaymentSignature({ orderId: 'order_ABC', paymentId: 'pay_XYZ', signature: sig.slice(0, -1) }, secret), false);

  // Subscriptions sign the other way round: payment first.
  const subSig = createHmac('sha256', secret).update('pay_XYZ|sub_123').digest('hex');
  assert.equal(verifySubscriptionSignature({ subscriptionId: 'sub_123', paymentId: 'pay_XYZ', signature: subSig }, secret), true);

  const body = '{"event":"payment.captured"}';
  const hook = createHmac('sha256', 'whsec').update(body).digest('hex');
  assert.equal(verifyWebhookSignature(body, hook, 'whsec'), true);
  assert.equal(verifyWebhookSignature(`${body} `, hook, 'whsec'), false, 'the raw body, byte for byte');
  assert.equal(verifyWebhookSignature(body, null, 'whsec'), false);
});

// ── Tax invoices ─────────────────────────────────────────────────────────────

test('GST splits into CGST and SGST within a state, IGST across states', () => {
  assert.deepEqual(splitGst(26_82, '33', '33'), { cgstPaise: 13_41, sgstPaise: 13_41, igstPaise: 0 });
  assert.deepEqual(splitGst(27_01, '33', '33'), { cgstPaise: 13_50, sgstPaise: 13_51, igstPaise: 0 }, 'the odd paisa goes to SGST');
  assert.deepEqual(splitGst(26_82, '33', '29'), { cgstPaise: 0, sgstPaise: 0, igstPaise: 26_82 });
  assert.equal(fyShort('2026-03-31'), '25-26');
  assert.equal(fyShort('2026-04-01'), '26-27');
});

test('amounts in words, in lakh and crore', () => {
  assert.equal(rupeesInWords(175_82), 'Rupees One Hundred Seventy-Five and Eighty-Two Paise Only');
  assert.equal(rupeesInWords(1_999_00), 'Rupees One Thousand Nine Hundred Ninety-Nine Only');
  assert.equal(indianWords(12_34_56_789), 'Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine');
  assert.equal(indianWords(1_00_000), 'One Lakh');
});

// ── The calendar ─────────────────────────────────────────────────────────────

test('dates are Indian dates, and months step without overflowing', () => {
  assert.equal(istDate(new Date('2026-09-11T19:00:00Z')), '2026-09-12', '12:30 a.m. in India is already the 12th');
  assert.equal(fyStartOf('2026-02-10'), '2025-04-01');
  assert.equal(previousMonth('2026-01-15'), '2025-12');
  assert.equal(addMonthsClamped(new Date('2026-01-31T10:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(addMonthsClamped(new Date('2028-01-31T10:00:00Z'), 1).toISOString().slice(0, 10), '2028-02-29');
  assert.equal(wholeMonthsBetween(new Date('2026-01-31T00:00:00Z'), new Date('2026-03-30T00:00:00Z')), 1);
});

// ── The assistant's reach ────────────────────────────────────────────────────

test('a role is only offered the tools for what it can see', () => {
  const admin = toolSpecsFor('admin').map((t) => t.name);
  const sales = toolSpecsFor('sales').map((t) => t.name);
  assert.ok(admin.includes('get_profit_and_loss'));
  assert.ok(!sales.includes('get_profit_and_loss'), 'sales does not see profit');
  assert.ok(!sales.includes('get_account_balance'));
  assert.ok(sales.includes('get_receivables'));
  assert.ok(!sales.includes('get_payables'), 'or suppliers');
  assert.deepEqual(hiddenAreas('admin'), []);
  assert.ok(hiddenAreas('sales').length >= 3);
  const prompt = buildSystemPrompt({ orgName: 'Acme Traders', userName: 'Asha', role: 'sales', today: '2026-09-12', fyStart: '2026-04-01', hidden: hiddenAreas('sales') });
  assert.match(prompt, /Acme Traders/);
  assert.match(prompt, /FY 2026-27/);
  assert.match(prompt, /```followups/);
  assert.match(prompt, /profit, costs/);
});

test('the stand-in reads the question the way a model would reach for tools', () => {
  assert.equal(extractAccount('What is the closing balance of HDFC Bank today?'), 'HDFC Bank');
  assert.equal(extractAccount('closing balance of each of our bank accounts'), null);
  const offered = new Set(toolSpecsFor('admin').map((t) => t.name));
  assert.deepEqual(planTools('How much cash do we have?', offered).map((p) => p.name), ['get_cash_position']);
  assert.deepEqual(planTools('Which customers are overdue?', offered).map((p) => p.name), ['get_receivables']);
  assert.deepEqual(planTools('Hello there', offered).map((p) => p.name), ['get_attention_items']);
  const sales = new Set(toolSpecsFor('sales').map((t) => t.name));
  assert.deepEqual(planTools('How much profit have we made this year?', sales), [], 'a role without the report gets no stand-in answer to a different question');
});

test('a bank is found by its own name, not by the institution it shares with a card', async () => {
  await withOrg(async ({ trx, orgId, acc }) => {
    const current = await trx
      .insertInto('accounts')
      .values({ org_id: orgId, code: '1211', name: 'HDFC Bank – Current', type: 'asset', subtype: 'bank', is_system: 1, is_active: 1 })
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('bank_accounts')
      .values([
        { org_id: orgId, kind: 'bank', name: 'HDFC Bank – Current', bank_name: 'HDFC Bank', ledger_account_id: Number(current.insertId), opening_balance: '0.0000', is_primary: 1, is_active: 1 },
        { org_id: orgId, kind: 'card', name: 'HDFC Business Credit Card', bank_name: 'HDFC Bank', ledger_account_id: acc[CODE.CREDIT_CARD], opening_balance: '0.0000', is_primary: 0, is_active: 1 },
      ])
      .execute();
    const out = await runTool(
      { ex: trx, orgId, userId: 1, role: 'admin', today: '2026-09-12', fyStart: '2026-04-01' },
      { id: 'z', name: 'get_account_balance', arguments: '{"account":"HDFC Bank"}' },
    );
    const data = JSON.parse(out.content) as { found: boolean; account?: { code: string } };
    assert.equal(data.found, true);
    assert.equal(data.account?.code, '1211');
  });
});

// ── Against the database ─────────────────────────────────────────────────────

async function withOrg(fn: (ctx: { trx: Trx; orgId: number; branchId: number; acc: Record<string, number> }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations').values({ name: 'Wallet Test Co', pan: 'AAAAA0000A' }).executeTakeFirstOrThrow();
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

const hold = (trx: Trx, orgId: number, userId: number, over: Partial<Parameters<typeof holdCredits>[3]> = {}) =>
  holdCredits(trx, orgId, userId, { capMc: 20_000, isDemo: false, monthlyCapMc: null, provider: 'standin', model: 'stand-in', ...over });

const settle = (trx: Trx, orgId: number, usageId: number, chargeMc: number) =>
  settleUsage(trx, orgId, usageId, {
    chargeMc,
    usage: NO_USAGE,
    costMicroUsd: chargeMc * 3,
    modelCalls: 2,
    toolCalls: 1,
    outcome: 'answered',
    durationMs: 800,
  });

test('credits are spent soonest-expiring first, grants are idempotent, and the ledger adds up', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const soon = new Date(Date.now() + 10 * 86_400_000);
    const later = new Date(Date.now() + 300 * 86_400_000);
    await grantCredits(trx, { orgId, source: 'topup', mc: 10_000, expiresAt: later, grantKey: 'topup:t1', note: 'pack' });
    const trial = await grantCredits(trx, { orgId, source: 'trial', mc: 3_000, expiresAt: soon, grantKey: 'trial', note: 'trial' });
    const again = await grantCredits(trx, { orgId, source: 'trial', mc: 3_000, expiresAt: soon, grantKey: 'trial', note: 'trial' });
    assert.equal(again.created, false);
    assert.equal(again.bucketId, trial.bucketId);

    const h = await hold(trx, orgId, 7, { capMc: 5_000 });
    assert.equal(h.holdMc, 5_000);
    let view = await walletView(trx, orgId);
    assert.deepEqual([view.totalMc, view.heldMc, view.availableMc], [13_000, 5_000, 8_000]);

    const { chargedMc } = await settle(trx, orgId, h.usageId, 4_200);
    assert.equal(chargedMc, 4_200);
    view = await walletView(trx, orgId);
    assert.deepEqual([view.totalMc, view.heldMc, view.availableMc], [8_800, 0, 8_800]);
    assert.deepEqual(view.buckets.map((b) => [b.source, b.remainingMc]), [['topup', 8_800]], 'the trial went first');

    const twice = await settle(trx, orgId, h.usageId, 4_200);
    assert.equal(twice.chargedMc, 0, 'settling twice charges once');

    const ledger = await trx.selectFrom('ai_credit_ledger').select(['delta_mc', 'balance_after_mc']).where('org_id', '=', orgId).orderBy('id').execute();
    assert.equal(ledger.reduce((t, l) => t + Number(l.delta_mc), 0), 8_800);
    assert.equal(Number(ledger[ledger.length - 1].balance_after_mc), 8_800);
  });
});

test('a question needs a whole credit to start, and a charge never overdraws', async () => {
  await withOrg(async ({ trx, orgId }) => {
    await grantCredits(trx, { orgId, source: 'topup', mc: 900, expiresAt: null, grantKey: 'a', note: 'a' });
    await assert.rejects(hold(trx, orgId, 7), (err: { status?: number; code?: string }) => err.status === 402 && err.code === 'out_of_credits');

    await grantCredits(trx, { orgId, source: 'topup', mc: 600, expiresAt: null, grantKey: 'b', note: 'b' });
    const h = await hold(trx, orgId, 7);
    assert.equal(h.holdMc, 1_500, 'holds everything available, and no more');
    const { chargedMc } = await settle(trx, orgId, h.usageId, 99_999);
    assert.equal(chargedMc, 1_500, 'capped at the hold');
    assert.equal((await walletView(trx, orgId)).totalMc, 0);
  });
});

test('two questions at once cannot spend the same credit', async () => {
  await withOrg(async ({ trx, orgId }) => {
    await grantCredits(trx, { orgId, source: 'topup', mc: 12_000, expiresAt: null, grantKey: 'c', note: 'c' });
    const first = await hold(trx, orgId, 7, { capMc: 10_000 });
    const second = await hold(trx, orgId, 8, { capMc: 10_000 });
    assert.equal(first.holdMc, 10_000);
    assert.equal(second.holdMc, 2_000, 'the second reserves only what the first left');
    await assert.rejects(hold(trx, orgId, 9), (err: { status?: number }) => err.status === 402);
  });
});

test('a per-person monthly limit is enforced', async () => {
  await withOrg(async ({ trx, orgId }) => {
    await grantCredits(trx, { orgId, source: 'topup', mc: 50_000, expiresAt: null, grantKey: 'd', note: 'd' });
    const h = await hold(trx, orgId, 7, { monthlyCapMc: 2_000 });
    assert.equal(h.holdMc, 2_000);
    await settle(trx, orgId, h.usageId, 1_500);
    await assert.rejects(hold(trx, orgId, 7, { monthlyCapMc: 2_000 }), (err: { status?: number; code?: string }) => err.status === 429 && err.code === 'user_cap_reached');
    const other = await hold(trx, orgId, 8, { monthlyCapMc: 2_000 });
    assert.equal(other.holdMc, 2_000, 'someone else still can');
  });
});

test('an abandoned reservation is released, uncharged', async () => {
  await withOrg(async ({ trx, orgId }) => {
    await grantCredits(trx, { orgId, source: 'topup', mc: 10_000, expiresAt: null, grantKey: 'e', note: 'e' });
    const h = await hold(trx, orgId, 7, { capMc: 3_000 });
    await trx.updateTable('ai_usage').set({ created_at: new Date(Date.now() - 20 * 60_000) }).where('id', '=', h.usageId).execute();
    assert.equal((await walletView(trx, orgId)).availableMc, 7_000);
    await prepareWallet(trx, orgId, new Date(), { isDemo: false });
    assert.equal((await walletView(trx, orgId)).availableMc, 10_000);
    const usage = await trx.selectFrom('ai_usage').select(['status', 'outcome', 'charged_mc']).where('id', '=', h.usageId).executeTakeFirstOrThrow();
    assert.deepEqual([usage.status, usage.outcome, Number(usage.charged_mc)], ['failed', 'abandoned', 0]);
  });
});

test('expired credits are swept, with a ledger line of their own', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const now = Date.now();
    await grantCredits(trx, { orgId, source: 'trial', mc: 2_000, expiresAt: new Date(now + 3_600_000), grantKey: 'trial', note: 'trial' });
    await grantCredits(trx, { orgId, source: 'topup', mc: 5_000, expiresAt: null, grantKey: 'f', note: 'f' });
    const later = new Date(now + 2 * 3_600_000);
    await prepareWallet(trx, orgId, later, { isDemo: false });
    assert.equal((await walletView(trx, orgId, later)).totalMc, 5_000);
    const expiry = await trx.selectFrom('ai_credit_ledger').select(['delta_mc', 'balance_after_mc']).where('org_id', '=', orgId).where('kind', '=', 'expiry').execute();
    assert.deepEqual(expiry.map((e) => [Number(e.delta_mc), Number(e.balance_after_mc)]), [[-2_000, 5_000]]);
  });
});

test('an active plan grants each month once, a month at a time', async () => {
  await withOrg(async ({ trx, orgId }) => {
    // Whole seconds: DATETIME keeps no fractions, and the key is built from
    // the stored value.
    const start = new Date(Math.floor((Date.now() - 40 * 86_400_000) / 1000) * 1000);
    const end = addMonthsClamped(start, 12);
    const sub = await trx
      .insertInto('billing_subscriptions')
      .values({
        org_id: orgId, plan_code: 'growth', period: 'yearly', status: 'active', provider: 'standin',
        provider_subscription_id: `test_sub_${orgId}`, amount_paise: 1, current_start: start, current_end: end,
      })
      .executeTakeFirstOrThrow();

    await prepareWallet(trx, orgId, new Date(), { isDemo: false });
    await prepareWallet(trx, orgId, new Date(), { isDemo: false });
    const buckets = await trx.selectFrom('ai_credit_buckets').select(['source', 'granted_mc', 'grant_key', 'expires_at']).where('org_id', '=', orgId).execute();
    assert.equal(buckets.length, 1, 'granted once');
    assert.equal(Number(buckets[0].granted_mc), 1_500 * MC_PER_CREDIT);
    const month2 = addMonthsClamped(start, 1);
    assert.equal(buckets[0].grant_key, `plan:${Number(sub.insertId)}:${month2.toISOString()}`, 'the second month, not the first');

    // A renewal that starts a new period grants that period, even on the same day.
    const renewedStart = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await trx
      .updateTable('billing_subscriptions')
      .set({ current_start: renewedStart, current_end: addMonthsClamped(renewedStart, 1), period: 'monthly' })
      .where('id', '=', Number(sub.insertId))
      .execute();
    await prepareWallet(trx, orgId, new Date(), { isDemo: false });
    const after = await trx.selectFrom('ai_credit_buckets').select('grant_key').where('org_id', '=', orgId).execute();
    assert.equal(after.length, 2, 'the renewed period has its own grant');
  });
});

test('a paid top-up grants its credits and one invoice, however many times it is reported', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const row = await trx
      .insertInto('billing_payments')
      .values({
        org_id: orgId, kind: 'topup', provider: 'standin', status: 'created', pack_code: 'pack_100',
        description: '100 AI credits', credits: 100, taxable_paise: 149_00, gst_paise: 26_82, amount_paise: 175_82,
        provider_order_id: `standin_order_t${orgId}`,
      })
      .executeTakeFirstOrThrow();
    const id = Number(row.insertId);
    const pay = { providerPaymentId: `standin_pay_t${orgId}`, method: 'test', amountPaise: 175_82 };

    const first = await markTopupPaid(trx, id, pay, { userId: null, name: 'Test' });
    assert.equal(first.alreadyPaid, false);
    assert.match(first.invoiceNumber ?? '', /^[A-Z]{1,4}\/\d{2}-\d{2}\/\d{5}$/);
    const second = await markTopupPaid(trx, id, pay, { userId: null, name: 'Test' });
    assert.equal(second.alreadyPaid, true);

    assert.equal((await walletView(trx, orgId)).totalMc, 100 * MC_PER_CREDIT);
    const invoices = await trx.selectFrom('billing_invoices').select(['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'total_paise']).where('org_id', '=', orgId).execute();
    assert.equal(invoices.length, 1);
    const inv = invoices[0];
    assert.equal(Number(inv.cgst_paise) + Number(inv.sgst_paise) + Number(inv.igst_paise), 26_82);
    assert.equal(Number(inv.total_paise), 175_82);

    const other = await trx
      .insertInto('billing_payments')
      .values({
        org_id: orgId, kind: 'topup', provider: 'standin', status: 'created', pack_code: 'pack_100',
        description: '100 AI credits', credits: 100, taxable_paise: 149_00, gst_paise: 26_82, amount_paise: 175_82,
        provider_order_id: `standin_order_u${orgId}`,
      })
      .executeTakeFirstOrThrow();
    await assert.rejects(
      markTopupPaid(trx, Number(other.insertId), { providerPaymentId: `standin_pay_u${orgId}`, method: 'test', amountPaise: 100 }, { userId: null, name: 'Test' }),
      (err: { status?: number; code?: string }) => err.status === 409 && err.code === 'amount_mismatch',
    );
  });
});

test('a whole question: the closing balance, from the ledger, with its source and its cost', async () => {
  await withOrg(async ({ trx, orgId, branchId, acc }) => {
    await postEntry(trx, {
      orgId, branchId, date: '2026-09-01', sourceType: 'manual', memo: 'Capital introduced',
      lines: [
        { accountId: acc[CODE.CASH], debit: 5_000_00 },
        { accountId: acc[CODE.CAPITAL], credit: 5_000_00 },
      ],
    });

    const events: { type: string; name?: string }[] = [];
    const result = await runAgent({
      provider: new StandinProvider({ delayMs: 0 }),
      tools: { ex: trx, orgId, userId: 1, role: 'admin', today: '2026-09-12', fyStart: '2026-04-01' },
      prompt: { orgName: 'Wallet Test Co', userName: 'Asha', role: 'admin', today: '2026-09-12', fyStart: '2026-04-01', hidden: [] },
      history: [],
      question: 'What is the closing balance of Cash in Hand?',
      holdMc: 20_000,
      price: priceFor('stand-in').price,
      creditCostUsd: 0.003,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
    });

    assert.equal(result.outcome, 'answered');
    assert.match(result.content, /Cash in Hand/);
    assert.match(result.content, /₹5,000\.00 Dr/);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.modelCalls, 2);
    assert.ok(result.costMicroUsd > 0, 'the tokens are priced');
    assert.ok(result.followups.length > 0);
    assert.equal(result.sources[0]?.href, '/reports/general-ledger');
    assert.ok(events.some((e) => e.type === 'tool' && e.name === 'get_account_balance'));
    assert.ok(!result.content.includes('```'), 'the follow-up block is not part of the answer');
  });
});

test.after(async () => {
  await db.destroy();
});

test('a tool a role was not given is refused, even if the model asks for it by name', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const out = await runTool(
      { ex: trx, orgId, userId: 1, role: 'sales', today: '2026-09-12', fyStart: '2026-04-01' },
      { id: 'x', name: 'get_profit_and_loss', arguments: '{}' },
    );
    assert.equal(out.ok, false);
    assert.match(out.content, /not available/);

    const bad = await runTool(
      { ex: trx, orgId, userId: 1, role: 'admin', today: '2026-09-12', fyStart: '2026-04-01' },
      { id: 'y', name: 'get_trial_balance', arguments: '{"as_of":"yesterday"}' },
    );
    assert.equal(bad.ok, false, 'arguments are validated, not trusted');
  });
});
