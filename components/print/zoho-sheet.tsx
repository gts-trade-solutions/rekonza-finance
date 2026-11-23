'use client';

// ─────────────────────────────────────────────────────────────────────────────
// A document set out in one of Zoho Books' twelve PDF templates.
//
// Every printed document (invoices, quotes, orders, challans, credit notes,
// receipts, bills …) is first read into a SheetModel by its own screen, with
// what the law wants on its face already decided: the title (Tax Invoice, Bill
// of Supply …), the endorsement, the tax columns, the amount in words, the
// e-invoice IRN and QR. This file only decides where each part sits, as the
// template the business chose in Settings → PDF Templates lays it out.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, Fragment, useContext, type CSSProperties, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { cn } from '@/lib/utils';
import { translate, type PrintLanguage } from '@/lib/print-languages';
import { accentOf, type PrintTemplate, type TemplateKey } from '@/lib/print-template';
import { rupeesInWords } from '@/lib/billing/words';
import { stateName } from '@/lib/tax/gst';
import { PAYMENT_TERMS } from '@/lib/options';

export interface SheetParty {
  label: string;
  name: string | null;
  lines: string[];
  gstin?: string | null;
}

export interface SheetLine {
  name: string;
  description: string | null;
  hsn: string | null;
  qty: number | null;
  unit: string | null;
  ratePaise: number | null;
  discountPct: number;
  taxablePaise: number;
  gstRatePct: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  amountPaise: number;
}

export interface SheetModel {
  /** "TAX INVOICE", "QUOTE", "BILL OF SUPPLY" … */
  title: string;
  /** "Invoice#", "Quote#" … */
  numberLabel: string;
  number: string;
  /** Rule 48's copy, when one is chosen. */
  copyLabel: string | null;
  /** Printed on the sheet: a draft or a cancelled document. */
  stamp: 'Draft' | 'Cancelled' | null;
  /** The words the law wants on its face (export, SEZ, composition, debit note …). */
  endorsement: string | null;
  /** More lines under the title: a voucher type's heading, a shipping bill. */
  headings: string[];
  seller: { name: string; logoUrl: string | null; lines: string[]; gstin: string | null; extra: string[] };
  billTo: SheetParty | null;
  shipTo: SheetParty | null;
  /** Beside the parties: Invoice Date, Terms, Due Date, P.O.#, Place Of Supply … */
  facts: { label: string; value: string }[];
  /** At the top of the Standard templates: "Balance Due" and its figure. */
  balance: { label: string; paise: number } | null;
  /** The date the Japanese templates print beside the number. */
  date: string;
  taxColumns: 'split' | 'integrated' | 'none';
  /** SGST, or UTGST in a union territory. */
  stateTax: string;
  lines: SheetLine[];
  /** Null when there is nothing to sum (a payment receipt). */
  subTotalPaise: number | null;
  /** After the sub total: each tax, shipping, adjustments, round off. */
  totals: { label: string; paise: number }[];
  totalLabel: string;
  totalPaise: number;
  /** After the total: Payment Made, Credits Applied … then the balance row. */
  after: { label: string; paise: number }[];
  balanceRow: { label: string; paise: number } | null;
  words: string | null;
  notes: string | null;
  terms: string | null;
  /** Bank details and the UPI code, already laid out. */
  payment: ReactNode;
  /** A payment's invoices, a credit's applications … */
  extra: ReactNode;
  /** The e-invoice's IRN and acknowledgement, already laid out, and its signed QR. */
  irn: ReactNode;
  qr: string | null;
  signatory: string | null;
  footer: string | null;
  /** The code column's heading: "HSN" on a goods invoice, "SAC" on a service one; "HSN/SAC" when mixed. */
  hsnLabel?: string;
  /** Services: quantities print without a unit. */
  unitless?: boolean;
  /** The currency the amounts are in (an export priced in dollars); rupees when absent. */
  currency?: string | null;
}

/** A payment-terms code as Zoho prints it: "net_30" is "Net 30". */
export const termsLabel = (code: string) =>
  PAYMENT_TERMS.find((x) => x.value === code)?.label ?? (/^net_(\d+)$/.test(code) ? `Net ${code.slice(4)}` : code);

/** "Tamil Nadu (33)". */
export const placeName = (code: string) => `${stateName(code)} (${code})`;

/** "Rupees … Only" as Zoho words it: "Indian Rupee … Only". */
export const zohoWords = (paise: number) => rupeesInWords(paise).replace(/^Rupees\s+/, 'Indian Rupee ');

/** An address as printed lines: the street lines, the city and PIN, the state. */
export function addressLines(address: string | null, city: string | null, pincode: string | null, stateCode?: string | null): string[] {
  const street = (address ?? '').split(/\n/).map((l) => l.trim()).filter(Boolean);
  // Plenty of addresses already end in the city and PIN; printing them again reads as a mistake.
  const cityLine = address && pincode && address.includes(pincode) ? '' : [city, pincode].filter(Boolean).join(' ');
  return [...street, ...(cityLine ? [cityLine] : []), ...(stateCode ? [placeName(stateCode)] : [])];
}

type TaxedLine = { gstRatePct: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number };

/** The tax totals Zoho lists under the sub total: one row per tax and rate. */
export function taxRows(lines: TaxedLine[], split: boolean, integrated: boolean, stateTax: string) {
  const rates = [...new Set(lines.map((l) => l.gstRatePct))].sort((a, b) => a - b);
  const rows: { label: string; paise: number }[] = [];
  const rate = (v: number) => `${Number.isInteger(v) ? v : Number(v.toFixed(2))}%`;
  for (const r of rates) {
    const of = lines.filter((l) => l.gstRatePct === r);
    if (split) {
      const c = of.reduce((t, l) => t + l.cgstPaise, 0);
      const s2 = of.reduce((t, l) => t + l.sgstPaise, 0);
      if (c) rows.push({ label: `CGST (${rate(r / 2)})`, paise: c });
      if (s2) rows.push({ label: `${stateTax} (${rate(r / 2)})`, paise: s2 });
    } else if (integrated) {
      const i = of.reduce((t, l) => t + l.igstPaise, 0);
      if (i) rows.push({ label: `IGST (${rate(r)})`, paise: i });
    }
  }
  const cess = lines.reduce((t, l) => t + l.cessPaise, 0);
  if (cess) rows.push({ label: 'Cess', paise: cess });
  return rows;
}

/** The second language labels print in, if any. */
export const SheetLang = createContext<PrintLanguage | null>(null);

/** Zoho's labels, as the second-language list knows them (lib/print-languages.ts). */
const ALIAS: Record<string, string> = {
  'bill to': 'Billed to', 'ship to': 'Shipped to', 'deliver to': 'Shipped to', 'invoice#': 'Invoice no.', 'invoice date': 'Invoice date',
  'due date': 'Due date', 'place of supply': 'Place of supply', 'reverse charge': 'Reverse charge', 'p.o.#': 'Order no.',
  'e-way bill#': 'E-way bill', 'item & description': 'Description', item: 'Description', description: 'Description', qty: 'Qty',
  rate: 'Rate', discount: 'Disc.', amount: 'Amount', 'sub total': 'Taxable value', 'shipping charge': 'Shipping', 'round off': 'Round off',
  total: 'Invoice total', 'total in words': 'Amount in words', notes: 'Notes', 'terms & conditions': 'Terms',
  'authorized signature': 'Authorised signatory', cess: 'Cess', 'tax invoice': 'Tax Invoice', 'bill of supply': 'Bill of Supply',
  invoice: 'Invoice', 'original for recipient': 'Original for recipient', 'duplicate for supplier': 'Duplicate for supplier',
  'duplicate for transporter': 'Duplicate for transporter', 'triplicate for supplier': 'Triplicate for supplier',
};

/** A label, and the same in the second language beside it. */
export function L({ t, block = false }: { t: string; block?: boolean }) {
  const lang = useContext(SheetLang);
  const bare = t.replace(/\s*:\s*$/, '');
  const local = translate(bare, lang) ?? translate(ALIAS[bare.toLowerCase()] ?? '', lang);
  if (!local) return <>{t}</>;
  return block
    ? <>{t}<span className="block text-[0.85em] font-normal normal-case tracking-normal opacity-70">{local}</span></>
    : <>{t} <span className="font-normal normal-case tracking-normal opacity-70">· {local}</span></>;
}

/** Amounts in a table: the ₹ belongs to the totals, not every cell. */
const n2 = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A total: "₹1,856.00", or "(-) ₹200.00" for a payment taken off; "$1,200.00" on a dollar invoice. */
const rupees = (paise: number, symbol = '₹') => `${paise < 0 ? '(-) ' : ''}${symbol}${n2(Math.abs(paise))}`;

/** The sign a currency prints with: ₹, $, €, or the code itself where there is no sign. */
export function currencySymbol(code: string | null | undefined): string {
  if (!code || code === 'INR') return '₹';
  try {
    const sign = new Intl.NumberFormat('en-IN', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find((x) => x.type === 'currency')?.value;
    return sign && sign !== code ? sign : `${code} `;
  } catch {
    return `${code} `;
  }
}

/** A total in the document's own currency. */
const money = (m: SheetModel, paise: number) => rupees(paise, currencySymbol(m.currency));
const qtyText = (q: number | null) => (q === null ? '' : q.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 }));
const pct = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(2).replace(/0+$/, '')}%`;

const INK = '#333333';
const GREY = '#6c6c6c';
const LIGHT = '#e3e3e3';

interface Ctx { m: SheetModel; t: PrintTemplate; key: TemplateKey; accent: string }
const SheetCtx = createContext<Ctx | null>(null);
const useSheet = () => useContext(SheetCtx)!;

/** The status ribbon across the top corner, on screen only (Zoho's preview has it, its PDF does not). */
export interface Ribbon { label: string; color: string }

export function ZohoSheet({
  model, template, layout, ribbon, last = true, className, style,
}: {
  model: SheetModel; template: PrintTemplate; layout: TemplateKey; ribbon?: Ribbon | null;
  last?: boolean; className?: string; style?: CSSProperties;
}) {
  const accent = accentOf(template, layout);
  const Body = BODIES[layout] ?? Standard;
  return (
    <SheetCtx.Provider value={{ m: model, t: template, key: layout, accent }}>
      <article
        className={cn(
          'print-sheet relative mx-auto w-full max-w-[210mm] overflow-hidden bg-white text-[11.5px] leading-[1.45] shadow-sm ring-1 ring-black/10 dark:bg-white',
          'print:max-w-none print:text-[10px] print:shadow-none print:ring-0',
          !last && 'break-after-page',
          className,
        )}
        style={{ color: INK, fontFamily: '"Open Sans", "Segoe UI", Ubuntu, Arial, sans-serif', ...style }}
        data-slot="tax-invoice"
        data-layout={layout}
      >
        {ribbon && <RibbonMark ribbon={ribbon} />}
        {/* Room for the ribbon on screen; paper has no ribbon and needs none. */}
        <div className={ribbon ? 'pt-4 print:pt-0' : undefined}><Body /></div>
      </article>
    </SheetCtx.Provider>
  );
}

function RibbonMark({ ribbon }: { ribbon: Ribbon }) {
  return (
    <div className="pointer-events-none absolute left-0 top-0 z-10 size-[86px] overflow-hidden no-print" data-slot="status-ribbon" aria-hidden>
      <div
        className="absolute left-[-34px] top-[16px] w-[130px] -rotate-45 py-[2px] text-center text-[10px] font-medium tracking-wide text-white shadow"
        style={{ backgroundColor: ribbon.color }}
      >
        {ribbon.label}
      </div>
    </div>
  );
}

// ── Parts every template uses ────────────────────────────────────────────────

function Logo({ className, big = false }: { className?: string; big?: boolean }) {
  const { m, t } = useSheet();
  if (!t.showLogo || !m.seller.logoUrl) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- printed as-is; next/image adds nothing on paper
    <img
      src={m.seller.logoUrl}
      alt={`${m.seller.name} logo`}
      className={cn('object-contain', big ? 'max-h-[84px] max-w-[240px]' : 'max-h-[70px] max-w-[200px]', className)}
      data-slot="invoice-logo"
    />
  );
}

function Seller({ align = 'left', nameClass, light = false }: { align?: 'left' | 'right' | 'center'; nameClass?: string; light?: boolean }) {
  const { m } = useSheet();
  return (
    <div className={cn('min-w-0 space-y-[1px]', align === 'right' && 'text-right', align === 'center' && 'text-center')} data-slot="sheet-seller">
      <p className={cn('text-[12.5px] font-bold', nameClass)}>{m.seller.name}</p>
      {m.seller.lines.map((l, i) => <p key={i} style={{ color: light ? undefined : GREY }}>{l}</p>)}
      {m.seller.gstin && <p style={{ color: light ? undefined : GREY }}>GSTIN {m.seller.gstin}</p>}
      {m.seller.extra.map((l, i) => <p key={`x${i}`} style={{ color: light ? undefined : GREY }}>{l}</p>)}
    </div>
  );
}

function Party({ p, align = 'left', labelStyle, nameClass, center = false }: {
  p: SheetParty | null; align?: 'left' | 'right'; labelStyle?: CSSProperties; nameClass?: string; center?: boolean;
}) {
  if (!p) return null;
  return (
    <div className={cn('min-w-0 space-y-[1px]', align === 'right' && 'text-right', center && 'text-center')} data-slot={`sheet-${p.label.toLowerCase().replace(/\s+/g, '-')}`}>
      <p style={{ color: GREY, ...labelStyle }}><L t={p.label} /></p>
      {p.name && <p className={cn('font-semibold', nameClass)}>{p.name}</p>}
      {p.lines.map((l, i) => <p key={i}>{l}</p>)}
      {p.gstin && <p>GSTIN {p.gstin}</p>}
    </div>
  );
}

/** The label: value rows beside the parties. */
function Facts({ align = 'right', labelStyle, bold = false, className, colon = true }: {
  align?: 'right' | 'left'; labelStyle?: CSSProperties; bold?: boolean; className?: string; colon?: boolean;
}) {
  const { m } = useSheet();
  if (!m.facts.length) return null;
  return (
    <table className={cn('border-collapse', className)} data-slot="sheet-facts">
      <tbody>
        {m.facts.map((f) => (
          <tr key={f.label}>
            <td className={cn('py-[3px] pr-6 align-top', align === 'right' ? 'text-right' : 'text-left', bold && 'font-semibold')} style={{ color: bold ? INK : GREY, ...labelStyle }}>
              <L t={f.label} />{colon ? ' :' : ''}
            </td>
            <td className={cn('py-[3px] align-top', align === 'right' ? 'text-right' : 'text-left')}>{f.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The title, with the copy above it and the stamp and endorsement under it. */
function Title({ className, style, align = 'right' }: { className?: string; style?: CSSProperties; align?: 'left' | 'right' | 'center' }) {
  const { m } = useSheet();
  return (
    <div className={cn(align === 'right' && 'text-right', align === 'center' && 'text-center')}>
      {m.copyLabel && <p className="text-[9.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: GREY }}><L t={m.copyLabel} /></p>}
      <h1 className={cn('text-[28px] font-normal uppercase leading-tight tracking-wide', className)} style={style}><L t={m.title} block /></h1>
      {m.stamp && (
        <span className="mt-1 inline-block rounded-[2px] border border-current px-1.5 text-[10px] font-bold uppercase tracking-wide" data-slot="sheet-stamp">{m.stamp}</span>
      )}
      {m.endorsement && <p className="mt-1 text-[10px] font-semibold uppercase">{m.endorsement}</p>}
      {m.headings.map((h) => <p key={h} className="text-[10.5px] font-semibold">{h}</p>)}
    </div>
  );
}

function NumberLine({ className }: { className?: string }) {
  const { m } = useSheet();
  return <p className={cn('text-[11px] font-semibold', className)} style={{ color: GREY }}><L t={m.numberLabel} /> {m.number}</p>;
}

function BalanceTop({ align = 'right' }: { align?: 'left' | 'right' }) {
  const { m } = useSheet();
  if (!m.balance) return null;
  return (
    <div className={cn('mt-5', align === 'right' ? 'text-right' : 'text-left')} data-slot="sheet-balance-top">
      <p className="text-[10px] font-bold"><L t={m.balance.label} /></p>
      <p className="text-[14px] font-bold">{money(m, m.balance.paise)}</p>
    </div>
  );
}

/** The e-invoice's IRN, acknowledgement and signed QR, across the top. */
function Irn() {
  const { m } = useSheet();
  if (!m.irn && !m.qr) return null;
  return (
    <div className="mb-4 flex items-start justify-between gap-4 border-b pb-3" style={{ borderColor: LIGHT }}>
      <div className="min-w-0 flex-1">{m.irn}</div>
      {m.qr && (
        <div className="shrink-0 text-center" data-slot="invoice-qr">
          <QRCodeSVG value={m.qr} size={120} level="M" marginSize={0} title="Signed QR code issued by the Invoice Registration Portal" className="size-[30mm] max-w-full" />
          <p className="mt-1 text-[8.5px] uppercase tracking-[0.08em]" style={{ color: GREY }}>e-Invoice QR</p>
        </div>
      )}
    </div>
  );
}

type TableVariant = 'dark' | 'light' | 'boxed' | 'grid' | 'accentText' | 'compact' | 'grand';

/** The item lines, in the table style the template uses. */
function Items({ variant }: { variant: TableVariant }) {
  const { m, accent } = useSheet();
  const hsn = m.lines.some((l) => l.hsn);
  const discount = m.lines.some((l) => l.discountPct > 0);
  const cess = m.lines.some((l) => l.cessPaise > 0);
  const qty = m.lines.some((l) => l.qty !== null);
  const taxGroups: { label: string; rate: (l: SheetLine) => number; amount: (l: SheetLine) => number }[] =
    m.taxColumns === 'split'
      ? [{ label: 'CGST', rate: (l) => l.gstRatePct / 2, amount: (l) => l.cgstPaise }, { label: m.stateTax, rate: (l) => l.gstRatePct / 2, amount: (l) => l.sgstPaise }]
      : m.taxColumns === 'integrated' ? [{ label: 'IGST', rate: (l) => l.gstRatePct, amount: (l) => l.igstPaise }] : [];
  const grouped = taxGroups.length > 0;
  const grand = variant === 'grand';
  const split = variant === 'compact';
  if (!m.lines.length) return null;

  const head: CSSProperties =
    variant === 'dark' ? { backgroundColor: accent, color: '#fff' }
      : variant === 'accentText' ? { color: accent, borderBottom: `1px solid ${LIGHT}` }
        : variant === 'grand' ? { color: GREY, borderBottom: `1px solid ${LIGHT}` }
          : variant === 'grid' ? { borderBottom: '1px solid #9b9b9b' }
            : { backgroundColor: '#f2f3f4', color: INK };
  const cellBorder = variant === 'grid' ? '1px solid #9b9b9b' : variant === 'boxed' || variant === 'compact' ? `1px solid ${LIGHT}` : undefined;
  const th = (extra?: string) => cn('px-2 py-[6px] font-semibold', grand && 'uppercase text-[10px] tracking-[0.04em]', extra);
  const tdStyle: CSSProperties = cellBorder ? { borderLeft: cellBorder, borderRight: cellBorder } : {};
  const rowBorder = variant === 'grid' ? '1px solid #9b9b9b' : `1px solid ${LIGHT}`;
  const rows = grouped && !grand ? 2 : 1;
  const thBox: CSSProperties = cellBorder ? { border: cellBorder } : {};

  return (
    <table className="mt-5 w-full border-collapse" style={variant === 'grid' ? { border: '1px solid #9b9b9b' } : undefined} data-slot="sheet-items">
      <thead>
        <tr style={head}>
          <th rowSpan={rows} className={th('w-7 text-center')} style={thBox}>#</th>
          {split ? (
            <>
              <th rowSpan={rows} className={th('text-left')} style={thBox}><L t="Item" /></th>
              <th rowSpan={rows} className={th('text-left')} style={thBox}><L t="Description" /></th>
            </>
          ) : (
            <th rowSpan={rows} className={th('text-left')} style={thBox}><L t={grand ? 'Item & Description' : variant === 'grid' ? 'Item' : 'Item & Description'} /></th>
          )}
          {hsn && <th rowSpan={rows} className={th('text-left')} style={thBox}>{m.hsnLabel ?? 'HSN/SAC'}</th>}
          {qty && !grand && <th rowSpan={rows} className={th('text-right')} style={thBox}><L t="Qty" /></th>}
          {qty && !grand && <th rowSpan={rows} className={th('text-right')} style={thBox}><L t="Rate" /></th>}
          {discount && <th rowSpan={rows} className={th('text-right')} style={thBox}><L t="Discount" /></th>}
          {!grand && taxGroups.map((g) => <th key={g.label} colSpan={2} className={th('text-center')} style={{ ...thBox, borderBottom: cellBorder ?? '1px solid rgba(255,255,255,.35)' }}>{g.label}</th>)}
          {grand && grouped && <th rowSpan={rows} className={th('text-right')} style={thBox}><L t="Tax" /></th>}
          {cess && <th rowSpan={rows} className={th('text-right')} style={thBox}><L t="Cess" /></th>}
          <th rowSpan={rows} className={th('text-right')} style={thBox}><L t="Amount" /></th>
        </tr>
        {rows === 2 && (
          <tr style={head}>
            {taxGroups.map((g) => (
              <Fragment key={g.label}>
                <th className={th('text-right text-[10px]')} style={thBox}>%</th>
                <th className={th('text-right text-[10px]')} style={thBox}><L t="Amt" /></th>
              </Fragment>
            ))}
          </tr>
        )}
      </thead>
      <tbody>
        {m.lines.map((l, i) => (
          <tr key={i} className="align-top" style={{ borderBottom: rowBorder }}>
            <td className="px-2 py-[7px] text-center" style={tdStyle}>{i + 1}</td>
            {split ? (
              <>
                <td className="px-2 py-[7px]" style={tdStyle}>{l.name}</td>
                <td className="px-2 py-[7px]" style={{ ...tdStyle, color: GREY }}>{l.description}</td>
              </>
            ) : (
              <td className="px-2 py-[7px]" style={tdStyle}>
                <p className={variant === 'grid' ? '' : 'font-medium'}>{l.name}</p>
                {l.description && <p className="whitespace-pre-line text-[10.5px]" style={{ color: GREY }}>{l.description}</p>}
                {variant === 'grid' && l.hsn && !hsn && <p className="text-[10px]" style={{ color: GREY }}>{m.hsnLabel ?? 'HSN'}: {l.hsn}</p>}
              </td>
            )}
            {hsn && <td className="px-2 py-[7px]" style={tdStyle}>{l.hsn}</td>}
            {qty && !grand && (
              <td className="whitespace-nowrap px-2 py-[7px] text-right tabular-nums" style={tdStyle}>
                {qtyText(l.qty)}{l.unit && !m.unitless && <span className="block text-[10px]" style={{ color: GREY }}>{l.unit}</span>}
              </td>
            )}
            {qty && !grand && <td className="px-2 py-[7px] text-right tabular-nums" style={tdStyle}>{l.ratePaise === null ? '' : n2(l.ratePaise)}</td>}
            {discount && <td className="px-2 py-[7px] text-right tabular-nums" style={tdStyle}>{l.discountPct ? pct(l.discountPct) : '0.00'}</td>}
            {!grand && taxGroups.map((g) => (
              <Fragment key={g.label}>
                <td className="px-2 py-[7px] text-right tabular-nums" style={tdStyle}>{pct(g.rate(l))}</td>
                <td className="px-2 py-[7px] text-right tabular-nums" style={tdStyle}>{n2(g.amount(l))}</td>
              </Fragment>
            ))}
            {grand && grouped && (
              <td className="px-2 py-[7px] text-right tabular-nums" style={tdStyle}>
                {n2(l.cgstPaise + l.sgstPaise + l.igstPaise)}<span className="block text-[10px]" style={{ color: GREY }}>{pct(l.gstRatePct)}</span>
              </td>
            )}
            {cess && <td className="px-2 py-[7px] text-right tabular-nums" style={tdStyle}>{n2(l.cessPaise)}</td>}
            <td className="px-2 py-[7px] text-right tabular-nums" style={tdStyle}>
              {n2(l.taxablePaise)}
              {grand && l.qty !== null && l.ratePaise !== null && <span className="block text-[10px]" style={{ color: GREY }}>{qtyText(l.qty)} x {n2(l.ratePaise)}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type TotalsVariant = 'standard' | 'grid' | 'minimalist' | 'grand' | 'basic' | 'boxed';

function Totals({ variant = 'standard', className }: { variant?: TotalsVariant; className?: string }) {
  const { m, accent } = useSheet();
  const label = variant === 'minimalist' ? { color: accent } : undefined;
  const rows: [string, number][] = [...(m.subTotalPaise === null ? [] : [['Sub Total', m.subTotalPaise] as [string, number]]), ...m.totals.map((x) => [x.label, x.paise] as [string, number])];
  const cell = variant === 'boxed' ? `1px solid ${LIGHT}` : undefined;
  const pad = variant === 'grid' ? 'py-[2px]' : 'py-[6px]';
  return (
    <table className={cn('w-full border-collapse', className)} data-slot="sheet-totals">
      <tbody>
        {rows.map(([l, v]) => (
          <tr key={l} style={cell ? { border: cell } : undefined}>
            <td className={cn(pad, 'pr-4 text-right')} style={label}><L t={l} /></td>
            <td className={cn(pad, 'w-[38%] pr-2 text-right tabular-nums')}>{n2(v)}</td>
          </tr>
        ))}
        <tr className="font-bold" style={cell ? { border: cell } : variant === 'basic' ? { borderTop: `2px solid ${accent}` } : undefined}>
          <td className={cn(pad, 'pr-4 text-right')} style={variant === 'basic' ? { color: accent } : label}>
            <L t={variant === 'basic' ? m.totalLabel.toUpperCase() : m.totalLabel} />
          </td>
          <td className={cn(pad, 'pr-2 text-right tabular-nums')} style={variant === 'basic' ? { color: accent } : undefined}>{money(m, m.totalPaise)}</td>
        </tr>
        {m.after.map((a) => (
          <tr key={a.label} style={cell ? { border: cell } : undefined}>
            <td className={cn(pad, 'pr-4 text-right')} style={label}><L t={a.label} /></td>
            <td className={cn(pad, 'pr-2 text-right tabular-nums')} style={{ color: a.paise < 0 ? '#d0383e' : undefined }}>{money(m, a.paise)}</td>
          </tr>
        ))}
        {m.balanceRow && (
          <tr
            className={cn('font-bold', variant === 'grand' && 'text-[14px]')}
            style={
              variant === 'minimalist' ? { backgroundColor: accent, color: '#fff' }
                : variant === 'grid' ? undefined
                  : variant === 'grand' ? undefined
                    : { backgroundColor: '#f5f4f3', ...(cell ? { border: cell } : {}) }
            }
            data-slot="sheet-balance-due"
          >
            <td className={cn(variant === 'grid' ? 'py-[3px]' : 'py-[9px]', 'pr-4 text-right')}><L t={m.balanceRow.label} /></td>
            <td className={cn(variant === 'grid' ? 'py-[3px]' : 'py-[9px]', 'pr-2 text-right tabular-nums')}>{money(m, m.balanceRow.paise)}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Words({ className }: { className?: string }) {
  const { m } = useSheet();
  if (!m.words) return null;
  return (
    <div className={className} data-slot="sheet-words">
      <p style={{ color: GREY }}><L t="Total In Words" /></p>
      <p className="font-semibold italic">{m.words}</p>
    </div>
  );
}

/** Notes, how to pay, the terms, and anything the document adds. */
function Closing({ labelStyle, className, termsBold = false }: { labelStyle?: CSSProperties; className?: string; termsBold?: boolean }) {
  const { m } = useSheet();
  return (
    <div className={cn('space-y-4', className)}>
      {m.extra}
      {m.notes && (
        <div data-slot="sheet-notes">
          <p style={{ color: GREY, ...labelStyle }}><L t="Notes" /></p>
          <p className="whitespace-pre-line">{m.notes}</p>
        </div>
      )}
      {m.payment}
      {m.terms && (
        <div data-slot="sheet-terms">
          <p className={termsBold ? 'font-bold' : ''} style={termsBold ? labelStyle : { color: GREY, ...labelStyle }}><L t="Terms & Conditions" /></p>
          <p className="whitespace-pre-line">{m.terms}</p>
        </div>
      )}
    </div>
  );
}

function Signature({ className, forSeller = false }: { className?: string; forSeller?: boolean }) {
  const { m, t } = useSheet();
  if (!t.showSignature) return null;
  return (
    <div className={cn('mt-10', className)} data-slot="sheet-signature">
      {forSeller && <p className="text-center">For {m.seller.name}</p>}
      {forSeller && <div className="h-12" />}
      {m.signatory && <p className={forSeller ? 'text-center font-medium' : 'font-medium'}>{m.signatory}</p>}
      <p className={forSeller ? 'text-center' : 'flex items-end gap-2'}>
        <L t="Authorized Signature" />
        {!forSeller && <span className="inline-block w-40 border-b" style={{ borderColor: '#9b9b9b' }} />}
      </p>
    </div>
  );
}

function Footer() {
  const { m } = useSheet();
  if (!m.footer) return null;
  return <p className="mt-6 border-t pt-2 text-center text-[9.5px]" style={{ color: GREY, borderColor: LIGHT }} data-slot="invoice-footer">{m.footer}</p>;
}

/** "─────── INVOICE ───────": the centred title of the Universal templates. */
function RuledTitle({ size = 'text-[15px]' }: { size?: string }) {
  const { m } = useSheet();
  return (
    <div className="my-4">
      {m.copyLabel && <p className="text-center text-[9.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: GREY }}><L t={m.copyLabel} /></p>}
      <div className="flex items-center gap-4">
        <span className="h-px flex-1" style={{ backgroundColor: LIGHT }} />
        <h1 className={cn('font-medium uppercase tracking-wide', size)}><L t={m.title} /></h1>
        <span className="h-px flex-1" style={{ backgroundColor: LIGHT }} />
      </div>
      {(m.stamp || m.endorsement || m.headings.length > 0) && (
        <div className="mt-1 text-center">
          {m.stamp && <span className="inline-block rounded-[2px] border border-current px-1.5 text-[10px] font-bold uppercase" data-slot="sheet-stamp">{m.stamp}</span>}
          {m.endorsement && <p className="text-[10px] font-semibold uppercase">{m.endorsement}</p>}
          {m.headings.map((h) => <p key={h} className="text-[10.5px] font-semibold">{h}</p>)}
        </div>
      )}
    </div>
  );
}

function ShipTo({ align = 'left' }: { align?: 'left' | 'right' }) {
  const { m } = useSheet();
  return m.shipTo ? <div className="mt-3"><Party p={m.shipTo} align={align} /></div> : null;
}

// ── The templates ────────────────────────────────────────────────────────────

const PAD = 'p-[34px] print:p-0';

/** Standard: logo and address left, the title and balance due right, a dark table. */
function Standard() {
  const { m } = useSheet();
  return (
    <div className={PAD}>
      <Irn />
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 space-y-2"><Logo /><Seller /></div>
        <div className="shrink-0"><Title /><NumberLine className="text-right" /><BalanceTop /></div>
      </div>
      <div className="mt-7 flex items-end justify-between gap-6">
        <div className="min-w-0"><Party p={m.billTo} /><ShipTo /></div>
        <Facts />
      </div>
      <Items variant="dark" />
      <div className="mt-2 flex gap-6">
        <Words className="mt-3 min-w-0 flex-1" />
        <Totals className="ml-auto w-1/2" />
      </div>
      <Closing className="mt-8" />
      <Signature />
      <Footer />
    </div>
  );
}

/** Standard Japanese: the customer first, the title in the middle, seal boxes under the company. */
function Japanese({ seals }: { seals: boolean }) {
  const { m } = useSheet();
  return (
    <div className={PAD}>
      <Irn />
      <div className="text-right text-[10.5px]" style={{ color: GREY }}>
        <p className="font-semibold">{m.number}</p>
        <p>{m.date}</p>
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-6">
        <div className="min-w-0 space-y-4">
          <Party p={m.billTo} />
          <ShipTo />
          <Facts align="left" />
          <div className="flex w-56 justify-between border-b pb-1 font-bold" style={{ borderColor: INK }} data-slot="sheet-total-top">
            <span><L t={m.totalLabel} /></span><span>{money(m, m.totalPaise)}</span>
          </div>
        </div>
        <div className="w-60 space-y-3">
          <Title align="left" className="text-[24px]" style={{ color: GREY }} />
          <Logo />
          <Seller />
          {seals && (
            <div className="mt-2 grid w-[150px] grid-cols-3 border" style={{ borderColor: INK }} data-slot="sheet-seal-boxes">
              {[0, 1, 2].map((i) => <div key={i} className={cn('h-12', i < 2 && 'border-r')} style={{ borderColor: INK }} />)}
            </div>
          )}
        </div>
      </div>
      <Items variant="dark" />
      <div className="mt-2 flex gap-6">
        <Words className="mt-3 min-w-0 flex-1" />
        <Totals className="ml-auto w-1/2" />
      </div>
      <Closing className="mt-8" />
      <Signature />
      <Footer />
    </div>
  );
}

/** Standard Euro: Standard turned round, the title left and the company right. */
function Euro() {
  const { m } = useSheet();
  return (
    <div className={PAD}>
      <Irn />
      <div className="flex items-start justify-between gap-6">
        <div className="shrink-0"><Title align="left" /><NumberLine /><BalanceTop align="left" /></div>
        <div className="min-w-0 space-y-2 text-right"><Logo className="ml-auto" /><Seller align="right" /></div>
      </div>
      <div className="mt-7 flex items-end justify-between gap-6">
        <Facts align="left" />
        <div className="min-w-0"><Party p={m.billTo} align="right" /><ShipTo align="right" /></div>
      </div>
      <Items variant="dark" />
      <div className="mt-2 flex gap-6">
        <Words className="mt-3 min-w-0 flex-1" />
        <Totals className="ml-auto w-1/2" />
      </div>
      <Closing className="mt-8" />
      <Signature />
      <Footer />
    </div>
  );
}

/** Continental: the address where a window envelope shows it, the details beside it. */
function Continental() {
  const { m } = useSheet();
  return (
    <div className={PAD}>
      <Irn />
      <div className="flex items-start justify-between gap-6">
        <div className="shrink-0"><Title align="left" /><NumberLine /><BalanceTop align="left" /></div>
        <div className="min-w-0 space-y-2 text-right"><Logo className="ml-auto" /><Seller align="right" /></div>
      </div>
      <div className="mt-7 grid grid-cols-2 gap-6">
        <div className="min-h-[34mm] min-w-0"><Party p={m.billTo} nameClass="text-[12.5px]" /><ShipTo /></div>
        <Facts align="left" className="ml-auto self-start" />
      </div>
      <Items variant="dark" />
      <div className="mt-2 flex gap-6">
        <Words className="mt-3 min-w-0 flex-1" />
        <Totals className="ml-auto w-1/2" />
      </div>
      <Closing className="mt-8" />
      <Signature />
      <Footer />
    </div>
  );
}

/** Spreadsheet: the GST tax invoice in ruled boxes, the tax split into CGST and SGST columns. */
function Spreadsheet() {
  const { m, t } = useSheet();
  const line = '1px solid #9b9b9b';
  const half = Math.ceil(m.facts.length / 2);
  const left = m.facts.slice(0, Math.max(half, Math.min(4, m.facts.length)));
  const right = m.facts.slice(left.length);
  const FactRows = ({ rows }: { rows: { label: string; value: string }[] }) => (
    <table className="w-full border-collapse">
      <tbody>
        {rows.map((f) => (
          <tr key={f.label}>
            <td className="w-[45%] py-[1px] pr-2"><L t={f.label} /></td>
            <td className="py-[1px] font-semibold">: {f.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div className="p-[24px] print:p-0">
      <Irn />
      <div style={{ border: line }}>
        <div className="flex items-start justify-between gap-4 p-2" style={{ borderBottom: line }}>
          <div className="flex min-w-0 items-start gap-3">
            <Logo className="max-h-[60px] max-w-[120px]" />
            <div className="min-w-0 space-y-[1px]">
              <p className="font-bold">{m.seller.name}</p>
              {m.seller.lines.map((l, i) => <p key={i}>{l}</p>)}
              {m.seller.gstin && <p>GSTIN {m.seller.gstin}</p>}
              {m.seller.extra.map((l, i) => <p key={`x${i}`}>{l}</p>)}
            </div>
          </div>
          <Title className="text-[24px]" />
        </div>
        <div className="grid grid-cols-2" style={{ borderBottom: line }}>
          <div className="p-2" style={{ borderRight: line }}><FactRows rows={[{ label: m.numberLabel.replace(/#$/, '#'), value: m.number }, ...left]} /></div>
          <div className="p-2"><FactRows rows={right} /></div>
        </div>
        <div className="grid grid-cols-2 font-semibold" style={{ borderBottom: line, backgroundColor: '#f2f3f4' }}>
          <div className="px-2 py-[2px]" style={{ borderRight: line }}><L t={m.billTo?.label ?? 'Bill To'} /></div>
          <div className="px-2 py-[2px]"><L t={m.shipTo?.label ?? 'Ship To'} /></div>
        </div>
        <div className="grid grid-cols-2">
          {[m.billTo, m.shipTo ?? (m.billTo ? { ...m.billTo, label: 'Ship To' } : null)].map((p, i) => (
            <div key={i} className="min-w-0 space-y-[1px] p-2" style={i === 0 ? { borderRight: line } : undefined}>
              {p?.name && <p className="font-bold">{p.name}</p>}
              {p?.lines.map((l, j) => <p key={j}>{l}</p>)}
              {p?.gstin && <p>GSTIN {p.gstin}</p>}
            </div>
          ))}
        </div>
        <div className="-mt-5"><Items variant="grid" /></div>
        <div className="grid grid-cols-[1fr_42%]" style={{ borderTop: line }}>
          <div className="space-y-3 p-2" style={{ borderRight: line }}>
            <Words />
            <Closing className="!space-y-3" />
          </div>
          <div>
            <div className="p-2" style={{ borderBottom: line }}><Totals variant="grid" /></div>
            {t.showSignature && (
              <div className="flex min-h-[110px] flex-col justify-between p-2 text-center" data-slot="sheet-signature">
                <p>For {m.seller.name}</p>
                <div>
                  {m.signatory && <p className="font-medium">{m.signatory}</p>}
                  <p><L t="Authorized Signature" /></p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}

/** Minimalist: the customer and the title, a red rule, the company in the footer. */
function Minimalist() {
  const { m, accent } = useSheet();
  const red = { color: accent };
  return (
    <div className="flex min-h-[270mm] flex-col print:min-h-0">
      <div className="flex-1 px-[34px] pt-[34px] print:px-0 print:pt-0">
        <Irn />
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0"><Party p={m.billTo} labelStyle={red} /><ShipTo /></div>
          <div className="shrink-0"><Title style={red} className="text-[24px]" /><p className="text-right text-[11px]" style={{ color: GREY }}>{m.number}</p></div>
        </div>
        <div className="mt-6 grid grid-cols-2" style={{ borderTop: `1px solid ${accent}` }}>
          <div className="py-3 pr-4" style={{ borderRight: `1px solid ${accent}` }}><Facts align="left" labelStyle={red} colon={false} /></div>
          <div className="py-3 pl-4">
            {m.balance && (
              <div className="flex justify-between border px-3 py-2 font-semibold" style={{ borderColor: accent, color: accent }} data-slot="sheet-balance-top">
                <span><L t={m.balance.label} /></span><span>{money(m, m.balance.paise)}</span>
              </div>
            )}
          </div>
        </div>
        <Items variant="accentText" />
        <div className="mt-4 grid grid-cols-2 gap-6 bg-[#f7f7f7] p-4">
          <div className="space-y-3"><Words /><Closing labelStyle={red} /></div>
          <Totals variant="minimalist" />
        </div>
        <Signature />
      </div>
      <div className="mt-8 flex items-center gap-4 border-t px-[34px] py-4 print:px-0" style={{ borderColor: LIGHT }} data-slot="sheet-company-footer">
        <Logo className="max-h-[48px] max-w-[120px]" />
        <p className="text-[10px]"><span className="font-bold">{m.seller.name}</span> {[...m.seller.lines, m.seller.gstin ? `GSTIN ${m.seller.gstin}` : ''].filter(Boolean).join(' ')}</p>
      </div>
      <div className="px-[34px] pb-4 print:px-0"><Footer /></div>
    </div>
  );
}

/** Grand: a dark band with the logo, the title and the company, the balance due under it. */
function Grand() {
  const { m, accent } = useSheet();
  return (
    <div>
      <div className="flex items-center justify-between gap-6 px-[34px] py-5 text-white print:px-4" style={{ backgroundColor: accent }}>
        <Logo className="max-h-[60px] max-w-[140px]" />
        <div className="text-center">
          {m.copyLabel && <p className="text-[9.5px] font-semibold uppercase tracking-[0.08em] opacity-80"><L t={m.copyLabel} /></p>}
          <h1 className="text-[28px] font-light uppercase tracking-[0.08em] text-white/70"><L t={m.title} /></h1>
          {m.stamp && <span className="inline-block rounded-[2px] border border-current px-1.5 text-[10px] font-bold uppercase" data-slot="sheet-stamp">{m.stamp}</span>}
        </div>
        <Seller align="right" light nameClass="text-[11px]" />
      </div>
      <div className="px-[34px] print:px-0">
        {m.balance && (
          <p className="py-2 text-right text-[13px] font-semibold uppercase" data-slot="sheet-balance-top"><L t={m.balance.label} /> {money(m, m.balance.paise)}</p>
        )}
        <Irn />
        {(m.endorsement || m.headings.length > 0) && (
          <div className="mb-2">{m.endorsement && <p className="text-[10px] font-semibold uppercase">{m.endorsement}</p>}{m.headings.map((h) => <p key={h} className="font-semibold">{h}</p>)}</div>
        )}
        <div className="mt-3 flex items-start justify-between gap-6">
          <div className="min-w-0">
            {m.billTo && (
              <div className="space-y-[1px]" data-slot="sheet-bill-to">
                <p className="text-[16px]">{m.billTo.name}</p>
                {m.billTo.lines.map((l, i) => <p key={i} style={{ color: GREY }}>{l}</p>)}
                {m.billTo.gstin && <p style={{ color: GREY }}>GSTIN {m.billTo.gstin}</p>}
              </div>
            )}
            <ShipTo />
          </div>
          <table className="border-collapse" data-slot="sheet-facts">
            <tbody>
              <tr><td className="py-[2px] pr-5 text-right" style={{ color: GREY }}><L t={m.numberLabel} /></td><td className="py-[2px] text-right font-semibold">{m.number}</td></tr>
              {m.facts.map((f) => (
                <tr key={f.label}><td className="py-[2px] pr-5 text-right" style={{ color: GREY }}><L t={f.label} /></td><td className="py-[2px] text-right font-semibold">{f.value}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <Items variant="grand" />
        <div className="mt-3 grid grid-cols-2 gap-6 bg-[#f5f5f5] p-4">
          <div className="space-y-3"><Words />{m.notes && <p className="whitespace-pre-line">{m.notes}</p>}</div>
          <Totals variant="grand" />
        </div>
        <Closing className="mt-6" />
        <Signature />
        <Footer />
      </div>
    </div>
  );
}

/** Lite: the company across the top, a ruled title, the details in a strip. */
function Lite() {
  const { m } = useSheet();
  return (
    <div className={PAD}>
      <Irn />
      <div className="flex items-start justify-between gap-6"><Logo /><Seller align="right" /></div>
      <RuledTitle />
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0"><Party p={m.billTo} labelStyle={{ color: INK, fontWeight: 600 }} /><ShipTo /></div>
        <div className="text-right"><p style={{ color: GREY }}><L t={m.numberLabel} /></p><p className="font-bold">{m.number}</p></div>
      </div>
      {m.facts.length > 0 && (
        <table className="mt-5 w-full border-collapse" data-slot="sheet-facts">
          <tbody>
            <tr className="bg-[#f2f3f4]">{m.facts.map((f) => <td key={f.label} className="px-2 py-[5px]" style={{ color: GREY }}><L t={f.label} /></td>)}</tr>
            <tr style={{ borderBottom: `1px solid ${LIGHT}` }}>{m.facts.map((f) => <td key={f.label} className="px-2 py-[5px]">{f.value}</td>)}</tr>
          </tbody>
        </table>
      )}
      <Items variant="light" />
      <div className="mt-2 flex gap-6">
        <Words className="mt-3 min-w-0 flex-1" />
        <Totals className="ml-auto w-1/2" />
      </div>
      <Closing className="mt-8" />
      <Signature />
      <Footer />
    </div>
  );
}

/** Simple: a ruled title, the details in a boxed table, boxed lines and totals. */
function Simple() {
  const { m } = useSheet();
  const box = `1px solid ${LIGHT}`;
  return (
    <div className={PAD}>
      <Irn />
      <div className="flex items-start justify-between gap-6"><Logo /><Seller align="right" /></div>
      <RuledTitle />
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0"><Party p={m.billTo} labelStyle={{ color: INK, fontWeight: 600 }} /><ShipTo /></div>
        <table className="w-[46%] border-collapse" data-slot="sheet-facts">
          <tbody>
            {[{ label: m.numberLabel, value: m.number }, ...m.facts].map((f) => (
              <tr key={f.label} style={{ border: box }}>
                <td className="w-[45%] bg-[#f7f7f7] px-2 py-[4px]" style={{ borderRight: box }}><L t={f.label} /></td>
                <td className="px-2 py-[4px]">{f.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Items variant="boxed" />
      <div className="mt-3 flex gap-6">
        <div className="min-w-0 flex-1 space-y-3"><Words />{m.notes && <p className="whitespace-pre-line">{m.notes}</p>}</div>
        <Totals variant="boxed" className="ml-auto w-[46%]" />
      </div>
      <Closing className="mt-8 [&_[data-slot=sheet-notes]]:hidden" />
      <Signature />
      <Footer />
    </div>
  );
}

/** Compact: the item and its description in separate columns, for long invoices. */
function Compact() {
  const { m } = useSheet();
  return (
    <div className="p-[28px] text-[10.5px] print:p-0">
      <Irn />
      <div className="flex items-start justify-between gap-6"><Logo className="max-h-[56px]" /><Seller align="right" /></div>
      <RuledTitle size="text-[13px]" />
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0"><Party p={m.billTo} labelStyle={{ color: INK, fontWeight: 700 }} /><ShipTo /></div>
        <table className="border-collapse" data-slot="sheet-facts">
          <tbody>
            {[{ label: m.numberLabel, value: m.number }, ...m.facts].map((f) => (
              <tr key={f.label}><td className="py-[1px] pr-5 font-bold"><L t={f.label} /></td><td className="py-[1px]">{f.value}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Items variant="compact" />
      <div className="mt-2 flex gap-6">
        <div className="min-w-0 flex-1 space-y-3"><Words />{m.notes && <p className="whitespace-pre-line">{m.notes}</p>}</div>
        <Totals className="ml-auto w-[45%] [&_td]:!py-[3px]" />
      </div>
      <Closing className="mt-6 [&_[data-slot=sheet-notes]]:hidden" termsBold />
      <Signature />
      <Footer />
    </div>
  );
}

/** Basic: a coloured bar, everything centred, the title large and pale behind. */
function Basic() {
  const { m, accent } = useSheet();
  const contact = m.seller.extra.join('  |  ');
  return (
    <div className="flex min-h-[270mm] flex-col print:min-h-0">
      <div className="h-[6px]" style={{ backgroundColor: accent }} />
      <div className="flex-1 px-[34px] pt-6 print:px-0">
        <Irn />
        <div className="flex flex-col items-center text-center">
          <Logo className="mb-2" />
          <p className="text-[18px] font-semibold uppercase tracking-wide" style={{ color: accent }}>{m.seller.name}</p>
          <p className="text-[10px] uppercase tracking-wide" style={{ color: accent }}>{[...m.seller.lines, m.seller.gstin ? `GSTIN ${m.seller.gstin}` : ''].filter(Boolean).join(' ')}</p>
          {m.copyLabel && <p className="mt-2 text-[9.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: GREY }}><L t={m.copyLabel} /></p>}
          <h1 className="mt-1 text-[56px] font-extrabold uppercase leading-none tracking-wide" style={{ color: accent, opacity: 0.16 }}><L t={m.title} /></h1>
          {m.stamp && <span className="mt-1 inline-block rounded-[2px] border border-current px-1.5 text-[10px] font-bold uppercase" data-slot="sheet-stamp">{m.stamp}</span>}
          {m.endorsement && <p className="mt-1 text-[10px] font-semibold uppercase">{m.endorsement}</p>}
          {m.headings.map((h) => <p key={h} className="text-[10.5px] font-semibold">{h}</p>)}
        </div>
        <div className="mt-4 border-t pt-4 text-center" style={{ borderColor: accent }}>
          {m.billTo && (
            <div data-slot="sheet-bill-to">
              <p className="inline-block border-b px-3 text-[10px] uppercase tracking-wide" style={{ color: accent, borderColor: accent }}><L t={m.billTo.label} /></p>
              <p className="mt-2 text-[13px] font-semibold">{m.billTo.name}</p>
              <p>{[...m.billTo.lines, m.billTo.gstin ? `GSTIN ${m.billTo.gstin}` : ''].filter(Boolean).join(', ')}</p>
            </div>
          )}
          {m.shipTo && <p className="mt-2 text-[10.5px]" style={{ color: GREY }}><L t={m.shipTo.label} />: {[m.shipTo.name, ...m.shipTo.lines].filter(Boolean).join(', ')}</p>}
        </div>
        <div className="mt-5 flex justify-center gap-8 text-center" data-slot="sheet-facts">
          {[{ label: m.numberLabel, value: m.number }, ...m.facts].map((f) => (
            <div key={f.label}>
              <p className="text-[9.5px] uppercase tracking-wide" style={{ color: GREY }}><L t={f.label.replace(/#$/, ' #')} /></p>
              <p className="mt-1">{f.value}</p>
            </div>
          ))}
        </div>
        <Items variant="accentText" />
        <div className="mt-2 flex gap-6">
          <Words className="mt-3 min-w-0 flex-1" />
          <Totals variant="basic" className="ml-auto w-1/2" />
        </div>
        <Closing className="mt-8" />
        <Signature />
      </div>
      <div className="px-[34px] pb-5 text-center text-[10px] print:px-0" style={{ color: accent }}>
        {contact && <p className="mt-6">{contact}</p>}
        <Footer />
      </div>
    </div>
  );
}

const BODIES: Record<TemplateKey, () => ReactNode> = {
  standard: Standard,
  standard_japanese: () => <Japanese seals />,
  standard_japanese_sans_sealboxes: () => <Japanese seals={false} />,
  standard_euro: Euro,
  spreadsheet: Spreadsheet,
  minimalist: Minimalist,
  grand: Grand,
  continental: Continental,
  lite: Lite,
  simple: Simple,
  compact: Compact,
  basic: Basic,
};

/** The ribbon Zoho's preview shows for a status. */
export function ribbonFor(status: string, overdue = false): Ribbon | null {
  const s = status.toLowerCase();
  if (s === 'void' || s === 'cancelled') return { label: 'Void', color: '#8e8e8e' };
  if (s === 'draft') return { label: 'Draft', color: '#8e8e8e' };
  if (s === 'paid' || s === 'closed' || s === 'invoiced' || s === 'accepted' || s === 'billed') return { label: s === 'paid' ? 'Paid' : s[0].toUpperCase() + s.slice(1), color: '#21b26a' };
  if (s === 'partially_paid' || s === 'partial') return { label: 'Partially Paid', color: '#2fa36b' };
  if (overdue) return { label: 'Overdue', color: '#e85b4f' };
  if (s === 'written_off') return { label: 'Written Off', color: '#8e8e8e' };
  return { label: s === 'sent' || s === 'unpaid' ? 'Open' : s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), color: '#3a86d6' };
}
