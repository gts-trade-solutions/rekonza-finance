'use client';

// Document numbering: every series a branch runs, and the org-wide ones.
//
// A branch's series can be given its own prefix and padding — "TN-INV" for the
// Chennai registration, say — from the next document onwards. The counter
// itself is never editable: the next number is whatever the database hands
// out, so no two documents can ever share one.

import { useState } from 'react';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';

export interface SeriesRow {
  scope: 'branch' | 'org';
  docType: string;
  label: string;
  branchId: string | null;
  branchName: string | null;
  fyLabel: string;
  prefix: string;
  padding: number;
  nextNumber: number;
  issued: number;
  sample: string;
  gst: boolean;
  maxLength: number;
}

const th = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground';

export function NumberingPanel({ series, canEdit, onChanged }: { series: SeriesRow[]; canEdit: boolean; onChanged: () => void }) {
  const branches = [...new Set(series.filter((s) => s.scope === 'branch').map((s) => s.branchName))];
  const org = series.filter((s) => s.scope === 'org');
  const fy = series[0]?.fyLabel;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h3 className="mb-1 text-sm font-semibold">Document numbering{fy ? ` · FY ${fy}` : ''}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Invoices, credit notes and delivery challans must be numbered consecutively, uniquely for the financial
          year, in at most 16 characters of letters, digits, hyphens and slashes (rules 46, 53 and 55). Each branch
          keeps its own series per year, held in the database so two people saving at the same moment never get the
          same number. You can change a series&apos; prefix and padding; the count carries on from where it is, and
          the new style carries into next year.
        </p>
      </Card>

      {branches.map((b) => (
        <div key={b ?? 'none'} className="space-y-2">
          <h4 className="text-sm font-semibold">{b}</h4>
          <div className="overflow-x-auto rounded-lg border thin-scroll">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className={th}>Document</th>
                  <th className={th}>Prefix</th>
                  <th className={th}>Digits</th>
                  <th className={th}>Next number</th>
                  <th className={`${th} text-right`}>Issued this year</th>
                  <th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {series.filter((s) => s.scope === 'branch' && s.branchName === b).map((s) => (
                  <BranchRow key={`${s.branchId}:${s.docType}`} s={s} canEdit={canEdit} onChanged={onChanged} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {org.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Across the organisation</h4>
          <p className="text-xs text-muted-foreground">
            Receipts, payments, bills, expenses and retainers are internal documents, numbered once for the whole
            organisation.
          </p>
          <div className="overflow-x-auto rounded-lg border thin-scroll">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className={th}>Document</th>
                  <th className={th}>Next number</th>
                  <th className={`${th} text-right`}>Issued this year</th>
                </tr>
              </thead>
              <tbody>
                {org.map((s) => (
                  <tr key={s.docType} className="border-b last:border-0">
                    <td className="px-3 py-2">{s.label}</td>
                    <td className="px-3 py-2 font-mono text-xs">{s.sample}</td>
                    <td className="px-3 py-2 text-right tabular">{s.issued}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function BranchRow({ s, canEdit, onChanged }: { s: SeriesRow; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [prefix, setPrefix] = useState(s.prefix);
  const [padding, setPadding] = useState(s.padding);
  const [busy, setBusy] = useState(false);

  const preview = `${prefix.toUpperCase()}/${s.fyLabel}/${String(s.nextNumber).padStart(padding, '0')}`;
  const tooLong = s.gst && prefix.length + s.fyLabel.length + 2 + Math.max(padding, String(s.nextNumber).length) > 16;

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/settings/numbering', { branchId: s.branchId, docType: s.docType, prefix, padding });
      toast.success(`${s.label} at ${s.branchName} will be numbered like ${preview}`);
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error('Not changed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-b last:border-0">
      <td className="px-3 py-2">
        {s.label}
        {s.gst && <Badge variant="outline" className="ml-2 text-[10px]">GST · ≤16</Badge>}
      </td>
      <td className="px-3 py-2">
        {editing
          ? <Input value={prefix} onChange={(e) => setPrefix(e.target.value.replace(/[^A-Za-z0-9-]/g, ''))} maxLength={10} className="h-8 w-28 font-mono uppercase" />
          : <span className="font-mono text-xs">{s.prefix}</span>}
      </td>
      <td className="px-3 py-2">
        {editing
          ? <Input type="number" min={1} max={6} value={padding} onChange={(e) => setPadding(Number(e.target.value) || 1)} className="h-8 w-16" />
          : <span className="text-xs">{s.padding}</span>}
      </td>
      <td className="px-3 py-2 font-mono text-xs">
        {editing ? <span className={tooLong ? 'text-destructive' : ''}>{preview}{tooLong ? ' · too long' : ''}</span> : s.sample}
      </td>
      <td className="px-3 py-2 text-right tabular">{s.issued}</td>
      <td className="px-2 py-2 text-right">
        {canEdit && (editing ? (
          <div className="flex justify-end gap-1">
            <Button size="icon" variant="ghost" className="size-7" aria-label="Save" disabled={busy || tooLong || !prefix} onClick={() => void save()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            </Button>
            <Button size="icon" variant="ghost" className="size-7" aria-label="Cancel" onClick={() => { setEditing(false); setPrefix(s.prefix); setPadding(s.padding); }}>
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button size="icon" variant="ghost" className="size-7" aria-label={`Change the ${s.label} prefix`} onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </Button>
        ))}
      </td>
    </tr>
  );
}
