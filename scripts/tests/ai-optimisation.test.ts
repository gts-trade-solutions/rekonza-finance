// The assistant made quicker and cheaper (lib/server/ai/cache.ts, agent.ts,
// openai.ts): lookups of one step run side by side, a lookup made while the
// books stood still is reused, the cache keys move with every write, and
// OpenAI is given a prompt-cache key — only OpenAI.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/ai-optimisation.test.ts
//
// Nothing here asks a question through the stored assistant (that writes
// conversations and charges); the agent loop is run directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { runAgent } from '../../lib/server/ai/agent';
import { answerKey, booksVersion, lookupCache, lookupKey, normaliseQuestion } from '../../lib/server/ai/cache';
import { OpenAiProvider } from '../../lib/server/ai/openai';
import { priceFor } from '../../lib/server/ai/pricing';
import type { AiProvider, ChatRequest, ChatResult, ToolCall } from '../../lib/server/ai/types';
import type { ToolContext, ToolRun } from '../../lib/server/ai/tools';

test.after(() => db.destroy());

const TODAY = '2026-10-31';
const FY = '2026-04-01';
const usage = { inputTokens: 100, cachedTokens: 0, outputTokens: 10, reasoningTokens: 0, estimated: false };

/** Asks for the given lookups once, then answers. */
function scripted(calls: ToolCall[], answer = 'Done.'): AiProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: 'openai', model: 'gpt-5-mini', requests,
    async chat(req: ChatRequest): Promise<ChatResult> {
      requests.push(req);
      if (requests.length === 1) return { text: '', toolCalls: calls, usage, finishReason: 'tool_calls' };
      return { text: answer, toolCalls: [], usage, finishReason: 'stop' };
    },
  };
}

const base = (provider: AiProvider, tools: ToolContext) => ({
  provider, tools,
  prompt: { orgName: 'Speed Co', userName: 'Asha', role: 'admin' as const, today: TODAY, fyStart: FY, hidden: [] },
  history: [], question: 'How are we doing?', holdMc: 20_000, price: priceFor('gpt-5-mini').price, creditCostUsd: 0.003,
  signal: new AbortController().signal, emit: () => {},
});

async function withBook(fn: (trx: Trx, ctx: ToolContext, branchId: number, acc: Record<string, number>) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Speed Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCT9090J1Z9' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await fn(trx, { ex: trx, orgId, userId: 1, role: 'admin', today: TODAY, fyStart: FY }, branchId, acc);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('the lookups of one step run side by side, answered in the order asked', async () => {
  const calls: ToolCall[] = [
    { id: 'a', name: 'get_profit_and_loss', arguments: '{}' },
    { id: 'b', name: 'get_cash_position', arguments: '{}' },
    { id: 'c', name: 'get_receivables', arguments: '{}' },
  ];
  const provider = scripted(calls);
  let running = 0;
  let peak = 0;
  const slow = async (call: ToolCall): Promise<ToolRun> => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 60));
    running--;
    return { ok: true, content: JSON.stringify({ tool: call.name }), sources: [], label: call.name, report: null };
  };
  const started = Date.now();
  const result = await runAgent({ ...base(provider, { ex: db, orgId: 0, userId: 0, role: 'admin', today: TODAY, fyStart: FY }), runLookup: slow });
  assert.equal(result.outcome, 'answered');
  assert.equal(result.toolCalls, 3);
  assert.equal(peak, 3, 'all three at once');
  assert.ok(Date.now() - started < 170, 'about one lookup’s time, not three');
  const toolMsgs = provider.requests[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => (m as { toolCallId: string }).toolCallId), ['a', 'b', 'c']);
});

test('a lookup made while the books stand still is reused; a write moves the version', async () => {
  await withBook(async (trx, ctx, branchId, acc) => {
    lookupCache.clear();
    const version = await booksVersion(trx, ctx.orgId);
    const call: ToolCall = { id: 'x', name: 'get_cash_position', arguments: '{}' };
    const first = await runAgent({ ...base(scripted([call]), ctx), booksVersion: version });
    assert.equal(first.lookupsFromCache, 0);
    // The same figures, arguments in another order, asked again.
    const again = await runAgent({ ...base(scripted([{ ...call, arguments: ' {} ' }]), ctx), booksVersion: version });
    assert.equal(again.lookupsFromCache, 1, 'read once, reused');

    await postEntry(trx, { orgId: ctx.orgId, branchId, date: '2026-10-30', memo: 'Capital', sourceType: 'manual', lines: [
      { accountId: acc[CODE.BANK_DEFAULT], debit: 1_00_000_00 }, { accountId: acc[CODE.CAPITAL], credit: 1_00_000_00 },
    ] });
    const moved = await booksVersion(trx, ctx.orgId);
    assert.notEqual(moved, version, 'the write moved the version');
    const after = await runAgent({ ...base(scripted([call]), ctx), booksVersion: moved });
    assert.equal(after.lookupsFromCache, 0, 'read afresh after the books changed');
  });
});

test('cache keys: the same question however typed; a new version or day is a new key', () => {
  assert.equal(normaliseQuestion('  What do customers OWE us?? '), 'what do customers owe us');
  const scope = { orgId: 7, role: 'admin', today: TODAY, version: '10.4', model: 'openai:gpt-5-mini' };
  assert.equal(answerKey(scope, 'What do customers owe us?'), answerKey(scope, 'what do customers owe us'));
  assert.notEqual(answerKey(scope, 'q'), answerKey({ ...scope, version: '11.4' }, 'q'));
  assert.notEqual(answerKey(scope, 'q'), answerKey({ ...scope, today: '2026-11-01' }, 'q'));
  assert.notEqual(answerKey(scope, 'q'), answerKey({ ...scope, role: 'sales' }, 'q'), 'a role never sees another role’s answer');
  const l = { orgId: 7, role: 'admin', today: TODAY, version: '10.4' };
  assert.equal(
    lookupKey(l, { id: '1', name: 't', arguments: '{"from":"2026-04-01","to":"2026-10-31"}' }),
    lookupKey(l, { id: '2', name: 't', arguments: '{"to":"2026-10-31","from":"2026-04-01"}' }),
  );
});

test('OpenAI is given a prompt-cache key; a proxy is not', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const req = { messages: [{ role: 'user' as const, content: 'hi' }], maxOutputTokens: 100, cacheKey: 'rekonza:7:admin' };
  await new OpenAiProvider({ apiKey: 'sk', model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1' }, fakeFetch).chat(req);
  await new OpenAiProvider({ apiKey: 'sk', model: 'gpt-5-mini', baseUrl: 'https://proxy.example/v1' }, fakeFetch).chat(req);
  assert.equal(bodies[0].prompt_cache_key, 'rekonza:7:admin');
  assert.equal('prompt_cache_key' in bodies[1], false);
});
