import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Demo book, status review 7, items 9, 10 and 14: the records the auditors'
// tests look for, so each screen shows real figures.
//
//   Before the coverage seed (its pay runs and depreciation take these in):
//     four employees with varied structures — above and below the PF and ESI
//     ceilings, working in Maharashtra, Karnataka, West Bengal and Telangana,
//     one on the old regime — and four assets to dispose of later.
//   After it:
//     9   disposals each way (sold by invoice with GST, sold into the bank,
//         scrapped, part of one), one undone with its reason, and one waiting
//         for approval under a disposal approval rule;
//     10  TDS on salary deposited by challan and linked, Q2's 24Q receipt
//         number, September and October dues paid, one employee's salary
//         taken back and paid again;
//     14  June's payroll, run in greytHR before the move, imported and paid
//         with its dues; and the Inventory account brought into line so the
//         integration check reads Pass with the book's real figures.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { IdMap } from './bootstrap';
import { DEMO_TODAY } from './demo-book';
import { createEmployee } from '../payroll/employees';
import { addAsset, disposeAsset, ensureAssetClasses, listAssetClasses, setDisposalApproval, undoDisposal } from '../services/fixed-assets';
import { recordSalaryChallan, salaryTdsMonths, setReturnReceipt } from '../payroll/salary-tds';
import { payStatutory, statutoryRegister } from '../payroll/statutory-dues';
import { paySalaries, reverseSalaryPayment, salaryPayments } from '../payroll/salary-payments';
import { importPayroll } from '../payroll/payroll-import';
import { trueUpStock } from '../services/stock-ledger';

const R = (rupees: number) => Math.round(rupees * 100);
const pad = (n: number) => String(n).padStart(2, '0');
/** The last four whole months before the book's date, as the coverage seed counts them. */
const MONTHS = [4, 3, 2, 1].map((k) => {
  const [y, m] = DEMO_TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - k, 1)).toISOString().slice(0, 7);
});
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const thisMonth = DEMO_TODAY.slice(0, 7);
const inThisMonth = (day: number) => `${thisMonth}-${pad(Math.min(day, Number(DEMO_TODAY.slice(8, 10))))}`;

const ledgerOf = async (trx: Trx, bankAccountId: number) => Number((await trx.selectFrom('bank_accounts').select('ledger_account_id')
  .where('id', '=', bankAccountId).executeTakeFirstOrThrow()).ledger_account_id);

/** Before the coverage seed: the employees and assets its runs take in. */
export async function seedSr7cBefore(trx: Trx, ids: IdMap) {
  const org = ids.orgId;
  const chennai = ids.branches.br_chennai;
  const blr = ids.branches.br_bengaluru;
  const from = `${MONTHS[0]}-01`;
  const STAFF = [
    // Basic above the ₹15,000 PF ceiling (EPS capped at ₹1,250), gross above ESI; works in Mumbai: Maharashtra PT and LWF.
    { code: 'E006', name: 'Rohit Menon', branch: chennai, state: '27', designation: 'Regional sales manager', dept: 'Sales', gender: 'male' as const, basic: 40_000, hra: 16_000, special: 14_000, regime: 'new' as const },
    // Bengaluru depot: Karnataka PT at ₹200, basic above the PF ceiling.
    { code: 'E007', name: 'Divya Rao', branch: blr, state: null, designation: 'Depot supervisor', dept: 'Stores', gender: 'female' as const, basic: 18_000, hra: 7_200, special: 4_800, regime: 'new' as const },
    // Below both ceilings, posted to Kolkata: ESI covered, West Bengal PT ₹130 and LWF.
    { code: 'E008', name: 'Imran Sheikh', branch: chennai, state: '19', designation: 'Field technician', dept: 'Service', gender: 'male' as const, basic: 9_000, hra: 4_000, special: 3_000, regime: 'new' as const },
    // High earner in Hyderabad on the old regime with ₹2 lakh declared: Telangana PT, TDS every month.
    { code: 'E009', name: 'Sunita Reddy', branch: chennai, state: '36', designation: 'Finance controller', dept: 'Accounts', gender: 'female' as const, basic: 60_000, hra: 24_000, special: 36_000, regime: 'old' as const },
  ];
  for (const [i, s] of STAFF.entries()) {
    await createEmployee(trx, org, {
      branchId: s.branch, workStateCode: s.state, code: s.code, name: s.name, gender: s.gender, dateOfJoining: '2024-04-01', designation: s.designation,
      department: s.dept, pan: ['GRMPM5521K', 'HDRPR6632L', 'JISPS7743M', 'KSRPR8854N'][i], uan: `1009${String(4480 + i).padStart(8, '0')}`,
      esiIpNumber: s.basic + s.hra + s.special <= 21_000 ? `51000842${String(310 + i)}` : null,
      pfMember: true, ptApplicable: true, taxRegime: s.regime, declaredDeductionsPaise: s.regime === 'old' ? R(2_00_000) : 0, metroCity: true,
      bankAccountName: s.name, bankAccountNo: `5010012${String(3401 + i)}88`, bankIfsc: 'HDFC0000123',
    }, { basic: R(s.basic), da: 0, hra: R(s.hra), special: R(s.special), other: 0, effectiveFrom: from });
  }

  // Assets the coverage seed's depreciation runs charge, to be disposed of after.
  await ensureAssetClasses(trx, org);
  const classes = await listAssetClasses(trx, org);
  const cls = (name: string) => Number(classes.find((c) => c.name === name)!.id);
  const hdfc = await ledgerOf(trx, ids.bankAccounts.ba_hdfc);
  const ASSETS = [
    { name: 'Air compressor 10 HP', cls: 'Plant & Machinery', cost: 6_00_000, life: 15, method: null, hsn: '8414', itc: 1_08_000 },
    { name: 'Billing server (old)', cls: 'Computers & Peripherals', cost: 1_20_000, life: 3, method: null, hsn: '8471', itc: 21_600 },
    { name: 'Battery forklift', cls: 'Vehicles', cost: 9_00_000, life: 8, method: 'wdv' as const, hsn: '8427', itc: 0 },
    { name: 'Mezzanine shelving line', cls: 'Furniture & Fittings', cost: 4_00_000, life: 10, method: null, hsn: '9403', itc: 72_000 },
  ];
  for (const a of ASSETS) {
    await addAsset(trx, org, ids.users.u_priya, {
      branchId: chennai, classId: cls(a.cls), name: a.name, acquiredOn: from, putToUseOn: from, costPaise: R(a.cost), usefulLifeYears: a.life,
      method: a.method, hsnSac: a.hsn, itcClaimedPaise: R(a.itc), source: { kind: 'paid', fromAccountId: hdfc }, location: 'Chennai HO', custodian: 'Karthik S',
    });
  }
}

/** After the coverage seed and the demo controls: disposals, statutory deposits, an import, and the stock true-up. */
export async function seedSr7c(trx: Trx, ids: IdMap) {
  const org = ids.orgId;
  const admin = ids.users.u_arun;
  const priya = ids.users.u_priya;
  const hdfc = ids.bankAccounts.ba_hdfc;
  const asset = async (name: string) => Number((await trx.selectFrom('fixed_assets').select('id').where('org_id', '=', org).where('name', '=', name).executeTakeFirstOrThrow()).id);

  // ── 9. Disposals, each way, after the runs to the end of last month ──────
  await disposeAsset(trx, org, priya, await asset('Air compressor 10 HP'), {
    date: inThisMonth(12), kind: 'sold', proceedsVia: 'invoice', customerId: ids.contacts.c_sharma, salePaise: R(4_50_000), gstRatePct: 18,
    reason: 'Replaced by a 15 HP screw compressor',
  });
  await disposeAsset(trx, org, priya, await asset('Battery forklift'), {
    date: inThisMonth(18), kind: 'sold', proceedsVia: 'bank', bankAccountId: hdfc, salePaise: R(6_20_000),
    reason: 'Written off after the warehouse accident; the insurer settled the claim into HDFC',
  });
  await disposeAsset(trx, org, priya, await asset('Billing server (old)'), { date: inThisMonth(8), kind: 'scrapped', reason: 'Motherboard failed; not worth repairing' });
  await disposeAsset(trx, org, priya, await asset('Mezzanine shelving line'), {
    date: inThisMonth(20), kind: 'scrapped', partCostPaise: R(1_00_000), reason: 'One bay damaged by the forklift; the rest stays in use',
  });
  // Sold, then undone: the buyer's cheque bounced and the machine never left.
  const wheel = await trx.selectFrom('fixed_assets').select('id').where('org_id', '=', org).where('name', '=', 'Wheel alignment machine').executeTakeFirst();
  if (wheel) {
    await disposeAsset(trx, org, priya, Number(wheel.id), {
      date: inThisMonth(5), kind: 'sold', proceedsVia: 'invoice', customerId: ids.contacts.c_speedwell, salePaise: R(3_80_000), gstRatePct: 18, reason: 'Sale to Speedwell Garages',
    });
    await undoDisposal(trx, org, admin, Number(wheel.id), 'Sale cancelled: the buyer’s cheque bounced and the machine never left the workshop');
  }
  // Disposals of ₹5 lakh and above now need an admin's approval; the van waits for one.
  await setDisposalApproval(trx, org, admin, { isActive: true, thresholdPaise: R(5_00_000), approverRole: 'admin' });
  const van = await trx.selectFrom('fixed_assets').select('id').where('org_id', '=', org).where('name', 'like', 'Tata Ace%').executeTakeFirst();
  if (van) {
    await disposeAsset(trx, org, priya, Number(van.id), {
      date: inThisMonth(25), kind: 'sold', proceedsVia: 'invoice', customerId: ids.contacts.c_velocity, salePaise: R(5_60_000), gstRatePct: 28,
      reason: 'Replacing with an electric van; Velocity Auto Works has offered ₹5.6 lakh',
    });
  }

  // ── 10. TDS on salary deposited by challan, the months' dues paid ────────
  const months = [...MONTHS];
  let serial = 31;
  for (const m of months) {
    const due = (await salaryTdsMonths(trx, org, [m]))[0];
    if (!due || due.balancePaise <= 0) continue;
    await recordSalaryChallan(trx, org, admin, {
      forMonth: m, date: `${addMonths(m, 1)}-06`, bsrCode: '0510308', serial: String(serial++).padStart(5, '0'), taxPaise: due.balancePaise, bankAccountId: hdfc,
      notes: 'ITNS 281, 92B, HDFC net banking',
    });
  }
  const [y2, m2] = MONTHS[2].split('-').map(Number);
  const q2fy = m2 >= 4 ? y2 : y2 - 1;
  const q2 = (m2 >= 4 ? Math.floor((m2 - 4) / 3) + 1 : 4) as 1 | 2 | 3 | 4;
  await setReturnReceipt(trx, org, admin, q2fy, q2, 'QAUFRTYE4567890', `${addMonths(MONTHS[2], 1)}-28`);
  for (const m of MONTHS.slice(2)) {
    const { dues } = await statutoryRegister(trx, org, m, m);
    for (const d of dues) {
      if (d.balancePaise <= 0) continue;
      await payStatutory(trx, org, admin, {
        component: d.component, period: m, amountPaise: d.balancePaise, date: `${addMonths(m, 1)}-12`, bankAccountId: hdfc,
        reference: d.component === 'pf' ? `TRRN 3${m.replace('-', '')}11` : d.component === 'esi' ? `ESIC ${m.replace('-', '')}7` : `${d.component.toUpperCase()} ${m}`,
      });
    }
  }
  // Last month's transfer to Imran bounced (account closed): taken back, paid again two days later.
  const lastRun = await trx.selectFrom('payroll_runs').select('id').where('org_id', '=', org).where('month', '=', MONTHS[3]).executeTakeFirst();
  if (lastRun) {
    const s = await salaryPayments(trx, org, Number(lastRun.id));
    const imran = s.rows.find((r) => r.code === 'E008');
    const pay = imran?.payments.find((x) => !x.reversed);
    if (imran && pay) {
      await reverseSalaryPayment(trx, org, admin, Number(pay.id), 'Transfer returned: account closed; new account details taken');
      await paySalaries(trx, org, admin, Number(lastRun.id), { bankAccountId: hdfc, date: inThisMonth(3), employeeIds: [Number(imran.employeeId)], reference: 'NEFT re-sent' });
    }
  }

  // ── 14. June's payroll from greytHR, before payroll moved in-house ───────
  const june = addMonths(MONTHS[0], -1);
  const STAFF = [['E001', 'Karthik S', 'Stores', 14_000, 5_600, 5_400], ['E002', 'Lakshmi R', 'Accounts', 11_000, 4_400, 2_600],
    ['E003', 'Suresh M', 'Sales', 9_000, 3_600, 2_400], ['E004', 'Meena P', 'Service', 7_500, 3_000, 1_500], ['E005', 'Anand K', 'Logistics', 6_000, 2_400, 1_600]] as const;
  const rows = STAFF.map(([code, name, department, basic, hra, special]) => {
    const gross = basic + hra + special;
    const pfEe = Math.round(Math.min(basic, 15_000) * 0.12);
    const pfEr = Math.round(Math.min(basic, 15_000) * 0.13);
    const esiEe = gross <= 21_000 ? Math.ceil(gross * 0.0075) : 0;
    const esiEr = gross <= 21_000 ? Math.ceil(gross * 0.0325) : 0;
    return {
      code, name, department, basicPaise: R(basic), hraPaise: R(hra), otherPaise: R(special), grossPaise: R(gross),
      pfEmployeePaise: R(pfEe), pfEmployerPaise: R(pfEr), esiEmployeePaise: R(esiEe), esiEmployerPaise: R(esiEr), ptPaise: 0,
      lwfEmployeePaise: 0, lwfEmployerPaise: 0, tdsPaise: 0, advancePaise: 0, netPaise: R(gross - pfEe - esiEe),
    };
  });
  const imp = await importPayroll(trx, org, admin, {
    month: june, sourceSystem: 'greytHR', fileName: `greytHR-salary-register-${june}.xlsx`, rows, paidFromBankAccountId: hdfc, paidOn: `${MONTHS[0]}-01`,
  }, false);
  if (!imp.posted) throw new Error(`The June import did not post: ${imp.problems.map((p) => p.message).join('; ')}`);
  const { dues } = await statutoryRegister(trx, org, june, june);
  for (const d of dues) {
    if (d.balancePaise > 0) await payStatutory(trx, org, admin, { component: d.component, period: june, amountPaise: d.balancePaise, date: `${MONTHS[0]}-14`, bankAccountId: hdfc, reference: `${d.component.toUpperCase()} ${june}` });
  }

  // The Inventory account brought into line with the stock valuation today,
  // as the month-end true-up would: the integration check reads Pass.
  await trueUpStock(trx, org, admin, DEMO_TODAY, `Stock brought into line with its valuation at ${DEMO_TODAY} (integration check)`);
}
