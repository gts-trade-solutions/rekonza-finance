'use client';

// Zoho Books' New / Edit Retainer Invoice (the client calls them Service Invoices, their item 24), recorded from Zoho's demo on
// 2026-11-23: Customer Name, Retainer Invoice Number, Reference#, Retainer
// Invoice Date, Project Name, the DESCRIPTION | AMOUNT table, Sub Total and
// Total, Customer Notes, Terms & Conditions, and Save as Draft · Save and Send
// · Cancel (Edit: Save · Save and Send · Cancel). Zoho's empty save says "The
// Description field cannot be empty.". ?clone=<id> starts from a copy.

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import { DocumentForm, FormErrors, FormRow, FormRowPair } from '@/components/shared/form-layout';
import { MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { useAppStore } from '@/lib/store';
import { localDay } from '@/lib/selectors';
import { useApi } from '@/lib/api/use-api';
import { ApiError, projects as projectsApi, retainers, type RetainerDetail } from '@/lib/api/client';
import { refreshSplitList } from '@/components/shared/record-split';

interface Row { key: string; description: string; amountPaise: number }
let next = 0;
const row = (description = '', amountPaise = 0): Row => ({ key: `r${next++}`, description, amountPaise });

export function RetainerForm({ editing }: { editing?: RetainerDetail }) {
  const router = useRouter();
  const branchId = useAppStore((s) => s.activeBranchId || s.branches[0]?.id || '');
  const cloneId = useSearchParams().get('clone');
  const [customerId, setCustomerId] = useState(editing?.customerId ?? '');
  const [reference, setReference] = useState(editing?.reference ?? '');
  const [date, setDate] = useState(editing?.date ?? localDay(new Date()));
  const [projectId, setProjectId] = useState(editing?.projectId ?? '');
  const [rows, setRows] = useState<Row[]>(editing ? editing.lines.map((l) => row(l.description, l.amountPaise)) : [row()]);
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [terms, setTerms] = useState(editing?.terms ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState<false | 'draft' | 'send'>(false);

  // Clone: the copy's customer, lines, notes and terms, dated today and numbered afresh.
  const cloned = useRef(false);
  useEffect(() => {
    if (!cloneId || editing || cloned.current) return;
    cloned.current = true;
    retainers.get(cloneId).then((r) => {
      setCustomerId(r.customerId); setProjectId(r.projectId ?? ''); setReference(r.reference ?? '');
      setRows(r.lines.map((l) => row(l.description, l.amountPaise))); setNotes(r.notes ?? ''); setTerms(r.terms ?? '');
    }).catch(() => toast.error('That retainer could not be copied'));
  }, [cloneId, editing]);

  const projectsState = useApi(() => (customerId ? projectsApi.list({ status: 'active', customerId }) : Promise.resolve({ projects: [] })), [customerId]);
  const projectOptions = useMemo(() => (projectsState.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name })), [projectsState.data]);
  const total = rows.reduce((t, r) => t + (r.amountPaise || 0), 0);
  const back = editing ? `/sales/retainers/${editing.id}` : '/sales/retainers';

  const save = async (mode: 'draft' | 'send') => {
    const problems: string[] = [];
    if (!customerId) problems.push('Select a customer.');
    const filled = rows.filter((r) => r.description.trim() || r.amountPaise);
    if (!filled.length || filled.some((r) => !r.description.trim())) problems.push('The Description field cannot be empty.');
    if (filled.some((r) => !(r.amountPaise > 0))) problems.push('Enter an amount for every line.');
    setErrors(problems);
    if (problems.length) return;
    setSaving(mode);
    const payload = {
      branchId: editing?.branchId ?? branchId, customerId, date, reference: reference || null, projectId: projectId || null,
      lines: filled.map((r) => ({ description: r.description.trim(), amountPaise: r.amountPaise })), notes: notes || null, terms: terms || null,
      status: mode === 'draft' ? ('draft' as const) : ('sent' as const),
    };
    try {
      const r = editing ? await retainers.update(editing.id, payload) : await retainers.create(payload);
      toast.success(editing ? `Service invoice ${r.number} saved` : `Service invoice ${r.number} ${mode === 'draft' ? 'saved as draft' : 'saved'}`, {
        description: 'Held as unearned revenue until the work is done and it is applied to an invoice.',
      });
      refreshSplitList();
      router.push(`/sales/retainers/${r.id}`);
    } catch (e) {
      setErrors([e instanceof ApiError ? e.message : String(e)]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DocumentForm
      title={editing ? `Edit Service Invoice ${editing.number}` : 'New Service Invoice'}
      icon={<FileText className="size-5 text-muted-foreground" />}
      backHref={back}
      footer={
        <>
          {!editing && (
            <Button variant="outline" onClick={() => void save('draft')} disabled={!!saving} data-slot="retainer-save-draft">
              {saving === 'draft' && <Loader2 className="size-4 animate-spin" />} Save as Draft
            </Button>
          )}
          {editing && (
            <Button variant="outline" onClick={() => void save(editing.status === 'draft' ? 'draft' : 'send')} disabled={!!saving} data-slot="retainer-save">
              {saving && <Loader2 className="size-4 animate-spin" />} Save
            </Button>
          )}
          <Button onClick={() => void save('send')} disabled={!!saving} data-slot="retainer-save-send">
            {saving === 'send' && <Loader2 className="size-4 animate-spin" />} Save and Send
          </Button>
          <Button variant="ghost" onClick={() => router.push(back)} disabled={!!saving}>Cancel</Button>
        </>
      }
      footerSummary={<p className="text-sm"><span className="text-muted-foreground">Total Amount: </span><span className="font-semibold tabular"><Money value={total} /></span></p>}
    >
      <FormErrors errors={errors} onClose={() => setErrors([])} />
      <div className="space-y-4" data-slot="retainer-form">
        <FormRow label="Customer Name" required width="lg">
          <ContactPicker kind="customer" value={customerId} onChange={(v) => { setCustomerId(v); setProjectId(''); }} />
        </FormRow>
        <FormRowPair>
          <FormRow label="Service Invoice Number" required>
            <Input value={editing?.number ?? ''} readOnly placeholder="Given the next number in the series when saved" />
          </FormRow>
          <FormRow label="Reference#">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </FormRow>
        </FormRowPair>
        <FormRowPair>
          <FormRow label="Service Invoice Date" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </FormRow>
          <FormRow label="Project Name">
            <Combobox options={projectOptions} value={projectId} onChange={setProjectId} placeholder={customerId ? 'Select a project' : 'Select a customer first'} showAvatar={false} clearable />
          </FormRow>
        </FormRowPair>
      </div>

      <section className="space-y-2" data-slot="retainer-lines">
        <div className="overflow-x-auto rounded-[var(--radius-card)] border">
          <table className="w-full text-[13px]">
            <thead className="bg-[#f9f9fb] text-[11px] font-semibold uppercase text-[#6c718a]">
              <tr><th className="px-4 py-2.5 text-left">Description</th><th className="w-56 px-4 py-2.5 text-right">Amount</th><th className="w-10" /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t">
                  <td className="px-3 py-2"><Textarea rows={1} placeholder="Description" value={r.description} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, description: e.target.value } : x)))} /></td>
                  <td className="px-3 py-2"><MoneyInput valuePaise={r.amountPaise} onChangePaise={(p) => setRows(rows.map((x) => (x.key === r.key ? { ...x, amountPaise: p } : x)))} /></td>
                  <td className="px-2 py-2 text-center">
                    {rows.length > 1 && <button type="button" aria-label="Delete item" className="text-muted-foreground hover:text-destructive" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}><Trash2 className="size-4" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRows([...rows, row()])} data-slot="retainer-add-row"><Plus className="size-4" /> Add New Row</Button>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <FormRow label="Customer Notes" width="full">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Enter any notes to be displayed in your transaction" />
        </FormRow>
        <div className="space-y-2 rounded-[var(--radius-card)] bg-muted/30 p-4 text-[13px]" data-slot="retainer-totals">
          <div className="flex justify-between"><span>Sub Total</span><Money value={total} /></div>
          <div className="flex justify-between border-t pt-2 font-semibold"><span>Total ( ₹ )</span><Money value={total} /></div>
        </div>
      </div>
      <FormRow label="Terms & Conditions" width="full">
        <Textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Enter the terms and conditions of your business to be displayed in your transaction" className="max-w-[720px]" />
      </FormRow>
    </DocumentForm>
  );
}
