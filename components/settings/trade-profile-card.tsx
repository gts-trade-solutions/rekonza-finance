'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Settings → Organisation: where the business sells and what it supplies, and
// its Letter of Undertaking.
//
//   Sales        within India, within India and abroad, or abroad only
//   Supplies     goods (HSN codes), services (SAC codes), or both, separately
//   LUT          filed for the year, yes or no; with a yes, its ARN and dates
//   IGST         what an export takes when nobody chooses: nil under the LUT,
//                or paid and claimed back as a refund. Without a LUT, paid.
//
// The invoice form offers the same two for each export, with this as its
// default, and refuses IGST nil when no LUT covers the invoice date.
// ─────────────────────────────────────────────────────────────────────────────

import { Globe2, MapPin, Package, Plane, Wrench, Boxes } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/form-bits';
import { dayLabel } from '@/lib/date-range';
import { cn } from '@/lib/utils';

export type TradeScope = 'domestic' | 'both' | 'international';
export type Supplies = 'goods' | 'services' | 'both';

export interface TradeForm {
  tradeScope: TradeScope;
  supplies: Supplies;
  lutDeclared: boolean;
  lutArn: string;
  lutValidFrom: string;
  lutValidTo: string;
  exportIgst: 'nil_lut' | 'paid';
}

function Choice<T extends string | boolean>({ label, options, value, onChange, disabled, slot }: {
  label: string;
  options: { v: T; label: string; hint: string; icon?: typeof Globe2; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  slot: string;
}) {
  return (
    <div className={cn('grid gap-2', options.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')} role="radiogroup" aria-label={label} data-slot={slot}>
      {options.map((o) => {
        const on = value === o.v;
        const Icon = o.icon;
        return (
          <button key={String(o.v)} type="button" role="radio" aria-checked={on} disabled={disabled || o.disabled}
            onClick={() => !on && onChange(o.v)}
            className={cn('flex items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              on ? 'border-primary bg-primary/5' : 'hover:bg-accent/50')}>
            {Icon && <Icon className={cn('mt-0.5 size-4 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} />}
            <span className="min-w-0">
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const Row = ({ title, hint, children }: { title: string; hint: string; children: ReactNode }) => (
  <div className="space-y-2">
    <div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
    {children}
  </div>
);

export function TradeProfileCard({ value, onChange, canEdit, errors }: {
  value: TradeForm;
  onChange: (v: Partial<TradeForm>) => void;
  canEdit: boolean;
  errors: Record<string, string>;
}) {
  const abroad = value.tradeScope !== 'domestic';
  const lutText = value.lutDeclared && value.lutArn
    ? `LUT ${value.lutArn}${value.lutValidFrom && value.lutValidTo ? `, ${dayLabel(value.lutValidFrom)} to ${dayLabel(value.lutValidTo)}` : ''}`
    : null;
  return (
    <Card className="space-y-5 p-5" data-slot="trade-profile">
      <div>
        <h3 className="text-sm font-semibold">Sales and exports</h3>
        <p className="text-xs text-muted-foreground">
          Where the business sells, what it supplies, and its Letter of Undertaking (LUT) for exports.
        </p>
      </div>

      <Row title="Where you sell" hint="Domestic is within India. International is exports, to customers outside India.">
        <Choice<TradeScope> label="Where you sell" slot="trade-scope" value={value.tradeScope} disabled={!canEdit}
          onChange={(v) => onChange({ tradeScope: v })}
          options={[
            { v: 'domestic', icon: MapPin, label: 'Domestic', hint: 'Within India only' },
            { v: 'both', icon: Globe2, label: 'Domestic and international', hint: 'Within India, and exports' },
            { v: 'international', icon: Plane, label: 'International', hint: 'Exports only' },
          ]} />
      </Row>

      <Row title="What you supply" hint="Goods carry an HSN code and stock; services carry a SAC code. GST and the returns keep them apart.">
        <Choice<Supplies> label="What you supply" slot="supplies" value={value.supplies} disabled={!canEdit}
          onChange={(v) => onChange({ supplies: v })}
          options={[
            { v: 'goods', icon: Package, label: 'Goods', hint: 'HSN codes, stock, e-way bills' },
            { v: 'services', icon: Wrench, label: 'Services', hint: 'SAC codes, no stock' },
            { v: 'both', icon: Boxes, label: 'Goods and services', hint: 'Both, each kept separately' },
          ]} />
      </Row>

      {abroad && (
        <>
          <Row title="LUT declaration" hint="A Letter of Undertaking (Form GST RFD-11), filed on the GST portal for each financial year, lets exports go without paying IGST.">
            <Choice<boolean> label="LUT declaration" slot="lut-declared" value={value.lutDeclared} disabled={!canEdit}
              onChange={(v) => onChange(v ? { lutDeclared: true } : { lutDeclared: false, exportIgst: 'paid' })}
              options={[
                { v: true, label: 'Yes — LUT filed', hint: 'Exports can go with IGST nil' },
                { v: false, label: 'No LUT', hint: 'IGST is paid on exports and claimed back as a refund' },
              ]} />
            {value.lutDeclared && (
              <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-3">
                <Field label="LUT ARN" required hint="The acknowledgement number the portal gave" error={errors.lutArn}>
                  <Input value={value.lutArn} onChange={(e) => onChange({ lutArn: e.target.value.toUpperCase() })} className="font-mono" maxLength={20} disabled={!canEdit} data-slot="lut-arn" />
                </Field>
                <Field label="Valid from" required error={errors.lutValidFrom}>
                  <Input type="date" value={value.lutValidFrom} onChange={(e) => onChange({ lutValidFrom: e.target.value })} disabled={!canEdit} />
                </Field>
                <Field label="Valid to" required>
                  <Input type="date" value={value.lutValidTo} onChange={(e) => onChange({ lutValidTo: e.target.value })} disabled={!canEdit} />
                </Field>
              </div>
            )}
          </Row>

          <Row title="IGST on exports" hint="What a new export invoice starts with. Each invoice can still choose; IGST nil needs a LUT in force on its date.">
            <Choice<'nil_lut' | 'paid'> label="IGST on exports" slot="export-igst-default" value={value.lutDeclared ? value.exportIgst : 'paid'} disabled={!canEdit}
              onChange={(v) => onChange({ exportIgst: v })}
              options={[
                { v: 'nil_lut', label: 'IGST nil — under LUT', hint: lutText ?? 'Needs a LUT: answer Yes above', disabled: !value.lutDeclared },
                { v: 'paid', label: 'IGST paid', hint: 'Charged on the invoice and claimed back as a refund' },
              ]} />
          </Row>
        </>
      )}
    </Card>
  );
}
