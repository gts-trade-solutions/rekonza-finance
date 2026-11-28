'use client';

// Accountant → Integration Check (status review 7, item 14): do the payroll
// and inventory sub-ledgers agree with the general ledger for a period?
//
//   Payroll vs GL     each pay run and imported register against its own
//                     entries, account by account; each payroll liability at
//                     the period's end against its ledger balance, with any
//                     entry from elsewhere listed.
//   Inventory vs GL   the stock valuation against the Inventory account; on a
//                     periodic book a stated pass (the statements value stock).
//   External feeds    payroll imported from another system, and Tally.
//
// Each section says Pass (difference ₹0.00) or Difference, drills down to the
// run, the entry and the ledger, and the whole page prints and exports.

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, Download, FileText, Printer, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { Field } from '@/components/shared/form-bits';
import { JournalDialog } from '@/components/sales/sales-doc-record';
import { integration, type IntegrationCheckData } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { downloadWorkbook } from '@/lib/xlsx';

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const td = 'px-3 py-1.5';
const r2 = (p: number) => (p / 100).toFixed(2);
const fmt = (iso: string | null) => (iso ? new Date(iso.length > 10 ? iso : `${iso}T00:00:00`).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', ...(iso.length > 10 ? { hour: '2-digit', minute: '2-digit' } : {}) }) : 'Never');
const fyStart = () => { const d = new Date(); return `${d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear()}-04-01`; };
const SOURCE: Record<string, string> = {
  bill: 'Bills (stock bought)', invoice: 'Invoices (cost of goods sold)', credit_note: 'Credit notes (goods back)', vendor_credit: 'Vendor credits', stock_valuation: 'Month-end true-up',
  stock_opening: 'Stock taken into the ledger', manual_journal: 'Manual journals', journal: 'Journals', stock_adjustment: 'Stock adjustments', production: 'Production',
};

function Status({ ok, label }: { ok: boolean; label?: string }) {
  return ok
    ? <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-700" data-slot="status-pass"><CheckCircle2 className="size-3" /> {label ?? 'Pass'}</Badge>
    : <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive" data-slot="status-difference"><XCircle className="size-3" /> {label ?? 'Difference'}</Badge>;
}

function exportAll(d: IntegrationCheckData) {
  const runs = [['Run', 'Month', 'Account', 'Register', 'Ledger', 'Difference', 'Result'],
    ...d.payroll.runs.flatMap((r) => r.lines.map((l) => [r.label, r.month, l.label, r2(l.registerPaise), r2(l.ledgerPaise), r2(l.differencePaise), l.differencePaise === 0 ? 'Pass' : 'Difference']))];
  const liabilities = [['Liability', 'Posted by payroll', 'Paid / deposited', 'Owed per payroll', 'Ledger balance', 'Full & final', 'Other entries', 'Difference', 'Result'],
    ...d.payroll.liabilities.map((l) => [l.label, r2(l.postedPaise), r2(l.settledPaise), r2(l.subledgerPaise), r2(l.ledgerPaise), r2(l.settlementsPaise), r2(l.otherPaise), r2(l.differencePaise), l.ok ? 'Pass' : 'Difference']),
    [], ['Other entries in payroll liabilities'], ['Liability', 'Entry', 'Date', 'Source', 'Memo', 'Amount'],
    ...d.payroll.liabilities.flatMap((l) => l.other.map((o) => [l.label, o.entryNo, o.date, o.source, o.memo ?? '', r2(o.amountPaise)]))];
  const inv = d.inventory;
  const inventory = [['As at', inv.asOf], ['Method', inv.method], ['Stock valuation (documents)', r2(inv.stockValuePaise)], ['Inventory account (ledger)', r2(inv.ledgerPaise)],
    ['Difference', r2(inv.differencePaise)], ['Result', inv.status === 'difference' ? 'Difference' : 'Pass'], ['Last true-up', inv.lastTrueUp ?? ''], [],
    ['Moved the Inventory account since the last true-up', 'Entries', 'Amount'], ...inv.movements.map((m) => [SOURCE[m.sourceType] ?? m.sourceType, m.entries, r2(m.amountPaise)]), [],
    ['Item', 'Qty', 'Value now', 'At the last true-up', 'Moved'], ...inv.items.map((i) => [i.name, i.qty, r2(i.valuePaise), r2(i.atTrueUpPaise), r2(i.movedPaise)])];
  downloadWorkbook(`integration-check-${d.from}-${d.to}.xlsx`, [{ name: 'Pay runs', rows: runs }, { name: 'Payroll liabilities', rows: liabilities }, { name: 'Inventory', rows: inventory }]);
}

export default function IntegrationCheckPage() {
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const state = useApi(() => integration.check(from, to), [from, to]);
  const [journal, setJournal] = useState<{ id: string; label: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const gl = (accountId: string | null) => (accountId ? `/reports/general-ledger?account=${accountId}&from=${from}&to=${to}` : null);

  return (
    <>
      <PageHeader
        title="Integration check"
        description="Payroll and inventory against the general ledger: every pay run, payroll liability and the stock valuation, with Pass or the difference, and where it comes from."
        actions={(
          <div className="no-print flex flex-wrap items-end gap-2">
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" data-slot="ic-from" /></Field>
            <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" data-slot="ic-to" /></Field>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => window.print()}><Printer className="size-3.5" /> Print</Button>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={!state.data} onClick={() => state.data && exportAll(state.data)} data-slot="ic-export"><Download className="size-3.5" /> Export</Button>
          </div>
        )}
      />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => {
          const inv = d.inventory;
          return (
            <div className="space-y-5" data-slot="integration-check">
              <div className="grid gap-3 sm:grid-cols-2">
                <Card className="flex items-center justify-between gap-3 p-4" data-slot="ic-payroll-summary">
                  <div><p className="text-sm font-semibold">Payroll vs general ledger</p><p className="text-xs text-muted-foreground">{d.payroll.runs.length} pay run(s) and imports · {d.payroll.liabilities.length} liabilities</p></div>
                  <Status ok={d.payroll.ok} />
                </Card>
                <Card className="flex items-center justify-between gap-3 p-4" data-slot="ic-inventory-summary">
                  <div><p className="text-sm font-semibold">Inventory vs general ledger</p><p className="text-xs text-muted-foreground">{inv.method === 'perpetual' ? `Perpetual since ${fmt(inv.perpetualFrom)}` : 'Periodic: the statements value stock'} · {inv.itemCount} item(s) in stock</p></div>
                  <Status ok={inv.status !== 'difference'} label={inv.status === 'pass_periodic' ? 'Pass (periodic)' : undefined} />
                </Card>
              </div>

              {/* ── Payroll ── */}
              <Card className="overflow-hidden p-0" data-slot="ic-runs">
                <div className="border-b px-4 py-2.5"><p className="text-sm font-semibold">Pay runs and imported registers against their entries</p>
                  <p className="text-xs text-muted-foreground">The register&apos;s totals against what the run&apos;s own entries (net of any reversal on reopening) put in each account.</p></div>
                {d.payroll.runs.length === 0 ? <p className="p-6 text-sm text-muted-foreground" data-slot="ic-no-runs">No posted payroll from {fmt(from)} to {fmt(to)}. Post a month&apos;s payroll (Payroll → Payroll), or import one run elsewhere (Payroll → Import Salary Register).</p> : (
                  <table className="w-full text-xs">
                    <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Run</th><th className={`${th} text-right`}>Employees</th><th className={`${th} text-right`}>Gross (register)</th><th className={`${th} text-right`}>Gross (ledger)</th><th className={`${th} text-right`}>Net pay (register)</th><th className={`${th} text-right`}>Net pay (ledger)</th><th className={th}>Result</th><th className={th} /></tr></thead>
                    <tbody>
                      {d.payroll.runs.map((r) => {
                        const gross = r.lines[0];
                        const net = r.lines.find((l) => l.label.startsWith('Salaries Payable'))!;
                        const key = `${r.kind}-${r.id}`;
                        return [
                          <tr key={key} className="cursor-pointer border-b hover:bg-row-hover" onClick={() => setOpen(open === key ? null : key)} data-slot="ic-run">
                            <td className={td}><span className="font-medium">{r.label}</span> <span className="text-muted-foreground">· {r.status}</span></td>
                            <td className={`${td} text-right`}>{r.employees}</td>
                            <td className={`${td} text-right`}><Money value={gross.registerPaise} /></td><td className={`${td} text-right`}><Money value={gross.ledgerPaise} /></td>
                            <td className={`${td} text-right`}><Money value={net.registerPaise} /></td><td className={`${td} text-right`}><Money value={net.ledgerPaise} /></td>
                            <td className={td}><Status ok={r.ok} /></td>
                            <td className={`${td} whitespace-nowrap text-right`} onClick={(e) => e.stopPropagation()}>
                              {r.kind === 'run' ? <Link className="text-primary hover:underline" href={`/payroll/runs/${r.id}`}>Open run</Link> : <Link className="text-primary hover:underline" href="/payroll/import">Open import</Link>}
                              {r.entryIds.map((e, i) => <button key={e} type="button" className="ml-2 text-primary hover:underline" onClick={() => setJournal({ id: e, label: `${r.label}${r.entryIds.length > 1 ? ` (${i + 1})` : ''}` })}>Entry {i + 1}</button>)}
                            </td>
                          </tr>,
                          open === key && (
                            <tr key={`${key}-d`} className="border-b bg-muted/20"><td colSpan={8} className="px-4 py-2">
                              {r.components.length > 0 && <p className="mb-1 text-muted-foreground">Gross by component: {r.components.map((c) => `${c.label} ₹${(c.amountPaise / 100).toLocaleString('en-IN')}`).join(' · ')}</p>}
                              <table className="w-full"><thead><tr className="text-[10px] uppercase text-muted-foreground"><th className="py-1 text-left">Account</th><th className="py-1 text-right">Register</th><th className="py-1 text-right">Ledger</th><th className="py-1 text-right">Difference</th><th /></tr></thead>
                                <tbody>{r.lines.map((l) => (
                                  <tr key={l.label} className="border-t" data-slot="ic-run-line"><td className="py-1">{l.label}</td><td className="py-1 text-right"><Money value={l.registerPaise} /></td><td className="py-1 text-right"><Money value={l.ledgerPaise} /></td>
                                    <td className={`py-1 text-right ${l.differencePaise ? 'text-destructive' : ''}`}><Money value={l.differencePaise} /></td>
                                    <td className="py-1 text-right">{gl(l.accountId) && <Link className="text-primary hover:underline" href={gl(l.accountId)!}>Ledger</Link>}</td></tr>
                                ))}</tbody></table>
                            </td></tr>
                          ),
                        ];
                      })}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card className="overflow-hidden p-0" data-slot="ic-liabilities">
                <div className="border-b px-4 py-2.5"><p className="text-sm font-semibold">Payroll liabilities at {fmt(to)}: what payroll says is owed against the ledger</p>
                  <p className="text-xs text-muted-foreground">Posted by pay runs and imports, less dues paid, challans deposited and salaries paid — against the account&apos;s balance. Entries from anywhere else are listed under it.</p></div>
                <table className="w-full text-xs">
                  <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Liability</th><th className={`${th} text-right`}>Posted by payroll</th><th className={`${th} text-right`}>Paid</th><th className={`${th} text-right`}>Owed per payroll</th><th className={`${th} text-right`}>Ledger balance</th><th className={`${th} text-right`}>F&amp;F / other entries</th><th className={`${th} text-right`}>Difference</th><th className={th}>Result</th></tr></thead>
                  <tbody>
                    {d.payroll.liabilities.map((l) => [
                      <tr key={l.code} className="border-b" data-slot="ic-liability">
                        <td className={td}>{gl(l.accountId) ? <Link className="text-primary hover:underline" href={gl(l.accountId)!}>{l.label}</Link> : l.label}</td>
                        <td className={`${td} text-right`}><Money value={l.postedPaise} /></td><td className={`${td} text-right`}><Money value={l.settledPaise} /></td>
                        <td className={`${td} text-right font-medium`}><Money value={l.subledgerPaise} /></td><td className={`${td} text-right font-medium`}><Money value={l.ledgerPaise} /></td>
                        <td className={`${td} text-right`}><Money value={l.settlementsPaise + l.otherPaise} showZero={false} /></td>
                        <td className={`${td} text-right ${l.differencePaise ? 'text-destructive' : ''}`}><Money value={l.differencePaise} /></td>
                        <td className={td}><Status ok={l.ok} /></td>
                      </tr>,
                      ...l.other.map((o) => (
                        <tr key={`${l.code}-${o.entryId}`} className="border-b bg-muted/10 text-muted-foreground">
                          <td className={`${td} pl-8`} colSpan={5}><button type="button" className="text-primary hover:underline" onClick={() => setJournal({ id: o.entryId, label: `entry ${o.entryNo}` })}>Entry {o.entryNo}</button> · {o.date} · {o.source.replaceAll('_', ' ')} · {o.memo}</td>
                          <td className={`${td} text-right`}><Money value={o.amountPaise} /></td><td colSpan={2} />
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
              </Card>

              {/* ── Inventory ── */}
              <Card className="space-y-3 p-4" data-slot="ic-inventory">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">Inventory at {fmt(inv.asOf)}: the stock valuation against the Inventory account</p>
                  <Status ok={inv.status !== 'difference'} label={inv.status === 'pass_periodic' ? 'Pass (periodic)' : undefined} />
                </div>
                <div className="grid max-w-2xl grid-cols-[1fr_auto] gap-x-8 gap-y-1 text-sm">
                  <span>Stock valuation from the documents</span><Money value={inv.stockValuePaise} className="font-medium" />
                  <span>Inventory account in the ledger</span><Money value={inv.ledgerPaise} className="font-medium" />
                  <span>Difference</span><Money value={inv.differencePaise} className={inv.status === 'difference' ? 'font-semibold text-destructive' : 'font-semibold'} />
                </div>
                <p className="text-xs text-muted-foreground" data-slot="ic-inventory-note">
                  {inv.method === 'periodic'
                    ? 'This book keeps stock periodically: purchases are expensed and the ledger carries no stock; the balance sheet and the profit and loss take closing stock from the valuation (AS 2). That is the method working, not a gap.'
                    : inv.status === 'pass'
                      ? `Perpetual inventory: every purchase, sale and the month-end true-up post to the Inventory account, and it equals the valuation to the paisa.${inv.lastTrueUp ? ` Last brought into line on ${fmt(inv.lastTrueUp)}.` : ''}`
                      : `Perpetual inventory: the difference is what moved since the account was last brought into line${inv.lastTrueUp ? ` on ${fmt(inv.lastTrueUp)}` : ''} without an entry of its own (an adjustment, production, a change in average cost). The month-end true-up posts it; the items are below.`}
                </p>
                <div className="flex flex-wrap gap-3 text-xs">
                  <Link className="text-primary hover:underline" href={`/reports/inventory-valuation?asOf=${inv.asOf}`}>Inventory valuation report</Link>
                  {gl(inv.inventoryAccountId) && <Link className="text-primary hover:underline" href={gl(inv.inventoryAccountId)!}>Inventory account in the ledger</Link>}
                </div>
                {inv.movements.length > 0 && (
                  <table className="w-full max-w-2xl text-xs" data-slot="ic-inventory-movements">
                    <thead><tr className="border-b"><th className={`${th} text-left`}>Moved the Inventory account{inv.lastTrueUp ? ` after ${fmt(inv.lastTrueUp)}` : ''}</th><th className={`${th} text-right`}>Entries</th><th className={`${th} text-right`}>Amount</th></tr></thead>
                    <tbody>{inv.movements.map((m) => <tr key={m.sourceType} className="border-b last:border-0"><td className={td}>{SOURCE[m.sourceType] ?? m.sourceType.replaceAll('_', ' ')}</td><td className={`${td} text-right`}>{m.entries}</td><td className={`${td} text-right`}><Money value={m.amountPaise} /></td></tr>)}</tbody>
                  </table>
                )}
                {inv.items.length > 0 && (
                  <table className="w-full text-xs" data-slot="ic-inventory-items">
                    <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Item</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Value now</th><th className={`${th} text-right`}>At the last true-up</th><th className={`${th} text-right`}>Moved since</th></tr></thead>
                    <tbody>{inv.items.map((i) => <tr key={i.itemId} className="border-b last:border-0"><td className={td}>{i.name}{i.sku ? <span className="ml-1 font-mono text-muted-foreground">{i.sku}</span> : null}</td><td className={`${td} text-right`}>{i.qty}</td><td className={`${td} text-right`}><Money value={i.valuePaise} /></td><td className={`${td} text-right`}><Money value={i.atTrueUpPaise} /></td><td className={`${td} text-right`}><Money value={i.movedPaise} /></td></tr>)}</tbody>
                  </table>
                )}
              </Card>

              {/* ── External feeds ── */}
              <Card className="p-4" data-slot="ic-external">
                <p className="text-sm font-semibold">External integrations</p>
                <table className="mt-2 w-full text-xs">
                  <thead><tr className="border-b"><th className={`${th} text-left`}>Feed</th><th className={`${th} text-left`}>Last run</th><th className={`${th} text-left`}>What it did</th><th className={th} /></tr></thead>
                  <tbody>
                    <tr className="border-b"><td className={td}>Payroll from another system (salary register file)</td><td className={td}>{fmt(d.external.payrollImport?.at ?? null)}</td>
                      <td className={td}>{d.external.payrollImport ? `${d.external.payrollImport.month}${d.external.payrollImport.source ? ` from ${d.external.payrollImport.source}` : ''} · ${d.external.payrollImport.status}` : 'None imported; payroll runs here'}</td>
                      <td className={`${td} text-right`}><Link className="text-primary hover:underline" href="/payroll/import">Import</Link></td></tr>
                    <tr className="border-b"><td className={td}>Tally sync (connector)</td><td className={td}>{d.external.tallySync.length ? fmt(d.external.tallySync[0].lastSyncedAt) : 'Never'}</td>
                      <td className={td}>{d.external.tallySync.length ? d.external.tallySync.map((c) => `${c.company}${c.inventory ? ' (with inventory)' : ''}${c.lastError ? ` — error: ${c.lastError}` : ''}`).join('; ') : 'No Tally company connected'}</td>
                      <td className={`${td} text-right`}><Link className="text-primary hover:underline" href="/tally/import">Tally</Link></td></tr>
                    <tr className="border-b"><td className={td}>Tally vouchers imported</td><td className={td}>{fmt(d.external.tallyVoucherImport?.at ?? null)}</td><td className={td}>{d.external.tallyVoucherImport ? `${d.external.tallyVoucherImport.vouchers} voucher(s) in all` : '—'}</td><td /></tr>
                    <tr className="border-b"><td className={td}>Tally files imported (XML, JSON, Excel)</td><td className={td}>{fmt(d.external.tallyFileImport?.at ?? null)}</td><td className={td}>{d.external.tallyFileImport?.detail ?? '—'}</td><td /></tr>
                    <tr><td className={td}>Export to Tally (masters, vouchers, stock)</td><td className={td}>{fmt(d.external.tallyExport?.at ?? null)}</td>
                      <td className={td}>{d.external.tallyExport ? `${d.external.tallyExport.kind}: ${d.external.tallyExport.vouchers} voucher(s), ${d.external.tallyExport.ledgers} ledger(s), ${d.external.tallyExport.from} to ${d.external.tallyExport.to}` : '—'}</td>
                      <td className={`${td} text-right`}><Link className="text-primary hover:underline" href="/tally/export">Export</Link></td></tr>
                  </tbody>
                </table>
              </Card>
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><FileText className="size-3" /> Read only: nothing on this page posts. A difference is corrected where it arose — the run, the payment, or the entry listed.</p>
            </div>
          );
        }}
      </AsyncPage>
      {journal && <JournalDialog entryId={journal.id} number={journal.label} onClose={() => setJournal(null)} />}
    </>
  );
}
