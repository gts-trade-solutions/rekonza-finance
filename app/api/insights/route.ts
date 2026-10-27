import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { detectFlags } from '@/lib/server/ai/insights';

// ─────────────────────────────────────────────────────────────────────────────
// What needs attention in the books, found by rules.
//
// The rules themselves live in lib/server/ai/insights.ts, shared with the
// assistant, which offers them as starting points and can look them up as a
// tool. They are filtered by role there: nobody is shown a flag about a part
// of the books their role cannot open.
//
// The keyword router that used to answer questions here has been replaced by
// the assistant itself, which answers from the same reports.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async ({ orgId, role }) => {
    const flags = await detectFlags(db, orgId, role);
    return {
      view: 'flags',
      flags,
      summary: {
        high: flags.filter((f) => f.severity === 'high').length,
        medium: flags.filter((f) => f.severity === 'medium').length,
        low: flags.filter((f) => f.severity === 'low').length,
      },
    };
  },
  { permission: { module: 'ai', action: 'view' } },
);
