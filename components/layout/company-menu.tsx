'use client';

// The company menu: the one you are in, the others you work in, and a new one.
// Moving to another keeps you signed in; that company's own rules apply on the
// way in, so it may ask for your two-step code there.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Check, ChevronDown, Loader2, Plus, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { GST_STATES } from '@/lib/tax/gst';

interface Company { orgId: string; name: string; isDemo: boolean; role: string; needsCode: boolean }

export function CompanyMenu({ org, branch }: {
  org: { name: string; fiscalYearLabel?: string; pan?: string | null } | null;
  branch: { name: string; gstin?: string | null } | undefined;
}) {
  const router = useRouter();
  const list = useApi(() => api.get<{ current: string; companies: Company[] }>('/api/companies'), []);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', stateCode: '33', gstin: '' });
  const [busy, setBusy] = useState(false);

  const move = async (c: Company) => {
    const code = c.needsCode ? window.prompt(`The code from your authenticator app for ${c.name}`) : null;
    if (c.needsCode && !code) return;
    try {
      await api.post('/api/companies', { action: 'switch', orgId: c.orgId, code });
      // Everything on screen belongs to the company left; start clean.
      window.location.assign('/dashboard');
    } catch (e) {
      toast.error(`Not moved to ${c.name}`, { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ orgId: number }>('/api/companies', { action: 'create', name: f.name, stateCode: f.stateCode, gstin: f.gstin || null });
      toast.success(`${f.name} created`, { description: 'Moving you there now.' });
      await api.post('/api/companies', { action: 'switch', orgId: r.orgId });
      window.location.assign('/dashboard');
    } catch (e) {
      toast.error('Not created', { description: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  };

  const others = (list.data?.companies ?? []).filter((c) => c.orgId !== list.data?.current);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-foreground/80 transition-colors hover:bg-accent">
          <Building2 className="size-4 shrink-0 opacity-70" />
          <span className="hidden max-w-[170px] truncate sm:inline">{org?.name ?? 'Organisation'}</span>
          <ChevronDown className="size-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel>Company</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="items-start gap-2.5 py-2">
            <Building2 className="mt-0.5 size-4 shrink-0 opacity-70" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{org?.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">{org?.fiscalYearLabel} · PAN {org?.pan}</p>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {branch?.name} · <span className="font-mono">{branch?.gstin}</span>
              </p>
            </div>
            <Badge variant="secondary" className="text-[9px]">Active</Badge>
          </DropdownMenuItem>
          {others.length > 0 && <DropdownMenuSeparator />}
          {others.map((c) => (
            <DropdownMenuItem key={c.orgId} onClick={() => void move(c)} className="gap-2.5">
              <Check className="size-4 opacity-0" />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-[10px] capitalize text-muted-foreground">{c.role}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAdding(true)}>
            <Plus className="mr-2 size-4" /> Add a company
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push('/settings')}>
            <Settings className="mr-2 size-4" /> Manage this company
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a company</DialogTitle>
            <DialogDescription>
              A separate set of books, with you as its admin and the password you use now. Move between companies from this menu;
              see them together under Reports → Consolidated statements.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Race Auto Exports Pvt Ltd" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="State">
                <select value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  {Object.entries(GST_STATES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
              </Field>
              <Field label="GSTIN" hint="Leave empty if it is not registered">
                <Input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} className="font-mono" maxLength={15} />
              </Field>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            <Button disabled={busy || f.name.trim().length < 2} onClick={() => void create()} className="gap-1.5">
              {busy && <Loader2 className="size-3.5 animate-spin" />} Create and move there
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
