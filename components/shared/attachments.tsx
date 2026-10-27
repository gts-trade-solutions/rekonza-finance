'use client';

// The files attached to one record: the supplier's bill scan, a signed challan,
// a contract. Anyone who can see the record can open them; anyone who can edit
// it can add or take one off. Taking one off keeps the file, as evidence, and
// the audit trail records who did it.

import { useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { files, type AttachableType, type Attachment } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.docx,.csv,.txt';
const MAX_MB = 10;

const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Files picked on a form for a record that does not exist yet. They are held
 * in the browser and sent once the record is saved, by `uploadPending`.
 */
export function PendingAttachments({
  value, onChange, label,
}: {
  value: File[];
  onChange: (files: File[]) => void;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const add = (picked: FileList | null) => {
    const ok = Array.from(picked ?? []).filter((f) => {
      if (f.size <= MAX_MB * 1024 * 1024) return true;
      toast.error(`${f.name} is larger than ${MAX_MB} MB`);
      return false;
    });
    onChange([...value, ...ok]);
    if (input.current) input.current.value = '';
  };
  return (
    <div className="space-y-1.5">
      <input ref={input} type="file" accept={ACCEPT} multiple className="hidden" onChange={(e) => add(e.target.files)} />
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
      >
        <Paperclip className="size-3.5" /> {label}
      </button>
      {value.map((f, i) => (
        <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <span className="text-muted-foreground">{size(f.size)}</span>
          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5 text-muted-foreground hover:text-foreground" />
          </button>
        </div>
      ))}
      {value.length > 0 && <p className="text-[11px] text-muted-foreground">Attached when you save.</p>}
    </div>
  );
}

/** Send the files picked before the record existed. Says which ones failed. */
export async function uploadPending(targetType: AttachableType, targetId: string, picked: File[]) {
  const failed: string[] = [];
  for (const f of picked) {
    try {
      await files.upload(targetType, targetId, f);
    } catch (e) {
      failed.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed.length) {
    toast.error(`${failed.length} file(s) were not attached`, {
      description: `${failed.join(' · ')} Attach them again from the saved record.`,
    });
  }
}

export function Attachments({
  targetType, targetId, canEdit, title = 'Attachments',
}: {
  targetType: AttachableType;
  targetId: string;
  canEdit: boolean;
  title?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const state = useApi(() => files.list(targetType, targetId), [targetType, targetId]);
  const list: Attachment[] = state.data?.attachments ?? [];

  const upload = async (picked: FileList | null) => {
    if (!picked?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(picked)) {
        if (f.size > MAX_MB * 1024 * 1024) {
          toast.error(`${f.name} is larger than ${MAX_MB} MB`);
          continue;
        }
        await files.upload(targetType, targetId, f);
        toast.success(`Attached ${f.name}`);
      }
      await state.refetch();
    } catch (e) {
      toast.error('Could not attach the file', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async (a: Attachment) => {
    if (!window.confirm(`Take ${a.filename} off this record? The file is kept in the audit trail.`)) return;
    try {
      await files.remove(a.id);
      await state.refetch();
    } catch (e) {
      toast.error('Could not remove it', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Paperclip className="size-4 text-muted-foreground" /> {title}
          {list.length > 0 && <span className="text-xs font-normal text-muted-foreground">({list.length})</span>}
        </p>
        {canEdit && (
          <>
            <input
              ref={input} type="file" accept={ACCEPT} multiple className="hidden"
              onChange={(e) => void upload(e.target.files)} data-slot="attachment-input"
            />
            <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Attach file
            </Button>
          </>
        )}
      </div>

      {state.error ? (
        <p className="mt-3 text-sm text-destructive">{state.error}</p>
      ) : list.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {state.loading ? 'Loading…' : canEdit
            ? `Nothing attached. PDF, images, Excel, Word or CSV, up to ${MAX_MB} MB each.`
            : 'Nothing attached.'}
        </p>
      ) : (
        <ul className="mt-3 divide-y rounded-md border">
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2">
              {a.contentType.startsWith('image/')
                ? <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                : <FileText className="size-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <a href={files.url(a.id)} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">
                  {a.filename}
                </a>
                <p className="text-xs text-muted-foreground">
                  {size(a.sizeBytes)} · {a.uploadedBy ?? 'Unknown'} ·{' '}
                  {new Date(a.uploadedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
              </div>
              {canEdit && (
                <Button size="icon" variant="ghost" className="size-7" aria-label={`Remove ${a.filename}`} onClick={() => void remove(a)}>
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
