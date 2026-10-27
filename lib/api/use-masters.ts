'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Hydrate the store's master data from the API.
//
// The migration strategy, in one file. Dozens of forms read customers, items,
// HSN codes and accounts out of the Zustand store through helpers like
// `customerOptions(s)`, and the line editor does the same internally. Rewriting
// every one of them to fetch for itself would be a very large change with a
// very large surface for mistakes.
//
// Instead the masters are loaded once and written into the store under the
// server's own ids. Every existing form keeps working untouched, but the data
// it shows is real and the id it submits is the one the API expects. Writes
// then move to the API page by page, which is the part that actually needs
// care — a read showing stale data is a nuisance, a write going to the wrong
// place is a lost document.
//
// Every collection a form reads is now mirrored, the organisation and the
// chart of accounts included. They were held back during the migration because
// the seeded journal entries still carried local ids; with every screen on the
// API, the opposite is true — leaving them on the mock seed would show a new
// business somebody else's company name in the topbar and somebody else's bank
// accounts in its pickers.
//
// Documents are never mirrored — those are the things that change while you
// are looking at them.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { api } from './client';
import { useAppStore } from '@/lib/store';
import type { Account, BankAccount, Contact, HsnCode, Item, Org, User } from '@/lib/types';

interface MastersResponse {
  org: {
    id: string; name: string; legalName: string | null; pan: string | null;
    gstRegistrationType: Org['gstRegistrationType']; aatoAbove5Cr: boolean;
    fiscalYearLabel: string; fiscalYearStart: string; fiscalYearEnd: string;
    baseCurrency: string; address: string | null; email: string | null;
    phone: string | null; isDemo: boolean;
  } | null;
  contacts: {
    id: string; kind: 'customer' | 'vendor' | 'both'; displayName: string;
    gstin: string | null; pan: string | null; gstTreatment: string; stateCode: string;
    email: string | null; phone: string | null; paymentTerms: string | null;
    isMsme: boolean; tdsSection: string | null; billingAddress: string | null; currency?: string; billWise?: boolean;
  }[];
  items: {
    id: string; kind: 'goods' | 'service'; name: string; sku: string | null;
    hsnSac: string | null; uqc: string; salePricePaise: number;
    purchasePricePaise: number; gstRatePct: number; taxPref: string;
    trackInventory?: boolean; trackBatches?: boolean; trackSerials?: boolean;
    altUqc?: string | null; altFactor?: number | null; mrpPaise?: number | null;
  }[];
  hsnCodes: {
    id: string; code: string; kind: 'hsn' | 'sac'; description: string;
    gstRatePct: number; cessRatePct: number;
    rates: { effectiveFrom: string; gstRatePct: number; cessRatePct: number }[];
    uqc: string | null; isActive: boolean;
  }[];
  branches: {
    id: string; name: string; gstin: string | null; stateCode: string;
    address: string | null; city: string | null; pincode: string | null;
    isPrimary: boolean;
  }[];
  users: {
    id: string; name: string; email: string; role: string;
    branchId: string | null; branchAccess: string[];
  }[];
  accounts: {
    id: string; code: string; name: string; type: Account['type'];
    subtype: string | null; isSystem: boolean;
  }[];
  bankAccounts: {
    id: string; kind: BankAccount['kind']; name: string; bankName: string | null;
    accountLast4: string | null; ifsc: string | null; ledgerAccountId: string;
    openingBalancePaise: number; isPrimary: boolean; feedConnected: boolean;
  }[];
  nextInvoiceNumber: string | null;
  nextBillNumber: string | null;
  invoiceDefaults: { terms: string | null; notes: string | null };
}

const AVATAR = ['#4f7ce8', '#2fa4a0', '#e0883a', '#8a63d2', '#d9556b', '#3f9f5f'];
const colorFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR[h % AVATAR.length];
};

/** Split a stored one-line address back into the shape the forms expect. */
function address(line: string | null, stateCode: string) {
  const parts = (line ?? '').split(',').map((s) => s.trim());
  return {
    label: 'Billing',
    line1: parts[0] ?? '',
    city: parts[1] ?? '',
    stateCode,
    pincode: parts[2] ?? '',
  };
}

export function useMasters(): {
  ready: boolean;
  error: string | null;
  nextInvoiceNumber: string | null;
  nextBillNumber: string | null;
} {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextInvoiceNumber, setNext] = useState<string | null>(null);
  const [nextBillNumber, setNextBill] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .get<MastersResponse>('/api/masters')
      .then((m) => {
        if (cancelled) return;

        useAppStore.setState({
          org: m.org && {
            id: m.org.id,
            name: m.org.name,
            pan: m.org.pan ?? '',
            gstRegistrationType: m.org.gstRegistrationType,
            aatoAbove5Cr: m.org.aatoAbove5Cr,
            fiscalYearLabel: m.org.fiscalYearLabel,
            fiscalYearStart: m.org.fiscalYearStart,
            fiscalYearEnd: m.org.fiscalYearEnd,
            baseCurrency: 'INR',
            address: m.org.address ?? '',
            email: m.org.email ?? '',
            phone: m.org.phone ?? '',
          },

          contacts: m.contacts.map<Contact>((c) => ({
            id: c.id,
            kind: c.kind,
            displayName: c.displayName,
            companyName: c.displayName,
            gstin: c.gstin,
            gstTreatment: c.gstTreatment as Contact['gstTreatment'],
            currency: c.currency ?? 'INR',
            pan: c.pan ?? null,
            stateCode: c.stateCode,
            email: c.email ?? '',
            phone: c.phone ?? '',
            billingAddress: address(c.billingAddress, c.stateCode),
            paymentTermsDays: Number(c.paymentTerms?.replace('net_', '') || 0),
            creditLimit: null,
            isMsme: c.isMsme,
            billWise: c.billWise !== false,
            tdsSection: c.tdsSection ?? undefined,
            openingBalance: 0,
            isArchived: false,
          })),

          items: m.items.map<Item>((i) => ({
            id: i.id,
            kind: i.kind,
            name: i.name,
            sku: i.sku ?? '',
            hsnSac: i.hsnSac ?? '',
            uqc: i.uqc,
            salePricePaise: i.salePricePaise,
            purchasePricePaise: i.purchasePricePaise,
            gstRatePct: i.gstRatePct,
            taxPref: i.taxPref as Item['taxPref'],
            trackInventory: !!i.trackInventory,
            trackBatches: !!i.trackBatches,
            trackSerials: !!i.trackSerials,
            altUqc: i.altUqc ?? undefined,
            altFactor: i.altFactor ?? undefined,
            mrpPaise: i.mrpPaise ?? undefined,
            saleAccountId: '',
            purchaseAccountId: '',
            isArchived: false,
          })),

          hsnCodes: m.hsnCodes.map<HsnCode>((h) => ({
            id: h.id,
            code: h.code,
            kind: h.kind,
            description: h.description,
            gstRatePct: h.gstRatePct,
            cessRatePct: h.cessRatePct,
            rates: h.rates,
            uqc: h.uqc ?? undefined,
            isActive: h.isActive,
          })),

          branches: m.branches.map((b) => ({
            id: b.id,
            name: b.name,
            gstin: b.gstin ?? '',
            stateCode: b.stateCode,
            address: b.address ?? '',
            city: b.city ?? '',
            pincode: b.pincode ?? '',
            isPrimary: b.isPrimary,
          })),

          users: m.users.map<User>((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role as User['role'],
            avatarColor: colorFor(u.id),
            branchId: u.branchId ?? '',
            branchAccess: u.branchAccess,
          })),

          accounts: m.accounts.map<Account>((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            type: a.type,
            // The chart is stored flat and read as a tree from the code
            // prefixes, so there is no parent id to carry across.
            parentId: null,
            isSystem: a.isSystem,
            isArchived: false,
          })),

          bankAccounts: m.bankAccounts.map<BankAccount>((b) => ({
            id: b.id,
            kind: b.kind,
            name: b.name,
            bankName: b.bankName ?? undefined,
            accountLast4: b.accountLast4 ?? undefined,
            ifsc: b.ifsc ?? undefined,
            ledgerAccountId: b.ledgerAccountId,
            openingBalancePaise: b.openingBalancePaise,
            isPrimary: b.isPrimary,
            feedConnected: b.feedConnected,
          })),
        });

        setNext(m.nextInvoiceNumber);
        setNextBill(m.nextBillNumber);
        // Held in the store too, so a document form can show the number the
        // database will actually assign rather than computing its own.
        useAppStore.setState({
          nextNumbers: { invoice: m.nextInvoiceNumber, bill: m.nextBillNumber },
          invoiceDefaults: m.invoiceDefaults ?? { terms: null, notes: null },
        });
        setReady(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load master data.');
        setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { ready, error, nextInvoiceNumber, nextBillNumber };
}
