// ─────────────────────────────────────────────────────────────────────────────
// The permission matrix. Deliberately framework-neutral — no 'use client', no
// React — because it is needed in two places:
//
//   * the UI, to decide which buttons and menus to render;
//   * the API, to decide whether a request is allowed at all.
//
// Only the second one is a control. A hidden button is a courtesy; anyone can
// call the endpoint directly. Keeping one matrix means the two can never
// disagree about what a role may do.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoleName } from './types';

export type Action = 'view' | 'create' | 'edit' | 'approve' | 'void' | 'print' | 'export';

/** Taking a copy away: printed, or downloaded as a file. */
const OUTPUT: Action[] = ['print', 'export'];

const MATRIX: Record<RoleName, Record<string, Action[]>> = {
  admin: {
    '*': ['view', 'create', 'edit', 'approve', 'void'],
  },
  accountant: {
    sales: ['view', 'create', 'edit', 'approve', 'void'],
    purchases: ['view', 'create', 'edit', 'approve', 'void'],
    banking: ['view', 'create', 'edit', 'approve', 'void'],
    accountant: ['view', 'create', 'edit', 'approve', 'void'],
    gst: ['view', 'create', 'edit', 'approve'],
    inventory: ['view', 'create', 'edit'],
    reports: ['view'],
    settings: ['view'],
    ai: ['view', 'create'],
    // A client's Tally company, read in by a connector on their PC. Pairing
    // that connector is part of looking after the books.
    tally: ['view', 'edit'],
    // Salaries are confidential: only admins and accountants see payroll.
    payroll: ['view', 'create', 'edit', 'approve'],
    // Analytics works on copies, never the ledger, so building reports is
    // open to anyone who can see the figures they are built from.
    analytics: ['view', 'create', 'edit', 'void'],
  },
  sales: {
    sales: ['view', 'create', 'edit'],
    reports: ['view'],
    inventory: ['view'],
    ai: ['view'],
    analytics: ['view', 'create', 'edit'],
  },
  staff: {
    sales: ['view', 'create'],
    purchases: ['view', 'create'],
    inventory: ['view'],
    ai: ['view'],
  },
  viewer: {
    sales: ['view'],
    purchases: ['view'],
    banking: ['view'],
    accountant: ['view'],
    gst: ['view'],
    reports: ['view'],
    inventory: ['view'],
    ai: ['view'],
    // Auditors and stakeholders read the board pack; they do not edit it.
    analytics: ['view'],
    tally: ['view'],
  },
};

/**
 * A custom role's grants, module by module. A module can be narrowed with
 * dotted parts — reports.sales, reports.financial — and a role that names any
 * part of a module has only the parts it names.
 */
export type CustomPermissions = Record<string, Action[]>;

let ambient: () => CustomPermissions | null | undefined = () => undefined;

/**
 * Where the current user's custom role is read from when a check does not pass
 * one: the request's on the server (set by route()), the session's in the
 * browser. With none, the built-in role's matrix decides, as it always has.
 */
export function setCustomPermissionSource(source: () => CustomPermissions | null | undefined) {
  ambient = source;
}

function grants(custom: CustomPermissions, module: string, action: Action): boolean {
  // A role saved before printing and exporting were rights of their own has no
  // 'output' marker: for it, seeing a thing is printing and exporting it.
  if (OUTPUT.includes(action) && !('output' in custom)) return grants(custom, module, 'view');
  if (custom[module]) return custom[module].includes(action);
  const parent = module.split('.')[0];
  if (parent !== module) {
    if (Object.keys(custom).some((k) => k.startsWith(`${parent}.`))) return false;
    return custom[parent]?.includes(action) ?? false;
  }
  // The module itself: granted if any part of it is.
  return Object.entries(custom).some(([k, a]) => k.startsWith(`${module}.`) && a.includes(action));
}

export function hasPermission(
  role: RoleName | undefined, module: string, action: Action, custom: CustomPermissions | null | undefined = ambient(),
): boolean {
  if (!role) return false;
  // An admin is always an admin; a custom role refines the others.
  if (custom && role !== 'admin') return grants(custom, module, action);
  // The built-in roles print and export whatever they may see.
  if (OUTPUT.includes(action)) return hasPermission(role, module, 'view', null);
  const m = MATRIX[role];
  if (m['*']?.includes(action)) return true;
  // reports.sales and the like fall back to their module for the built-in roles.
  return m[module]?.includes(action) ?? m[module.split('.')[0]]?.includes(action) ?? false;
}

/** The modules a custom role can be given, in the order the role editor lists them. */
export const PERMISSION_MODULES: { key: string; label: string; actions: Action[] }[] = [
  { key: 'sales', label: 'Sales', actions: ['view', 'create', 'edit', 'approve', 'void', 'print', 'export'] },
  { key: 'purchases', label: 'Purchases', actions: ['view', 'create', 'edit', 'approve', 'void', 'print', 'export'] },
  { key: 'banking', label: 'Banking', actions: ['view', 'create', 'edit', 'approve', 'void', 'print', 'export'] },
  { key: 'accountant', label: 'Accountant (journals, chart, period close)', actions: ['view', 'create', 'edit', 'approve', 'void', 'print', 'export'] },
  { key: 'gst', label: 'GST & taxes', actions: ['view', 'create', 'edit', 'approve', 'print', 'export'] },
  { key: 'inventory', label: 'Inventory', actions: ['view', 'create', 'edit', 'print', 'export'] },
  { key: 'payroll', label: 'Payroll', actions: ['view', 'create', 'edit', 'approve', 'print', 'export'] },
  { key: 'reports.financial', label: 'Reports: financial statements', actions: ['view', 'print', 'export'] },
  { key: 'reports.sales', label: 'Reports: sales', actions: ['view', 'print', 'export'] },
  { key: 'reports.purchases', label: 'Reports: purchases', actions: ['view', 'print', 'export'] },
  { key: 'reports.banking', label: 'Reports: banking', actions: ['view', 'print', 'export'] },
  { key: 'analytics', label: 'Analytics', actions: ['view', 'create', 'edit', 'void', 'export'] },
  { key: 'tally', label: 'Tally', actions: ['view', 'edit'] },
  { key: 'ai', label: 'AI assistant', actions: ['view', 'create'] },
  { key: 'settings', label: 'Settings', actions: ['view'] },
];

/** A restricted voucher type's right, under a custom role: voucher.EXP and the like. */
export const voucherModule = (code: string) => `voucher.${code}`;

/** A built-in role's grants laid out as a custom role's, to start an editor from. */
export function matrixOf(role: RoleName): CustomPermissions {
  return Object.fromEntries(PERMISSION_MODULES
    .map((m) => [m.key, m.actions.filter((a) => hasPermission(role, m.key, a, null))] as const)
    .filter(([, a]) => a.length));
}
