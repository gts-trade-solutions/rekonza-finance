'use client';

// Reusable form primitives so every create/edit screen looks identical.

import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toRupees } from '@/lib/money';

export function Field({
  label,
  hint,
  required,
  children,
  className,
  error,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
  error?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-4', className)}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Rupee input that stores paise. Keeps the user typing in familiar units. */
export function MoneyInput({
  valuePaise,
  onChangePaise,
  className,
  placeholder = '0.00',
  disabled,
}: {
  valuePaise: number;
  onChangePaise: (paise: number) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        ₹
      </span>
      <Input
        type="number"
        step="0.01"
        min="0"
        disabled={disabled}
        className={cn('pl-6 text-right tabular', className)}
        placeholder={placeholder}
        value={valuePaise === 0 ? '' : toRupees(valuePaise)}
        onChange={(e) => onChangePaise(Math.round(parseFloat(e.target.value || '0') * 100))}
      />
    </div>
  );
}

/** Read-only summary row used in totals panels. */
export function TotalRow({
  label,
  children,
  emphasis,
  muted,
}: {
  label: ReactNode;
  children: ReactNode;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 py-1.5 text-sm',
        emphasis && 'border-t pt-2.5 text-base font-semibold',
        muted && 'text-muted-foreground',
      )}
    >
      <span className={cn(!emphasis && 'text-muted-foreground')}>{label}</span>
      <span className="tabular">{children}</span>
    </div>
  );
}
