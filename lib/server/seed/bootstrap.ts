import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: create the organisation, its branches, users and master data.
//
// The master data is imported from lib/mock/seed/* rather than copied here.
// Those files are plain arrays with no browser dependency, and reusing them
// means the database holds exactly the book the client has already reviewed —
// same customers, same items, same HSN codes — with no second copy to drift.
//
// This function does not create transactions. Invoices, bills and payments are
// seeded separately, through the real services, so every one of them posts a
// genuine balanced journal entry rather than being written straight to a table.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { installChartOfAccounts, accountIds, CODE, requireAccount } from '../ledger/chart-of-accounts';
import { postEntry, type DraftLine } from '../ledger/posting';
import { hashPassword } from '../auth/password';
import { SEED_ORG, SEED_BRANCHES, SEED_USERS } from '../../mock/seed/org';
import { SEED_CUSTOMERS, SEED_VENDORS } from '../../mock/seed/contacts';
import { SEED_ITEMS } from '../../mock/seed/items';
import { SEED_HSN_CODES } from '../../mock/seed/hsn';
import { toSqlFromPaise } from '../money-sql';

/** Maps the demo's string keys to the row ids the database assigned. */
export interface IdMap {
  orgId: number;
  branches: Record<string, number>;
  users: Record<string, number>;
  contacts: Record<string, number>;
  items: Record<string, number>;
  accounts: Record<string, number>;
  bankAccounts: Record<string, number>;
}

export interface BootstrapOptions {
  /** Password given to every seeded user. Demo only. */
  demoPassword?: string;
  /** Skip the demo masters and create only the org, its branch and the admin. */
  minimal?: boolean;
  /**
   * Marks the organisation as the demo book. Only the seed script sets this.
   * Everything the app does differently for a demo — the banner, the one-click
   * door on the sign-in page, what the seeder is allowed to wipe — hangs off
   * this flag, so it defaults to false and a real sign-up can never set it.
   */
  isDemo?: boolean;
  org?: {
    name: string;
    pan?: string | null;
    email?: string | null;
    phone?: string | null;
    gstRegistrationType?: 'regular' | 'composition' | 'unregistered';
  };
  /**
   * The first GST registration. A branch here is a registration, not an office,
   * so a new business gets exactly one and adds more when it registers in
   * another state. Omitted only by the demo seed, which brings its own two.
   */
  branch?: {
    name: string; stateCode: string; gstin?: string | null; address?: string | null;
    /** Both required by the GST portals, on every document, for both parties. */
    city?: string | null; pincode?: string | null;
  };
  admin?: { name: string; email: string; password: string };
}

export async function bootstrap(trx: Trx, options: BootstrapOptions = {}): Promise<IdMap> {
  const org = await trx
    .insertInto('organizations')
    .values({
      name: options.org?.name ?? SEED_ORG.name,
      legal_name: options.org?.name ?? SEED_ORG.name,
      pan: options.org?.pan ?? SEED_ORG.pan,
      gst_registration_type: options.org?.gstRegistrationType ?? SEED_ORG.gstRegistrationType,
      // Aggregate turnover is not known at sign-up, and claiming a business is
      // above the e-invoicing threshold when it is not would put mandatory
      // banners in front of somebody who does not need them. It starts false
      // and is set in settings.
      aato_above_5cr: options.org ? 0 : SEED_ORG.aatoAbove5Cr ? 1 : 0,
      fiscal_year_start_month: 4,
      base_currency: 'INR',
      address: options.org ? null : SEED_ORG.address,
      email: options.org?.email ?? SEED_ORG.email,
      phone: options.org?.phone ?? SEED_ORG.phone,
      onboarded_at: new Date(),
      is_demo: options.isDemo ? 1 : 0,
    })
    .executeTakeFirstOrThrow();
  const orgId = Number(org.insertId);

  // ── Branches ───────────────────────────────────────────────────────────────
  //
  // A sign-up brings its own single registration. Falling through to the demo's
  // two would not merely be wrong data — their GSTINs are unique in the schema,
  // so the second business to register would collide with the first and the
  // whole transaction would roll back.
  const branchSpecs = options.branch
    ? [{
        id: 'br_primary',
        name: options.branch.name,
        gstin: options.branch.gstin || null,
        stateCode: options.branch.stateCode,
        address: options.branch.address ?? null,
        city: options.branch.city ?? null,
        pincode: options.branch.pincode ?? null,
        isPrimary: true,
      }]
    : SEED_BRANCHES;

  const branches: Record<string, number> = {};
  for (const b of branchSpecs) {
    const row = await trx
      .insertInto('branches')
      .values({
        org_id: orgId,
        name: b.name,
        gstin: b.gstin,
        state_code: b.stateCode,
        address: b.address,
        // Separate columns, not parsed out of the address line: the e-invoice
        // and e-way bill schemas both demand them as their own fields.
        city: b.city ?? null,
        pincode: b.pincode ?? null,
        is_primary: b.isPrimary ? 1 : 0,
        is_active: 1,
      })
      .executeTakeFirstOrThrow();
    branches[b.id] = Number(row.insertId);
  }

  await installChartOfAccounts(trx, orgId);
  const accounts = await accountIds(trx, orgId);

  // ── Users ──────────────────────────────────────────────────────────────────
  // One hash, reused across the demo users. Hashing argon2id eleven times costs
  // about half a second each; doing it once is the difference between a seed
  // that runs in two seconds and one that runs in eight.
  const demoPassword = options.demoPassword ?? 'Rekonza@2026';
  const sharedHash = await hashPassword(demoPassword);

  const users: Record<string, number> = {};
  const userList = options.admin
    ? [{
        id: 'u_admin',
        name: options.admin.name,
        email: options.admin.email.toLowerCase(),
        role: 'admin' as const,
        branchId: branchSpecs[0].id,
        branchAccess: branchSpecs.map((b) => b.id),
      }]
    : SEED_USERS;

  const adminHash = options.admin ? await hashPassword(options.admin.password) : sharedHash;

  for (const u of userList) {
    const row = await trx
      .insertInto('users')
      .values({
        org_id: orgId,
        name: u.name,
        email: u.email.toLowerCase(),
        password_hash: options.admin ? adminHash : sharedHash,
        role: u.role,
        home_branch_id: branches[u.branchId] ?? null,
        is_active: 1,
      })
      .executeTakeFirstOrThrow();
    const userId = Number(row.insertId);
    users[u.id] = userId;

    // Only users with more than one registration get explicit grants; the rest
    // fall back to their home branch, which is what the API assumes.
    const access = u.branchAccess ?? [];
    if (access.length > 1) {
      await trx
        .insertInto('user_branches')
        .values(access.filter((b) => branches[b]).map((b) => ({ user_id: userId, branch_id: branches[b] })))
        .execute();
    }
  }

  if (options.minimal) {
    // A book with nowhere to put money cannot record its first receipt, and
    // "add a bank account before you can be paid" is a poor first five minutes.
    // Cash in Hand is the one account every business has, it needs no details
    // from the owner, and its ledger account is already in the chart — so it is
    // created at zero and the real bank accounts are added in settings.
    const cash = await trx
      .insertInto('bank_accounts')
      .values({
        org_id: orgId,
        kind: 'cash',
        name: 'Cash in Hand',
        bank_name: null,
        account_last4: null,
        ifsc: null,
        ledger_account_id: requireAccount(accounts, CODE.CASH),
        opening_balance: toSqlFromPaise(0),
        opening_date: null,
        is_primary: 1,
        feed_connected: 0,
        is_active: 1,
      })
      .executeTakeFirstOrThrow();

    return {
      orgId,
      branches,
      users,
      contacts: {},
      items: {},
      accounts,
      bankAccounts: { ba_cash: Number(cash.insertId) },
    };
  }

  // ── HSN / SAC master ───────────────────────────────────────────────────────
  await trx
    .insertInto('hsn_codes')
    .values(
      SEED_HSN_CODES.map((h) => ({
        org_id: orgId,
        code: h.code,
        kind: h.kind,
        description: h.description,
        gst_rate_pct: h.gstRatePct,
        uqc: h.uqc ?? null,
        is_active: h.isActive ? 1 : 0,
      })),
    )
    .execute();

  // ── Contacts ───────────────────────────────────────────────────────────────
  const contacts: Record<string, number> = {};
  for (const c of [...SEED_CUSTOMERS, ...SEED_VENDORS]) {
    const row = await trx
      .insertInto('contacts')
      .values({
        org_id: orgId,
        kind: c.kind,
        display_name: c.displayName,
        legal_name: c.companyName,
        gst_treatment: c.gstTreatment,
        gstin: c.gstin,
        pan: c.pan,
        state_code: c.stateCode,
        is_msme: c.isMsme ? 1 : 0,
        msme_udyam_no: c.udyamNo ?? null,
        email: c.email || null,
        phone: c.phone || null,
        billing_address: formatAddress(c.billingAddress),
        // The seed has always carried these inside the address object and
        // `formatAddress` flattened them into one string, losing them. The GST
        // portals want them back out again, so they are stored as they came.
        billing_city: c.billingAddress?.city ?? null,
        billing_pincode: c.billingAddress?.pincode ?? null,
        shipping_address: c.shippingAddress ? formatAddress(c.shippingAddress) : null,
        shipping_city: c.shippingAddress?.city ?? null,
        shipping_pincode: c.shippingAddress?.pincode ?? null,
        payment_terms: c.paymentTermsDays ? `net_${c.paymentTermsDays}` : null,
        credit_limit: c.creditLimit != null ? toSqlFromPaise(c.creditLimit) : null,
        opening_balance: toSqlFromPaise(c.openingBalance ?? 0),
        tds_applicable: c.tdsSection || c.customerDeductsTds ? 1 : 0,
        tds_section: c.tdsSection ?? null,
        is_archived: c.isArchived ? 1 : 0,
      })
      .executeTakeFirstOrThrow();
    contacts[c.id] = Number(row.insertId);
  }

  // ── Items ──────────────────────────────────────────────────────────────────
  const items: Record<string, number> = {};
  for (const i of SEED_ITEMS) {
    const row = await trx
      .insertInto('items')
      .values({
        org_id: orgId,
        kind: i.kind,
        name: i.name,
        sku: i.sku,
        hsn_sac: i.hsnSac,
        uqc: i.uqc,
        sale_price: toSqlFromPaise(i.salePricePaise),
        purchase_price: toSqlFromPaise(i.purchasePricePaise),
        gst_rate_pct: i.gstRatePct,
        tax_pref: i.taxPref,
        // The demo's account keys map onto codes in the standard chart.
        sale_account_id: accounts[i.kind === 'service' ? CODE.SERVICE_INCOME : CODE.SALES],
        purchase_account_id: accounts[CODE.PURCHASES],
        description: i.description ?? null,
        track_inventory: 0,
        is_archived: i.isArchived ? 1 : 0,
      })
      .executeTakeFirstOrThrow();
    items[i.id] = Number(row.insertId);
  }

  // ── Bank accounts ──────────────────────────────────────────────────────────
  // Each needs its own ledger account, so the reconciliation screen can compare
  // a statement against the books without guessing which account is which.
  const bankSpecs = [
    { key: 'ba_hdfc', kind: 'bank' as const, name: 'HDFC Bank – Current', bank: 'HDFC Bank', last4: '4412', ifsc: 'HDFC0000123', opening: 12_50_000_00, primary: true, code: '1211' },
    { key: 'ba_icici', kind: 'bank' as const, name: 'ICICI Bank – Current', bank: 'ICICI Bank', last4: '8890', ifsc: 'ICIC0000456', opening: 4_20_000_00, primary: false, code: '1212' },
    { key: 'ba_cash', kind: 'cash' as const, name: 'Cash in Hand', bank: null, last4: null, ifsc: null, opening: 35_000_00, primary: false, code: CODE.CASH },
    { key: 'ba_card', kind: 'card' as const, name: 'HDFC Business Credit Card', bank: 'HDFC Bank', last4: '7731', ifsc: null, opening: 0, primary: false, code: CODE.CREDIT_CARD },
    { key: 'ba_clearing', kind: 'clearing' as const, name: 'Payment Clearing Account', bank: null, last4: null, ifsc: null, opening: 0, primary: false, code: CODE.PAYMENT_CLEARING },
  ];

  const bankAccounts: Record<string, number> = {};
  for (const b of bankSpecs) {
    let ledgerId = accounts[b.code];
    if (!ledgerId) {
      const acct = await trx
        .insertInto('accounts')
        .values({
          org_id: orgId,
          code: b.code,
          name: b.name,
          type: b.kind === 'card' ? 'liability' : 'asset',
          subtype: b.kind === 'card' ? 'credit_card' : 'bank',
          is_system: 1,
          is_active: 1,
        })
        .executeTakeFirstOrThrow();
      ledgerId = Number(acct.insertId);
      accounts[b.code] = ledgerId;
    }

    const row = await trx
      .insertInto('bank_accounts')
      .values({
        org_id: orgId,
        kind: b.kind,
        name: b.name,
        bank_name: b.bank,
        account_last4: b.last4,
        ifsc: b.ifsc,
        ledger_account_id: ledgerId,
        opening_balance: toSqlFromPaise(b.opening),
        opening_date: SEED_ORG.fiscalYearStart,
        is_primary: b.primary ? 1 : 0,
        feed_connected: 0,
        is_active: 1,
      })
      .executeTakeFirstOrThrow();
    bankAccounts[b.key] = Number(row.insertId);
  }

  // ── Opening balances ───────────────────────────────────────────────────────
  //
  // A business that has been trading does not start the year with nothing in
  // the bank. Recording the opening figure on the bank account record alone
  // would leave it invisible to every statement: the balance sheet would show
  // no cash, and the reconciliation screen would compare a real statement
  // against a ledger that began at zero.
  //
  // So it is posted, like everything else:
  //
  //   Dr Bank / Cash               what was actually there on day one
  //     Cr Opening Balance Equity  the contra, because the money came from
  //                                somewhere before the books began
  //
  // Opening Balance Equity exists for exactly this. It is not real equity — it
  // is a holding account that nets to nothing once every opening figure is in.
  const openingLines: DraftLine[] = [];
  let openingTotal = 0;
  for (const b of bankSpecs) {
    if (!b.opening) continue;
    openingLines.push({
      accountId: accounts[b.code],
      debit: b.opening,
      description: `Opening balance — ${b.name}`,
    });
    openingTotal += b.opening;
  }

  if (openingTotal > 0) {
    openingLines.push({
      accountId: requireAccount(accounts, CODE.OPENING_BALANCE_EQUITY),
      credit: openingTotal,
      description: 'Balances brought forward',
    });

    await postEntry(trx, {
      orgId,
      branchId: branches[SEED_BRANCHES[0].id],
      date: SEED_ORG.fiscalYearStart,
      memo: `Opening balances as at ${SEED_ORG.fiscalYearStart}`,
      sourceType: 'opening',
      userId: users[SEED_USERS[0].id],
      module: 'accountant',
      lines: openingLines,
    });
  }

  return { orgId, branches, users, contacts, items, accounts, bankAccounts };
}

function formatAddress(a: { line1: string; city?: string; stateCode?: string; pincode?: string }): string {
  return [a.line1, a.city, a.pincode].filter(Boolean).join(', ');
}
