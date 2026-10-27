import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { isValidVpa } from '@/lib/billing/upi';

// ─────────────────────────────────────────────────────────────────────────────
// What goes on an invoice beyond what Rule 46 requires: the logo, the bank
// account to pay into, a UPI code for the balance, the standard terms and
// the signatory's name.
//
// The logo itself is uploaded as an attachment on the organisation
// (POST /api/files, targetType 'organization'); this only reports it.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async ({ orgId }) => {
    const [org, accounts] = await Promise.all([
      db.selectFrom('organizations')
        .select([
          'name', 'logo_file_id', 'print_bank_account_id', 'upi_id', 'upi_payee_name', 'print_upi_qr',
          'default_invoice_terms', 'default_invoice_notes', 'signatory_name', 'print_language',
        ])
        .where('id', '=', orgId)
        .executeTakeFirstOrThrow(),
      db.selectFrom('bank_accounts')
        .select(['id', 'name', 'bank_name', 'account_last4', 'account_number', 'account_holder', 'ifsc', 'branch_name'])
        .where('org_id', '=', orgId)
        .where('kind', '=', 'bank')
        .where('is_active', '=', 1)
        .orderBy('is_primary', 'desc')
        .orderBy('name')
        .execute(),
    ]);
    return {
      logoFileId: org.logo_file_id ? asId(org.logo_file_id) : null,
      bankAccountId: org.print_bank_account_id ? asId(org.print_bank_account_id) : null,
      upiId: org.upi_id,
      upiPayeeName: org.upi_payee_name,
      showUpiQr: !!org.print_upi_qr,
      defaultTerms: org.default_invoice_terms,
      defaultNotes: org.default_invoice_notes,
      signatoryName: org.signatory_name,
      printLanguage: org.print_language,
      orgId: asId(orgId),
      orgName: org.name,
      bankAccounts: accounts.map((a) => ({
        id: asId(a.id),
        name: a.name,
        bankName: a.bank_name,
        last4: a.account_last4,
        accountNumber: a.account_number,
        accountHolder: a.account_holder,
        ifsc: a.ifsc,
        branchName: a.branch_name,
      })),
    };
  },
  { permission: { module: 'settings', action: 'view' } },
);

const blank = z.literal('').transform(() => null);
const text = (max: number) => z.string().trim().max(max).nullish().or(blank);

const PrintInput = z.object({
  bankAccountId: z.union([z.string(), z.number()]).nullish().or(blank),
  /** The full details of the chosen account, as they are to print. */
  bank: z.object({
    accountNumber: z.string().trim().regex(/^[0-9A-Z]{6,34}$/i, 'An account number is 6 to 34 letters and digits, with no spaces.'),
    accountHolder: text(150),
    ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC is four letters, a zero, then six letters or digits.'),
    branchName: text(150),
  }).nullish(),
  upiId: z.string().trim().refine(isValidVpa, 'A UPI ID looks like name@bank.').nullish().or(blank),
  upiPayeeName: text(100),
  showUpiQr: z.boolean().default(true),
  defaultTerms: text(4000),
  defaultNotes: text(2000),
  signatoryName: text(150),
  printLanguage: z.enum(['hi', 'mr', 'gu', 'ta', 'te', 'kn', 'ml', 'bn']).nullish(),
});

export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, PrintInput);
    const bankId = input.bankAccountId ? Number(input.bankAccountId) : null;

    await transaction(async (trx) => {
      if (bankId) {
        const acct = await trx.selectFrom('bank_accounts').select(['id', 'account_last4'])
          .where('id', '=', bankId).where('org_id', '=', orgId).where('kind', '=', 'bank')
          .executeTakeFirst();
        if (!acct) throw badRequest('That bank account does not belong to this organisation.');
        if (input.bank) {
          // The number on file was entered when the account was set up; a full
          // number that disagrees with it is a different account.
          const last4 = input.bank.accountNumber.slice(-4);
          if (acct.account_last4 && acct.account_last4 !== last4) {
            throw badRequest(`That account number ends ${last4}, but this account was set up ending ${acct.account_last4}.`);
          }
          await trx.updateTable('bank_accounts').set({
            account_number: input.bank.accountNumber.toUpperCase(),
            account_last4: last4,
            account_holder: input.bank.accountHolder ?? null,
            ifsc: input.bank.ifsc,
            branch_name: input.bank.branchName ?? null,
          }).where('id', '=', bankId).execute();
        }
      }

      await trx.updateTable('organizations').set({
        print_bank_account_id: bankId,
        upi_id: input.upiId ?? null,
        upi_payee_name: input.upiPayeeName ?? null,
        print_upi_qr: input.showUpiQr ? 1 : 0,
        default_invoice_terms: input.defaultTerms ?? null,
        default_invoice_notes: input.defaultNotes ?? null,
        signatory_name: input.signatoryName ?? null,
        print_language: input.printLanguage ?? null,
      }).where('id', '=', orgId).execute();

      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'organization', targetId: orgId,
        detail: 'Updated what invoices print: bank details, UPI, terms and signatory',
        payload: { bankAccountId: bankId, upiId: input.upiId ?? null, showUpiQr: input.showUpiQr },
        ...auditMeta(req),
      });
    });

    return { ok: true };
  },
  { permission: { module: 'settings', action: 'edit' } },
);
