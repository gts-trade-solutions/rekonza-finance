'use client';

// What can happen to an e-way bill on the road: the goods move to another
// lorry, the journey outlasts the validity, or the bill turns out to be wrong.
// Each has a legal limit, and each dialog says it before the button.

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { gst, type EwayBillRow } from '@/lib/api/client';
import { useApiAction } from '@/lib/api/use-api';
import { timeLeft } from '@/lib/tax/einvoice';
import {
  EWB_CANCEL_REASONS, EWB_EXTEND_REASONS, VEHICLE_CHANGE_REASONS,
  type EwbCancelReason, type EwbExtendReason, type VehicleChangeReason,
} from '@/lib/tax/eway';
import { cn } from '@/lib/utils';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Sep, 23:59" in Indian time, which is the clock an e-way bill's validity runs on. */
export function ewbTime(iso: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day} ${MONTHS[Number(p.month) - 1]}, ${p.hour}:${p.minute}`;
}

interface DialogProps {
  /** The bill being acted on; null keeps the dialog closed. */
  bill: EwayBillRow | null;
  onClose: () => void;
  onDone: () => void;
}

function Choice<T extends string>({
  name,
  value,
  onChange,
  options,
  columns = 2,
}: {
  name: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  columns?: 2 | 3;
}) {
  return (
    <div className={cn('grid grid-cols-2 gap-2', columns === 3 && 'sm:grid-cols-3')}>
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded-[3px] border px-3 py-2 text-sm transition-colors',
            value === o.value ? 'border-primary bg-primary/5' : 'hover:bg-accent/40',
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="accent-primary"
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

const standIn = 'Nothing was filed: this bill came from the stand-in.';

// ── A new vehicle ────────────────────────────────────────────────────────────

export function ChangeVehicleDialog({ bill, onClose, onDone }: DialogProps) {
  const [vehicleNo, setVehicleNo] = useState('');
  const [place, setPlace] = useState('');
  const [reason, setReason] = useState<VehicleChangeReason>('1');
  const [remark, setRemark] = useState('');
  const change = useApiAction(gst.changeEwayVehicle);

  const submit = async () => {
    if (!bill?.id) return;
    const done = await change.run({ ewayBillId: bill.id, vehicleNo, fromPlace: place, reason, remark });
    if (!done) return; // the reason is shown in the dialog
    toast.success(`Vehicle on ${done.ewayBillNo} changed to ${done.vehicleNo}`, {
      description: done.live ? undefined : standIn,
    });
    onClose();
    onDone();
  };

  return (
    <Dialog open={bill !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-slot="ewb-vehicle-dialog">
        <DialogHeader>
          <DialogTitle>Change the vehicle on {bill?.ewayBillNo}</DialogTitle>
          <DialogDescription>
            Goods can move to another vehicle as often as they need to while the bill is valid, and each change is
            recorded with where it happened. The expiry does not move
            {bill?.validUntil ? `: it stays ${ewbTime(bill.validUntil)}` : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New vehicle number" required>
            <Input
              value={vehicleNo}
              onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
              placeholder="AA00AA0000"
              className="font-mono"
              data-slot="ewb-new-vehicle"
            />
          </Field>
          <Field label="Where the goods are now" required hint="The town or city">
            <Input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Town or city" data-slot="ewb-from-place" />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Why</legend>
          <Choice
            name="vehicle-reason"
            value={reason}
            onChange={setReason}
            columns={3}
            options={(['1', '2', '3'] as const).map((c) => ({ value: c, label: VEHICLE_CHANGE_REASONS[c] }))}
          />
        </fieldset>
        <Field label="Remark" hint="Optional, up to 100 characters">
          <Input value={remark} maxLength={100} onChange={(e) => setRemark(e.target.value)} placeholder="Optional" />
        </Field>
        {change.error && <p className="text-sm text-destructive">{change.error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={() => void submit()} disabled={change.busy} className="gap-1.5" data-slot="ewb-vehicle-save">
            {change.busy && <Loader2 className="size-3.5 animate-spin" />} Change vehicle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── More time ────────────────────────────────────────────────────────────────

export function ExtendEwayBillDialog({ bill, onClose, onDone }: DialogProps) {
  const [consignment, setConsignment] = useState<'in_movement' | 'in_transit'>('in_movement');
  const [vehicleNo, setVehicleNo] = useState(bill?.vehicleNo ?? '');
  const [place, setPlace] = useState('');
  const [pincode, setPincode] = useState('');
  const [distance, setDistance] = useState(100);
  const [reason, setReason] = useState<EwbExtendReason>('4');
  const [remark, setRemark] = useState('');
  const extend = useApiAction(gst.extendEwayBill);
  const days = Math.max(1, Math.ceil(distance / 200));

  const submit = async () => {
    if (!bill?.id) return;
    const done = await extend.run({
      ewayBillId: bill.id,
      remainingDistanceKm: distance,
      fromPlace: place,
      fromPincode: pincode,
      reason,
      remark,
      consignment,
      vehicleNo: consignment === 'in_movement' ? vehicleNo : null,
    });
    if (!done) return;
    toast.success(`E-way bill ${done.ewayBillNo} extended`, {
      description:
        `Now valid until ${ewbTime(done.validUntil)}; extension ${done.extendedCount}.` +
        (done.live ? '' : ` ${standIn}`),
    });
    onClose();
    onDone();
  };

  return (
    <Dialog open={bill !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-slot="ewb-extend-dialog">
        <DialogHeader>
          <DialogTitle>Extend e-way bill {bill?.ewayBillNo}</DialogTitle>
          <DialogDescription>
            An extension is possible only in the 8 hours either side of expiry
            {bill?.validUntil ? ` (${ewbTime(bill.validUntil)})` : ''}. The new validity is counted from now on the
            distance still to go: one day per 200 km, to midnight of the last day.
          </DialogDescription>
        </DialogHeader>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Where the goods are</legend>
          <Choice
            name="consignment"
            value={consignment}
            onChange={setConsignment}
            options={[
              { value: 'in_movement', label: 'On a vehicle' },
              { value: 'in_transit', label: 'Waiting at a place' },
            ]}
          />
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          {consignment === 'in_movement' && (
            <Field label="Vehicle number" required>
              <Input
                value={vehicleNo}
                onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
                placeholder="AA00AA0000"
                className="font-mono"
              />
            </Field>
          )}
          <Field label="Current town or city" required>
            <Input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Town or city" data-slot="ewb-extend-place" />
          </Field>
          <Field label="PIN code" required>
            <Input
              value={pincode}
              inputMode="numeric"
              maxLength={6}
              onChange={(e) => setPincode(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="000000"
              data-slot="ewb-extend-pincode"
            />
          </Field>
          <Field label="Distance still to go (km)" required>
            <Input
              type="number"
              min="1"
              value={distance}
              onChange={(e) => setDistance(Math.max(1, Math.round(Number(e.target.value) || 1)))}
            />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Why</legend>
          <Choice
            name="extend-reason"
            value={reason}
            onChange={setReason}
            columns={3}
            options={(['4', '5', '1', '2', '99'] as const).map((c) => ({ value: c, label: EWB_EXTEND_REASONS[c] }))}
          />
        </fieldset>
        <Field label="Remark" hint="Optional, up to 100 characters">
          <Input value={remark} maxLength={100} onChange={(e) => setRemark(e.target.value)} placeholder="Optional" />
        </Field>
        <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          New validity: {days} day{days === 1 ? '' : 's'} from today.
        </div>
        {extend.error && <p className="text-sm text-destructive">{extend.error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={() => void submit()} disabled={extend.busy} className="gap-1.5" data-slot="ewb-extend-save">
            {extend.busy && <Loader2 className="size-3.5 animate-spin" />} Extend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Cancelling ───────────────────────────────────────────────────────────────

export function CancelEwayBillDialog({ bill, onClose, onDone }: DialogProps) {
  const [reason, setReason] = useState<EwbCancelReason>('3');
  const [remark, setRemark] = useState('');
  const cancel = useApiAction(gst.cancelEwayBill);

  const submit = async () => {
    if (!bill?.id) return;
    const done = await cancel.run(bill.id, reason, remark.trim());
    if (!done) return;
    toast.success(`E-way bill ${done.ewayBillNo} cancelled`, {
      description:
        [
          done.live ? null : standIn,
          done.recovered ? 'The portal had already cancelled it; the register now agrees.' : null,
        ]
          .filter(Boolean)
          .join(' ') || undefined,
    });
    onClose();
    onDone();
  };

  return (
    <Dialog open={bill !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-slot="ewb-cancel-dialog">
        <DialogHeader>
          <DialogTitle>Cancel e-way bill {bill?.ewayBillNo}?</DialogTitle>
          <DialogDescription>
            The bill stops covering the goods at once. The {bill?.docKind === 'challan' ? 'challan' : 'invoice'} is
            not affected: if the goods still have to move, generate a new bill for it.
            {bill?.cancelUntil && <> The window closes in {timeLeft(bill.cancelUntil)}.</>}
          </DialogDescription>
        </DialogHeader>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Reason</legend>
          <Choice
            name="ewb-cancel-reason"
            value={reason}
            onChange={setReason}
            options={(['3', '1', '2', '4'] as const).map((c) => ({ value: c, label: EWB_CANCEL_REASONS[c] }))}
          />
        </fieldset>
        <Field label="Remark" hint="Optional, up to 100 characters">
          <Input value={remark} maxLength={100} onChange={(e) => setRemark(e.target.value)} placeholder="Optional" />
        </Field>
        {cancel.error && <p className="text-sm text-destructive">{cancel.error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep the bill</Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={cancel.busy}
            className="gap-1.5"
            data-slot="ewb-cancel-confirm"
          >
            {cancel.busy && <Loader2 className="size-3.5 animate-spin" />} Cancel e-way bill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
