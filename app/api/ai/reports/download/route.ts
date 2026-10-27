import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { badRequest, body, route } from '@/lib/server/http';
import { aiSettingsFor } from '@/lib/server/ai/settings';
import { currentSessionKey } from '@/lib/server/ai/session-key';
import { quoteDownload, takeDownload, type DownloadScope } from '@/lib/server/ai/downloads';
import { walletView } from '@/lib/server/billing/wallet';

// ─────────────────────────────────────────────────────────────────────────────
// Downloading a report under an answer.
//
//   GET   what it would cost — free the first time, and for a report already
//         downloaded; a credit otherwise — so the page can say so first
//   POST  charge it when due, and return the stored report to make the file
// ─────────────────────────────────────────────────────────────────────────────

async function scopeFor(orgId: number, userId: number): Promise<DownloadScope> {
  const settings = await aiSettingsFor(db, orgId);
  return {
    orgId,
    userId,
    isDemo: settings.isDemo,
    sessionKey: await currentSessionKey(),
    monthlyCapMc: settings.userMonthlyCapMc,
  };
}

const MessageId = z.coerce.number().int().positive();
const Key = z.string().trim().min(1).max(120);

export const GET = route(
  async ({ user, orgId, req }) => {
    const url = new URL(req.url);
    const messageId = MessageId.safeParse(url.searchParams.get('messageId'));
    const key = Key.safeParse(url.searchParams.get('key'));
    if (!messageId.success || !key.success) throw badRequest('Say which report to download.');
    return quoteDownload(db, await scopeFor(orgId, user.userId), messageId.data, key.data);
  },
  { permission: { module: 'ai', action: 'view' } },
);

const Take = z.object({
  messageId: MessageId,
  key: Key,
  format: z.enum(['png', 'csv']),
});

export const POST = route(
  async ({ user, orgId, req }) => {
    const input = await body(req, Take);
    const scope = await scopeFor(orgId, user.userId);
    // Only database work, and the receipt makes it safe to repeat.
    const taken = await transaction((trx) => takeDownload(trx, scope, input.messageId, input.key, input.format), {
      retryDeadlocks: true,
    });
    const wallet = await walletView(db, orgId);
    return { ...taken, availableMc: wallet.availableMc };
  },
  { permission: { module: 'ai', action: 'view' } },
);
