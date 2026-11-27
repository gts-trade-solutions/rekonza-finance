'use client';

// Payroll → Import Salary Register (status review 7, item 14): a month's
// payroll run in another system (greytHR, Keka, Zoho Payroll, a bureau),
// imported from its salary register — CSV or Excel, a row per employee — and
// posted as the salary journal, after every row is checked to foot.

import { useState } from 'react';
import Papa from 'papaparse';
import { Download, FileUp, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { Field } from '@/components/shared/form-bits';
import { DeleteButton, reasonQuery, useConfirmDelete } from '@/components/shared/row-actions';
import { JournalDialog } from '@/components/sales/sales-doc-record';
import { api, integration, type PayrollImportResult, type PayrollImportRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { downloadCsv } from '@/components/shared/report-shell';

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The columns the register is read by, and the headings each may go by in other systems' exports. */
const COLUMNS: { key: keyof PayrollImportRow; label: string; words: string[]; money: boolean; required?: boolean }[] = [
  { key: 'code', label: 'Employee code', words: ['employee code', 'emp code', 'emp id', 'employee id', 'code'], money: false, required: true },
  { key: 'name', label: 'Employee name', words: ['employee name', 'name'], money: false, required: true },
  { key: 'department', label: 'Department', words: ['department', 'dept', 'cost centre', 'cost center'], money: false },
  { key: 'basicPaise', label: 'Basic', words: ['basic'], money: true },
  { key: 'hraPaise', label: 'HRA', words: ['hra', 'house rent'], money: true },
  { key: 'otherPaise', label: 'Other earnings', words: ['other earnings', 'allowance', 'special'], money: true },
  { key: 'grossPaise', label: 'Gross', words: ['gross'], money: true, required: true },
  { key: 'pfEmployeePaise', label: 'PF employee', words: ['pf employee', 'employee pf', 'epf ee', 'pf ee'], money: true },
  { key: 'pfEmployerPaise', label: 'PF employer', words: ['pf employer', 'employer pf', 'epf er', 'pf er'], money: true },
  { key: 'esiEmployeePaise', label: 'ESI employee', words: ['esi employee', 'employee esi', 'esi ee'], money: true },
  { key: 'esiEmployerPaise', label: 'ESI employer', words: ['esi employer', 'employer esi', 'esi er'], money: true },
  { key: 'ptPaise', label: 'Professional tax', words: ['professional tax', 'prof tax', 'pt'], money: true },
  { key: 'lwfEmployeePaise', label: 'LWF employee', words: ['lwf employee', 'employee lwf', 'lwf ee'], money: true },
  { key: 'lwfEmployerPaise', label: 'LWF employer', words: ['lwf employer', 'employer lwf', 'lwf er'], money: true },
  { key: 'tdsPaise', label: 'TDS', words: ['tds', 'income tax'], money: true },
  { key: 'advancePaise', label: 'Advance recovery', words: ['advance', 'loan', 'recovery'], money: true },
  { key: 'netPaise', label: 'Net pay', words: ['net pay', 'net salary', 'take home', 'net'], money: true, required: true },
];

function readRows(grid: unknown[][]): { rows: PayrollImportRow[]; missing: string[] } {
  const head = (grid[0] ?? []).map((h) => String(h ?? '').trim().toLowerCase());
  const used = new Set<number>();
  const at = new Map<string, number>();
  // A heading that is exactly one of a column's names first; then headings that
  // contain a name of four letters or more (never "pt" inside "department").
  const passes: ((h: string, w: string) => boolean)[] = [(h, w) => h === w, (h, w) => w.length >= 4 && h.includes(w)];
  for (const match of passes) {
    for (const c of [...COLUMNS].sort((a, b) => Math.max(...b.words.map((w) => w.length)) - Math.max(...a.words.map((w) => w.length)))) {
      if (at.has(c.key)) continue;
      const i = head.findIndex((h, n) => !used.has(n) && c.words.some((w) => match(h, w)));
      if (i >= 0) { at.set(c.key, i); used.add(i); }
    }
  }
  const missing = COLUMNS.filter((c) => c.required && !at.has(c.key)).map((c) => c.label);
  const money = (v: unknown) => Math.round(Number(String(v ?? '').replace(/[₹,\s]/g, '') || 0) * 100);
  const rows = grid.slice(1).filter((r) => String(r[at.get('code') ?? 0] ?? '').trim()).map((r) => {
    const o: Record<string, unknown> = {};
    for (const c of COLUMNS) {
      const i = at.get(c.key);
      if (i === undefined) continue;
      o[c.key] = c.money ? money(r[i]) : String(r[i] ?? '').trim();
    }
    return o as unknown as PayrollImportRow;
  });
  return { rows, missing };
}

export default function PayrollImportPage() {
  const list = useApi(() => integration.imports(), []);
  const canPost = usePermission('payroll', 'approve');
  const banks = useAppStore((s) => s.bankAccounts).filter((b) => b.kind === 'bank');
  const del = useConfirmDelete();
  const [f, setF] = useState({ month: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 7), source: '', bankId: '', paidOn: '' });
  const [file, setFile] = useState<{ name: string; rows: PayrollImportRow[] } | null>(null);
  const [check, setCheck] = useState<PayrollImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [journal, setJournal] = useState<string | null>(null);

  const load = async (fl: File) => {
    try {
      let grid: unknown[][];
      if (/\.xlsx$/i.test(fl.name)) {
        const { default: readXlsxFile } = await import('read-excel-file/browser');
        const sheets = (await readXlsxFile(fl)) as unknown as { data: unknown[][] }[];
        grid = sheets.find((s) => s.data.length > 1)?.data ?? [];
      } else {
        grid = Papa.parse<string[]>((await fl.text()).replace(/^﻿/, ''), { skipEmptyLines: 'greedy' }).data;
      }
      const { rows, missing } = readRows(grid);
      if (missing.length) throw new Error(`The sheet has no column for: ${missing.join(', ')}.`);
      if (!rows.length) throw new Error('No rows under the headings.');
      setFile({ name: fl.name, rows });
      await run(true, rows, fl.name);
    } catch (e) {
      toast.error('Not read', { description: err(e) });
    }
  };
  const run = async (dryRun: boolean, rows = file?.rows, fileName = file?.name) => {
    if (!rows) return;
    setBusy(true);
    try {
      const r = await integration.importRegister({ month: f.month, sourceSystem: f.source || null, fileName, rows, dryRun, paidFromBankAccountId: f.bankId || null, paidOn: f.bankId ? f.paidOn || null : null });
      setCheck(r);
      if (!dryRun && r.posted) {
        toast.success(`Salary register for ${f.month} posted`, { description: `${r.totals.employees} employees, the salary journal${f.bankId ? ' and its payment' : ''} in the ledger.` });
        setFile(null);
        setCheck(null);
        void list.refetch();
      } else if (!dryRun && r.problems.length) {
        toast.error('Not posted', { description: r.problems[0].message });
      }
    } catch (e) {
      toast.error('Not done', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };

  const sample = () => downloadCsv('salary-register-sample.csv', [
    COLUMNS.map((c) => c.label),
    ['E101', 'Ravi Kumar', 'Stores', '15000.00', '6000.00', '4000.00', '25000.00', '1800.00', '1950.00', '0.00', '0.00', '200.00', '0.00', '0.00', '500.00', '1000.00', '21500.00'],
    ['E102', 'Anita Shah', 'Sales', '12000.00', '4800.00', '1200.00', '18000.00', '1440.00', '1560.00', '135.00', '585.00', '0.00', '0.00', '0.00', '0.00', '0.00', '16425.00'],
  ]);

  return (
    <>
      <PageHeader title="Import salary register" description="A month's payroll run in another system — greytHR, Keka, Zoho Payroll, a payroll bureau — imported from its salary register and posted as the salary journal. Every row must foot: gross less deductions is the net pay." />
      <div className="space-y-4">
        <Card className="space-y-3 p-4" data-slot="payroll-import-form">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Month" required><Input type="month" value={f.month} onChange={(e) => { setF({ ...f, month: e.target.value }); setCheck(null); }} data-slot="import-month" /></Field>
            <Field label="From which system"><Input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="greytHR, Keka, bureau…" data-slot="import-source" /></Field>
            <Field label="Salaries paid from (optional)">
              <Select value={f.bankId || 'none'} onValueChange={(v) => setF({ ...f, bankId: v === 'none' ? '' : String(v) })}>
                <SelectTrigger data-slot="import-bank"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">Not paid yet</SelectItem>{banks.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            {f.bankId && <Field label="Paid on" required><Input type="date" value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} data-slot="import-paid-on" /></Field>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent" data-slot="import-file-label">
              <FileUp className="size-4" /> Choose the register (CSV or Excel)
              <input type="file" accept=".csv,.xlsx" className="sr-only" data-slot="import-file" onChange={(e) => { const fl = e.target.files?.[0]; e.target.value = ''; if (fl) void load(fl); }} />
            </label>
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={sample}><Download className="size-3.5" /> Sample layout</Button>
            {file && <span className="text-xs text-muted-foreground">{file.name}: {file.rows.length} row(s)</span>}
          </div>
          <p className="text-[11px] text-muted-foreground">Columns are matched by their headings: employee code, name, department (a cost centre of that name gets the salary), basic, HRA, other earnings, gross, PF and ESI (employee and employer), professional tax, LWF, TDS, advance recovery, net pay.</p>
        </Card>

        {check && (
          <Card className="space-y-3 p-4" data-slot="import-check">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">{check.problems.length ? `${check.problems.length} problem(s): nothing will post until they are fixed` : 'Every row foots. Ready to post.'}</p>
              {check.problems.length ? <Badge variant="outline" className="border-destructive/40 text-destructive">Fix the sheet</Badge> : <Badge variant="outline" className="border-emerald-500/40 text-emerald-700">Checked</Badge>}
            </div>
            {check.problems.length > 0 && (
              <ul className="space-y-0.5 text-xs text-destructive" data-slot="import-problems">{check.problems.slice(0, 30).map((p, i) => <li key={i}>{p.row ? `Row ${p.row}${p.code ? ` (${p.code})` : ''}: ` : ''}{p.message}</li>)}</ul>
            )}
            <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-4" data-slot="import-totals">
              {([['Employees', null, check.totals.employees], ['Gross', check.totals.grossPaise], ['Employer PF, ESI, LWF', check.totals.employerPaise], ['PF (both)', check.totals.pfPaise], ['ESI (both)', check.totals.esiPaise], ['Professional tax', check.totals.ptPaise],
                ['LWF', check.totals.lwfPaise], ['TDS', check.totals.tdsPaise], ['Advances', check.totals.advancesPaise], ['Net pay', check.totals.netPaise]] as [string, number | null, number?][]).map(([l, v, n]) => (
                <div key={l} className="flex justify-between gap-2 border-b py-1"><span className="text-muted-foreground">{l}</span>{v === null ? <span>{n}</span> : <Money value={v} />}</div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Posts: Dr Salaries &amp; Wages (basic, HRA, other earnings), Dr Employer PF, ESI and LWF; Cr PF, ESI, Professional Tax, LWF and TDS Payable, Cr Loans &amp; Advances, Cr Salaries Payable{f.bankId ? '; then Dr Salaries Payable, Cr the bank' : ''}.</p>
            <div className="flex justify-end">
              <Button size="sm" disabled={busy || !canPost || check.problems.length > 0 || (!!f.bankId && !f.paidOn)} onClick={() => void run(false)} data-slot="import-post">
                {busy && <Loader2 className="size-3.5 animate-spin" />} Post the salary journal
              </Button>
            </div>
          </Card>
        )}

        <Card className="overflow-hidden p-0" data-slot="import-list">
          <p className="border-b px-4 py-2.5 text-sm font-medium">Imported registers</p>
          {!list.data?.imports.length ? <p className="p-6 text-sm text-muted-foreground">Nothing imported yet. Payroll run here (Payroll → Payroll) needs no import.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Month</th><th className={`${th} text-left`}>From</th><th className={`${th} text-right`}>Employees</th><th className={`${th} text-right`}>Gross</th><th className={`${th} text-right`}>Net pay</th><th className={`${th} text-left`}>Status</th><th className={th} /></tr></thead>
              <tbody>
                {list.data.imports.map((i) => (
                  <tr key={i.id} className="border-b last:border-0" data-slot="import-row">
                    <td className="px-3 py-1.5">{i.month}</td><td className="px-3 py-1.5">{i.sourceSystem ?? '—'}{i.fileName ? <span className="block text-muted-foreground">{i.fileName}</span> : null}</td>
                    <td className="px-3 py-1.5 text-right">{i.employees}</td><td className="px-3 py-1.5 text-right"><Money value={i.grossPaise} /></td><td className="px-3 py-1.5 text-right"><Money value={i.netPaise} /></td>
                    <td className="px-3 py-1.5">{i.status === 'posted' ? 'Posted' : `Reversed${i.reverseReason ? `: ${i.reverseReason}` : ''}`}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right">
                      {i.entryId && <button type="button" className="mr-2 text-primary hover:underline" onClick={() => setJournal(i.entryId)}>Entry</button>}
                      {i.status === 'posted' && canPost && <DeleteButton onClick={() => del.ask({
                        title: `Reverse the salary register for ${i.month}?`, description: 'Its salary journal (and payment) are reversed in the ledger, never erased; the import stays on record, marked reversed. Refused while dues for the month are paid against it.',
                        reason: true, run: (reason) => api.delete(`/api/payroll/imports?id=${i.id}${reasonQuery(reason, false)}`), done: 'Reversed', onDone: () => void list.refetch(),
                      })} label="Reverse" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      {journal && <JournalDialog entryId={journal} number="the imported payroll" onClose={() => setJournal(null)} />}
      {del.dialog}
    </>
  );
}
