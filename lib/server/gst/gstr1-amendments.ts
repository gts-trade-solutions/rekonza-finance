import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-1 amendments: tables 9A, 9C and 10.
//
// A return once filed is never revised. If an invoice, credit note or debit
// note reported in a filed GSTR-1 is changed afterwards — its value, its rate,
// the buyer's GSTIN, the place of supply — section 37(3) of the CGST Act has
// the change reported in a later return, in the amendment tables, with the
// document's original number and date:
//
//   9A  B2BA, B2CLA, EXPA   invoices to registered buyers, large consumer
//                           sales, exports
//   9C  CDNRA, CDNURA       credit and debit notes
//   10  B2CSA               the consumer summary of an earlier month, revised
//
// and no later than 30 November after the end of the financial year (or the
// annual return, if earlier).
//
// To know what was filed, the return is kept document by document when it is
// marked filed (gst_filed_documents, migration 133). The latest version filed
// of a document is its row with the latest period: an amendment, once its own
// return is filed, becomes the version later changes are compared with.
//
// A filed document that is now void or deleted is listed too, but not put in
// the file: the portal does not take an amendment to nil, so the way to undo a
// filed invoice is a credit note. Moving a document from one table to another
// (a consumer sale whose buyer turns out to be registered) is listed for the
// same reason — the portal amends a document only within its own table.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { gstr1Build, type Gstr1DocEntry, type Gstr1Section } from './gstr1-json';

const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const day = (v: unknown) => (v ? String(v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString() : v).slice(0, 10) : '');
const p = toPaiseFromSql;

export type AmendmentKind = 'b2ba' | 'b2cla' | 'expa' | 'cdnra' | 'cdnura' | 'b2csa';

export interface Gstr1Figures {
  valuePaise: Paise; taxablePaise: Paise; igstPaise: Paise; cgstPaise: Paise; sgstPaise: Paise; cessPaise: Paise;
}

export interface Gstr1Amendment {
  table: '9A' | '9C' | '10';
  kind: AmendmentKind;
  docType: Gstr1DocEntry['docType'];
  docId: number;
  /** The month of the return that first reported it. */
  originalPeriod: string;
  originalNumber: string;
  originalDate: string;
  number: string;
  date: string;
  ctin: string | null;
  pos: string;
  /** As last filed, and as the books hold it now. */
  before: Gstr1Figures;
  after: Gstr1Figures;
  /** What changed, in words. */
  changes: string[];
  /** Void or deleted since: listed, not put in the file. */
  cancelled: boolean;
  /** Now in a different table: listed, not put in the file. */
  movedTo: Gstr1Section | null;
  /** In the file the return downloads. */
  inFile: boolean;
  /** An export or SEZ supply: its difference goes in GSTR-3B 3.1(b), not 3.1(a). */
  zeroRated: boolean;
}

export interface Gstr1AmendmentFile {
  b2ba: unknown[]; b2cla: unknown[]; expa: unknown[]; cdnra: unknown[]; cdnura: unknown[]; b2csa: unknown[];
}

interface FiledRow {
  period: string; doc_type: Gstr1DocEntry['docType']; doc_id: number; number: string; doc_date: string | null;
  section: Gstr1Section; ctin: string | null; pos: string | null;
  value: string; taxable: string; igst: string; cgst: string; sgst: string; cess: string;
  detail: unknown; created_at: Date | string;
}

const figuresOfRow = (r: FiledRow): Gstr1Figures => ({
  valuePaise: p(r.value), taxablePaise: p(r.taxable), igstPaise: p(r.igst), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst), cessPaise: p(r.cess),
});
const figuresOfDoc = (d: Gstr1DocEntry): Gstr1Figures => ({
  valuePaise: d.valuePaise, taxablePaise: d.taxablePaise, igstPaise: d.igstPaise, cgstPaise: d.cgstPaise, sgstPaise: d.sgstPaise, cessPaise: d.cessPaise,
});
const NIL: Gstr1Figures = { valuePaise: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 };

const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as { rates?: Gstr1DocEntry['rates']; entry?: Record<string, unknown> | null; group?: Record<string, unknown> } | null;
const rateKey = (rates: Gstr1DocEntry['rates'] | undefined) =>
  JSON.stringify([...(rates ?? [])].map((r) => [r.rt, r.txval, r.iamt, r.camt, r.samt, r.csamt]).sort());

const KIND: Partial<Record<Gstr1Section, { kind: AmendmentKind; table: Gstr1Amendment['table'] }>> = {
  b2b: { kind: 'b2ba', table: '9A' },
  b2cl: { kind: 'b2cla', table: '9A' },
  exp: { kind: 'expa', table: '9A' },
  cdnr: { kind: 'cdnra', table: '9C' },
  cdnur: { kind: 'cdnura', table: '9C' },
  b2cs: { kind: 'b2csa', table: '10' },
};

const SECTION_LABEL: Record<Gstr1Section, string> = {
  b2b: 'B2B', b2cl: 'B2CL', exp: 'exports', b2cs: 'B2CS', cdnr: 'CDNR', cdnur: 'CDNUR', nil: 'nil-rated / exempt', eco95: 'table 14(b)',
};

/** What changed between the version filed and the books now. */
function differences(filed: FiledRow, now: Gstr1DocEntry): string[] {
  const out: string[] = [];
  if (filed.number !== now.number) out.push(`number ${filed.number} → ${now.number}`);
  if (day(filed.doc_date) !== now.date) out.push(`date ${day(filed.doc_date)} → ${now.date}`);
  if ((filed.ctin ?? null) !== (now.ctin ?? null)) out.push(`buyer GSTIN ${filed.ctin ?? 'none'} → ${now.ctin ?? 'none'}`);
  if ((filed.pos ?? '') !== now.pos) out.push(`place of supply ${filed.pos} → ${now.pos}`);
  if (p(filed.value) !== now.valuePaise) out.push(`value ₹${(p(filed.value) / 100).toFixed(2)} → ₹${(now.valuePaise / 100).toFixed(2)}`);
  if (rateKey(parse(filed.detail)?.rates) !== rateKey(now.rates)) out.push('taxable value or tax by rate');
  return out;
}

/** The latest version filed of every document reported before `month`, with the first time it was. */
async function filedBefore(ex: Executor, orgId: number, month: string) {
  const { rows } = await sql<FiledRow>`
    SELECT period, doc_type, doc_id, number, doc_date, section, ctin, pos, value, taxable, igst, cgst, sgst, cess, detail, created_at
      FROM gst_filed_documents
     WHERE org_id = ${orgId} AND return_type = 'GSTR1' AND period < ${month}
     ORDER BY period
  `.execute(ex);
  const first = new Map<string, FiledRow>();
  const latest = new Map<string, FiledRow>();
  for (const r of rows) {
    const k = `${r.doc_type}:${r.doc_id}`;
    if (!first.has(k)) first.set(k, r);
    latest.set(k, r);
  }
  return { first, latest };
}

/**
 * The documents of filed returns changed since: candidates only. Anything
 * written after its latest filing (an edit reverses and posts again, a payment
 * touches the invoice too), voided, or deleted. Each is then compared with
 * what was filed, so a payment received is not mistaken for an amendment.
 */
async function touchedSince(ex: Executor, orgId: number, latest: Map<string, FiledRow>) {
  if (!latest.size) return new Set<string>();
  const ids = (t: string) => [...latest.values()].filter((r) => r.doc_type === t || (t === 'invoice' && r.doc_type === 'debit_note')).map((r) => Number(r.doc_id));
  const invIds = ids('invoice');
  const cnIds = ids('credit_note');
  const touched = new Set<string>();
  const filedAt = (k: string) => new Date(latest.get(k)!.created_at as string).getTime();
  if (invIds.length) {
    const inv = await ex.selectFrom('invoices').select(['id', 'doc_kind', 'status', 'updated_at']).where('org_id', '=', orgId).where('id', 'in', invIds).execute();
    const seen = new Set(inv.map((i) => i.id));
    for (const i of inv) {
      const k = `${i.doc_kind === 'debit_note' ? 'debit_note' : 'invoice'}:${i.id}`;
      if (!latest.has(k)) continue;
      if (i.status === 'void' || i.status === 'draft' || new Date(i.updated_at as unknown as string).getTime() >= filedAt(k)) touched.add(k);
    }
    for (const id of invIds) if (!seen.has(id)) { touched.add(`invoice:${id}`); touched.add(`debit_note:${id}`); }
  }
  if (cnIds.length) {
    const cn = await ex.selectFrom('credit_notes').select(['id', 'status', 'updated_at']).where('org_id', '=', orgId).where('id', 'in', cnIds).execute();
    const seen = new Set(cn.map((c) => c.id));
    for (const c of cn) {
      const k = `credit_note:${c.id}`;
      if (c.status === 'void' || c.status === 'draft' || new Date(c.updated_at as unknown as string).getTime() >= filedAt(k)) touched.add(k);
    }
    for (const id of cnIds) if (!seen.has(id)) touched.add(`credit_note:${id}`);
  }
  return new Set([...touched].filter((k) => latest.has(k)));
}

const monthOf = (iso: string) => iso.slice(0, 7);
const mmyyyy = (m: string) => `${m.slice(5, 7)}${m.slice(0, 4)}`;

/** Put the amendments into the shape the portal file takes. */
function toFile(rows: { a: Gstr1Amendment; now: Gstr1DocEntry | null }[], b2csRevised: unknown[]): Gstr1AmendmentFile {
  const byKey = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);
  const b2ba = new Map<string, unknown[]>();
  const b2cla = new Map<string, unknown[]>();
  const expa = new Map<string, unknown[]>();
  const cdnra = new Map<string, unknown[]>();
  const cdnura: unknown[] = [];
  for (const { a, now } of rows) {
    if (!a.inFile || !now?.entry) continue;
    const orig = { o: a.originalNumber, d: dmy(a.originalDate) };
    switch (a.kind) {
      case 'b2ba': byKey(b2ba, now.ctin ?? '', { oinum: orig.o, oidt: orig.d, ...now.entry }); break;
      case 'b2cla': byKey(b2cla, now.pos, { oinum: orig.o, oidt: orig.d, ...now.entry }); break;
      case 'expa': byKey(expa, String(now.group.exp_typ ?? 'WOPAY'), { oinum: orig.o, oidt: orig.d, ...now.entry }); break;
      case 'cdnra': byKey(cdnra, now.ctin ?? '', { ont_num: orig.o, ont_dt: orig.d, ...now.entry }); break;
      case 'cdnura': cdnura.push({ ont_num: orig.o, ont_dt: orig.d, ...now.entry }); break;
      default: break;
    }
  }
  return {
    b2ba: [...b2ba].map(([ctin, inv]) => ({ ctin, inv })),
    b2cla: [...b2cla].map(([pos, inv]) => ({ pos, inv })),
    expa: [...expa].map(([exp_typ, inv]) => ({ exp_typ, inv })),
    cdnra: [...cdnra].map(([ctin, nt]) => ({ ctin, nt })),
    cdnura,
    b2csa: b2csRevised,
  };
}

/**
 * The consumer summary of an earlier month, revised (table 10): for each place
 * of supply that a changed B2CS document touches, the whole of that month's
 * figures as they stand now, rate by rate — the portal replaces the row.
 */
function b2csRevision(period: string, docsNow: Gstr1DocEntry[], touched: { pos: string; sply: string }[]) {
  const keys = new Set(touched.map((t) => `${t.sply}|${t.pos}`));
  const sum = new Map<string, Map<number, { rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>>();
  for (const d of docsNow) {
    if (d.section !== 'b2cs') continue;
    const k = `${String(d.group.sply_ty)}|${d.pos}`;
    if (!keys.has(k)) continue;
    const byRate = sum.get(k) ?? new Map();
    for (const r of d.rates) {
      const have = byRate.get(r.rt) ?? { rt: r.rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      byRate.set(r.rt, {
        rt: r.rt, txval: have.txval + r.txval, iamt: have.iamt + r.iamt, camt: have.camt + r.camt, samt: have.samt + r.samt, csamt: have.csamt + r.csamt,
      });
    }
    sum.set(k, byRate);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return [...keys].map((k) => {
    const [sply_ty, pos] = k.split('|');
    const itms = [...(sum.get(k)?.values() ?? [])].map((r) => ({ rt: r.rt, txval: round(r.txval), iamt: round(r.iamt), camt: round(r.camt), samt: round(r.samt), csamt: round(r.csamt) }));
    return { omon: mmyyyy(period), sply_ty, pos, typ: 'OE', itms: itms.length ? itms : [{ rt: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }] };
  });
}

/** An export or a supply to an SEZ: zero-rated (IGST Act s.16). */
function isZeroRated(d: Gstr1DocEntry) {
  const e = (d.entry ?? {}) as Record<string, unknown>;
  return d.section === 'exp' || ['SEWP', 'SEWOP'].includes(String(e.inv_typ)) || ['EXPWP', 'EXPWOP'].includes(String(e.typ));
}

/**
 * What the amendments a return period carries add to (or take off) the tax of
 * that period: GSTR-3B is filled from GSTR-1 amendments and all, so the
 * difference an amended invoice makes is declared, and paid, in the month the
 * amendment is reported (s.37(3) with s.39). Voided or moved documents are
 * left out: the portal does not take those as amendments (see above).
 */
export async function amendmentDeltas(ex: Executor, orgId: number, months: string[]) {
  const out: { row: '3.1a' | '3.1b'; month: string; a: Gstr1Amendment; delta: Gstr1Figures }[] = [];
  for (const m of months) {
    const { rows } = await gstr1Amendments(ex, orgId, m);
    for (const a of rows) {
      if (a.cancelled || a.movedTo) continue;
      const delta: Gstr1Figures = {
        valuePaise: a.after.valuePaise - a.before.valuePaise, taxablePaise: a.after.taxablePaise - a.before.taxablePaise,
        igstPaise: a.after.igstPaise - a.before.igstPaise, cgstPaise: a.after.cgstPaise - a.before.cgstPaise,
        sgstPaise: a.after.sgstPaise - a.before.sgstPaise, cessPaise: a.after.cessPaise - a.before.cessPaise,
      };
      if (!delta.taxablePaise && !delta.igstPaise && !delta.cgstPaise && !delta.sgstPaise && !delta.cessPaise) continue;
      out.push({ row: a.zeroRated ? '3.1b' : '3.1a', month: m, a, delta });
    }
  }
  return out;
}

/** Has GSTR-1 for the month been marked filed? */
async function isFiled(ex: Executor, orgId: number, month: string) {
  const f = await ex.selectFrom('compliance_filings').select('id').where('org_id', '=', orgId).where('item_key', 'in', ['gstr1', 'iff']).where('period', '=', month).executeTakeFirst();
  return !!f;
}

/**
 * The amendments a month's GSTR-1 carries. For a month not yet filed: every
 * document of an earlier filed return that the books now hold differently.
 * For a filed month: what its own filing carried, as recorded then.
 */
export async function gstr1Amendments(ex: Executor, orgId: number, month: string): Promise<{ rows: Gstr1Amendment[]; file: Gstr1AmendmentFile }> {
  const { first, latest } = await filedBefore(ex, orgId, month);
  const out: { a: Gstr1Amendment; now: Gstr1DocEntry | null }[] = [];
  const b2csTouched = new Map<string, { pos: string; sply: string }[]>();

  if (await isFiled(ex, orgId, month)) {
    // What this month's own filing carried: its rows for documents first filed earlier.
    const { rows } = await sql<FiledRow>`
      SELECT period, doc_type, doc_id, number, doc_date, section, ctin, pos, value, taxable, igst, cgst, sgst, cess, detail, created_at
        FROM gst_filed_documents WHERE org_id = ${orgId} AND return_type = 'GSTR1' AND period = ${month}
    `.execute(ex);
    for (const r of rows) {
      const k = `${r.doc_type}:${r.doc_id}`;
      const orig = first.get(k);
      const before = latest.get(k);
      if (!orig || !before) continue;
      const map = KIND[r.section];
      if (!map) continue;
      const d = parse(r.detail);
      const now: Gstr1DocEntry = {
        docType: r.doc_type, docId: Number(r.doc_id), number: r.number, date: day(r.doc_date), section: r.section, ctin: r.ctin, pos: r.pos ?? '',
        ...figuresOfRow(r), entry: d?.entry ?? null, group: d?.group ?? {}, rates: d?.rates ?? [],
      };
      if (r.section === 'b2cs') {
        b2csTouched.set(orig.period, [...(b2csTouched.get(orig.period) ?? []), { pos: now.pos, sply: String(now.group.sply_ty ?? 'INTRA') }]);
      }
      out.push({
        a: {
          ...map, docType: r.doc_type, docId: Number(r.doc_id), originalPeriod: orig.period, originalNumber: orig.number, originalDate: day(orig.doc_date),
          number: r.number, date: day(r.doc_date), ctin: r.ctin, pos: r.pos ?? '', before: figuresOfRow(before), after: figuresOfRow(r),
          changes: differences(before, now), cancelled: false, movedTo: null, inFile: r.section !== 'b2cs', zeroRated: isZeroRated(now),
        },
        now,
      });
    }
    const revised = (await Promise.all([...b2csTouched].map(async ([period, t]) => {
      const { docs } = await gstr1Build(ex, orgId, period);
      return b2csRevision(period, docs, t);
    }))).flat();
    return { rows: out.map((x) => x.a), file: toFile(out, revised) };
  }

  const touched = await touchedSince(ex, orgId, latest);
  // The months whose documents need building again, to see each as it is now.
  const periods = new Set<string>();
  for (const k of touched) periods.add(first.get(k)!.period);
  const built = new Map<string, Gstr1DocEntry[]>();
  const docsOf = async (period: string) => {
    if (!built.has(period)) built.set(period, (await gstr1Build(ex, orgId, period)).docs);
    return built.get(period)!;
  };

  for (const k of touched) {
    const orig = first.get(k)!;
    const before = latest.get(k)!;
    const [docType, idText] = k.split(':');
    const id = Number(idText);
    let now = (await docsOf(orig.period)).find((d) => d.docType === docType && d.docId === id) ?? null;
    if (!now) {
      // Its date may have moved: look for it where it is dated now.
      const cur = docType === 'credit_note'
        ? await ex.selectFrom('credit_notes').select(['note_date as d', 'status']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst()
        : await ex.selectFrom('invoices').select(['invoice_date as d', 'status']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (cur && cur.status !== 'void' && cur.status !== 'draft' && monthOf(day(cur.d)) !== orig.period && monthOf(day(cur.d)) < month) {
        now = (await docsOf(monthOf(day(cur.d)))).find((d) => d.docType === docType && d.docId === id) ?? null;
      }
    }
    const map = KIND[before.section];
    if (!map) continue;
    const base = {
      ...map, docType: docType as Gstr1DocEntry['docType'], docId: id, originalPeriod: orig.period, originalNumber: orig.number, originalDate: day(orig.doc_date),
      ctin: now?.ctin ?? before.ctin, pos: now?.pos ?? before.pos ?? '', before: figuresOfRow(before),
    };
    if (!now) {
      out.push({
        a: { ...base, number: before.number, date: day(before.doc_date), after: NIL, changes: ['void or deleted since it was filed'], cancelled: true, movedTo: null, inFile: false, zeroRated: before.section === 'exp' },
        now: null,
      });
      continue;
    }
    const changes = differences(before, now);
    if (!changes.length && now.section === before.section) continue;
    const moved = now.section !== before.section ? now.section : null;
    if (moved) changes.unshift(`now in ${SECTION_LABEL[moved]}, filed in ${SECTION_LABEL[before.section]}`);
    if (before.section === 'b2cs' && !moved) {
      b2csTouched.set(orig.period, [...(b2csTouched.get(orig.period) ?? []), { pos: now.pos, sply: String(now.group.sply_ty ?? 'INTRA') }]);
      if (before.pos && before.pos !== now.pos) b2csTouched.get(orig.period)!.push({ pos: before.pos, sply: String(parse(before.detail)?.group?.sply_ty ?? 'INTRA') });
    }
    out.push({
      a: { ...base, number: now.number, date: now.date, after: figuresOfDoc(now), changes, cancelled: false, movedTo: moved, inFile: !moved && before.section !== 'b2cs', zeroRated: isZeroRated(now) },
      now,
    });
  }

  const revised = (await Promise.all([...b2csTouched].map(async ([period, t]) => b2csRevision(period, await docsOf(period), t)))).flat();
  out.sort((x, y) => x.a.originalPeriod.localeCompare(y.a.originalPeriod) || x.a.originalNumber.localeCompare(y.a.originalNumber));
  return { rows: out.map((x) => x.a), file: toFile(out, revised) };
}

/**
 * Keep what a month's GSTR-1 (or IFF) carried, document by document, as it is
 * marked filed: its own documents and the amendments it reported. Run again,
 * it replaces the month's rows, so marking a return filed twice is harmless.
 */
export async function snapshotGstr1(trx: Trx, orgId: number, month: string, scope: 'gstr1' | 'iff' = 'gstr1'): Promise<number> {
  // The amendments are worked out before the month counts as filed.
  await trx.deleteFrom('gst_filed_documents').where('org_id', '=', orgId).where('return_type', '=', 'GSTR1').where('period', '=', month).execute();
  const { file, docs } = await gstr1Build(trx, orgId, month, { scope });
  const amended = await (async () => {
    // Worked out as for an open month, whatever the filing mark says by now.
    const { first, latest } = await filedBefore(trx, orgId, month);
    const touched = await touchedSince(trx, orgId, latest);
    const out: Gstr1DocEntry[] = [];
    const cache = new Map<string, Gstr1DocEntry[]>();
    for (const k of touched) {
      const orig = first.get(k)!;
      const before = latest.get(k)!;
      if (!cache.has(orig.period)) cache.set(orig.period, (await gstr1Build(trx, orgId, orig.period)).docs);
      const [t, id] = k.split(':');
      const now = cache.get(orig.period)!.find((d) => d.docType === t && d.docId === Number(id));
      if (now && (differences(before, now).length || now.section !== before.section)) out.push(now);
    }
    return out;
  })();
  const rows = [...docs, ...amended.filter((a) => !docs.some((d) => d.docType === a.docType && d.docId === a.docId))];
  if (!rows.length) return 0;
  await trx.insertInto('gst_filed_documents').values(rows.map((d) => ({
    org_id: orgId, return_type: 'GSTR1', period: month, gstin: file.gstin || null,
    doc_type: d.docType, doc_id: d.docId, number: d.number, doc_date: d.date, section: d.section,
    ctin: d.ctin, pos: d.pos || null,
    value: toSqlFromPaise(d.valuePaise), taxable: toSqlFromPaise(d.taxablePaise),
    igst: toSqlFromPaise(d.igstPaise), cgst: toSqlFromPaise(d.cgstPaise), sgst: toSqlFromPaise(d.sgstPaise), cess: toSqlFromPaise(d.cessPaise),
    detail: JSON.stringify({ entry: d.entry, group: d.group, rates: d.rates }),
  }))).execute();
  return rows.length;
}
