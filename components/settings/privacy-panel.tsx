'use client';

// Personal data under the Digital Personal Data Protection Act, 2023: who
// answers for it, how long records are kept, requests from the people in the
// books and what was done about each, and any breach and who was told.

import { useState } from 'react';
import { AlertTriangle, Download, Eraser, Lock, LockOpen, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { ContactPicker } from '@/components/forms/quick-create';
import { downloadJson } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';
import { usePermission } from '@/lib/store/hooks';

type Kind = 'access' | 'correction' | 'erasure' | 'grievance' | 'consent_withdrawal';
interface Request {
  id: string; subjectType: 'contact' | 'employee' | 'user' | 'other'; subjectId: string | null; subjectName: string; kind: Kind;
  details: string | null; receivedOn: string; dueOn: string; status: 'open' | 'done' | 'refused'; response: string | null; handledBy: string | null; overdue: boolean;
}
interface Breach {
  id: string; discoveredAt: string; description: string; dataAffected: string | null; peopleAffected: number | null;
  boardInformedAt: string | null; boardReportAt: string | null; peopleInformedAt: string | null; reportDueBy: string;
}
interface Privacy {
  settings: { grievanceOfficer: { name: string; email: string; phone: string }; retentionYears: number; responseDays: number };
  requests: Request[]; breaches: Breach[]; encryptionAtRest: boolean;
}

const KIND: Record<Kind, string> = {
  access: 'See their data', correction: 'Correct it', erasure: 'Erase it', grievance: 'Grievance', consent_withdrawal: 'Withdraw consent',
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dmy = (d: string) => new Date(d).toLocaleDateString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);

/** Employees on the books with no standing consent to salary processing. Shown only to those who see payroll. */
function EmployeeConsentGap() {
  const canSee = usePermission('payroll', 'view');
  const gap = useApi(
    () => (canSee ? api.get<{ missing: { id: string; code: string; name: string }[] }>('/api/payroll/consents') : Promise.resolve({ missing: [] })),
    [canSee],
  );
  const missing = gap.data?.missing ?? [];
  if (!canSee || !missing.length) return null;
  return (
    <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div className="text-xs leading-relaxed text-muted-foreground">
        <p className="text-sm font-medium text-foreground">{missing.length} employee{missing.length === 1 ? ' has' : 's have'} no consent recorded for salary processing</p>
        {missing.slice(0, 8).map((m) => `${m.code} ${m.name}`).join(' · ')}{missing.length > 8 ? ` and ${missing.length - 8} more` : ''}.
        Record it under Payroll → Employees, on each person&apos;s Privacy tab.
      </div>
    </Card>
  );
}

export function PrivacyPanel({ canEdit }: { canEdit: boolean }) {
  const state = useApi(() => api.get<Privacy>('/api/privacy'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [req, setReq] = useState({ subjectType: 'contact' as Request['subjectType'], party: 'customer' as 'customer' | 'vendor', contactId: '', subjectName: '', kind: 'access' as Kind, details: '', receivedOn: today() });
  const [breach, setBreach] = useState({ discoveredAt: new Date().toISOString().slice(0, 16), description: '', dataAffected: '', peopleAffected: '' });
  const [closing, setClosing] = useState<{ id: string; status: 'done' | 'refused'; response: string } | null>(null);

  const post = async <T,>(key: string, payload: Record<string, unknown>, done?: string): Promise<T | null> => {
    setBusy(key);
    try {
      const r = await api.post<T>('/api/privacy', payload);
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
    <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
      {(d) => (
        <div className="space-y-4">
          <Card className={cn('flex items-start gap-3 p-4', d.encryptionAtRest ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5')}>
            {d.encryptionAtRest ? <Lock className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <LockOpen className="mt-0.5 size-4 shrink-0 text-amber-600" />}
            <div className="text-xs leading-relaxed text-muted-foreground">
              <p className="text-sm font-medium text-foreground">Encryption at rest is {d.encryptionAtRest ? 'on' : 'off'}</p>
              {d.encryptionAtRest
                ? 'Bank account numbers of parties and employees, employee PAN and Aadhaar numbers, and two-step sign-in secrets, are stored sealed with AES-256-GCM.'
                : <>Set FIELD_ENCRYPTION_KEY on the server (32 random bytes, as hex) and run <span className="font-mono">npm run fields:seal</span> to seal bank account numbers, employee PAN and Aadhaar numbers, and two-step secrets already stored. Keep the key safe: without it sealed values cannot be read.</>}
            </div>
          </Card>

          <EmployeeConsentGap />

          <Card className="space-y-3 p-5">
            <div>
              <h3 className="text-sm font-semibold">Who answers for personal data</h3>
              <p className="mt-1 text-xs text-muted-foreground">The contact the DPDP Act asks a business to publish for questions and grievances about personal data, and how long its records are kept.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-5">
              {(['name', 'email', 'phone'] as const).map((k) => (
                <Field key={k} label={k === 'name' ? 'Grievance officer' : k === 'email' ? 'Email' : 'Phone'}>
                  <Input defaultValue={d.settings.grievanceOfficer[k]} disabled={!canEdit}
                    onBlur={(e) => e.target.value !== d.settings.grievanceOfficer[k] &&
                      void post('gro', { action: 'settings', grievanceOfficer: { ...d.settings.grievanceOfficer, [k]: e.target.value } }, 'Saved')} />
                </Field>
              ))}
              <Field label="Keep records (years)" hint="After the year of the last document">
                <Input type="number" min={6} max={20} defaultValue={d.settings.retentionYears} disabled={!canEdit}
                  onBlur={(e) => Number(e.target.value) !== d.settings.retentionYears && void post('ret', { action: 'settings', retentionYears: Number(e.target.value) }, 'Saved')} />
              </Field>
              <Field label="Answer within (days)" hint="At most 90 for a grievance">
                <Input type="number" min={1} max={90} defaultValue={d.settings.responseDays} disabled={!canEdit}
                  onBlur={(e) => Number(e.target.value) !== d.settings.responseDays && void post('days', { action: 'settings', responseDays: Number(e.target.value) }, 'Saved')} />
              </Field>
            </div>
          </Card>

          <Card className="space-y-3 p-5">
            <div>
              <h3 className="text-sm font-semibold">Requests about personal data</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                To see their data, correct it, erase it, withdraw consent, or complain. Erasing keeps what the tax laws require:
                a party with documents inside the retention period has only email, phone, bank details and notes cleared.
              </p>
            </div>
            {canEdit && (
              <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-6 sm:items-end">
                <Field label="Who">
                  <div>
                    <select value={req.subjectType === 'contact' ? req.party : req.subjectType}
                      onChange={(e) => { const v = e.target.value; setReq({ ...req, ...(v === 'customer' || v === 'vendor' ? { subjectType: 'contact', party: v } : { subjectType: v as Request['subjectType'] }), contactId: '' }); }}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                      <option value="customer">A customer</option><option value="vendor">A supplier</option>
                      <option value="employee">An employee</option><option value="user">A user</option><option value="other">Someone else</option>
                    </select>
                  </div>
                </Field>
                <div className="sm:col-span-2">
                  {req.subjectType === 'contact' ? (
                    <Field label="Party"><ContactPicker kind={req.party} value={req.contactId} onChange={(id) => setReq({ ...req, contactId: id })} canCreate={false} /></Field>
                  ) : (
                    <Field label="Name"><Input value={req.subjectName} onChange={(e) => setReq({ ...req, subjectName: e.target.value })} /></Field>
                  )}
                </div>
                <Field label="Asks to">
                  <div>
                    <select value={req.kind} onChange={(e) => setReq({ ...req, kind: e.target.value as Kind })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                      {(Object.keys(KIND) as Kind[]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}
                    </select>
                  </div>
                </Field>
                <Field label="Received"><Input type="date" value={req.receivedOn} onChange={(e) => setReq({ ...req, receivedOn: e.target.value })} /></Field>
                <Button size="sm" className="gap-1.5" disabled={busy === 'req' || (req.subjectType === 'contact' ? !req.contactId : !req.subjectName.trim())}
                  onClick={() => void post('req', {
                    action: 'log-request', subjectType: req.subjectType, subjectId: req.contactId || null, kind: req.kind, receivedOn: req.receivedOn,
                    subjectName: req.subjectType === 'contact' ? `${req.party === 'customer' ? 'Customer' : 'Supplier'} #${req.contactId}` : req.subjectName,
                  }, 'Request logged').then((r) => r && setReq({ ...req, contactId: '', subjectName: '' }))}>
                  <Plus className="size-3.5" /> Log
                </Button>
              </div>
            )}
            {d.requests.length === 0 ? (
              <p className="py-3 text-center text-sm text-muted-foreground">No requests yet.</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {d.requests.map((r) => (
                  <li key={r.id} className="space-y-1.5 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{KIND[r.kind]}</Badge>
                      <span className="font-medium">{r.subjectName}</span>
                      <span className="text-xs text-muted-foreground">received {dmy(r.receivedOn)}</span>
                      {r.status === 'open'
                        ? <Badge variant="outline" className={cn('text-[10px]', r.overdue && 'border-destructive/40 text-destructive')}>{r.overdue ? 'Overdue' : 'Due'} {dmy(r.dueOn)}</Badge>
                        : <Badge variant="secondary" className="text-[10px] capitalize">{r.status}{r.handledBy ? ` by ${r.handledBy}` : ''}</Badge>}
                      {canEdit && r.subjectType === 'contact' && r.subjectId && (
                        <span className="ml-auto flex gap-1">
                          <Button size="xs" variant="outline" className="gap-1" disabled={busy === r.id}
                            onClick={() => void post<unknown>(r.id, { action: 'contact-data', contactId: r.subjectId }).then((data) => data && downloadJson(`personal-data-${r.subjectId}.json`, data))}>
                            <Download className="size-3" /> Their data
                          </Button>
                          {r.kind === 'erasure' && r.status === 'open' && (
                            <Button size="xs" variant="outline" className="gap-1" disabled={busy === r.id}
                              onClick={() => window.confirm('Erase this party\'s personal details as far as the tax laws allow? This cannot be undone.') &&
                                void post<{ full: boolean; keptUntil: string | null }>(r.id, { action: 'erase-contact', contactId: r.subjectId }).then((x) => x && toast.success(
                                  x.full ? 'Erased' : 'Contact details erased',
                                  { description: x.full ? 'Documents stay under an anonymous name.' : `Name and address stay with the documents until ${dmy(x.keptUntil!)}.` },
                                ))}>
                              <Eraser className="size-3" /> Erase
                            </Button>
                          )}
                        </span>
                      )}
                      {canEdit && r.status === 'open' && (
                        <Button size="xs" variant="ghost" className={r.subjectType === 'contact' ? '' : 'ml-auto'} onClick={() => setClosing({ id: r.id, status: 'done', response: '' })}>Close</Button>
                      )}
                    </div>
                    {r.response && <p className="text-xs text-muted-foreground">{r.response}</p>}
                    {closing?.id === r.id && (
                      <div className="flex flex-wrap items-end gap-2">
                        <select value={closing.status} onChange={(e) => setClosing({ ...closing, status: e.target.value as 'done' | 'refused' })} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                          <option value="done">Done</option><option value="refused">Refused</option>
                        </select>
                        <Input value={closing.response} onChange={(e) => setClosing({ ...closing, response: e.target.value })} placeholder="What was done, or why not" className="h-8 min-w-64 flex-1 text-xs" />
                        <Button size="xs" disabled={!closing.response.trim() || busy === r.id}
                          onClick={() => void post(r.id, { action: 'close-request', ...closing }, 'Request closed').then((x) => x && setClosing(null))}>Save</Button>
                        <Button size="xs" variant="ghost" onClick={() => setClosing(null)}>Cancel</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="space-y-3 p-5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div>
                <h3 className="text-sm font-semibold">Personal data breaches</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  A breach is to be told to the Data Protection Board and to each person affected, with a detailed report to the Board within 72 hours of it becoming known (DPDP Rules, 2025).
                </p>
              </div>
            </div>
            {canEdit && (
              <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-[180px_1fr_1fr_100px_auto] sm:items-end">
                <Field label="Found"><Input type="datetime-local" value={breach.discoveredAt} onChange={(e) => setBreach({ ...breach, discoveredAt: e.target.value })} /></Field>
                <Field label="What happened"><Input value={breach.description} onChange={(e) => setBreach({ ...breach, description: e.target.value })} /></Field>
                <Field label="Data affected"><Input value={breach.dataAffected} onChange={(e) => setBreach({ ...breach, dataAffected: e.target.value })} placeholder="e.g. customer phone numbers" /></Field>
                <Field label="People"><Input type="number" min={0} value={breach.peopleAffected} onChange={(e) => setBreach({ ...breach, peopleAffected: e.target.value })} /></Field>
                <Button size="sm" disabled={busy === 'breach' || !breach.description.trim()}
                  onClick={() => void post('breach', {
                    action: 'log-breach', discoveredAt: new Date(breach.discoveredAt).toISOString(), description: breach.description,
                    dataAffected: breach.dataAffected || null, peopleAffected: breach.peopleAffected ? Number(breach.peopleAffected) : null,
                  }, 'Breach logged').then((x) => x && setBreach({ ...breach, description: '', dataAffected: '', peopleAffected: '' }))}>
                  Log
                </Button>
              </div>
            )}
            {d.breaches.length === 0 ? (
              <p className="py-3 text-center text-sm text-muted-foreground">None recorded.</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {d.breaches.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="text-xs text-muted-foreground">{new Date(b.discoveredAt).toLocaleString('en-IN')}</span>
                    <span className="font-medium">{b.description}</span>
                    {b.peopleAffected !== null && <span className="text-xs text-muted-foreground">{b.peopleAffected} people</span>}
                    <span className="ml-auto flex flex-wrap gap-1">
                      {([['board_informed', 'Board told', b.boardInformedAt], ['board_report', 'Report sent', b.boardReportAt], ['people_informed', 'People told', b.peopleInformedAt]] as const).map(([step, label, at]) => (
                        at ? <Badge key={step} variant="outline" className="border-emerald-500/40 text-[10px]">{label} {new Date(at).toLocaleDateString('en-IN')}</Badge>
                          : canEdit && <Button key={step} size="xs" variant="outline" disabled={busy === b.id} onClick={() => void post(b.id, { action: 'mark-breach', id: b.id, step }, `${label}`)}>{label}?</Button>
                      ))}
                      {!b.boardReportAt && <Badge variant="outline" className={cn('text-[10px]', new Date(b.reportDueBy) < new Date() && 'border-destructive/40 text-destructive')}>Report due {new Date(b.reportDueBy).toLocaleString('en-IN')}</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </AsyncPage>
  );
}
