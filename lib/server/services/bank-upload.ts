import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Bulk payment upload files, in the layouts banks' corporate portals take
// (status review 7, item 6), and the bank's reply read back.
//
// A released payment batch (payment-batches.ts) is one transfer per supplier.
// Each transfer carries our own reference, "<batch number>/<vendor id>", in
// the field the bank echoes back in its status file (customer reference /
// instruction reference), so the reply is matched to the transfer exactly;
// failing that, by beneficiary account and amount.
//
// The layouts. NEFT and RTGS are the RBI's (RTGS from ₹2 lakh); IMPS is
// offered where the bank's file has it. Only the generic file is Rekonza's
// own; the four banks' layouts follow their published corporate bulk-upload
// templates as far as they are public, and none has been checked against a
// live corporate account here. Each is marked so on screen, with the advice
// to compare it once with the bank's own sample before the first upload.
//
//   generic   CSV with a heading row: Payment type, Beneficiary name, account,
//             IFSC, Amount, Value date (dd/mm/yyyy), Debit account no,
//             Remarks (30 characters, what NEFT carries), Bills paid,
//             Customer reference.
//   hdfc      HDFC Bank ENet bulk upload: comma-separated, no heading row;
//             Transaction type (N NEFT, R RTGS, I within HDFC), Beneficiary
//             code (blank), Beneficiary account number, Instrument amount,
//             Beneficiary name, Drawee location, Print location, Bene address
//             1–5, Instruction reference number, Customer reference number,
//             Payment details 1–7, Cheque number, Cheque/transaction date
//             (dd/mm/yyyy), MICR number, IFSC code, Bene bank name, Bene bank
//             branch name, Beneficiary email id.
//   icici     ICICI Bank CIB bulk payment CSV with headings: PYMT_PROD_TYPE_CODE
//             (PAB_VENDOR), PYMT_MODE (NEFT/RTGS/IMPS), DEBIT_ACC_NO, BNF_NAME,
//             BENE_ACC_NO, BENE_IFSC, AMOUNT, DEBIT_NARR, CREDIT_NARR,
//             MOBILE_NUM, EMAIL_ID, REMARK, PYMT_DATE (dd-mm-yyyy), REF_NO.
//   sbi       SBI CINB bulk upload, "#"-separated text, no heading row: Debit
//             account, Beneficiary name, Beneficiary account, IFSC, Amount,
//             Payment mode (NEFT/RTGS), Narration, Reference.
//   axis      Axis Bank CIB bulk upload CSV with headings: Payment Mode
//             (N NEFT, R RTGS, I IMPS), Amount, Value Date (dd-mm-yyyy),
//             Beneficiary Name, Beneficiary Account No, IFSC Code, Debit
//             Account No, Customer Reference No, Remarks.
// ─────────────────────────────────────────────────────────────────────────────

import type { Paise } from '../../types';
import { amount as cellAmount } from '../../bank-statement';

export type BankFormat = 'generic' | 'hdfc' | 'icici' | 'sbi' | 'axis';

export const BANK_FORMATS: { id: BankFormat; label: string; verified: boolean; note: string }[] = [
  { id: 'generic', label: 'NEFT / RTGS / IMPS (generic CSV)', verified: true, note: 'Rekonza\'s own layout with a heading row; most corporate portals map it.' },
  { id: 'hdfc', label: 'HDFC Bank ENet', verified: false, note: 'From HDFC Bank\'s published ENet bulk upload layout. Not checked against a live ENet account: compare it once with your bank\'s sample.' },
  { id: 'icici', label: 'ICICI Bank CIB', verified: false, note: 'From ICICI Bank\'s CIB bulk payment template. Not checked against a live CIB account: compare it once with your bank\'s sample.' },
  { id: 'sbi', label: 'SBI CINB', verified: false, note: 'From SBI Corporate Internet Banking\'s bulk upload layout. Not checked against a live CINB account: compare it once with your bank\'s sample.' },
  { id: 'axis', label: 'Axis Bank CIB', verified: false, note: 'From Axis Bank\'s CIB bulk upload template. Not checked against a live account: compare it once with your bank\'s sample.' },
];

export interface UploadTransfer {
  vendorId: number; beneficiary: string; accountNo: string; ifsc: string; amountPaise: Paise;
  mode: 'NEFT' | 'RTGS' | 'IMPS'; reference: string; remarks: string; bills: string;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const rupees = (p: Paise) => (p / 100).toFixed(2);

/** The file the bank takes: its name and text. `payDate` is yyyy-mm-dd. */
export function bankUploadFile(format: BankFormat, batch: { number: string; payDate: string; debitAccountNo: string }, list: UploadTransfer[]): { fileName: string; text: string; mime: string } {
  const [y, m, d] = batch.payDate.split('-');
  const dmySlash = `${d}/${m}/${y}`;
  const dmyDash = `${d}-${m}-${y}`;
  const safe = batch.number.replace(/[^A-Za-z0-9-]/g, '-');
  const debit = batch.debitAccountNo.replace(/\s/g, '');
  const name = (s: string) => s.replace(/[^A-Za-z0-9 .&-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 35);
  switch (format) {
    case 'hdfc': {
      const code = (t: UploadTransfer) => (t.mode === 'RTGS' ? 'R' : t.ifsc.startsWith('HDFC') ? 'I' : 'N');
      const lines = list.map((t) => [
        code(t), '', t.accountNo, rupees(t.amountPaise), name(t.beneficiary), '', '', '', '', '', '', '',
        t.reference.slice(0, 20), t.reference.slice(0, 20), t.remarks.slice(0, 30), '', '', '', '', '', '', '',
        dmySlash, '', t.ifsc, '', '', '',
      ].map(csvCell).join(','));
      return { fileName: `${safe}-hdfc-enet.csv`, text: lines.join('\r\n') + '\r\n', mime: 'text/csv' };
    }
    case 'icici': {
      const head = ['PYMT_PROD_TYPE_CODE', 'PYMT_MODE', 'DEBIT_ACC_NO', 'BNF_NAME', 'BENE_ACC_NO', 'BENE_IFSC', 'AMOUNT', 'DEBIT_NARR', 'CREDIT_NARR', 'MOBILE_NUM', 'EMAIL_ID', 'REMARK', 'PYMT_DATE', 'REF_NO'];
      const lines = list.map((t) => ['PAB_VENDOR', t.mode, debit, name(t.beneficiary), t.accountNo, t.ifsc, rupees(t.amountPaise), t.remarks.slice(0, 30), t.remarks.slice(0, 30), '', '', t.bills.slice(0, 100), dmyDash, t.reference].map(csvCell).join(','));
      return { fileName: `${safe}-icici-cib.csv`, text: [head.join(','), ...lines].join('\r\n') + '\r\n', mime: 'text/csv' };
    }
    case 'sbi': {
      const lines = list.map((t) => [debit, name(t.beneficiary), t.accountNo, t.ifsc, rupees(t.amountPaise), t.mode === 'IMPS' ? 'NEFT' : t.mode, t.remarks.slice(0, 30), t.reference].map((v) => v.replace(/#/g, ' ')).join('#'));
      return { fileName: `${safe}-sbi-cinb.txt`, text: lines.join('\r\n') + '\r\n', mime: 'text/plain' };
    }
    case 'axis': {
      const head = ['Payment Mode', 'Amount', 'Value Date', 'Beneficiary Name', 'Beneficiary Account No', 'IFSC Code', 'Debit Account No', 'Customer Reference No', 'Remarks'];
      const lines = list.map((t) => [t.mode === 'RTGS' ? 'R' : t.mode === 'IMPS' ? 'I' : 'N', rupees(t.amountPaise), dmyDash, name(t.beneficiary), t.accountNo, t.ifsc, debit, t.reference, t.remarks.slice(0, 30)].map(csvCell).join(','));
      return { fileName: `${safe}-axis-cib.csv`, text: [head.join(','), ...lines].join('\r\n') + '\r\n', mime: 'text/csv' };
    }
    default: {
      const head = ['Payment type', 'Beneficiary name', 'Beneficiary account no', 'IFSC', 'Amount', 'Value date', 'Debit account no', 'Remarks', 'Bills paid', 'Customer reference'];
      const lines = list.map((t) => [t.mode, t.beneficiary, t.accountNo, t.ifsc, rupees(t.amountPaise), dmySlash, debit, t.remarks.slice(0, 30), t.bills, t.reference].map(csvCell).join(','));
      return { fileName: `${safe}-bank-upload.csv`, text: [head.join(','), ...lines].join('\r\n') + '\r\n', mime: 'text/csv' };
    }
  }
}

export interface BankReplyLine { reference: string | null; accountNo: string | null; amountPaise: number | null; status: 'paid' | 'failed' | 'unknown'; utr: string | null; reason: string | null; row: number }

const norm = (c: unknown) => String(c ?? '').replace(/^﻿/, '').trim().toLowerCase();
const PAID = /^(paid|success|successful|executed|processed|completed|credited|settled|ok|s)$/i;
const FAILED = /^(failed|failure|rejected|returned|reversed|cancelled|unsuccessful|error|f|r)$/i;

/**
 * The bank's status (reverse) file, read: for each line its reference, account,
 * amount, whether it was paid or failed, the UTR and the reason. Banks name
 * these columns differently ("Customer Reference No", "Status", "UTR No",
 * "Reject Reason"…); the heading row is found by its names, anywhere in the
 * first 30 rows.
 */
export function readBankReply(grid: unknown[][]): { lines: BankReplyLine[]; problem: string | null } {
  const at = grid.slice(0, 30).findIndex((r) => (r ?? []).some((c) => /status/.test(norm(c))) && (r ?? []).some((c) => /ref|utr|account|a\/c/.test(norm(c))));
  if (at < 0) return { lines: [], problem: 'No heading row with a Status column and a reference or account column was found.' };
  const h = grid[at].map(norm);
  const col = (...res: RegExp[]) => h.findIndex((x) => res.some((r) => r.test(x)));
  const ref = col(/customer ref/, /instruction ref/, /^ref(erence)?(\s*no\.?)?$/, /ref_no/, /payment ref/, /^reference/);
  const acct = col(/bene.*(acc|a\/c)/, /beneficiary account/, /account no/, /acc(ount)?_?no/);
  const amt = col(/amount/);
  const status = col(/^status$/, /status/);
  const utr = col(/utr/, /bank ref/, /transaction id/, /txn ref/);
  const reason = col(/reason/, /remark/, /description/, /error/, /message/);
  const lines: BankReplyLine[] = [];
  grid.slice(at + 1).forEach((r, i) => {
    if (!r || !r.some((c) => String(c ?? '').trim())) return;
    const s = String(r[status] ?? '').trim();
    lines.push({
      row: at + i + 2,
      reference: ref >= 0 ? String(r[ref] ?? '').trim() || null : null,
      accountNo: acct >= 0 ? String(r[acct] ?? '').replace(/\s/g, '') || null : null,
      amountPaise: amt >= 0 && String(r[amt] ?? '').trim() ? Math.round(cellAmount(r[amt]) * 100) : null,
      status: PAID.test(s) ? 'paid' : FAILED.test(s) ? 'failed' : /fail|reject|return/i.test(s) ? 'failed' : /success|paid|process|execut/i.test(s) ? 'paid' : 'unknown',
      utr: utr >= 0 ? String(r[utr] ?? '').trim() || null : null,
      reason: reason >= 0 ? String(r[reason] ?? '').trim() || null : null,
    });
  });
  return { lines, problem: lines.length ? null : 'The heading row was found, but no lines under it.' };
}
