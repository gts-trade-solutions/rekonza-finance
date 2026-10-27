'use client';

// Bringing bank transactions in.
//
// The CSV is parsed in the browser on purpose. Every Indian bank exports a
// slightly different shape, and the column mapping is something a person has to
// see and confirm — so the server only ever receives normalised rows, and none
// of those bank-specific quirks live in it.
//
// Duplicate lines are skipped by the importer, not by the user. Re-importing an
// overlapping statement is normal, and a fingerprint of each line is what stops
// it doubling the balance.

import { useRef, useState } from 'react';
import Papa from 'papaparse';
import { Download, FileSpreadsheet, Info, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { PageHeader } from '@/components/shared/page-header';
import { Field } from '@/components/shared/form-bits';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

/** A sample statement the user can download, edit and re-upload. */
const SAMPLE_CSV = `Date,Narration,Reference,Debit,Credit
2026-08-06,NEFT CR TRICHY SPARE POINT,N2026080601,,58500.00
2026-08-05,BHARAT PETRO FUEL OMR,POS9912,3200.00,
2026-08-04,SWIFT LOGISTICS FREIGHT AUG,N2026080402,18500.00,
2026-08-03,UPI CR HOSUR AUTO AGENCIES,UPI7781234,,96000.00
2026-08-02,BANK CHARGES RTGS,CHG9931,354.00,
`;

interface BankAccountRow {
  id: string;
  name: string;
  kind: string;
  bankName: string | null;
  accountLast4: string | null;
}

interface ImportRow {
  id: string;
  filename: string;
  bankName: string;
  rowsTotal: number;
  rowsImported: number;
  rowsDuplicate: number;
  matched: number;
  lines: number;
  periodFrom: string | null;
  periodTo: string | null;
  importedBy: string | null;
  at: string;
}

const short = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

export default function BankImportsPage() {
  const canImport = usePermission('banking', 'create');
  const fileRef = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState('');

  const accounts = useApi<{ accounts: BankAccountRow[] }>(() => api.get('/api/banking/accounts'), []);
  const history = useApi<{ imports: ImportRow[] }>(() => api.get('/api/banking/import'), []);

  const upload = useApiAction((input: unknown) =>
    api.post<{ imported: number; duplicates: number }>('/api/banking/import', input),
  );

  const options = (accounts.data?.accounts ?? []).map((a) => ({
    value: a.id,
    label: a.name,
    sublabel: a.accountLast4 ? `${a.bankName ?? a.kind} ····${a.accountLast4}` : a.kind,
  }));

  // Default to the first account once they arrive, so the picker is never empty.
  const activeAccount = accountId || options[0]?.value || '';

  const onFile = (file: File) => {
    if (!activeAccount) {
      toast.error('Pick the account to import into first.');
      return;
    }
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (res) => {
        const rows = res.data
          .map((r) => {
            const debit = parseFloat((r.Debit ?? r.debit ?? '0').replace(/,/g, '') || '0');
            const credit = parseFloat((r.Credit ?? r.credit ?? '0').replace(/,/g, '') || '0');
            if (!debit && !credit) return null;
            return {
              date: (r.Date ?? r.date ?? '').slice(0, 10),
              narration: r.Narration ?? r.narration ?? r.Description ?? 'Imported line',
              reference: r.Reference ?? r.reference ?? null,
              depositPaise: Math.round(credit * 100),
              withdrawalPaise: Math.round(debit * 100),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null && /^\d{4}-\d{2}-\d{2}$/.test(x.date));

        if (rows.length === 0) {
          toast.error('No usable rows found', {
            description: 'Expected columns: Date, Narration, Reference, Debit, Credit.',
          });
          return;
        }

        const result = await upload.run({ bankAccountId: activeAccount, filename: file.name, rows });
        if (!result) {
          toast.error(upload.error ?? 'The statement was not imported');
          return;
        }
        toast.success(`${result.imported} transactions imported`, {
          description:
            result.duplicates > 0
              ? `${result.duplicates} duplicate line(s) were skipped automatically.`
              : 'No duplicates found.',
        });
        history.refetch();
      },
      error: () => toast.error('Could not read that file'),
    });
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sample-bank-statement.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Imports"
        description="Bring bank transactions in by file upload. Duplicate lines are detected and skipped."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-4 p-5">
          <div>
            <h3 className="text-sm font-semibold">Upload a statement</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              CSV with columns: Date, Narration, Reference, Debit, Credit
            </p>
          </div>

          <Field label="Import into account">
            <Combobox
              options={options}
              value={activeAccount}
              onChange={setAccountId}
              placeholder="Select account"
              searchPlaceholder="Search accounts"
            />
          </Field>

          <div
            onClick={() => canImport && fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f && canImport) onFile(f);
            }}
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors hover:border-primary/50 hover:bg-accent/40"
          >
            <Upload className="mb-2 size-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              {upload.busy ? 'Importing…' : 'Drop a CSV here or click to browse'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Most Indian banks export this format directly</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = '';
            }}
          />

          <Button variant="outline" size="sm" onClick={downloadSample} className="gap-1.5">
            <Download className="size-3.5" /> Download a sample file
          </Button>
        </Card>

        <Card className="space-y-4 p-5">
          <div>
            <h3 className="text-sm font-semibold">Automatic bank feeds</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Not available yet — and here is the honest reason.</p>
          </div>

          <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              A live feed in India runs through the Account Aggregator framework, and pulling data from it directly
              requires being a licensed Financial Information User — which means being regulated by the RBI, SEBI,
              IRDAI or PFRDA. Accounting software is none of those. The route open to us is going through a licensed
              aggregator as a partner, which is a commercial arrangement rather than a feature we can simply build.
              Until that is in place, uploading a statement is the honest option, and the duplicate detection means
              re-uploading an overlapping period costs nothing.
            </p>
          </div>

          <div className="space-y-2">
            {(accounts.data?.accounts ?? []).map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{b.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {b.accountLast4 ? `${b.bankName ?? b.kind} ····${b.accountLast4}` : b.kind}
                  </p>
                </div>
                <Badge variant="outline" className="text-[10px]">Upload only</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold">Import history</h3>
        <AsyncPage state={history}>
          {(d) =>
            d.imports.length === 0 ? (
              <p className="text-sm text-muted-foreground">No imports yet.</p>
            ) : (
              <div className="divide-y">
                {d.imports.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center gap-3 py-3">
                    <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{b.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {b.bankName} · {short(b.periodFrom)} – {short(b.periodTo)}
                        {b.importedBy ? ` · by ${b.importedBy}` : ''}
                      </p>
                    </div>
                    <Badge variant="secondary" className="text-[10px]">{b.rowsImported} lines</Badge>
                    {b.rowsDuplicate > 0 && (
                      <Badge variant="outline" className="text-[10px]">{b.rowsDuplicate} skipped</Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={
                        'text-[10px] ' +
                        (b.lines > 0 && b.matched === b.lines ? 'border-emerald-500/40' : '')
                      }
                    >
                      {b.matched} of {b.lines} matched
                    </Badge>
                  </div>
                ))}
              </div>
            )
          }
        </AsyncPage>
      </Card>
    </>
  );
}
