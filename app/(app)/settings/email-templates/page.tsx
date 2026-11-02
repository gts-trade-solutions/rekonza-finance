'use client';

// Email templates — the wording of each email the books send, with its
// placeholders, a preview filled with sample figures, and a way back to the
// built-in wording (lib/server/mail/templates.ts).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Mail, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface Template {
  kind: string; label: string; when: string; subject: string; body: string; custom: boolean; updatedAt: string | null;
  placeholders: Record<string, string>; required: string[]; defaultSubject: string; defaultBody: string;
}

/** Sample figures for the preview. */
const SAMPLE: Record<string, string> = {
  customer: 'Kumar Stores', party: 'Kumar Stores', contact: 'Kumar Stores', document: 'invoice', number: 'INV/26-27/0042', date: '02 Nov 2026',
  total: '₹11,800.00', balance: '₹11,800.00', due_date: '02 Dec 2026', balance_line: '₹11,800.00 is due by 02 Dec 2026.', due_words: 'falls due on 02 Dec 2026',
  link: 'https://your-books.example/s/abc123', business: 'Your business', from: '01 Apr 2026', to: '31 Oct 2026', opening: '₹0.00', charges: '₹1,18,000.00',
  payments: '₹1,06,200.00', closing: '₹11,800.00', charges_label: 'Invoiced', payments_label: 'Received', closing_label: 'Balance due',
  check_line: 'Please check it against your books and let us know within 15 days if your balance differs.',
  what: 'You can see your invoices with us, pay them, answer our quotes and read your statement here:', expires: '01 Feb 2027',
};
/** What changes in the sample from one document's email to the next. */
const BY_KIND: Record<string, Record<string, string>> = {
  quote: { document: 'quote', number: 'QT/26-27/0007', detail_line: 'It is valid until 17 Nov 2026.' },
  sales_order: { document: 'sales order', number: 'SO/26-27/0012', detail_line: 'We expect to ship it by 09 Nov 2026.' },
  challan: { document: 'delivery challan', number: 'DC/26-27/0003', detail_line: 'The goods travel with this challan.' },
  credit_note: { document: 'credit note', number: 'CN/26-27/0002', total: '₹1,180.00', detail_line: 'Against invoice INV/26-27/0042 dated 02 Nov 2026 · Damaged in transit.' },
  retainer: { document: 'retainer invoice', number: 'RET/26-27/0001', total: '₹25,000.00', detail_line: '₹25,000.00 is due.' },
  payment_receipt: { document: 'payment receipt', number: 'RCPT/26-27/0031', detail_line: 'It has been applied to INV/26-27/0042.' },
  purchase_order: { party: 'Steel Co', document: 'purchase order', number: 'PO/26-27/0009', detail_line: 'Please deliver by 14 Nov 2026.' },
  vendor_credit: { party: 'Steel Co', document: 'vendor credit', number: 'VC/26-27/0001', total: '₹1,000.00', detail_line: 'Against your bill SC-77 dated 08 Oct 2026.' },
  payment_advice: { party: 'Steel Co', document: 'payment advice', number: 'PAY/26-27/0014', detail_line: 'It settles SC-77. Paid by NEFT, reference UTR123.' },
};
const fill = (t: string, kind: string) => t.replace(/\{([A-Za-z_]+)\}/g, (w, k: string) => {
  const v = BY_KIND[kind]?.[k.toLowerCase()] ?? SAMPLE[k.toLowerCase()];
  if (v === undefined) return w;
  return /^[A-Z]/.test(k) ? v.charAt(0).toUpperCase() + v.slice(1) : v;
});

function Editor({ t, canEdit, onSaved }: { t: Template; canEdit: boolean; onSaved: (all: Template[]) => void }) {
  const [subject, setSubject] = useState(t.subject);
  const [body, setBody] = useState(t.body);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSubject(t.subject); setBody(t.body); }, [t.subject, t.body]);
  const dirty = subject !== t.subject || body !== t.body;
  const preview = useMemo(() => ({ subject: fill(subject, t.kind), body: fill(body, t.kind) }), [subject, body, t.kind]);

  const post = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const r = await api.post<{ templates: Template[] }>('/api/settings/email-templates', payload);
      toast.success(done);
      onSaved(r.templates);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const insert = (key: string) => setBody((b) => `${b}{${key}}`);

  return (
    <Card className="space-y-4 p-5" data-slot={`email-template-${t.kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 font-semibold"><Mail className="size-4 text-muted-foreground" /> {t.label}</h3>
          <p className="text-xs text-muted-foreground">{t.when}</p>
        </div>
        <Badge variant="outline" className="text-[10px]">{t.custom ? `Your wording${t.updatedAt ? ` · ${new Date(t.updatedAt).toLocaleDateString('en-IN')}` : ''}` : 'Built-in wording'}</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`s-${t.kind}`}>Subject</Label>
            <Input id={`s-${t.kind}`} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} disabled={!canEdit} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`b-${t.kind}`}>Email</Label>
            <Textarea id={`b-${t.kind}`} value={body} onChange={(e) => setBody(e.target.value)} rows={10} maxLength={5000} disabled={!canEdit} className="font-mono text-xs" />
          </div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(t.placeholders).map(([k, why]) => (
              <button key={k} type="button" title={why} disabled={!canEdit} onClick={() => insert(k)}
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted ${t.required.includes(k) ? 'border-primary/50' : ''}`}>
                {`{${k}}`}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">Click a placeholder to add it; point at one to see what it becomes.{t.required.length ? ` Keep ${t.required.map((r) => `{${r}}`).join(', ')}.` : ''} Capitalise the first letter ({'{Document}'}) for a capital in the email.</p>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || !dirty} onClick={() => post({ action: 'save', kind: t.kind, subject, body }, `${t.label} email saved`)}>{busy ? 'Saving…' : 'Save'}</Button>
              {dirty && <Button size="sm" variant="ghost" onClick={() => { setSubject(t.subject); setBody(t.body); }}>Undo changes</Button>}
              {t.custom && <Button size="sm" variant="ghost" className="gap-1" disabled={busy} onClick={() => post({ action: 'reset', kind: t.kind }, `${t.label} email back to the built-in wording`)}><RotateCcw className="size-3.5" /> Built-in wording</Button>}
            </div>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Preview, with sample figures</p>
          <div className="rounded-md border bg-muted/20 p-3 text-sm">
            <p className="border-b pb-2 font-medium">{preview.subject}</p>
            <p className="whitespace-pre-wrap pt-2">{preview.body}</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function EmailTemplatesPage() {
  const canEdit = usePermission('settings', 'edit');
  const state = useApi(() => api.get<{ templates: Template[] }>('/api/settings/email-templates'), []);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [picked, setPicked] = useState('invoice');
  useEffect(() => { if (state.data) setTemplates(state.data.templates); }, [state.data]);
  const shown = (templates ?? []).find((t) => t.kind === picked) ?? templates?.[0];

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 gap-1.5"><Link href="/settings"><ArrowLeft className="size-3.5" /> Settings</Link></Button>
      <PageHeader title="Email templates" description="How each email the books send is worded. The placeholders in braces are filled in as it goes." />
      <AsyncPage state={state}>
        {() => (
          // As Zoho lists them: pick an email on the left, edit it on the right.
          <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
            <nav className="flex flex-wrap gap-1 lg:flex-col" aria-label="Emails" data-slot="email-template-list">
              {(templates ?? []).map((t) => (
                <button key={t.kind} type="button" onClick={() => setPicked(t.kind)} aria-pressed={shown?.kind === t.kind}
                  className={`flex items-center justify-between gap-2 rounded-[3px] px-2.5 py-1.5 text-left text-sm transition-colors ${shown?.kind === t.kind ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}>
                  {t.label}
                  {t.custom && <span className="text-[10px] uppercase tracking-wide opacity-80">Edited</span>}
                </button>
              ))}
            </nav>
            {shown && <Editor key={shown.kind} t={shown} canEdit={canEdit} onSaved={setTemplates} />}
          </div>
        )}
      </AsyncPage>
    </>
  );
}
