import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Downloading a detailed report.
//
// A person's first download is free. After that each new report costs
// REPORT_DOWNLOAD_CREDITS, and the same report again — in either format —
// costs nothing, because it has been paid for. The receipt is one row per
// person, answer and report, kept even when the conversation is deleted, so
// deleting one never hands out another free download.
//
// The file is made in the browser, from the report returned here: the copy
// stored with the answer, not whatever the page happens to be holding.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { notFound } from '../http';
import { FREE_REPORT_DOWNLOADS, MC_PER_CREDIT, REPORT_DOWNLOAD_CREDITS } from '../../billing/catalog';
import type { AiReport } from '../../ai/reports';
import { prepareWallet, spendCredits, walletView } from '../billing/wallet';

export const DOWNLOAD_PRICE_MC = REPORT_DOWNLOAD_CREDITS * MC_PER_CREDIT;

export interface DownloadScope {
  orgId: number;
  userId: number;
  isDemo: boolean;
  /** The demo book's conversations belong to a sign-in session, not a user. */
  sessionKey: string | null;
  monthlyCapMc: number | null;
}

function parseReports(v: unknown): AiReport[] {
  if (!v) return [];
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as AiReport[];
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as AiReport[]) : [];
}

/** A report from an answer in one of this person's own conversations — anyone else's is not found. */
export async function findReport(
  ex: Executor,
  s: DownloadScope,
  messageId: number,
  key: string,
): Promise<{ report: AiReport; conversationId: number }> {
  let q = ex
    .selectFrom('ai_messages as m')
    .innerJoin('ai_conversations as c', 'c.id', 'm.conversation_id')
    .select(['m.reports_json', 'm.conversation_id'])
    .where('m.id', '=', messageId)
    .where('m.org_id', '=', s.orgId)
    .where('m.role', '=', 'assistant')
    .where('c.org_id', '=', s.orgId)
    .where('c.user_id', '=', s.userId);
  if (s.isDemo) q = q.where('c.session_key', '=', s.sessionKey ?? '__none__');
  const row = await q.executeTakeFirst();
  const report = parseReports(row?.reports_json).find((r) => r.key === key);
  if (!row || !report) throw notFound('That report is not available.');
  return { report, conversationId: Number(row.conversation_id) };
}

const receipt = (ex: Executor, s: DownloadScope, messageId: number, key: string) =>
  ex
    .selectFrom('ai_report_downloads')
    .select('id')
    .where('org_id', '=', s.orgId)
    .where('user_id', '=', s.userId)
    .where('message_id', '=', messageId)
    .where('report_key', '=', key);

async function downloadsSoFar(ex: Executor, s: DownloadScope): Promise<number> {
  const { rows } = await sql<{ n: number | string }>`
    SELECT COUNT(*) AS n FROM ai_report_downloads WHERE org_id = ${s.orgId} AND user_id = ${s.userId}
  `.execute(ex);
  return Number(rows[0]?.n ?? 0);
}

export interface DownloadQuote {
  owned: boolean;
  free: boolean;
  priceMc: number;
  availableMc: number;
}

/** What a download would cost, without charging anything. */
export async function quoteDownload(ex: Executor, s: DownloadScope, messageId: number, key: string): Promise<DownloadQuote> {
  await findReport(ex, s, messageId, key);
  const [owned, count, wallet] = await Promise.all([
    receipt(ex, s, messageId, key).executeTakeFirst(),
    downloadsSoFar(ex, s),
    walletView(ex, s.orgId),
  ]);
  const free = !owned && count < FREE_REPORT_DOWNLOADS;
  return { owned: !!owned, free, priceMc: owned || free ? 0 : DOWNLOAD_PRICE_MC, availableMc: wallet.availableMc };
}

export interface TakenDownload {
  report: AiReport;
  chargedMc: number;
  free: boolean;
  owned: boolean;
}

/** Charge for a download when one is due, and hand back the report. Inside the caller's transaction. */
export async function takeDownload(
  trx: Trx,
  s: DownloadScope,
  messageId: number,
  key: string,
  format: 'png' | 'csv',
  now = new Date(),
): Promise<TakenDownload> {
  const { report, conversationId } = await findReport(trx, s, messageId, key);
  // The wallet's lock first, as every credit movement takes it: two downloads
  // at once queue here, so they cannot both be the free first one.
  await prepareWallet(trx, s.orgId, now, { isDemo: s.isDemo });

  if (await receipt(trx, s, messageId, key).forUpdate().executeTakeFirst()) {
    return { report, chargedMc: 0, free: false, owned: true };
  }

  const free = (await downloadsSoFar(trx, s)) < FREE_REPORT_DOWNLOADS;
  let chargedMc = 0;
  let usageId: number | null = null;
  if (!free) {
    const spent = await spendCredits(
      trx,
      s.orgId,
      s.userId,
      DOWNLOAD_PRICE_MC,
      { provider: 'download', model: 'report', note: `Report download · ${report.title}`, monthlyCapMc: s.monthlyCapMc, conversationId },
      now,
    );
    chargedMc = spent.chargedMc;
    usageId = spent.usageId;
  }

  await trx
    .insertInto('ai_report_downloads')
    .values({
      org_id: s.orgId,
      user_id: s.userId,
      message_id: messageId,
      report_key: key,
      format,
      charged_mc: chargedMc,
      free: free ? 1 : 0,
      usage_id: usageId,
    })
    .execute();
  return { report, chargedMc, free, owned: false };
}
