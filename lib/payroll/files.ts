// The files a payroll month produces for others: the bank's salary upload, the
// EPFO electronic challan-cum-return (ECR) and ESIC's monthly contribution
// sheet. Pure and client-safe: built from a run's lines where they are
// downloaded.

import type { Cell } from '../xlsx';

type Paise = number;
export interface FileLine {
  code: string; name: string; uan: string | null; esiIpNumber: string | null;
  bankAccountName: string | null; bankAccountNo: string | null; bankIfsc: string | null;
  daysInMonth: number; paidDays: number; gross: Paise; netPay: Paise;
  pfWage: Paise; epsWage: Paise; pfEmployee: Paise; pfEmployerEps: Paise; pfEmployerEpf: Paise;
  esiWage: Paise; esiEmployer: Paise;
}

const rupees = (p: Paise) => Math.round(p / 100);
const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

/** Salary transfers, one row each; anyone without full bank details is left out and named. */
export function bankTransfers(lines: FileLine[], month: string): { rows: Cell[][]; missing: string[] } {
  const ok = lines.filter((l) => l.netPay > 0 && l.bankAccountNo && l.bankIfsc);
  return {
    rows: [
      ['Beneficiary name', 'Account number', 'IFSC', 'Amount', 'Narration'],
      ...ok.map((l) => [l.bankAccountName || l.name, l.bankAccountNo, l.bankIfsc, l.netPay / 100, `Salary ${monthName(month)}`]),
    ],
    missing: lines.filter((l) => l.netPay > 0 && !(l.bankAccountNo && l.bankIfsc)).map((l) => `${l.code} ${l.name}`),
  };
}

/**
 * The ECR text file EPFO's portal takes: one member a line, fields joined by
 * #~#, whole rupees. NCP days are the days of the month not paid for.
 */
export function ecr(lines: FileLine[]): { text: string; missing: string[] } {
  const members = lines.filter((l) => l.pfEmployee > 0);
  const text = members.filter((l) => l.uan).map((l) => [
    l.uan, l.name.replace(/[^A-Za-z .]/g, '').toUpperCase(),
    rupees(l.gross), rupees(l.pfWage), rupees(l.epsWage), rupees(Math.min(l.pfWage, 15_000_00)),
    rupees(l.pfEmployee), rupees(l.pfEmployerEps), rupees(l.pfEmployerEpf),
    Math.round(l.daysInMonth - l.paidDays), 0,
  ].join('#~#')).join('\n');
  return { text, missing: members.filter((l) => !l.uan).map((l) => `${l.code} ${l.name}`) };
}

/** ESIC's monthly contribution upload: covered employees, days paid and wages. */
export function esiContributions(lines: FileLine[]): { rows: Cell[][]; missing: string[] } {
  const covered = lines.filter((l) => l.esiEmployer > 0);
  return {
    rows: [
      ['IP Number', 'IP Name', 'No of Days for which wages paid/payable during the month', 'Total Monthly Wages', 'Reason Code for Zero working days', 'Last Working Day'],
      ...covered.filter((l) => l.esiIpNumber).map((l) => [l.esiIpNumber, l.name, Math.round(l.paidDays), rupees(l.esiWage), 0, '']),
    ],
    missing: covered.filter((l) => !l.esiIpNumber).map((l) => `${l.code} ${l.name}`),
  };
}
