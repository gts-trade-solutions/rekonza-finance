// Turns store records into Combobox options, so every picker in the app shows
// the same secondary line for the same entity type.

import type { ComboboxOption } from '@/components/ui/combobox';
import type { AppState } from './store';
import { formatINR } from './money';
import { GST_STATES, stateName } from './tax/gst';

const AVATAR_COLORS = [
  '#4f7ce8', '#2fa4a0', '#e0883a', '#8a63d2', '#d9556b',
  '#3f9f5f', '#c85a9c', '#5b8def', '#d18b2c', '#3c9ea8',
];

/** Stable per-record colour so the same customer always gets the same chip. */
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function customerOptions(s: AppState): ComboboxOption[] {
  return s.contacts
    .filter((c) => !c.isArchived && (c.kind === 'customer' || c.kind === 'both'))
    .map((c) => ({
      value: c.id,
      label: c.displayName,
      sublabel: c.gstin ?? `${c.gstTreatment.replace(/_/g, ' ')} · ${stateName(c.stateCode)}`,
      avatarColor: colorFor(c.id),
    }));
}

export function vendorOptions(s: AppState): ComboboxOption[] {
  return s.contacts
    .filter((c) => !c.isArchived && (c.kind === 'vendor' || c.kind === 'both'))
    .map((c) => ({
      value: c.id,
      label: c.displayName + (c.isMsme ? '  · MSME' : ''),
      sublabel: c.gstin ?? `${c.gstTreatment.replace(/_/g, ' ')} · ${stateName(c.stateCode)}`,
      avatarColor: colorFor(c.id),
    }));
}

export function itemOptions(s: AppState, priceMode: 'sale' | 'purchase' = 'sale'): ComboboxOption[] {
  return s.items
    .filter((i) => !i.isArchived)
    .map((i) => ({
      value: i.id,
      label: i.name,
      sublabel: `${i.sku} · HSN ${i.hsnSac} · GST ${i.gstRatePct}%`,
      meta: formatINR(priceMode === 'sale' ? i.salePricePaise : i.purchasePricePaise),
      avatarColor: colorFor(i.id),
      group: i.kind === 'service' ? 'Services' : 'Goods',
    }));
}

export function accountOptions(
  s: AppState,
  filter?: (typeof s.accounts)[number]['type'][],
): ComboboxOption[] {
  return s.accounts
    .filter((a) => !a.isArchived && (!filter || filter.includes(a.type)))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => ({
      value: a.id,
      label: a.name,
      sublabel: `${a.code} · ${a.type}`,
      group: a.type.charAt(0).toUpperCase() + a.type.slice(1),
      avatarColor: colorFor(a.id),
    }));
}

export function bankAccountOptions(s: AppState): ComboboxOption[] {
  return s.bankAccounts.map((b) => ({
    value: b.id,
    label: b.name,
    sublabel: b.accountLast4 ? `•••• ${b.accountLast4}` : b.kind,
    avatarColor: colorFor(b.id),
  }));
}

export function branchOptions(s: AppState): ComboboxOption[] {
  return s.branches.map((b) => ({
    value: b.id,
    label: b.name,
    sublabel: `${b.gstin} · ${stateName(b.stateCode)}`,
    avatarColor: colorFor(b.id),
  }));
}

/**
 * The registrations the signed-in user may raise documents for. A user is
 * attached to one branch by default, which is why the branch picker stays
 * hidden for most people — there is nothing for them to choose.
 */
export function userBranches(s: AppState): string[] {
  const user = s.users.find((u) => u.id === s.session?.userId);
  if (!user) return s.branches.map((b) => b.id);
  return user.branchAccess?.length ? user.branchAccess : [user.branchId];
}

export function branchOptionsForUser(s: AppState): ComboboxOption[] {
  const allowed = new Set(userBranches(s));
  return branchOptions(s).filter((o) => allowed.has(o.value));
}

export function userOptions(s: AppState): ComboboxOption[] {
  return s.users.map((u) => ({
    value: u.id,
    label: u.name,
    sublabel: u.role,
    avatarColor: u.avatarColor,
  }));
}

/** All 37 GST state codes — used for Place of Supply. */
export function stateOptions(): ComboboxOption[] {
  return Object.entries(GST_STATES).map(([code, name]) => ({
    value: code,
    label: name,
    sublabel: `Code ${code}`,
  }));
}

/** Zoho's payment-terms presets, plus the custom escape hatch. */
export const PAYMENT_TERMS: { value: string; label: string; days: number }[] = [
  { value: 'due_on_receipt', label: 'Due on Receipt', days: 0 },
  { value: 'net_15', label: 'Net 15', days: 15 },
  { value: 'net_30', label: 'Net 30', days: 30 },
  { value: 'net_45', label: 'Net 45', days: 45 },
  { value: 'net_60', label: 'Net 60', days: 60 },
  { value: 'due_end_of_month', label: 'Due end of the month', days: -1 },
  { value: 'due_end_of_next_month', label: 'Due end of next month', days: -2 },
];

export function termsOptions(): ComboboxOption[] {
  return PAYMENT_TERMS.map((t) => ({ value: t.value, label: t.label }));
}

/** Resolve a terms preset to a concrete due date. */
export function dueDateFor(termsValue: string, invoiceDate: string): string {
  const t = PAYMENT_TERMS.find((x) => x.value === termsValue) ?? PAYMENT_TERMS[2];
  const d = new Date(invoiceDate);
  if (t.days === -1) {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
  }
  if (t.days === -2) {
    return new Date(d.getFullYear(), d.getMonth() + 2, 0).toISOString().slice(0, 10);
  }
  d.setDate(d.getDate() + t.days);
  return d.toISOString().slice(0, 10);
}

/** Best-fit terms preset for a customer's stored payment-term days. */
export function termsForDays(days: number): string {
  return PAYMENT_TERMS.find((t) => t.days === days)?.value ?? 'net_30';
}

/**
 * The organisation's approved HSN / SAC codes, narrowed to what this document
 * is for. `supplyKind` of 'both' offers everything, grouped so goods and
 * services stay visually separate.
 *
 * Typing "1" in the picker filters to codes *starting* with 1, because that is
 * how anyone who knows their codes searches — chapter first, then narrower.
 */
export function hsnOptions(
  s: AppState,
  supplyKind: 'goods' | 'service' | 'both' = 'both',
): ComboboxOption[] {
  return s.hsnCodes
    .filter((h) => h.isActive)
    .filter((h) =>
      supplyKind === 'both' ? true : supplyKind === 'goods' ? h.kind === 'hsn' : h.kind === 'sac',
    )
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((h) => ({
      value: h.code,
      label: h.code,
      sublabel: h.description,
      meta: `${h.gstRatePct}%`,
      group: h.kind === 'sac' ? 'Services (SAC)' : 'Goods (HSN)',
    }));
}

/** Items narrowed to what this document is for. */
export function itemOptionsFor(
  s: AppState,
  supplyKind: 'goods' | 'service' | 'both',
  priceMode: 'sale' | 'purchase' = 'sale',
): ComboboxOption[] {
  const all = itemOptions(s, priceMode);
  if (supplyKind === 'both') return all;
  const allowed = new Set(
    s.items.filter((i) => i.kind === (supplyKind === 'goods' ? 'goods' : 'service')).map((i) => i.id),
  );
  return all.filter((o) => allowed.has(o.value));
}
