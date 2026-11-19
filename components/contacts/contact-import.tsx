'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho's ⋯ → Import → "Import Customers": a dialog asking what to import,
// the customers themselves or their contact persons, then Continue.
// Customers go to the import screen (Settings → Import, customers chosen).
// Contact persons are read here: a CSV or TSV with each person's customer by
// display name, added to that customer's people.
// ─────────────────────────────────────────────────────────────────────────────

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { contactPersons, contacts, type ContactPerson } from '@/lib/api/client';
import { parseDelimitedText, readTextFile } from '@/lib/delimited';
import { csvText } from '@/lib/xlsx';

const COLUMNS = ['Display Name', 'Salutation', 'First Name', 'Last Name', 'Email Address', 'Work Phone', 'Mobile', 'Designation', 'Department'];

export function ImportContactsDialog({ side, open, onOpenChange, onDone }: { side: 'customer' | 'vendor'; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  const router = useRouter();
  const noun = side === 'customer' ? 'Customer' : 'Vendor';
  const [what, setWhat] = useState<'contacts' | 'persons'>('contacts');
  const [step, setStep] = useState<'choose' | 'persons'>('choose');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const close = (o: boolean) => { onOpenChange(o); if (!o) { setStep('choose'); setReport(null); } };

  const sample = () => {
    const blob = new Blob([csvText([COLUMNS, [side === 'customer' ? 'Apex Motors Pvt Ltd' : 'Bosch Automotive Distributors', 'Ms.', 'Divya', 'Menon', 'divya@example.com', '080 4110 2200', '+91 98860 44120', 'Purchase Manager', 'Purchase']])], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${side}-contact-persons-sample.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importPersons = async (f: File) => {
    setBusy(true);
    setReport(null);
    try {
      const grid = parseDelimitedText(await readTextFile(f));
      const [head, ...body] = grid;
      const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
      if (col('Display Name') < 0) throw new Error(`The file needs a "Display Name" column naming each person's ${noun.toLowerCase()}.`);
      const list = (await contacts.list({ kind: side, archived: true })).contacts;
      const byName = new Map(list.map((c) => [c.displayName.trim().toLowerCase(), c]));
      const groups = new Map<string, { contactId: string; people: ContactPerson[] }>();
      const missing: string[] = [];
      for (const r of body) {
        const v = (name: string) => { const i = col(name); return i >= 0 ? (r[i] ?? '').trim() : ''; };
        const owner = byName.get(v('Display Name').toLowerCase());
        if (!owner) { missing.push(v('Display Name') || '(blank)'); continue; }
        const first = v('First Name'); const last = v('Last Name');
        if (!first && !last) continue;
        const g = groups.get(owner.id) ?? { contactId: owner.id, people: [] };
        g.people.push({
          id: null, salutation: v('Salutation') || null, name: [first, last].filter(Boolean).join(' '), firstName: first || null, lastName: last || null,
          email: v('Email Address') || null, phone: v('Work Phone') || null, mobile: v('Mobile') || null,
          designation: v('Designation') || null, department: v('Department') || null, isPrimary: false, receivesDocuments: true,
        });
        groups.set(owner.id, g);
      }
      let added = 0;
      const failed: string[] = [];
      for (const g of groups.values()) {
        try {
          const have = (await contactPersons.list(g.contactId)).persons;
          const people = [...have, ...g.people].map((p, i) => ({ ...p, isPrimary: p.isPrimary || (i === 0 && !have.some((x) => x.isPrimary)) }));
          await contactPersons.save(g.contactId, people);
          added += g.people.length;
        } catch (e) {
          failed.push(e instanceof Error ? e.message : String(e));
        }
      }
      setReport([
        `${added} contact person${added === 1 ? '' : 's'} imported.`,
        ...(missing.length ? [`${missing.length} row${missing.length === 1 ? '' : 's'} skipped: no ${noun.toLowerCase()} named ${[...new Set(missing)].slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}.`] : []),
        ...failed.slice(0, 3),
      ]);
      if (added) { toast.success(`${added} contact persons imported`); onDone?.(); }
    } catch (e) {
      toast.error('Not imported', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md" data-slot="import-contacts-dialog">
        {step === 'choose' ? (
          <>
            <DialogHeader>
              <DialogTitle>Import {noun}s</DialogTitle>
              <DialogDescription>You can import contacts into Rekonza from a .CSV or .TSV or .XLSX file.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-[13px]" role="radiogroup" aria-label="What to import">
              <label className="flex cursor-pointer items-center gap-2"><input type="radio" name="import-what" className="size-3.5 accent-primary" checked={what === 'contacts'} onChange={() => setWhat('contacts')} /> {noun}s</label>
              <label className="flex cursor-pointer items-center gap-2"><input type="radio" name="import-what" className="size-3.5 accent-primary" checked={what === 'persons'} onChange={() => setWhat('persons')} data-slot="import-persons-choice" /> {noun}&apos;s Contact Persons</label>
            </div>
            <DialogFooter>
              <Button data-slot="import-continue" onClick={() => (what === 'contacts' ? router.push(side === 'customer' ? '/import/customers' : '/import/vendors') : setStep('persons'))}>Continue</Button>
              <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Import {noun}&apos;s Contact Persons</DialogTitle>
              <DialogDescription>A CSV or TSV file, one person to a row, with their {noun.toLowerCase()}&apos;s display name in the first column: {COLUMNS.join(', ')}.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-[13px]">
              <input ref={file} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values" className="hidden" data-slot="import-persons-file"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importPersons(f); }} />
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => file.current?.click()}><Upload className="size-3.5" /> {busy ? 'Importing…' : 'Choose File'}</Button>
                <Button variant="ghost" size="sm" onClick={sample}><Download className="size-3.5" /> Sample file</Button>
              </div>
              {report && <ul className="list-disc space-y-0.5 pl-5" data-slot="import-persons-report">{report.map((r) => <li key={r}>{r}</li>)}</ul>}
            </div>
            <DialogFooter><Button variant="outline" onClick={() => close(false)}>Close</Button></DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
