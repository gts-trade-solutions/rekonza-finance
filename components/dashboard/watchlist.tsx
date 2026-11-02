'use client';

// The dashboard's Account Watchlist and Projects widgets, as Zoho's: each
// person picks the accounts they keep an eye on — cash in hand, a loan, fuel —
// and sees each balance and this month's movement; and the active projects
// with the most time waiting to be billed (app/api/dashboard/extras).

import { useState } from 'react';
import Link from 'next/link';
import { Eye, FolderKanban, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/shared/money';
import { accounts as accountsApi, api, type AccountRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface Extras {
  watchlist: { id: string; code: string; name: string; type: string; balancePaise: number; monthPaise: number }[];
  chosenIds: string[];
  projects: { id: string; name: string; customer: string; unbilledHours: number; loggedHours: number; profitPaise: number }[];
}

export function DashboardExtras() {
  const state = useApi(() => api.get<Extras>('/api/dashboard/extras'), []);
  const canProjects = usePermission('projects', 'view');
  const [editing, setEditing] = useState(false);
  const d = state.data;
  if (!d) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4" data-slot="account-watchlist">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Eye className="size-4 text-muted-foreground" /> Account watchlist</h2>
          <Button size="xs" variant="ghost" className="gap-1" onClick={() => setEditing((v) => !v)}><Settings2 className="size-3" /> {editing ? 'Done' : 'Choose accounts'}</Button>
        </div>
        {editing ? (
          <WatchPicker chosen={d.chosenIds} onSaved={() => { setEditing(false); state.refetch(); }} />
        ) : d.watchlist.length ? (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left font-medium">Account</th><th className="pb-1 text-right font-medium">This month</th><th className="pb-1 text-right font-medium">Balance</th></tr></thead>
            <tbody>
              {d.watchlist.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="py-1.5"><Link href={`/reports/general-ledger?account=${a.id}`} className="hover:underline">{a.name}</Link> <span className="font-mono text-[10px] text-muted-foreground">{a.code}</span></td>
                  <td className="py-1.5 text-right"><Money value={a.monthPaise} colored /></td>
                  <td className="py-1.5 text-right font-medium"><Money value={a.balancePaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">Pick up to ten accounts to watch — cash in hand, a loan, fuel, a GST ledger — and their balances show here.</p>
        )}
      </Card>
      {canProjects && (
        <Card className="p-4" data-slot="dashboard-projects">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><FolderKanban className="size-4 text-muted-foreground" /> Projects</h2>
            <Link href="/projects" className="text-xs text-primary hover:underline">All projects</Link>
          </div>
          {d.projects.length ? (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left font-medium">Project</th><th className="pb-1 text-right font-medium">Logged</th><th className="pb-1 text-right font-medium">To bill</th><th className="pb-1 text-right font-medium">Profit</th></tr></thead>
              <tbody>
                {d.projects.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="py-1.5"><Link href={`/projects/${p.id}`} className="hover:underline">{p.name}</Link><span className="block text-[11px] text-muted-foreground">{p.customer}</span></td>
                    <td className="py-1.5 text-right tabular-nums">{p.loggedHours.toFixed(1)} h</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{p.unbilledHours.toFixed(1)} h</td>
                    <td className="py-1.5 text-right"><Money value={p.profitPaise} colored /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-sm text-muted-foreground">No active projects. Work you bill by the hour or as a fixed fee shows here once it is set up under Time Tracking.</p>}
        </Card>
      )}
    </div>
  );
}

function WatchPicker({ chosen, onSaved }: { chosen: string[]; onSaved: () => void }) {
  const chart = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list(), []);
  const [picked, setPicked] = useState<string[]>(chosen);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const list = (chart.data?.accounts ?? []).filter((a) => a.isActive && (!q || `${a.code} ${a.name}`.toLowerCase().includes(q.toLowerCase())));
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/dashboard/extras', { accountIds: picked });
      toast.success(picked.length ? `Watching ${picked.length} account${picked.length === 1 ? '' : 's'}` : 'Watchlist cleared');
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an account" className="h-8" aria-label="Find an account" />
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {list.map((a) => (
          <label key={a.id} className="flex items-center gap-2 text-sm">
            <Checkbox checked={picked.includes(a.id)} disabled={!picked.includes(a.id) && picked.length >= 10}
              onCheckedChange={(v) => setPicked((p) => (v ? [...p, a.id] : p.filter((x) => x !== a.id)))} />
            <span className="font-mono text-[10px] text-muted-foreground">{a.code}</span> {a.name}
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{picked.length} of 10</span>
        <Button size="sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
