// ─────────────────────────────────────────────────────────────────────────────
// GSTR-9 as the file the GST portal and its offline tool take (Returns →
// Annual Return → GSTR-9 → Prepare offline: open the downloaded JSON in the
// offline tool, or upload a prepared one).
//
// The key names are the GSTN's own, as its GSTR-9 save and file APIs and the
// offline tool use them, and cannot be changed: "fp" is the return period of
// the year's last month (032026 for FY 2025-26), every amount is in rupees as
// a number rounded to two places, and tables 10 to 13 travel together in one
// object ("table10"), as they share one sheet in the tool. Tables 4G1 and 5C1,
// added to the form for FY 2023-24, have no key in this schema; the screen
// says so where the year has them.
//
// This module is plain: it turns a computed Gstr9 into the file, so the
// tests can hold the two side by side.
// ─────────────────────────────────────────────────────────────────────────────

import type { Gstr9, TaxHeads, HsnSummaryRow, Table15Amounts } from './gstr9';

/** Rupees with two decimals, as a JSON number. */
export const r2 = (paise: number) => Math.round(paise) / 100;

const full = (h: TaxHeads) => ({ txval: r2(h.taxablePaise), iamt: r2(h.igstPaise), camt: r2(h.cgstPaise), samt: r2(h.sgstPaise), csamt: r2(h.cessPaise) });
const tax = (h: TaxHeads) => ({ iamt: r2(h.igstPaise), camt: r2(h.cgstPaise), samt: r2(h.sgstPaise), csamt: r2(h.cessPaise) });
const value = (paise: number) => ({ txval: r2(paise) });
const cs = (h: { cgstPaise: number; sgstPaise: number }) => ({ camt: r2(h.cgstPaise), samt: r2(h.sgstPaise) });
const igstCess = (h: TaxHeads) => ({ iamt: r2(h.igstPaise), csamt: r2(h.cessPaise) });
const typed = (b: { inputs: TaxHeads; capitalGoods: TaxHeads; inputServices?: TaxHeads }) => [
  { itc_typ: 'ip', ...tax(b.inputs) },
  { itc_typ: 'cg', ...tax(b.capitalGoods) },
  ...(b.inputServices ? [{ itc_typ: 'is', ...tax(b.inputServices) }] : []),
];
const hsnItems = (rows: HsnSummaryRow[]) => rows.filter((r) => r.code !== 'UNCLASSIFIED').map((r) => ({
  hsn_sc: r.code,
  uqc: r.uqc,
  desc: (r.description ?? '').trim().slice(0, 30),
  isconcesstional: 'N',
  qty: r.qty,
  txval: r2(r.taxablePaise),
  rt: r.ratePct,
  iamt: r2(r.igstPaise),
  camt: r2(r.cgstPaise),
  samt: r2(r.sgstPaise),
  csamt: r2(r.cessPaise),
}));
const t15 = (a: Table15Amounts) => ({
  iamt: r2(a.igstPaise), camt: r2(a.cgstPaise), samt: r2(a.sgstPaise), csamt: r2(a.cessPaise),
  intr: r2(a.interestPaise), pen: r2(a.penaltyPaise), fee: r2(a.lateFeePaise),
});

export function gstr9PortalJson(g: Gstr9) {
  const t4 = g.table4;
  const t5 = g.table5;
  const t6 = g.table6;
  const t7 = g.table7;
  const t8 = g.table8;
  const row9 = (head: 'IGST' | 'CGST' | 'SGST' | 'CESS') => g.table9.find((r) => r.head === head)!;
  const nine = (head: 'IGST' | 'CGST' | 'SGST') => {
    const r = row9(head);
    // Which credit may meet which head (s.49(5)): IGST meets all three; CGST
    // and SGST meet their own head and IGST, never each other.
    return {
      txpyble: r2(r.payablePaise),
      txpaid_cash: r2(r.paidInCashPaise),
      tax_paid_itc_iamt: r2(r.itc.IGST),
      ...(head !== 'SGST' ? { tax_paid_itc_camt: r2(r.itc.CGST) } : {}),
      ...(head !== 'CGST' ? { tax_paid_itc_samt: r2(r.itc.SGST) } : {}),
    };
  };
  const cess = row9('CESS');
  const paidOnly = (x: { payablePaise: number; paidPaise: number }) => ({ txpyble: r2(x.payablePaise), txpaid_cash: r2(x.paidPaise) });
  const t14 = (head: string) => {
    const r = g.table14.find((x) => x.head === head)!;
    return { txpyble: r2(r.payablePaise), txpaid: r2(r.paidPaise) };
  };

  return {
    gstin: g.gstin ?? '',
    isnil: g.isNil ? 'Y' : 'N',
    fp: `03${g.startYear + 1}`,
    table4: {
      b2c: full(t4.b2c),
      b2b: full(t4.b2b),
      exp: full(t4.exportsWithTax),
      sez: full(t4.sezWithTax),
      deemed: full(t4.deemedExports),
      at: full(t4.advances),
      rchrg: full(t4.rcmInward),
      sub_totalAG: full(t4.subtotalAG),
      cr_nt: full(t4.creditNotes),
      dr_nt: full(t4.debitNotes),
      amd_pos: full(t4.amendmentsPlus),
      amd_neg: full(t4.amendmentsMinus),
      sub_totalIL: full(t4.subtotalIL),
      sup_adv: full(t4.total),
    },
    table5: {
      zero_rtd: value(t5.zeroRated),
      sez: value(t5.sez),
      rchrg: value(t5.reverseCharge),
      exmt: value(t5.exempt),
      nil: value(t5.nil),
      non_gst: value(t5.nonGst),
      sub_totalAF: value(t5.subtotalAF),
      cr_nt: value(t5.creditNotes),
      dr_nt: value(t5.debitNotes),
      amd_pos: value(t5.amendmentsPlus),
      amd_neg: value(t5.amendmentsMinus),
      sub_totalHK: value(t5.subtotalHK),
      tover_tax_np: value(t5.notTaxable),
      total_tover: value(t5.totalTurnover),
    },
    table6: {
      itc_3b: tax(t6.itc3b),
      supp_non_rchrg: typed(t6.inward),
      supp_rchrg_unreg: typed(t6.rcmUnregistered),
      supp_rchrg_reg: typed(t6.rcmRegistered),
      iog: [
        { itc_typ: 'ip', ...igstCess(t6.importGoods.inputs) },
        { itc_typ: 'cg', ...igstCess(t6.importGoods.capitalGoods) },
      ],
      ios: igstCess(t6.importServices),
      isd: tax(t6.isd),
      itc_clmd: tax(t6.reclaimed),
      tran1: cs(t6.tran1),
      tran2: cs(t6.tran2),
      other: t6.otherDetail.map((o) => ({ desc: o.description.slice(0, 100), iamt: r2(o.igstPaise), camt: r2(o.cgstPaise), samt: r2(o.sgstPaise), csamt: r2(o.cessPaise) })),
      sub_totalBH: tax(t6.subtotalBH),
      difference: tax(t6.difference),
      sub_totalKM: tax(t6.subtotalKM),
      total_itc_availed: tax(t6.total),
    },
    table7: {
      rule37: tax(t7.rule37),
      rule39: tax(t7.rule39),
      rule42: tax(t7.rule42),
      rule43: tax(t7.rule43),
      sec17: tax(t7.section17_5),
      revsl_tran1: cs(t7.tran1),
      revsl_tran2: cs(t7.tran2),
      other: t7.otherDetail.map((o) => ({ desc: o.description.slice(0, 100), iamt: r2(o.igstPaise), camt: r2(o.cgstPaise), samt: r2(o.sgstPaise), csamt: r2(o.cessPaise) })),
      tot_itc_revd: tax(t7.total),
      net_itc_aval: tax(t7.netAvailable),
    },
    table8: {
      itc_2a: tax(t8.asPer2b),
      itc_tot: tax(t8.asPerTable6),
      itc_inwd_supp: tax(t8.nextYear),
      differenceABC: tax(t8.difference),
      itc_nt_availd: tax(t8.notAvailed),
      itc_nt_eleg: tax(t8.ineligible),
      iog_taxpaid: igstCess(t8.importIgstPaid),
      iog_itc_availd: igstCess(t8.importIgstAvailed),
      differenceGH: igstCess(t8.importDifference),
      iog_itc_ntavaild: igstCess(t8.importNotAvailed),
      tot_itc_lapsed: tax(t8.lapsed),
    },
    table9: {
      iamt: nine('IGST'),
      camt: nine('CGST'),
      samt: nine('SGST'),
      csamt: { txpyble: r2(cess.payablePaise), txpaid_cash: r2(cess.paidInCashPaise), tax_paid_itc_csamt: r2(cess.itc.CESS) },
      intr: paidOnly(g.table9Other.interest),
      fee: paidOnly(g.table9Other.lateFee),
      pen: paidOnly(g.table9Other.penalty),
      other: paidOnly(g.table9Other.other),
    },
    table10: {
      dbn_amd: full(g.table10),
      cdn_amd: full(g.table11),
      itc_rvsl: tax(g.table12),
      itc_availd: tax(g.table13),
      // Total turnover after the amendments: 5N, plus 10, less 11.
      total_turnover: full({
        taxablePaise: g.table5.totalTurnover + g.table10.taxablePaise - g.table11.taxablePaise,
        igstPaise: g.table10.igstPaise - g.table11.igstPaise,
        cgstPaise: g.table10.cgstPaise - g.table11.cgstPaise,
        sgstPaise: g.table10.sgstPaise - g.table11.sgstPaise,
        cessPaise: g.table10.cessPaise - g.table11.cessPaise,
      }),
    },
    table14: {
      iamt: t14('IGST'),
      camt: t14('CGST'),
      samt: t14('SGST'),
      csamt: t14('CESS'),
      intr: t14('INTEREST'),
    },
    table15: {
      rfd_clmd: t15(g.table15.refundClaimed),
      rfd_sanc: t15(g.table15.refundSanctioned),
      rfd_rejt: t15(g.table15.refundRejected),
      rfd_pend: t15(g.table15.refundPending),
      tax_dmnd: t15(g.table15.demand),
      tax_paid: t15(g.table15.demandPaid),
      dmnd_pend: t15(g.table15.demandPending),
    },
    table16: {
      comp_supp: value(g.table16.composition),
      deemed_supp: full(g.table16.deemedSupply),
      not_returned: full(g.table16.approval),
    },
    table17: { items: hsnItems(g.table17) },
    table18: { items: hsnItems(g.table18) },
  };
}

export type Gstr9PortalFile = ReturnType<typeof gstr9PortalJson>;
