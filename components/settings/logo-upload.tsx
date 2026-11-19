'use client';

// The organisation's logo, as Zoho Books asks for it at the top of the
// Organization Profile: a dashed box to upload into, the logo once there, and
// what it is used for. One file: a new one replaces the old (POST /api/files
// with targetType 'organization').

import { useRef, useState } from 'react';
import { ImageUp, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { files } from '@/lib/api/client';

export function LogoUpload({ orgId, logoFileId, canEdit, onChanged }: {
  orgId: string; logoFileId: string | null; canEdit: boolean; onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (picked: FileList | null) => {
    const file = picked?.[0];
    if (!file) return;
    if (!/\.(png|jpe?g|webp)$/i.test(file.name)) {
      toast.error('Choose a PNG, JPG or WebP image.');
      return;
    }
    setBusy(true);
    try {
      await files.upload('organization', orgId, file);
      toast.success('Logo updated. It prints on every document from now on.');
      onChanged();
    } catch (e) {
      toast.error('Could not use that file', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const remove = async () => {
    if (!logoFileId) return;
    setBusy(true);
    try {
      await files.remove(logoFileId);
      toast.success('Logo removed');
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-start gap-5" data-slot="logo-upload">
      <input ref={input} type="file" accept=".png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => void upload(e.target.files)} />
      <button
        type="button"
        disabled={!canEdit || busy}
        onClick={() => input.current?.click()}
        className="group relative flex h-[120px] w-[240px] shrink-0 items-center justify-center rounded-[4px] border border-dashed border-[#c9c9c9] bg-white p-2 text-center transition-colors hover:border-primary disabled:cursor-default"
        aria-label={logoFileId ? 'Replace the logo' : 'Upload your organization logo'}
      >
        {logoFileId ? (
          // eslint-disable-next-line @next/next/no-img-element -- an uploaded file served by the API
          <img src={files.url(logoFileId)} alt="Organization logo" className="max-h-full max-w-full object-contain" data-slot="logo-preview" />
        ) : (
          <span className="flex flex-col items-center gap-1.5 text-[13px] text-muted-foreground">
            {busy ? <Loader2 className="size-5 animate-spin" /> : <ImageUp className="size-5" />}
            Upload Your Organization Logo
          </span>
        )}
      </button>
      <div className="max-w-md space-y-2 text-[13px] leading-relaxed text-muted-foreground">
        <p>This logo will be displayed in transaction PDFs and email notifications.</p>
        <p>Preferred Image Dimensions: 240 × 240 pixels @ 72 DPI</p>
        <p>Supported Files: jpg, jpeg, png, webp<br />Maximum File Size: 10MB</p>
        {canEdit && logoFileId && (
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ImageUp className="size-3.5" />} Change
            </Button>
            <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" disabled={busy} onClick={() => void remove()}>
              <Trash2 className="size-3.5" /> Remove
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
