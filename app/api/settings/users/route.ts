import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  addUser, deleteCustomRole, listCustomRoles, listUsers, resetPassword, resetUserMfa, saveCustomRole, updateUser,
} from '@/lib/server/services/users';

// Users and custom roles. Seeing them is open to whoever sees Settings;
// changing them is an admin's (settings: edit).

export const GET = route(
  async ({ orgId }) => {
    const [users, roles] = await Promise.all([listUsers(db, orgId), listCustomRoles(db, orgId)]);
    return { users, roles };
  },
  { permission: { module: 'settings', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]).transform(Number);
const Role = z.enum(['admin', 'accountant', 'sales', 'staff', 'viewer']);
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'), name: z.string().trim().min(1).max(150), email: z.string().trim().email('Enter a valid email address.'),
    phone: z.string().max(20).nullish(), role: Role, customRoleId: Id.nullish(), homeBranchId: Id.nullish(),
  }),
  z.object({
    action: z.literal('update'), id: Id, name: z.string().trim().min(1).max(150).optional(), role: Role.optional(),
    customRoleId: Id.nullish(), homeBranchId: Id.nullish(), isActive: z.boolean().optional(),
  }),
  z.object({ action: z.literal('reset-password'), id: Id }),
  z.object({ action: z.literal('reset-mfa'), id: Id }),
  z.object({
    action: z.literal('save-role'), id: Id.nullish(), name: z.string().max(60), baseRole: z.enum(['accountant', 'sales', 'staff', 'viewer']),
    permissions: z.record(z.string(), z.array(z.enum(['view', 'create', 'edit', 'approve', 'void']))), description: z.string().max(255).nullish(),
  }),
  z.object({ action: z.literal('delete-role'), id: Id }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const meta = auditMeta(req);
    return transaction(async (trx) => {
      const audit = (targetType: string, targetId: number, detail: string, extra: Record<string, unknown> = {}) => logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType, targetId, detail, ...extra, ...meta,
      });
      switch (input.action) {
        case 'add': {
          const made = await addUser(trx, orgId, input);
          await audit('user', made.id, `Added ${input.name} (${input.email}) as ${input.role}${input.customRoleId ? ' with a custom role' : ''}`, { action: 'create' });
          // Shown once to the admin, who passes it on; it is not stored anywhere readable.
          return { id: asId(made.id), temporaryPassword: made.temporaryPassword };
        }
        case 'update': {
          const r = await updateUser(trx, orgId, input.id, input);
          await audit('user', input.id, `Changed ${r.name}`, { payload: { changes: { before: r.before, after: { ...r.after, isActive: input.isActive } } } });
          return { id: asId(input.id) };
        }
        case 'reset-password': {
          const temporaryPassword = await resetPassword(trx, orgId, input.id);
          await audit('user', input.id, 'Reset the password; signed out everywhere');
          return { id: asId(input.id), temporaryPassword };
        }
        case 'reset-mfa':
          await resetUserMfa(trx, orgId, input.id);
          await audit('user', input.id, 'Reset two-step sign-in; signed out everywhere');
          return { id: asId(input.id) };
        case 'save-role': {
          const id = await saveCustomRole(trx, orgId, { ...input, id: input.id ?? null });
          await audit('custom_role', id, `${input.id ? 'Changed' : 'Created'} the role ${input.name} (on ${input.baseRole})`, { payload: { permissions: input.permissions } });
          return { id: asId(id) };
        }
        case 'delete-role':
          await deleteCustomRole(trx, orgId, input.id);
          await audit('custom_role', input.id, 'Deleted a custom role');
          return { id: asId(input.id) };
      }
    });
  },
  { permission: { module: 'settings', action: 'edit' } },
);
