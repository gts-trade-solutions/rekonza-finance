import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId, badRequest } from '@/lib/server/http';
import { toPaiseFromSql, toSqlFromPaise } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { clearCheque, moveCheque, noticeDeadline, returnCheque } from '@/lib/server/services/cheques';

// ─────────────────────────────────────────────────────────────────────────────
// The cheque register.
//
// This is a record of paper in a drawer, not a ledger. A post-dated cheque
// changes no balance until it clears: the money is neither yours nor theirs
// while it sits waiting to mature, and booking it early would show cash you
// cannot spend. The payment that actually moves the money is recorded
// separately and linked to the cheque by its number.
//
// What the register is for is the question the ledger cannot answer — what is
// due to land next week, and what has bounced. A bounce is the one move here
// that posts: see lib/server/services/cheques.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async ({ orgId }) => {
    const rows = await db
      .selectFrom('cheques as q')
      .innerJoin('contacts as c', 'c.id', 'q.contact_id')
      .leftJoin('payments as p', 'p.id', 'q.payment_id')
      .select([
        'q.id', 'q.kind', 'q.cheque_no', 'q.bank_name', 'q.amount', 'q.is_pdc',
        'q.maturity_date', 'q.status', 'q.notes', 'q.payment_id', 'p.number as payment_number',
        'p.status as payment_status', 'q.cleared_on', 'q.returned_on', 'q.return_reason',
        'q.return_charges', 'q.charges_to_party',
        'q.contact_id', 'c.display_name as contact_name',
      ])
      .where('q.org_id', '=', orgId)
      .orderBy('q.maturity_date')
      .execute();

    const cheques = rows.map((r) => {
      const returnedOn = r.returned_on ? String(r.returned_on).slice(0, 10) : null;
      return {
        id: asId(r.id),
        kind: r.kind,
        chequeNo: r.cheque_no,
        bankName: r.bank_name,
        contactId: asId(r.contact_id),
        contactName: r.contact_name,
        amountPaise: toPaiseFromSql(r.amount),
        isPdc: !!r.is_pdc,
        maturityDate: String(r.maturity_date).slice(0, 10),
        status: r.status,
        notes: r.notes,
        paymentId: r.payment_id === null ? null : asId(r.payment_id),
        paymentNumber: r.payment_number ?? null,
        paymentVoid: r.payment_status === 'void',
        clearedOn: r.cleared_on ? String(r.cleared_on).slice(0, 10) : null,
        returnedOn,
        returnReason: r.return_reason,
        returnChargesPaise: toPaiseFromSql(r.return_charges),
        chargesToParty: !!r.charges_to_party,
        // Only the payee of a returned cheque has a notice to send.
        noticeBy: returnedOn && r.kind === 'received' ? noticeDeadline(returnedOn) : null,
      };
    });

    const pending = (kind: string) =>
      cheques.filter((c) => c.kind === kind && c.isPdc && c.status === 'in_hand');
    const bounced = cheques.filter((c) => c.status === 'bounced');

    return {
      cheques,
      summary: {
        pdcInPaise: pending('received').reduce((t, c) => t + c.amountPaise, 0),
        pdcInCount: pending('received').length,
        pdcOutPaise: pending('issued').reduce((t, c) => t + c.amountPaise, 0),
        pdcOutCount: pending('issued').length,
        bouncedPaise: bounced.reduce((t, c) => t + c.amountPaise, 0),
        bouncedCount: bounced.length,
      },
    };
  },
  { permission: { module: 'banking', action: 'view' } },
);

const CreateInput = z.object({
  kind: z.enum(['issued', 'received']),
  contactId: z.union([z.string(), z.number()]),
  chequeNo: z.string().trim().min(1, 'A cheque number is required.').max(20),
  bankName: z.string().trim().max(120).nullish(),
  amountPaise: z.number().int().positive('Enter an amount above zero.'),
  maturityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  notes: z.string().trim().max(500).nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, CreateInput);
    const contactId = Number(input.contactId);

    const contact = await db
      .selectFrom('contacts').select(['id', 'display_name'])
      .where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirst();
    if (!contact) throw badRequest('That contact does not exist.');

    // A cheque dated in the future is post-dated, whatever anybody calls it.
    // The flag is derived rather than asked for, because a mis-ticked box would
    // put a live cheque in the "waiting to mature" bucket.
    const isPdc = input.maturityDate > new Date().toISOString().slice(0, 10);

    const inserted = await db
      .insertInto('cheques')
      .values({
        org_id: orgId,
        kind: input.kind,
        contact_id: contactId,
        cheque_no: input.chequeNo,
        bank_name: input.bankName ?? null,
        amount: toSqlFromPaise(input.amountPaise),
        is_pdc: isPdc ? 1 : 0,
        maturity_date: input.maturityDate,
        status: 'in_hand',
        notes: input.notes ?? null,
      })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'cheque', targetId: id, targetLabel: input.chequeNo,
      detail: `${input.kind} cheque ${input.chequeNo} for ${(input.amountPaise / 100).toFixed(2)}, matures ${input.maturityDate}`,
      ...auditMeta(req),
    });

    return { id: asId(id), chequeNo: input.chequeNo, isPdc };
  },
  { permission: { module: 'banking', action: 'create' } },
);

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const Id = z.union([z.string(), z.number()]);

const StatusInput = z.discriminatedUnion('status', [
  z.object({ id: Id, status: z.literal('deposited') }),
  z.object({ id: Id, status: z.literal('cancelled') }),
  z.object({ id: Id, status: z.literal('cleared'), date: DATE.optional(), paymentId: Id.nullish() }),
  z.object({
    id: Id,
    status: z.literal('bounced'),
    date: DATE,
    reason: z.string().trim().min(3, "Give the bank's reason for the return.").max(200),
    chargesPaise: z.number().int().min(0).default(0),
    chargeToParty: z.boolean().default(false),
    bankAccountId: Id.nullish(),
  }),
]);

/**
 * Move a cheque along.
 *
 * Clearing links the cheque to the payment that recorded the money and posts
 * nothing itself. A return reverses that payment on the return date and posts
 * the bank's charge.
 */
export const PATCH = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, StatusInput);
    const id = Number(input.id);
    const today = new Date().toISOString().slice(0, 10);

    return transaction(async (trx) => {
      const cheque = await trx.selectFrom('cheques').select(['cheque_no'])
        .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!cheque) throw badRequest('That cheque does not exist.');

      const audit = (action: 'update' | 'void', detail: string) => logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action,
        targetType: 'cheque', targetId: id, targetLabel: cheque.cheque_no, detail, ...auditMeta(req),
      });

      switch (input.status) {
        case 'cleared': {
          const r = await clearCheque(trx, orgId, id, {
            date: input.date ?? today,
            paymentId: input.paymentId ? Number(input.paymentId) : null,
          });
          await audit('update', `Marked cleared${r.paymentNumber ? `; paid ${r.paymentNumber}` : '; no payment linked'}`);
          return { id: asId(id), status: 'cleared', paymentNumber: r.paymentNumber };
        }
        case 'bounced': {
          const r = await returnCheque(trx, orgId, user.userId, id, {
            date: input.date, reason: input.reason, chargesPaise: input.chargesPaise,
            chargeToParty: input.chargeToParty, branchId,
            bankAccountId: input.bankAccountId ? Number(input.bankAccountId) : null,
          });
          await audit('void',
            `Returned on ${input.date}: ${input.reason}` +
              (r.reversedPayment ? `; ${r.reversedPayment} reversed` : '; no payment to reverse') +
              (input.chargesPaise ? `; charges ${(input.chargesPaise / 100).toFixed(2)}${input.chargeToParty ? ' to the customer' : ''}` : ''));
          return {
            id: asId(id), status: 'bounced', reversedPayment: r.reversedPayment,
            chargesEntryId: r.chargesEntryId ? asId(r.chargesEntryId) : null,
          };
        }
        default:
          await moveCheque(trx, orgId, id, input.status);
          await audit('update', `Marked ${input.status}`);
          return { id: asId(id), status: input.status };
      }
    });
  },
  { permission: { module: 'banking', action: 'edit' } },
);
