// ─────────────────────────────────────────────────────────────────────────────
// The demo book's audit trail edits, after the independent auditor's check
// (status review 7, item 2): an edit log has to show what changed, so the
// demo carries real edits made through the services, recorded as the screens
// record them, each with the old and new value of every field that moved and
// the address the change came from.
//
//   * an invoice raised at ₹500 and its rate corrected to ₹550 (line 1 · rate
//     500 → 550, and the totals);
//   * Settings → Policies: sign-out after idle, 30 → 60 minutes (a setting that
//     changes nothing else the demo shows);
//   * a manual journal corrected from ₹25,000 to ₹27,500.
//
// Called once from scripts/seed.ts. The addresses are from the documentation
// range (RFC 5737), never anyone's real one.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { logAudit } from '../audit';
import type { IdMap } from './bootstrap';
import { DEMO_TODAY } from './demo-book';
import { CODE, accountIds } from '../ledger/chart-of-accounts';
import { createInvoice, updateInvoice } from '../services/sales';
import { editJournal, postManualJournal } from '../services/journals';
import { getPolicies, setPolicies } from '../services/org-settings';

const R = (rupees: number) => Math.round(rupees * 100);
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function seedDemoFxB(trx: Trx, ids: IdMap): Promise<void> {
  const org = ids.orgId;
  const admin = ids.users.u_arun;
  const accountant = ids.users.u_priya ?? admin;
  const names = new Map((await trx.selectFrom('users').select(['id', 'name']).where('org_id', '=', org).execute()).map((u) => [u.id, u.name]));
  const branch = ids.branches.br_chennai;
  const customer = ids.contacts.c_apex ?? Object.values(ids.contacts)[0];
  const item = await trx.selectFrom('items').select(['id', 'name', 'hsn_sac', 'gst_rate_pct']).where('org_id', '=', org).where('kind', '=', 'goods')
    .where('is_active', '=', 1).orderBy('id').executeTakeFirst();
  if (!customer || !item || !branch) return;
  const day = shift(DEMO_TODAY, -2);
  const meta = (ip: string) => ({ ip, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36' });

  // The invoice: raised at ₹500, then the rate corrected to ₹550.
  const line = (ratePaise: number) => ({ itemId: item.id, description: item.name, hsnSac: item.hsn_sac, qty: 1, ratePaise, gstRatePct: Number(item.gst_rate_pct) });
  const input = { branchId: branch, customerId: customer, date: day, dueDate: shift(day, 30), status: 'approved' as const, notes: 'Thanks for your business.' };
  const inv = await createInvoice(trx, org, accountant, { ...input, lines: [line(R(500))] } as never);
  await logAudit({ trx, orgId: org, actorUserId: accountant, actorName: names.get(accountant) ?? null, action: 'create', targetType: 'invoice', targetId: inv.id,
    targetLabel: inv.number, detail: `Created invoice ${inv.number}`, ...meta('203.0.113.24') });
  const made = await updateInvoice(trx, org, accountant, inv.id, { ...input, lines: [line(R(550))] } as never);
  await logAudit({ trx, orgId: org, actorUserId: accountant, actorName: names.get(accountant) ?? null, action: 'update', targetType: 'invoice', targetId: inv.id,
    targetLabel: made.number, detail: `Edited ${made.number}`, reason: 'Rate agreed at ₹550 on the purchase order',
    payload: { before: made.before, after: made.after }, ...meta('203.0.113.24') });

  // Settings → Policies: the idle sign-out lengthened, by the admin.
  const before = await getPolicies(trx, org);
  const minutes = before.sessionIdleMinutes === 60 ? 45 : 60;
  const after = await setPolicies(trx, org, admin, { sessionIdleMinutes: minutes });
  await logAudit({ trx, orgId: org, actorUserId: admin, actorName: names.get(admin) ?? null, action: 'update', targetType: 'organization', targetId: org,
    targetLabel: 'Policies', detail: 'Policies changed: sessionIdleMinutes', payload: { changes: { before, after } }, ...meta('198.51.100.7') });

  // A manual journal corrected: ₹25,000 to ₹27,500.
  const acc = await accountIds(trx, org);
  if (acc[CODE.BANK_DEFAULT] && acc[CODE.CAPITAL]) {
    const lines = (p: number) => [{ accountId: acc[CODE.BANK_DEFAULT], debitPaise: p }, { accountId: acc[CODE.CAPITAL], creditPaise: p }];
    const j = await postManualJournal(trx, org, accountant, { branchId: branch, date: shift(DEMO_TODAY, -5), memo: 'Capital brought in by the proprietor', lines: lines(R(25_000)) });
    const e = await editJournal(trx, org, accountant, j.id, { branchId: branch, date: shift(DEMO_TODAY, -5), memo: 'Capital brought in by the proprietor', lines: lines(R(27_500)) });
    await logAudit({ trx, orgId: org, actorUserId: accountant, actorName: names.get(accountant) ?? null, action: 'update', targetType: 'journal', targetId: e.entry.id,
      targetLabel: `#${e.entry.entryNo}`, detail: `Edited journal #${e.replacedEntryNo}: now #${e.entry.entryNo}`, reason: 'Bank slip shows ₹27,500',
      payload: { before: e.before, after: e.after }, ...meta('203.0.113.24') });
  }
}
