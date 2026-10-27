'use client';

// Editing a GST registration.
//
// Until now a branch was read-only in the app, which was survivable while it
// only held a name and a state. It stopped being survivable once the portals
// came into scope: a registration needs a valid GSTIN, a city and a PIN code
// before a single invoice can be registered, and a GSTIN typed wrongly at
// sign-up had nowhere to be corrected.
//
// The state is deliberately not editable. Every number series and every posted
// document was written under it, and a registration cannot move between states
// — that is a new registration, not an edit.

import { useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApiAction } from '@/lib/api/use-api';
import { isValidGstin, stateName } from '@/lib/tax/gst';

export interface EditableBranch {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string;
  address: string | null;
  city: string | null;
  pincode: string | null;
}

export function BranchDialog({
  branch,
  onOpenChange,
  onSaved,
}: {
  branch: EditableBranch | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ name: '', gstin: '', address: '', city: '', pincode: '' });
  const save = useApiAction((input: unknown) =>
    api.put<{ id: string; gstinChanged: boolean; note: string | null }>('/api/settings', input),
  );

  useEffect(() => {
    if (!branch) return;
    setForm({
      name: branch.name,
      gstin: branch.gstin ?? '',
      address: branch.address ?? '',
      city: branch.city ?? '',
      pincode: branch.pincode ?? '',
    });
    save.reset();
    // Resetting when a different branch is opened, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch?.id]);

  // Checked as it is typed, because the alternative is finding out from the
  // portal. The mod-36 check digit catches the great majority of typos.
  const gstinEntered = form.gstin.length > 0;
  const gstinComplete = form.gstin.length === 15;
  const gstinValid = gstinComplete && isValidGstin(form.gstin);
  const gstinState = gstinComplete ? form.gstin.slice(0, 2) : null;
  const wrongState = gstinState !== null && branch !== null && gstinState !== branch.stateCode;

  const submit = async () => {
    if (!branch) return;
    const done = await save.run({
      branchId: branch.id,
      name: form.name,
      gstin: form.gstin || null,
      address: form.address || null,
      city: form.city || null,
      pincode: form.pincode || null,
    });
    if (!done) {
      toast.error(save.error ?? 'The registration was not saved');
      return;
    }
    toast.success(`${form.name} saved`, { description: done.note ?? undefined });
    onOpenChange(false);
    onSaved();
  };

  return (
    <Dialog open={!!branch} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{branch?.name}</DialogTitle>
          <DialogDescription>
            {branch ? stateName(branch.stateCode) : ''} — the state cannot change, because every document
            and number series here was raised under it. The city and PIN code are separate fields because
            the GST portals require them that way, on both parties, on every document.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Registration name" required error={save.fieldErrors.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>

          <Field
            label="GSTIN"
            error={save.fieldErrors.gstin}
            hint={
              !gstinEntered
                ? 'Without one, nothing can be registered with the portals'
                : wrongState
                  ? `This GSTIN is registered in ${stateName(gstinState!)}, not ${stateName(branch!.stateCode)}`
                  : gstinComplete
                    ? gstinValid
                      ? 'Checksum valid'
                      : 'The check digit does not match — something is mistyped'
                    : `${form.gstin.length} of 15 characters`
            }
          >
            <div className="relative">
              <Input
                value={form.gstin}
                onChange={(e) =>
                  setForm({ ...form, gstin: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15) })
                }
                placeholder="00AAAAA0000A0Z0"
                className="pr-8 font-mono"
                maxLength={15}
              />
              {gstinComplete && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
                  {gstinValid && !wrongState ? (
                    <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <X className="size-4 text-destructive" />
                  )}
                </span>
              )}
            </div>
          </Field>

          <Field label="Address" error={save.fieldErrors.address}>
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="Street and locality"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="City" required error={save.fieldErrors.city}>
              <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </Field>
            <Field label="PIN code" required error={save.fieldErrors.pincode}>
              <Input
                value={form.pincode}
                onChange={(e) =>
                  setForm({ ...form, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })
                }
                placeholder="600001"
                className="font-mono"
                maxLength={6}
              />
            </Field>
          </div>

          {branch?.gstin && form.gstin && form.gstin !== branch.gstin && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-muted-foreground">
              Changing the GSTIN invalidates any portal credentials stored for this registration — they were
              issued against the old one. You will have to enter them again under Integrations.
            </p>
          )}

          {save.error && <p className="text-sm text-destructive">{save.error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={save.busy || !form.name || (gstinComplete && (!gstinValid || wrongState))}
          >
            {save.busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            {save.busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
