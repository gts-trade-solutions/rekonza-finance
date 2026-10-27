'use client';

// Users and custom roles: add people, change what they may do, switch them off,
// reset a forgotten password or a lost phone, and build roles of the book's own.

import { useState } from 'react';
import { Copy, KeyRound, Loader2, Pencil, Plus, ShieldCheck, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { matrixOf, PERMISSION_MODULES, voucherModule, type Action, type CustomPermissions } from '@/lib/rbac';

type Role = 'admin' | 'accountant' | 'sales' | 'staff' | 'viewer';
type BaseRole = Exclude<Role, 'admin'>;
interface User {
  id: string; name: string; email: string; phone: string | null; role: Role; customRoleId: string | null; customRoleName: string | null;
  homeBranchId: string | null; branchName: string | null; isActive: boolean; lastLoginAt: string | null; mfaOn: boolean; locked: boolean;
}
interface CustomRole { id: string; name: string; baseRole: BaseRole; permissions: CustomPermissions; description: string | null; userCount: number }

const ROLES: Role[] = ['admin', 'accountant', 'sales', 'staff', 'viewer'];
const ACTIONS: Action[] = ['view', 'create', 'edit', 'approve', 'void', 'print', 'export'];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const roleValue = (u: { role: Role; customRoleId: string | null }) => (u.customRoleId ? `custom:${u.customRoleId}` : `role:${u.role}`);
const fromRoleValue = (v: string, roles: CustomRole[]) => {
  if (v.startsWith('custom:')) {
    const r = roles.find((x) => x.id === v.slice(7));
    return { role: (r?.baseRole ?? 'viewer') as Role, customRoleId: v.slice(7) };
  }
  return { role: v.slice(5) as Role, customRoleId: null };
};

function RoleSelect({ value, onChange, roles }: { value: string; onChange: (v: string) => void; roles: CustomRole[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm capitalize">
      <optgroup label="Standard roles">{ROLES.map((r) => <option key={r} value={`role:${r}`}>{r}</option>)}</optgroup>
      {roles.length > 0 && <optgroup label="This book's roles">{roles.map((r) => <option key={r.id} value={`custom:${r.id}`}>{r.name}</option>)}</optgroup>}
    </select>
  );
}

function PasswordShown({ who, password, onClose }: { who: string; password: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Temporary password for {who}</DialogTitle>
          <DialogDescription>
            Pass it on privately. It is shown only now; they can change it from Settings → Sign-ins once signed in.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3">
          <span className="flex-1 select-all font-mono text-base">{password}</span>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void navigator.clipboard.writeText(password).then(() => toast.success('Copied'))}>
            <Copy className="size-3.5" /> Copy
          </Button>
        </div>
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoleEditor({ role, onClose, onSaved }: { role: CustomRole | 'new'; onClose: () => void; onSaved: () => void }) {
  const start = role === 'new' ? null : role;
  const [name, setName] = useState(start?.name ?? '');
  const [baseRole, setBaseRole] = useState<BaseRole>(start?.baseRole ?? 'staff');
  const [description, setDescription] = useState(start?.description ?? '');
  // A role saved before printing and exporting were rights of their own has
  // them wherever it may view; shown that way, and saved that way from now on.
  const [perms, setPerms] = useState<CustomPermissions>(() => {
    if (!start) return matrixOf('staff');
    if ('output' in start.permissions) return start.permissions;
    return Object.fromEntries(Object.entries(start.permissions).map(([k, a]) => {
      const m = PERMISSION_MODULES.find((x) => x.key === k);
      const extra: Action[] = a.includes('view') && m ? m.actions.filter((x) => x === 'print' || x === 'export') : [];
      return [k, ACTIONS.filter((x) => a.includes(x) || extra.includes(x))];
    }));
  });
  const vouchers = useApi(() => api.get<{ types: { id: string; code: string; name: string; restricted: boolean; isActive: boolean }[] }>('/api/voucher-types'), []);
  const restricted = (vouchers.data?.types ?? []).filter((t) => t.restricted);
  const [busy, setBusy] = useState(false);
  const toggle = (module: string, action: Action, on: boolean) => setPerms((p) => {
    const now = new Set(p[module] ?? []);
    if (on) { now.add(action); now.add('view'); } else { now.delete(action); if (action === 'view') now.clear(); }
    return { ...p, [module]: ACTIONS.filter((a) => now.has(a)) };
  });
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/settings/users', { action: 'save-role', id: start?.id ?? null, name, baseRole, description: description || null, permissions: perms });
      toast.success(`${name} saved`);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{start ? `Edit ${start.name}` : 'New role'}</DialogTitle>
          <DialogDescription>
            What people with this role may do, part by part. The standard role it is built on decides approvals under an
            approval rule and whether cost prices show.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing clerk" /></Field>
          <Field label="Built on">
            <div>
              <select value={baseRole} onChange={(e) => setBaseRole(e.target.value as BaseRole)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm capitalize">
                {(['accountant', 'sales', 'staff', 'viewer'] as const).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </Field>
          <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Start from:
          {(['accountant', 'sales', 'staff', 'viewer'] as const).map((r) => (
            <Button key={r} size="xs" variant="outline" className="capitalize" onClick={() => setPerms(matrixOf(r))}>{r}</Button>
          ))}
        </div>
        <div className="max-h-[50vh] overflow-auto rounded-md border thin-scroll">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">Part of the app</th>
                {ACTIONS.map((a) => <th key={a} className="px-2 py-2 text-center font-semibold capitalize">{a}</th>)}
              </tr>
            </thead>
            <tbody>
              {restricted.map((t) => {
                const key = voucherModule(t.code);
                return (
                  <tr key={key} className="border-t bg-muted/20">
                    <td className="px-3 py-1.5">Voucher type: {t.name}<span className="ml-1 text-xs text-muted-foreground">(restricted)</span></td>
                    {ACTIONS.map((a) => (
                      <td key={a} className="px-2 py-1.5 text-center">
                        {a === 'create' && (
                          <Checkbox checked={(perms[key] ?? []).includes('create')} aria-label={`Raise ${t.name}`}
                            onCheckedChange={(v) => setPerms((p) => ({ ...p, [key]: v ? ['create'] : [] }))} />
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {PERMISSION_MODULES.map((m) => (
                <tr key={m.key} className="border-t">
                  <td className="px-3 py-1.5">{m.label}</td>
                  {ACTIONS.map((a) => (
                    <td key={a} className="px-2 py-1.5 text-center">
                      {m.actions.includes(a) && (
                        <Checkbox checked={(perms[m.key] ?? []).includes(a)} aria-label={`${m.label}: ${a}`}
                          onCheckedChange={(v) => toggle(m.key, a, !!v)} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !name.trim()}>{busy && <Loader2 className="size-3.5 animate-spin" />} Save role</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UsersPanel({ canEdit, currentUserId, branches }: {
  canEdit: boolean; currentUserId: string | undefined; branches: { id: string; name: string }[];
}) {
  const state = useApi(() => api.get<{ users: User[]; roles: CustomRole[] }>('/api/settings/users'), []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', email: '', phone: '', roleValue: 'role:staff', homeBranchId: '' });
  const [shown, setShown] = useState<{ who: string; password: string } | null>(null);
  const [editingRole, setEditingRole] = useState<CustomRole | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const post = async <T,>(key: string, payload: Record<string, unknown>, done?: string): Promise<T | null> => {
    setBusy(key);
    try {
      const r = await api.post<T>('/api/settings/users', payload);
      if (done) toast.success(done);
      await state.refetch();
      return r;
    } catch (e) {
      toast.error('Not done', { description: errorText(e) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  return (
    <AsyncPage state={state} loading={<LoadingRows rows={4} />}>
      {(d) => (
        <>
          <Card className="p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Users</h3>
                <p className="text-xs text-muted-foreground">Unlimited users on every plan.</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="border-emerald-500/40 text-[10px]">{d.users.filter((u) => u.isActive).length} active</Badge>
                {canEdit && !adding && <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}><UserPlus className="size-3.5" /> Add user</Button>}
              </div>
            </div>

            {adding && (
              <div className="mb-3 grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-5 sm:items-end">
                <Field label="Name" required><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                <Field label="Email" required><Input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
                <Field label="Role"><div><RoleSelect value={draft.roleValue} onChange={(v) => setDraft({ ...draft, roleValue: v })} roles={d.roles} /></div></Field>
                <Field label="Home branch">
                  <div>
                    <select value={draft.homeBranchId} onChange={(e) => setDraft({ ...draft, homeBranchId: e.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                      <option value="">Primary</option>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                </Field>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy === 'add' || !draft.name.trim() || !draft.email.trim()}
                    onClick={() => void post<{ temporaryPassword: string }>('add', {
                      action: 'add', name: draft.name, email: draft.email, ...fromRoleValue(draft.roleValue, d.roles), homeBranchId: draft.homeBranchId || null,
                    }, `${draft.name} added`).then((r) => {
                      if (!r) return;
                      setShown({ who: draft.name, password: r.temporaryPassword });
                      setAdding(false);
                      setDraft({ name: '', email: '', phone: '', roleValue: 'role:staff', homeBranchId: '' });
                    })}>
                    {busy === 'add' && <Loader2 className="size-3.5 animate-spin" />} Add
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {d.users.map((u) => (
                <div key={u.id} className={`flex flex-wrap items-center gap-3 rounded-md border p-3 ${u.isActive ? '' : 'opacity-60'}`}>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {u.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 font-medium">
                      {u.name}
                      {u.id === currentUserId && <Badge variant="outline" className="text-[9px]">You</Badge>}
                      {u.mfaOn && <Badge variant="outline" className="gap-1 border-emerald-500/40 text-[9px]"><ShieldCheck className="size-2.5" /> Two-step</Badge>}
                      {u.locked && <Badge variant="outline" className="border-destructive/40 text-[9px] text-destructive">Locked</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {u.email}{u.branchName ? ` · ${u.branchName}` : ''} · {u.lastLoginAt ? `last in ${new Date(u.lastLoginAt).toLocaleDateString('en-IN')}` : 'never signed in'}
                    </p>
                  </div>
                  {canEdit ? (
                    <div className="w-40">
                      <RoleSelect value={roleValue(u)} roles={d.roles}
                        onChange={(v) => void post(u.id, { action: 'update', id: u.id, ...fromRoleValue(v, d.roles) }, `${u.name}'s role changed`)} />
                    </div>
                  ) : (
                    <Badge variant="secondary" className="capitalize">{u.customRoleName ?? u.role}</Badge>
                  )}
                  {canEdit && (
                    <div className="flex items-center gap-1">
                      <Button size="icon-sm" variant="ghost" title="Reset password" aria-label={`Reset ${u.name}'s password`} disabled={busy === u.id}
                        onClick={() => window.confirm(`Give ${u.name} a new temporary password and sign them out everywhere?`) &&
                          void post<{ temporaryPassword: string }>(u.id, { action: 'reset-password', id: u.id }).then((r) => r && setShown({ who: u.name, password: r.temporaryPassword }))}>
                        <KeyRound className="size-3.5" />
                      </Button>
                      {u.mfaOn && (
                        <Button size="icon-sm" variant="ghost" title="Reset two-step sign-in" aria-label={`Reset ${u.name}'s two-step sign-in`} disabled={busy === u.id}
                          onClick={() => window.confirm(`Clear ${u.name}'s two-step sign-in (a lost phone)? They set it up again at their next sign-in.`) &&
                            void post(u.id, { action: 'reset-mfa', id: u.id }, `${u.name}'s two-step sign-in cleared`)}>
                          <ShieldOff className="size-3.5" />
                        </Button>
                      )}
                      <Switch checked={u.isActive} disabled={busy === u.id || u.id === currentUserId} aria-label={u.isActive ? `Switch ${u.name} off` : `Switch ${u.name} on`}
                        onCheckedChange={(v) => void post(u.id, { action: 'update', id: u.id, isActive: v }, v ? `${u.name} switched on` : `${u.name} switched off and signed out`)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <Card className="space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">This book&apos;s roles</h3>
                <p className="text-xs text-muted-foreground">
                  Roles of your own: a billing clerk who raises invoices and sees only the sales reports, a storekeeper who sees stock and nothing that costs it.
                </p>
              </div>
              {canEdit && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditingRole('new')}><Plus className="size-3.5" /> New role</Button>}
            </div>
            {d.roles.length === 0 ? (
              <p className="rounded-md border px-3 py-4 text-center text-sm text-muted-foreground">None yet: everyone has one of the standard roles below.</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {d.roles.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <span className="font-medium">{r.name}</span>
                    <Badge variant="outline" className="text-[10px] capitalize">on {r.baseRole}</Badge>
                    <span className="text-xs text-muted-foreground">{r.userCount} user{r.userCount === 1 ? '' : 's'}{r.description ? ` · ${r.description}` : ''}</span>
                    {canEdit && (
                      <span className="ml-auto flex gap-1">
                        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditingRole(r)}><Pencil className="size-3.5" /></Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`Delete ${r.name}`} disabled={busy === `role-${r.id}`}
                          onClick={() => void post(`role-${r.id}`, { action: 'delete-role', id: r.id }, `${r.name} deleted`)}><Trash2 className="size-3.5" /></Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {shown && <PasswordShown who={shown.who} password={shown.password} onClose={() => setShown(null)} />}
          {editingRole && <RoleEditor role={editingRole} onClose={() => setEditingRole(null)} onSaved={() => { setEditingRole(null); void state.refetch(); }} />}
        </>
      )}
    </AsyncPage>
  );
}

/** One's own password. */
export function ChangePasswordCard() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const mismatch = f.again.length > 0 && f.next !== f.again;
  return (
    <Card className="space-y-3 p-5">
      <h3 className="text-sm font-semibold">Change your password</h3>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password" hint="8 or more, with upper and lower case and a digit"><Input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Field label="New password again" error={mismatch ? 'They do not match.' : undefined}><Input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
        <Button disabled={busy || !f.current || !f.next || f.next !== f.again}
          onClick={() => {
            setBusy(true);
            void api.post('/api/auth/password', { current: f.current, next: f.next })
              .then(() => { toast.success('Password changed', { description: 'Your other devices have been signed out.' }); setF({ current: '', next: '', again: '' }); })
              .catch((e) => toast.error('Not changed', { description: errorText(e) }))
              .finally(() => setBusy(false));
          }}>
          {busy && <Loader2 className="size-3.5 animate-spin" />} Change
        </Button>
      </div>
    </Card>
  );
}
