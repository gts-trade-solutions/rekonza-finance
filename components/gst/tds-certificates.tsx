'use client';

// Around the TDS return: certificates and PANs.
//
//   * Form 131 (earlier 16A) — downloaded from TRACES and sent to each deductee
//     within fifteen days of the return's due date; and the ones customers send
//     us for what they withheld, without which the credit cannot be claimed.
//   * Lower-deduction certificates a vendor holds. Bills inside one are deducted
//     at its rate until its amount runs out.
//   * Whether each deductee's PAN is operative. An inoperative PAN is deducted
//     at the no-PAN rate.

import { Fragment, useState } from 'react';
import { CheckCircle2, Loader2, Paperclip, Plus, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { ReportTable } from '@/components/shared/report-shell';
import { Attachments } from '@/components/shared/attachments';
import { ContactPicker } from '@/components/forms/quick-create';
import {
  tdsCertificates, type TdsCertificateRow, type TdsCertificatesResponse, type TdsDeducteePan, type TdsLowerCertificate,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const today = () => new Date().toISOString().slice(0, 10);
const currentFy = () => {
  const d = new Date();
  return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0);
};
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

const STATUS: Record<TdsCertificateRow['status'], { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  partial: { label: 'Part', tone: 'border-amber-500/40 text-amber-700 dark:text-amber-300' },
  due: { label: 'Due', tone: 'text-muted-foreground' },
  overdue: { label: 'Overdue', tone: 'border-red-500/40 text-red-700 dark:text-red-300' },
};

// ── Form 131 / 16A ───────────────────────────────────────────────────────────

export function TdsCertificatesPanel() {
  const [fy, setFy] = useState(currentFy());
  // The quarter whose certificates fall due next: last quarter's, until they are.
  const [quarter, setQuarter] = useState(() => {
    const m = new Date().getMonth() + 1;
    const current = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
    return current === 1 ? 1 : current - 1;
  });
  const state = useApi<TdsCertificatesResponse>(() => tdsCertificates.quarter(fy, quarter), [fy, quarter]);
  const canCreate = usePermission('gst', 'create');
  const [recording, setRecording] = useState<{ direction: 'issued' | 'received'; row: TdsCertificateRow } | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
          <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[0, 1, 2].map((i) => currentFy() - i).map((y) => (
              <SelectItem key={y} value={String(y)}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(quarter)} onValueChange={(v) => setQuarter(Number(v))}>
          <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {['Q1 · Apr–Jun', 'Q2 · Jul–Sep', 'Q3 · Oct–Dec', 'Q4 · Jan–Mar'].map((l, i) => (
              <SelectItem key={l} value={String(i + 1)}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <AsyncPage state={state}>
        {(d) => (
          <>
            <Card className="p-4 text-sm">
              <p className="font-medium">{d.form} for this quarter is due by {fmt(d.dueDate)}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Certificates are generated on TRACES once the quarter&apos;s return is processed, never by the deductor&apos;s
                own software. Download each one there, send it, and record it here with the PDF, so nothing due is missed.
              </p>
            </Card>

            <Section
              title="To deductees — what you deducted"
              empty="Nothing was deducted from anyone this quarter."
              rows={d.issued}
              canCreate={canCreate}
              onRecord={(row) => setRecording({ direction: 'issued', row })}
            />
            <Section
              title="From customers — what they withheld from you"
              hint="Without the customer's certificate, and the tax showing in Form 26AS / AIS, the credit cannot be claimed in your own return."
              empty="No customer withheld TDS from a receipt this quarter."
              rows={d.received}
              canCreate={canCreate}
              onRecord={(row) => setRecording({ direction: 'received', row })}
            />
          </>
        )}
      </AsyncPage>

      <RecordDialog
        open={recording}
        fy={fy}
        quarter={quarter}
        onClose={() => setRecording(null)}
        onDone={() => { setRecording(null); void state.refetch(); }}
      />
    </div>
  );
}

function Section({ title, hint, empty, rows, canCreate, onRecord }: {
  title: string; hint?: string; empty: string; rows: TdsCertificateRow[]; canCreate: boolean;
  onRecord: (row: TdsCertificateRow) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ReportTable>
          <thead>
            <tr className="border-b bg-muted/50">
              <th className={`${th} text-left`}>Party</th>
              <th className={`${th} text-left`}>PAN</th>
              <th className={`${th} text-right`}>TDS</th>
              <th className={`${th} text-left`}>Certificates</th>
              <th className={`${th} text-left`}>Status</th>
              <th className="w-28" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.contactId}>
                <tr className="border-b last:border-0">
                  <td className="px-3 py-2 text-sm font-medium">{r.contactName}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.pan ?? <span className="text-destructive">none</span>}</td>
                  <td className="px-3 py-2 text-right"><Money value={r.taxPaise} /></td>
                  <td className="px-3 py-2 text-xs">
                    {r.certificates.length === 0 ? '—' : r.certificates.map((c) => (
                      <button key={c.id} type="button" className="mr-2 font-mono underline-offset-2 hover:underline"
                        onClick={() => setOpen(open === c.id ? null : c.id)} title="Show the attached certificate">
                        {c.certificateNo}
                      </button>
                    ))}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={`text-[10px] ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</Badge>
                  </td>
                  <td className="px-2 py-2 text-right">
                    {canCreate && r.status !== 'done' && (
                      <Button size="xs" variant="outline" className="gap-1" onClick={() => onRecord(r)}>
                        <Plus className="size-3" /> Record
                      </Button>
                    )}
                  </td>
                </tr>
                {r.certificates.filter((c) => c.id === open).map((c) => (
                  <tr key={`${c.id}-files`} className="border-b bg-muted/20">
                    <td colSpan={6} className="px-3 py-3">
                      <p className="mb-2 text-xs text-muted-foreground">
                        {c.certificateNo} · {fmt(c.issuedOn)} · covers <Money value={c.taxPaise} />
                      </p>
                      <Attachments targetType="tds_certificate" targetId={c.id} canEdit={canCreate} title="Certificate PDF" />
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </ReportTable>
      )}
    </div>
  );
}

function RecordDialog({ open, fy, quarter, onClose, onDone }: {
  open: { direction: 'issued' | 'received'; row: TdsCertificateRow } | null;
  fy: number; quarter: number; onClose: () => void; onDone: () => void;
}) {
  const [no, setNo] = useState('');
  const [on, setOn] = useState(today());
  const [tax, setTax] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const left = open ? Math.max(0, open.row.taxPaise - open.row.coveredPaise) : 0;

  const save = async () => {
    if (!open) return;
    setBusy(true);
    try {
      await tdsCertificates.record({
        direction: open.direction, contactId: open.row.contactId, fy, quarter,
        certificateNo: no, issuedOn: on, taxPaise: tax ?? left,
      });
      toast.success(`Certificate ${no.toUpperCase()} recorded`, { description: 'Open it in the list to attach the PDF.' });
      setNo(''); setTax(null);
      onDone();
    } catch (e) {
      toast.error('Not recorded', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {open && (
          <>
            <DialogHeader>
              <DialogTitle>{open.direction === 'issued' ? 'Certificate sent to' : 'Certificate received from'} {open.row.contactName}</DialogTitle>
              <DialogDescription>
                Q{quarter} of FY {fy}-{String((fy + 1) % 100).padStart(2, '0')} · TDS <Money value={open.row.taxPaise} />
                {open.row.coveredPaise > 0 && <>, of which <Money value={open.row.coveredPaise} /> is already covered</>}.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Certificate number" required className="sm:col-span-2">
                <Input value={no} onChange={(e) => setNo(e.target.value)} className="font-mono uppercase" placeholder="As printed on it" />
              </Field>
              <Field label="Dated" required>
                <Input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
              </Field>
              <Field label="Tax it covers" required>
                <MoneyInput valuePaise={tax ?? left} onChangePaise={setTax} />
              </Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={() => void save()} disabled={busy || no.trim().length < 4}>
                {busy && <Loader2 className="size-4 animate-spin" />} Record
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Lower-deduction certificates ─────────────────────────────────────────────

export function LowerDeductionPanel() {
  const state = useApi<{ certificates: TdsLowerCertificate[] }>(() => tdsCertificates.lower(), []);
  const canCreate = usePermission('gst', 'create');
  const [adding, setAdding] = useState(false);

  const withdraw = async (c: TdsLowerCertificate) => {
    if (!window.confirm(`Withdraw certificate ${c.certificateNo}? Bills already deducted under it keep what they were deducted.`)) return;
    try {
      await tdsCertificates.cancelLower(c.id);
      toast.success(`${c.certificateNo} withdrawn`);
      void state.refetch();
    } catch (e) {
      toast.error('Not withdrawn', { description: err(e) });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          A vendor holding a certificate under section 197 (section 395 of the 2025 Act) is deducted at its rate on
          bills dated inside it, until its amount is used up. A bill that would overrun the amount is deducted at the
          normal rate. Each such deduction is reported in the return with remark A and the certificate number.
        </p>
        {canCreate && <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}><Plus className="size-4" /> Add certificate</Button>}
      </div>
      <AsyncPage state={state}>
        {(d) => d.certificates.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No lower-deduction certificates on file.</p>
        ) : (
          <ReportTable>
            <thead>
              <tr className="border-b bg-muted/50">
                <th className={`${th} text-left`}>Vendor</th>
                <th className={`${th} text-left`}>Certificate</th>
                <th className={`${th} text-left`}>Section · rate</th>
                <th className={`${th} text-left`}>Valid</th>
                <th className={`${th} text-right`}>Used / limit</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {d.certificates.map((c) => {
                const live = !c.cancelled && c.validTo >= today();
                return (
                  <tr key={c.id} className={`border-b last:border-0 ${live ? '' : 'opacity-60'}`}>
                    <td className="px-3 py-2 text-sm">{c.contactName}<span className="block font-mono text-[11px] text-muted-foreground">{c.pan}</span></td>
                    <td className="px-3 py-2 font-mono text-xs">{c.certificateNo}{c.cancelled && <Badge variant="outline" className="ml-2 text-[10px]">Withdrawn</Badge>}</td>
                    <td className="px-3 py-2 text-xs">{c.sectionCode} · {c.ratePct}%</td>
                    <td className="px-3 py-2 text-xs">{fmt(c.validFrom)} – {fmt(c.validTo)}</td>
                    <td className="px-3 py-2 text-right text-xs">
                      <Money value={c.usedPaise} /> / {c.limitPaise === null ? 'no limit' : <Money value={c.limitPaise} />}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {canCreate && !c.cancelled && (
                        <Button size="xs" variant="ghost" onClick={() => void withdraw(c)}>Withdraw</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </ReportTable>
        )}
      </AsyncPage>
      <AddLowerDialog open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void state.refetch(); }} />
    </div>
  );
}

function AddLowerDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const blank = { contactId: '', sectionCode: '', certificateNo: '', ratePct: '', validFrom: today(), validTo: '', limit: 0 };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await tdsCertificates.addLower({
        contactId: f.contactId, sectionCode: f.sectionCode.trim(), certificateNo: f.certificateNo, ratePct: Number(f.ratePct),
        validFrom: f.validFrom, validTo: f.validTo, limitPaise: f.limit > 0 ? f.limit : null,
      });
      toast.success(`Certificate ${f.certificateNo.toUpperCase()} on file`);
      setF(blank);
      onDone();
    } catch (e) {
      toast.error('Not added', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Lower-deduction certificate</DialogTitle>
          <DialogDescription>Copy the details from the certificate the vendor sent, as issued on TRACES.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vendor" required className="sm:col-span-2">
            <ContactPicker kind="vendor" value={f.contactId} onChange={(v) => setF({ ...f, contactId: v })} />
          </Field>
          <Field label="Certificate number" required>
            <Input value={f.certificateNo} onChange={(e) => setF({ ...f, certificateNo: e.target.value })} className="font-mono uppercase" />
          </Field>
          <Field label="Section" required hint="As mapped on the vendor, e.g. 194J">
            <Input value={f.sectionCode} onChange={(e) => setF({ ...f, sectionCode: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Rate %" required hint="0 for a nil-deduction certificate">
            <Input type="number" min={0} max={100} step="0.01" value={f.ratePct} onChange={(e) => setF({ ...f, ratePct: e.target.value })} />
          </Field>
          <Field label="Amount limit" hint="Leave at zero if it names none">
            <MoneyInput valuePaise={f.limit} onChangePaise={(p) => setF({ ...f, limit: p })} />
          </Field>
          <Field label="Valid from" required><Input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></Field>
          <Field label="Valid to" required><Input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.contactId || !f.sectionCode || !f.certificateNo || f.ratePct === '' || !f.validTo}>
            {busy && <Loader2 className="size-4 animate-spin" />} Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── PAN status ───────────────────────────────────────────────────────────────

export function PanCheckPanel() {
  const state = useApi<{ deductees: TdsDeducteePan[] }>(() => tdsCertificates.pans(), []);
  const canCreate = usePermission('gst', 'create');
  const set = async (p: TdsDeducteePan, status: 'operative' | 'inoperative') => {
    try {
      await tdsCertificates.setPan(p.id, status, today());
      toast.success(`${p.name}: PAN ${status}`, {
        description: status === 'inoperative' ? 'New bills from them are deducted at the no-PAN rate.' : undefined,
      });
      void state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: err(e) });
    }
  };
  return (
    <div className="space-y-3">
      <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
        A PAN not linked to Aadhaar is inoperative, and TDS on it is at the higher no-PAN rate (section 206AA; CBDT
        circular 3/2023). Check each deductee on the e-filing portal&apos;s &ldquo;Verify your PAN&rdquo; or on TRACES, and
        record the result here; recheck before each quarter&apos;s return.
      </p>
      <AsyncPage state={state}>
        {(d) => d.deductees.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Nobody is set up for TDS yet.</p>
        ) : (
          <ReportTable>
            <thead>
              <tr className="border-b bg-muted/50">
                <th className={`${th} text-left`}>Deductee</th>
                <th className={`${th} text-left`}>PAN</th>
                <th className={`${th} text-left`}>Status</th>
                <th className={`${th} text-left`}>Checked</th>
                <th className="w-52" />
              </tr>
            </thead>
            <tbody>
              {d.deductees.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="px-3 py-2 text-sm">{p.name}{p.section && <span className="ml-2 text-xs text-muted-foreground">{p.section}</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.pan ?? <span className="text-destructive">none — no-PAN rate</span>}</td>
                  <td className="px-3 py-2 text-xs">
                    {p.panStatus === 'operative' && <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><ShieldCheck className="size-3.5" /> Operative</span>}
                    {p.panStatus === 'inoperative' && <span className="flex items-center gap-1 text-destructive"><ShieldAlert className="size-3.5" /> Inoperative</span>}
                    {p.panStatus === 'unverified' && <span className="text-muted-foreground">Not checked</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.checkedOn ? fmt(p.checkedOn) : '—'}</td>
                  <td className="px-2 py-2 text-right">
                    {canCreate && p.pan && (
                      <div className="flex justify-end gap-1">
                        <Button size="xs" variant="outline" className="gap-1" onClick={() => void set(p, 'operative')}><CheckCircle2 className="size-3" /> Operative</Button>
                        <Button size="xs" variant="outline" className="gap-1" onClick={() => void set(p, 'inoperative')}><XCircle className="size-3" /> Inoperative</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        )}
      </AsyncPage>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Paperclip className="size-3" /> Keep a screenshot of the portal result on the vendor, under Attachments.</p>
    </div>
  );
}
