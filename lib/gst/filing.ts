// ─────────────────────────────────────────────────────────────────────────────
// Filing a GST return: what each return is called, where it is filed, how it
// is filed when no GST Suvidha Provider is connected, and what filing it late
// costs. Shared by the server (the filing status, the return status grid) and
// the screens (the filing bar on every return), so the words and the figures
// are the same everywhere.
//
// Filing itself happens on the GST portal. Only a GSP may call the GST system
// on a taxpayer's behalf, and every filing is signed with an OTP sent to the
// authorised signatory, so without a GSP contract configured on the server
// the honest thing is to give the file and the steps, never to pretend.
// ─────────────────────────────────────────────────────────────────────────────

export type FilingReturn = 'gstr1' | 'iff' | 'gstr3b' | 'gstr7' | 'gstr8' | 'gstr9' | 'gstr9c';

export const FILING_RETURNS: FilingReturn[] = ['gstr1', 'iff', 'gstr3b', 'gstr7', 'gstr8', 'gstr9', 'gstr9c'];

export interface ReturnMeta {
  title: string;
  /** Where the return is in Rekonza. */
  href: string;
  /** Monthly or quarterly returns are periods 'YYYY-MM' / 'YYYY-Qn'; annual ones the FY start year. */
  annual: boolean;
  /** The module locks that a filed return should hold its period against. */
  locks: ('sales' | 'purchases')[];
  /** Step by step, on gst.gov.in, with the file this screen downloads. */
  offlineSteps: string[];
}

export const RETURN_META: Record<FilingReturn, ReturnMeta> = {
  gstr1: {
    title: 'GSTR-1', href: '/gst/gstr1', annual: false, locks: ['sales'],
    offlineSteps: [
      'Download the return file here: Export → Portal JSON.',
      'Sign in at gst.gov.in and open Services → Returns → Returns Dashboard; pick the financial year and the return period, then GSTR-1 → Prepare Offline.',
      'On the Upload tab choose the JSON file and upload it. Wait for the status to show Processed (refresh after a minute or two). If it shows Processed with Error, open the error report, correct the documents in Rekonza and upload again.',
      'Back on the dashboard choose GSTR-1 → Prepare Online, check the summary against the totals on this screen, and click Generate GSTR-1 Summary.',
      'File with DSC or EVC (the OTP goes to the authorised signatory). Note the ARN the portal shows.',
      'Come back here and click Mark as filed: enter the date and the ARN. The period can be locked so nothing in it changes behind the filed return.',
    ],
  },
  iff: {
    title: 'IFF', href: '/gst/iff', annual: false, locks: ['sales'],
    offlineSteps: [
      'Download the IFF file here: Export → Portal JSON.',
      'On gst.gov.in open Returns Dashboard, pick the month, then IFF → Prepare Offline → Upload, and upload the file.',
      'When it shows Processed, open IFF → Prepare Online, check the summary and file with DSC or EVC.',
      'Mark it as filed here with the date and the ARN.',
    ],
  },
  gstr3b: {
    title: 'GSTR-3B', href: '/gst/gstr3b', annual: false, locks: ['sales', 'purchases'],
    offlineSteps: [
      'Download the return file here: Export → Return file (JSON). Keep the screen open: every table is laid out as the portal shows it.',
      'On gst.gov.in open Returns Dashboard, pick the period, then GSTR-3B → Prepare Online. Answer the questionnaire, then either upload the JSON through the offline utility, or enter each table from this screen (the portal fills 3.1, 3.2 and 4 from GSTR-1 and GSTR-2B; compare them with the "values from GSTR-1 and GSTR-2B" table here).',
      'Click Save GSTR-3B, then Proceed to Payment. Pay any cash due by challan (PMT-06) and set off the liability in the order the portal offers — it is the order of section 49(5) and Rule 88A shown in table 6.1 here.',
      'File with DSC or EVC and note the ARN.',
      'Mark it as filed here with the date and the ARN, and record the payment and set-off so the GST ledgers come back to nil.',
    ],
  },
  gstr7: {
    title: 'GSTR-7', href: '/gst/gstr7', annual: false, locks: ['purchases'],
    offlineSteps: [
      'Download the return file here: Export → Portal JSON.',
      'Sign in at gst.gov.in with the TDS registration (the GSTIN with D in the 14th place), open Returns Dashboard, pick the month, then GSTR-7 → Prepare Offline → Upload.',
      'When it shows Processed, open GSTR-7 → Prepare Online, check table 3 against this screen, pay the TDS from the cash ledger and file with DSC or EVC.',
      'Once filed, the portal makes the GSTR-7A certificates; enter each certificate number on its deductee here.',
      'Mark it as filed here with the date and the ARN.',
    ],
  },
  gstr8: {
    title: 'GSTR-8', href: '/gst/gstr8', annual: false, locks: ['purchases'],
    offlineSteps: [
      'Download the return file here: Export → Portal JSON.',
      'Sign in at gst.gov.in with the TCS registration (the GSTIN with C in the 14th place), open Returns Dashboard, pick the month, then GSTR-8 → Prepare Offline → Upload.',
      'When it shows Processed, open GSTR-8 → Prepare Online, check table 3 against this screen, pay the TCS from the cash ledger and file with DSC or EVC.',
      'Mark it as filed here with the date and the ARN.',
    ],
  },
  gstr9: {
    title: 'GSTR-9', href: '/gst/gstr9', annual: true, locks: ['sales', 'purchases'],
    offlineSteps: [
      'Download the return file here: Export → JSON for the offline tool.',
      'On gst.gov.in open Returns Dashboard, pick the financial year, then GSTR-9 → Prepare Offline. Download the GSTR-9 offline tool (Excel) from Downloads → Offline Tools if you want to review it there; it opens this JSON.',
      'Upload the JSON on the Upload tab. When it shows Processed, open Prepare Online, compute liabilities, check every table against this screen, pay any late fee, and file with DSC or EVC.',
      'Mark it as filed here with the date and the ARN.',
    ],
  },
  gstr9c: {
    title: 'GSTR-9C', href: '/gst/gstr9c', annual: true, locks: [],
    offlineSteps: [
      'GSTR-9C is filed after GSTR-9, with the audited financial statements.',
      'On gst.gov.in open Returns Dashboard, pick the financial year, then GSTR-9C → Prepare Offline; prepare it in the GSTR-9C offline tool from the reconciliation on this screen and upload the JSON the tool makes.',
      'File with DSC or EVC and mark it as filed here with the date and the ARN.',
    ],
  },
};

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'May 2026', 'Q2 FY 2026-27', 'FY 2025-26'. */
export function periodLabel(period: string): string {
  let m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (m) return `Q${m[2]} FY ${m[1]}-${String(Number(m[1]) + 1).slice(2)}`;
  m = /^(\d{4})$/.exec(period);
  if (m) return `FY ${m[1]}-${String(Number(m[1]) + 1).slice(2)}`;
  return period;
}

/** The last day a return's period covers: what a lock after filing holds. */
export function periodEnd(period: string): string {
  let m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    return `${y}-${pad(mo)}-${pad(new Date(y, mo, 0).getDate())}`;
  }
  m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (m) {
    const fy = Number(m[1]);
    const lastMonth = 3 + Number(m[2]) * 3; // 6, 9, 12, 15
    const y = lastMonth > 12 ? fy + 1 : fy;
    const mo = lastMonth > 12 ? lastMonth - 12 : lastMonth;
    return `${y}-${pad(mo)}-${pad(new Date(y, mo, 0).getDate())}`;
  }
  m = /^(\d{4})$/.exec(period);
  if (m) return `${Number(m[1]) + 1}-03-31`;
  return period;
}

export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The late fee for GSTR-1 (and GSTR-3B) filed after the due date: section 47,
 * as reduced by Notifications 20/2021-CT (GSTR-1) and 19/2021-CT (GSTR-3B):
 * ₹50 a day, half CGST and half SGST (₹20 a day for a nil return), capped by
 * the previous year's aggregate turnover — ₹2,000 up to ₹1.5 crore, ₹5,000 up
 * to ₹5 crore, ₹10,000 above; ₹500 for a nil return. In paise, each half.
 */
export function monthlyLateFee(daysLate: number, o: { nil: boolean; turnoverPaise: number; aboveFiveCrore?: boolean }) {
  if (daysLate <= 0) return { cgstPaise: 0, sgstPaise: 0, perDayRupees: 0, capRupees: 0 };
  const perDayRupees = o.nil ? 20 : 50;
  const capRupees = o.nil ? 500
    : o.aboveFiveCrore || o.turnoverPaise > 5_00_00_000_00 ? 10_000
      : o.turnoverPaise > 1_50_00_000_00 ? 5_000 : 2_000;
  const fee = Math.min(perDayRupees * daysLate, capRupees) * 100;
  return { cgstPaise: Math.round(fee / 2), sgstPaise: Math.round(fee / 2), perDayRupees, capRupees };
}

/** Interest under section 50(1): 18% a year on tax paid late, for the days late. */
export const lateInterest = (taxPaise: number, daysLate: number) =>
  daysLate > 0 && taxPaise > 0 ? Math.round((taxPaise * 18 * daysLate) / (100 * 365)) : 0;
