import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { createTransfer } from '@/lib/server/services/banking';
import { logAudit, auditMeta } from '@/lib/server/audit';

export const GET = route(
  async ({ orgId }) => {
    const rows = await db
      .selectFrom('bank_transfers')
      .innerJoin('bank_accounts as src', 'src.id', 'bank_transfers.from_bank_account_id')
      .innerJoin('bank_accounts as dst', 'dst.id', 'bank_transfers.to_bank_account_id')
      .select([
        'bank_transfers.id', 'bank_transfers.transfer_date', 'bank_transfers.amount',
        'bank_transfers.reference', 'bank_transfers.journal_entry_id',
        'src.name as from_name', 'dst.name as to_name',
      ])
      .where('bank_transfers.org_id', '=', orgId)
      .orderBy('bank_transfers.transfer_date', 'desc')
      .limit(200)
      .execute();

    return {
      transfers: rows.map((r) => ({
        id: asId(r.id),
        date: r.transfer_date,
        fromName: r.from_name,
        toName: r.to_name,
        reference: r.reference,
        amountPaise: toPaiseFromSql(r.amount),
        journalEntryId: r.journal_entry_id ? asId(r.journal_entry_id) : null,
      })),
    };
  },
  { permission: { module: 'banking', action: 'view' } },
);

const CreateInput = z.object({
  fromBankAccountId: z.string(),
  toBankAccountId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  amountPaise: z.number().int().positive('Enter an amount above zero.'),
  reference: z.string().nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, CreateInput);
    const created = await transaction(async (trx) =>
      createTransfer(trx, orgId, user.userId, {
        fromBankAccountId: Number(input.fromBankAccountId),
        toBankAccountId: Number(input.toBankAccountId),
        date: input.date,
        amountPaise: input.amountPaise,
        reference: input.reference,
      }),
    );

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name,
      action: 'create', targetType: 'bank_transfer', targetId: created.id,
      detail: `Transferred ${(input.amountPaise / 100).toFixed(2)}`,
      ...auditMeta(req),
    });

    return { id: asId(created.id), journalEntryId: asId(created.journalEntryId) };
  },
  { permission: { module: 'banking', action: 'create' } },
);
