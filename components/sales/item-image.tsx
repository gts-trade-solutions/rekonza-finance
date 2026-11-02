'use client';

// An item's picture, as Zoho Books shows one: a thumbnail on the item list,
// and in the item's form a place to add, change or take it off. The file is
// an attachment on the item (migration 099).

import { useRef, useState } from 'react';
import { ImageIcon, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';

export function ItemThumb({ fileId, name, size = 32 }: { fileId?: string | null; name: string; size?: number }) {
  if (!fileId) {
    return <span className="inline-flex shrink-0 items-center justify-center rounded border bg-muted/40 text-muted-foreground" style={{ width: size, height: size }}><ImageIcon className="size-3.5" /></span>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/api/files/${fileId}`} alt={name} loading="lazy" className="shrink-0 rounded border object-cover" style={{ width: size, height: size }} />;
}

export function ItemImageField({ itemId, fileId, name, canEdit, onChanged }: { itemId: string | null; fileId?: string | null; name: string; canEdit: boolean; onChanged: (fileId: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    if (!itemId) return;
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    form.append('targetType', 'item');
    form.append('targetId', itemId);
    form.append('role', 'image');
    try {
      const res = await fetch('/api/files', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Not uploaded');
      onChanged((data as { attachment: { id: string } }).attachment.id);
      toast.success('Picture added');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!fileId) return;
    setBusy(true);
    try {
      await api.delete(`/api/files/${fileId}`);
      onChanged(null);
      toast.success('Picture taken off');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!itemId) return <p className="text-xs text-muted-foreground">Save the item first, then add its picture.</p>;
  return (
    <div className="flex items-center gap-3" data-slot="item-image">
      <ItemThumb fileId={fileId} name={name} size={64} />
      {canEdit && (
        <div className="flex flex-col gap-1">
          <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          <Button size="xs" variant="outline" disabled={busy} onClick={() => ref.current?.click()} className="gap-1"><Upload className="size-3" /> {fileId ? 'Change picture' : 'Add a picture'}</Button>
          {fileId && <Button size="xs" variant="ghost" disabled={busy} onClick={remove} className="gap-1 text-muted-foreground"><X className="size-3" /> Take it off</Button>}
          <span className="text-[11px] text-muted-foreground">PNG, JPEG or WebP, up to 10 MB.</span>
        </div>
      )}
    </div>
  );
}
