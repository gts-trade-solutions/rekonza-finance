import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Filling a customer or vendor in from its GSTIN or its CIN, as Zoho Books
// prefills from a GSTIN.
//
// What the number itself says comes first and needs no one: a GSTIN carries
// its state (characters 1-2), its PAN (3-12) and so the kind of business (the
// PAN's fourth letter), and a check digit that catches a typo. A CIN carries
// whether the company is listed, its state, its year of incorporation and its
// kind (private, public, one-person …).
//
// The rest — the registered name and address, whether the registration is
// active, the date it was granted, the exact date a company was incorporated —
// is the government's record, and comes from whichever is set up:
//
//   1. the GSP (GST_API_*), through the GST system's own taxpayer search;
//   2. a GSTIN lookup service (GSTIN_LOOKUP_URL …): ClearTax, Masters India,
//      Vayana, Signzy and others answer in the GST system's own format
//      (lgnm, tradeNam, rgdt, pradr …), found wherever it sits in their reply;
//   3. for the incorporation date, a company (MCA) lookup service
//      (COMPANY_LOOKUP_URL …) answering for a CIN.
//
// Each URL is a template: {gstin} or {cin}, and {key} for the service's key;
// *_HEADERS is JSON with the same placeholders; *_BODY, when set, makes it a
// POST of that JSON. Answers are kept for twelve hours, so a form opened twice
// does not pay twice.
// ─────────────────────────────────────────────────────────────────────────────

import { badRequest, ApiError } from '../http';
import { isValidGstin } from '../../tax/gst';
import type { TaxpayerDetails } from './gst/returns-provider';

export type DetailsSource = 'gst-system' | 'lookup-service' | 'number';
export interface PartyDetails extends TaxpayerDetails {
  pan: string;
  source: DetailsSource;
}

/** The PAN's fourth letter: the kind of holder. */
const PAN_KIND: Record<string, string> = {
  C: 'Company', F: 'Partnership firm or LLP', P: 'Proprietorship', H: 'Hindu Undivided Family', A: 'Association of Persons',
  T: 'Trust', B: 'Body of Individuals', L: 'Local authority', J: 'Artificial juridical person', G: 'Government',
};

const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** What a GSTIN says by itself. Refuses a number whose check digit is wrong. */
export function gstinFacts(raw: string): PartyDetails {
  const gstin = raw.trim().toUpperCase();
  if (!GSTIN_SHAPE.test(gstin)) throw badRequest('That is not a GSTIN: 15 characters, like 33AABCR1234A1Z5.');
  if (!isValidGstin(gstin)) throw badRequest('That GSTIN’s last character does not match the rest: check it for a typo.');
  return {
    gstin, pan: gstin.slice(2, 12), legalName: null, tradeName: null, status: null,
    taxpayerType: null, constitution: PAN_KIND[gstin[5]] ?? null, registeredOn: null, cancelledOn: null,
    address: { line: null, city: null, district: null, stateCode: gstin.slice(0, 2), pincode: null },
    fromPortal: false, source: 'number',
  };
}

/** "21/07/2017", "21-07-2017" or "2017-07-21" as 2017-07-21; anything else as null. */
export function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const realFetch: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
let fetcher: Fetcher = realFetch;
/** For tests: answer the services without the network. */
export function setLookupFetcher(f: Fetcher | null) { fetcher = f ?? realFetch; cache.clear(); }

const cache = new Map<string, { at: number; value: unknown }>();
const KEEP_MS = 12 * 3600_000;

/** Call a configured service: URL, headers and body templates filled with the number and the key. */
async function callService(prefix: 'GSTIN_LOOKUP' | 'COMPANY_LOOKUP', vars: Record<string, string>): Promise<unknown> {
  const template = process.env[`${prefix}_URL`]?.trim();
  if (!template) return null;
  const all = { ...vars, key: process.env[`${prefix}_KEY`]?.trim() ?? '' };
  const fill = (t: string, enc: boolean) => t.replace(/\{(\w+)\}/g, (w, k: string) => (k in all ? (enc ? encodeURIComponent(all[k as keyof typeof all]) : all[k as keyof typeof all]) : w));
  const url = fill(template, true);
  const bodyTemplate = process.env[`${prefix}_BODY`]?.trim();
  const body = bodyTemplate ? fill(bodyTemplate, false) : null;
  // A service asked by POST carries the number in the body, not the URL: both make the key.
  const key = `${prefix} ${url} ${body ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.value;
  let headers: Record<string, string> = { accept: 'application/json' };
  const rawHeaders = process.env[`${prefix}_HEADERS`]?.trim();
  if (rawHeaders) {
    try { headers = { ...headers, ...JSON.parse(fill(rawHeaders, false)) as Record<string, string> }; } catch { /* a malformed setting is ignored, not fatal */ }
  }
  const res = await fetcher(url, body
    ? { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }
    : { method: 'GET', headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(502, `The lookup service answered ${res.status}. Check its key and how many lookups are left.`, 'lookup_failed');
  const value = await res.json().catch(() => null);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The first object, at any depth, that has one of these keys (compared without case or punctuation). */
function findWith(value: unknown, keys: string[], depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  const want = new Set(keys.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (!Array.isArray(value) && Object.keys(value).some((k) => want.has(k.toLowerCase().replace(/[^a-z0-9]/g, '')))) return value as Record<string, unknown>;
  for (const v of Object.values(value)) {
    const found = findWith(v, keys, depth + 1);
    if (found) return found;
  }
  return null;
}
const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const k of keys) {
    const hitKey = Object.keys(o).find((x) => norm(x) === norm(k));
    if (hitKey && o[hitKey] != null && String(o[hitKey]).trim() !== '') return String(o[hitKey]).trim();
  }
  return null;
};

/** A reply in the GST system's taxpayer format, wherever it sits, merged over what the number says. */
export function fromGstRecord(reply: unknown, base: PartyDetails, source: DetailsSource): PartyDetails | null {
  const d = findWith(reply, ['lgnm', 'tradeNam', 'legalName', 'legal_name']);
  if (!d) return null;
  const addrHolder = findWith(d.pradr ?? d, ['bnm', 'bno', 'st', 'loc', 'pncd', 'pincode']);
  const a = (addrHolder?.addr ?? addrHolder) as Record<string, unknown> | null;
  const line = a ? [pick(a, 'bno'), pick(a, 'flno'), pick(a, 'bnm'), pick(a, 'st'), pick(a, 'loc')].filter(Boolean).join(', ') || pick(a, 'address', 'adr') : null;
  return {
    ...base,
    legalName: pick(d, 'lgnm', 'legalName', 'legal_name') ?? base.legalName,
    tradeName: pick(d, 'tradeNam', 'tradeName', 'trade_name') ?? base.tradeName,
    status: pick(d, 'sts', 'status', 'gstinStatus') ?? base.status,
    taxpayerType: pick(d, 'dty', 'taxpayerType', 'taxpayer_type') ?? base.taxpayerType,
    constitution: pick(d, 'ctb', 'constitutionOfBusiness', 'constitution') ?? base.constitution,
    registeredOn: isoDate(pick(d, 'rgdt', 'registrationDate', 'registration_date', 'dateOfRegistration')) ?? base.registeredOn,
    cancelledOn: isoDate(pick(d, 'cxdt', 'cancellationDate', 'cancellation_date')) ?? base.cancelledOn,
    address: a ? {
      line, city: pick(a, 'city', 'dst', 'loc'), district: pick(a, 'dst', 'district'),
      stateCode: base.gstin.slice(0, 2), pincode: pick(a, 'pncd', 'pincode', 'pin'),
    } : base.address,
    fromPortal: true, source,
  };
}

/** Everything known about a GSTIN: the number, then the GSP, then a lookup service. */
export async function lookupParty(raw: string, viaGsp: ((gstin: string) => Promise<TaxpayerDetails>) | null): Promise<PartyDetails> {
  const base = gstinFacts(raw);
  if (viaGsp) {
    const t = await viaGsp(base.gstin);
    return { ...base, ...t, pan: base.pan, registeredOn: isoDate(t.registeredOn) ?? t.registeredOn, constitution: t.constitution ?? base.constitution, source: 'gst-system' };
  }
  const reply = await callService('GSTIN_LOOKUP', { gstin: base.gstin });
  if (reply == null) return base;
  return fromGstRecord(reply, base, 'lookup-service') ?? base;
}

// ── Companies: the CIN and the incorporation date ───────────────────────────

const CIN_SHAPE = /^([LU])(\d{5})([A-Z]{2})(\d{4})([A-Z]{3})(\d{6})$/;
const CIN_KIND: Record<string, string> = {
  PTC: 'Private limited company', PLC: 'Public limited company', OPC: 'One person company', GOI: 'Government of India company',
  SGC: 'State government company', NPL: 'Not-for-profit (section 8) company', ULL: 'Unlimited company', ULT: 'Unlimited company', FLC: 'Financial lease company', GAP: 'Public company limited by guarantee', GAT: 'Private company limited by guarantee',
};
/** The two-letter state codes a CIN uses (the vehicle registration letters). */
const CIN_STATE: Record<string, string> = {
  AN: 'Andaman and Nicobar', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CH: 'Chandigarh', CT: 'Chhattisgarh', CG: 'Chhattisgarh',
  DL: 'Delhi', DN: 'Dadra and Nagar Haveli', DD: 'Daman and Diu', GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu and Kashmir',
  JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya',
  MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', OD: 'Odisha', PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana',
  TS: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UR: 'Uttarakhand', UK: 'Uttarakhand', WB: 'West Bengal',
};

export interface CompanyDetails {
  cin: string;
  listed: boolean;
  state: string | null;
  kind: string | null;
  incorporatedYear: number;
  /** The exact date, from the MCA record; null until a company lookup service answers. */
  incorporatedOn: string | null;
  name: string | null;
  status: string | null;
  source: 'number' | 'lookup-service';
}

/** What a CIN says by itself: listed or not, state, year of incorporation, kind. */
export function cinFacts(raw: string): CompanyDetails {
  const cin = raw.trim().toUpperCase();
  const m = CIN_SHAPE.exec(cin);
  if (!m) throw badRequest('That is not a CIN: 21 characters, like U74999TN2015PTC123456.');
  const year = Number(m[4]);
  if (year < 1850 || year > new Date().getFullYear()) throw badRequest('That CIN’s year of incorporation cannot be right: check it for a typo.');
  return {
    cin, listed: m[1] === 'L', state: CIN_STATE[m[3]] ?? null, kind: CIN_KIND[m[5]] ?? null,
    incorporatedYear: year, incorporatedOn: null, name: null, status: null, source: 'number',
  };
}

/** Everything known about a CIN: the number, then a company (MCA) lookup service. */
export async function lookupCompany(raw: string): Promise<CompanyDetails> {
  const base = cinFacts(raw);
  const reply = await callService('COMPANY_LOOKUP', { cin: base.cin });
  if (reply == null) return base;
  const d = findWith(reply, ['dateOfIncorporation', 'date_of_incorporation', 'incorporationDate', 'incorporatedOn', 'companyName', 'company_name']);
  if (!d) return base;
  const on = isoDate(pick(d, 'dateOfIncorporation', 'date_of_incorporation', 'incorporationDate', 'incorporation_date', 'incorporatedOn', 'dateOfRegistration'));
  return {
    ...base,
    incorporatedOn: on,
    name: pick(d, 'companyName', 'company_name', 'name') ?? null,
    status: pick(d, 'companyStatus', 'company_status', 'status') ?? null,
    source: 'lookup-service',
  };
}

/** Whether each lookup is set up, for the go-live check and the forms. */
export const lookupServices = () => ({
  gstin: !!process.env.GSTIN_LOOKUP_URL?.trim(),
  company: !!process.env.COMPANY_LOOKUP_URL?.trim(),
});
