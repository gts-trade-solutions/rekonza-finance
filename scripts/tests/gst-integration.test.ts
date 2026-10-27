// The GST portal integration: payload building, the pre-flight check, and the
// e-way bill rules.
//   npx tsx --conditions=react-server --test scripts/tests/gst-integration.test.ts
//
// No database and no network. Everything under test here is a rule the
// government enforces, expressed as a pure function — which is exactly the
// part worth pinning down, because a wrong threshold is a detained vehicle and
// a wrong payload is a rejected invoice.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEinvoicePayload, fromIrpDate, isServiceLine, toIrpDate, toIrpSupplyType, toRupees2,
  type EinvoiceLine, type EinvoiceSource,
} from '../../lib/server/integrations/gst/einvoice-payload';
import { preflightEinvoice, summarise } from '../../lib/server/integrations/gst/preflight';
import { buildEwayBillPayload, toSubSupplyCode } from '../../lib/server/integrations/gst/eway-payload';
import { fakeIrn, fakeProvider, financialYear } from '../../lib/server/integrations/gst/fake';
import {
  assessEwayBill, canExtend, normaliseVehicleNo, thresholdPaise, validityDays, validUntil,
} from '../../lib/tax/eway';

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// A real, arithmetically consistent invoice: 10 chairs at ₹1,500, 18% GST
// within Tamil Nadu. ₹15,000 taxable, ₹1,350 CGST, ₹1,350 SGST, ₹17,700 total.
// The GSTINs are structurally valid with correct mod-36 check digits.

const SELLER_GSTIN = '33AABCU9603R1ZU';
const BUYER_GSTIN = '33AAACR5055K1ZE';

function line(over: Partial<EinvoiceLine> = {}): EinvoiceLine {
  return {
    lineNo: 1,
    description: 'Office chair, mesh back',
    hsnSac: '940130',
    qty: 10,
    uqc: 'NOS',
    ratePaise: 1_500_00,
    discountPaise: 0,
    taxablePaise: 15_000_00,
    gstRatePct: 18,
    cgstPaise: 1_350_00,
    sgstPaise: 1_350_00,
    igstPaise: 0,
    cessPaise: 0,
    lineTotalPaise: 17_700_00,
    ...over,
  };
}

function invoice(over: Partial<EinvoiceSource> = {}): EinvoiceSource {
  return {
    docType: 'INV',
    number: 'INV/2026/0042',
    date: '2026-09-01',
    supplyType: 'intra',
    supplyKind: 'goods',
    placeOfSupply: '33',
    seller: {
      gstin: SELLER_GSTIN,
      legalName: 'Coastal Furnishings Private Limited',
      tradeName: 'Coastal Furnishings',
      address1: '14 Anna Salai',
      city: 'Chennai',
      pincode: '600002',
      stateCode: '33',
    },
    buyer: {
      gstin: BUYER_GSTIN,
      legalName: 'Ridge Office Supplies LLP',
      tradeName: 'Ridge Office',
      address1: '9 Mount Road',
      city: 'Chennai',
      pincode: '600006',
      stateCode: '33',
    },
    lines: [line()],
    docDiscountPaise: 0,
    shippingChargePaise: 0,
    adjustmentPaise: 0,
    roundOffPaise: 0,
    totalPaise: 17_700_00,
    ...over,
  };
}

const TODAY = '2026-09-10';
const clean = { today: TODAY, aatoAbove5Cr: true };

/** Every error message, joined — so a test can assert on what the user is told. */
const errorText = (src: EinvoiceSource, opts = clean) =>
  preflightEinvoice(src, opts).errors.map((e) => `${e.field}: ${e.message}`).join('\n');

// ── Conversions ──────────────────────────────────────────────────────────────

test('dates convert to the portal format and back', () => {
  assert.equal(toIrpDate('2026-09-01'), '01/09/2026');
  assert.equal(fromIrpDate('01/09/2026'), '2026-09-01');
  assert.equal(fromIrpDate(toIrpDate('2026-03-31')), '2026-03-31');
});

test('paise convert to rupees without drifting', () => {
  assert.equal(toRupees2(17_700_00), 17700);
  assert.equal(toRupees2(1), 0.01);
  assert.equal(toRupees2(333_33), 333.33);
  // The classic float trap: 0.1 + 0.2. Integer paise never let it happen.
  assert.equal(toRupees2(10 + 20), 0.3);
});

test('the financial year starts in April', () => {
  assert.equal(financialYear('2026-04-01'), '2026-27');
  assert.equal(financialYear('2027-03-31'), '2026-27');
  // A January invoice belongs to the year that began the previous April.
  assert.equal(financialYear('2027-01-15'), '2026-27');
  assert.equal(financialYear('2026-03-31'), '2025-26');
});

test('supply types map to the portal codes', () => {
  assert.equal(toIrpSupplyType('intra'), 'B2B');
  assert.equal(toIrpSupplyType('inter'), 'B2B');
  assert.equal(toIrpSupplyType('nil_or_exempt'), 'B2B');
  assert.equal(toIrpSupplyType('export_lut'), 'EXPWOP');
  assert.equal(toIrpSupplyType('export_with_tax'), 'EXPWP');
  assert.equal(toIrpSupplyType('sez'), 'SEZWOP');
});

test('a service is recognised by its 99-prefixed code, per line', () => {
  assert.equal(isServiceLine('998313', 'goods'), true, 'SAC wins over the document');
  assert.equal(isServiceLine('940130', 'service'), false, 'HSN wins over the document');
  // Falls back to the document only when the line has no code at all.
  assert.equal(isServiceLine(null, 'service'), true);
  assert.equal(isServiceLine(null, 'goods'), false);
});

// ── Payload ──────────────────────────────────────────────────────────────────

test('a B2B invoice builds into the portal schema', () => {
  const p = buildEinvoicePayload(invoice());

  assert.equal(p.Version, '1.1');
  assert.equal(p.TranDtls.SupTyp, 'B2B');
  assert.equal(p.TranDtls.RegRev, 'N');
  assert.equal(p.DocDtls.Typ, 'INV');
  assert.equal(p.DocDtls.No, 'INV/2026/0042');
  assert.equal(p.DocDtls.Dt, '01/09/2026');

  assert.equal(p.SellerDtls.Gstin, SELLER_GSTIN);
  assert.equal(p.SellerDtls.Pin, 600002);
  assert.equal(p.SellerDtls.Stcd, '33');
  assert.equal(p.SellerDtls.Pos, undefined, 'place of supply belongs to the buyer only');

  assert.equal(p.BuyerDtls.Pos, '33');
  assert.equal(p.BuyerDtls.Pin, 600006);

  assert.equal(p.ItemList.length, 1);
  assert.equal(p.ItemList[0].IsServc, 'N');
  assert.equal(p.ItemList[0].HsnCd, '940130');
  assert.equal(p.ItemList[0].Qty, 10);
  assert.equal(p.ItemList[0].Unit, 'NOS');
  assert.equal(p.ItemList[0].AssAmt, 15000);
  assert.equal(p.ItemList[0].TotAmt, 15000);
  assert.equal(p.ItemList[0].CgstAmt, 1350);
  assert.equal(p.ItemList[0].TotItemVal, 17700);

  assert.equal(p.ValDtls.AssVal, 15000);
  assert.equal(p.ValDtls.CgstVal, 1350);
  assert.equal(p.ValDtls.SgstVal, 1350);
  assert.equal(p.ValDtls.IgstVal, 0);
  assert.equal(p.ValDtls.TotInvVal, 17700);

  assert.equal(p.EwbDtls, undefined, 'no transport details, no e-way bill request');
  assert.equal(p.ShipDtls, undefined, 'ship-to is only sent when it differs');
});

test('a service line carries no quantity or unit', () => {
  const p = buildEinvoicePayload(
    invoice({
      supplyKind: 'service',
      lines: [line({ hsnSac: '998313', qty: 1, uqc: null })],
    }),
  );
  assert.equal(p.ItemList[0].IsServc, 'Y');
  assert.equal(p.ItemList[0].Qty, undefined);
  assert.equal(p.ItemList[0].Unit, undefined);
});

test('an export buyer goes as state 96 and PIN 999999', () => {
  const p = buildEinvoicePayload(
    invoice({
      supplyType: 'export_lut',
      placeOfSupply: '96',
      buyer: {
        gstin: null,
        legalName: 'Harbour Trading Co',
        address1: '400 Orchard Road',
        city: 'Singapore',
        pincode: '238877',
        stateCode: '96',
      },
      lines: [line({ cgstPaise: 0, sgstPaise: 0, lineTotalPaise: 15_000_00, gstRatePct: 0 })],
      totalPaise: 15_000_00,
      export: { currency: 'USD', countryCode: 'SG' },
    }),
  );

  assert.equal(p.TranDtls.SupTyp, 'EXPWOP');
  assert.equal(p.BuyerDtls.Pin, 999999, 'a foreign postcode is a rejection');
  assert.equal(p.BuyerDtls.Stcd, '96');
  assert.equal(p.BuyerDtls.Pos, '96');
  assert.equal(p.BuyerDtls.Gstin, 'URP', "the portal's own placeholder");
  assert.equal(p.ExpDtls?.ForCur, 'USD');
  assert.equal(p.ExpDtls?.RefClm, 'N', 'nothing to refund under a letter of undertaking');
});

test('transport details ride along, so one call yields both documents', () => {
  const p = buildEinvoicePayload(
    invoice({
      transport: { vehicleNo: 'TN-01-AB-1234', distanceKm: 320, mode: 'road' },
    }),
  );
  assert.equal(p.EwbDtls?.VehNo, 'TN01AB1234', 'punctuation is stripped');
  assert.equal(p.EwbDtls?.Distance, 320);
  assert.equal(p.EwbDtls?.TransMode, '1');
  assert.equal(p.EwbDtls?.VehType, 'R');
});

// ── Pre-flight: the document ─────────────────────────────────────────────────

test('a well-formed invoice passes', () => {
  const result = preflightEinvoice(invoice(), clean);
  assert.equal(result.ok, true, errorText(invoice()));
  assert.equal(result.errors.length, 0);
  assert.equal(summarise(result), '');
});

test('invoice numbers the portal refuses are caught here instead', () => {
  // Starts with a zero — a real portal rule, and a very ordinary-looking series.
  assert.match(errorText(invoice({ number: '0042/2026' })), /starts with "0"/);
  // Starts with a slash.
  assert.match(errorText(invoice({ number: '/2026/42' })), /starts with "\/"/);
  // Too long.
  assert.match(errorText(invoice({ number: 'INVOICE/2026-27/000042' })), /22 characters.*allows 16/s);
  // A space, a hash and brackets are all out.
  assert.match(errorText(invoice({ number: 'INV 42' })), /Only letters, digits/);
  assert.match(errorText(invoice({ number: 'INV#42' })), /Only letters, digits/);
  // And the ordinary case still passes.
  assert.equal(preflightEinvoice(invoice({ number: 'INV-2026-42' }), clean).ok, true);
});

test('a future-dated or pre-GST invoice is refused', () => {
  assert.match(errorText(invoice({ date: '2026-12-01' })), /in the future/);
  assert.match(errorText(invoice({ date: '2017-06-30' })), /before GST began/);
});

test('the 30-day window is an error above 10 crore and a warning below it', () => {
  const old = invoice({ date: '2026-07-01' }); // 71 days before TODAY

  const big = preflightEinvoice(old, { ...clean, aatoAbove10Cr: true });
  assert.equal(big.ok, false);
  assert.match(big.errors.map((e) => e.message).join(), /71 days old.*credit note/s);

  const small = preflightEinvoice(old, { ...clean, aatoAbove10Cr: false });
  assert.equal(small.ok, true, 'the hard stop is a 10-crore rule, not everyone’s');
  assert.match(small.warnings.map((w) => w.message).join(), /71 days old/);
});

// ── Pre-flight: the parties ──────────────────────────────────────────────────

test('the missing PIN codes are named, not hidden behind an error code', () => {
  const text = errorText(
    invoice({
      seller: { ...invoice().seller, pincode: null },
      buyer: { ...invoice().buyer, pincode: null },
    }),
  );
  assert.match(text, /seller\.pincode: No PIN code for this branch/);
  assert.match(text, /buyer\.pincode: No PIN code for the customer/);
});

test('a PIN code that cannot be one is rejected', () => {
  assert.match(errorText(invoice({ buyer: { ...invoice().buyer, pincode: '60006' } })), /not a valid PIN/);
  assert.match(errorText(invoice({ buyer: { ...invoice().buyer, pincode: '060006' } })), /cannot start with 0/);
});

test('a missing city is caught — the portal wants it as its own field', () => {
  assert.match(errorText(invoice({ buyer: { ...invoice().buyer, city: null } })), /buyer\.city/);
  assert.match(errorText(invoice({ seller: { ...invoice().seller, city: '' } })), /seller\.city/);
});

test('a mistyped GSTIN fails its checksum', () => {
  // Last character changed, so the mod-36 check no longer holds.
  const text = errorText(invoice({ buyer: { ...invoice().buyer, gstin: '33AAACR5055K1ZF' } }));
  assert.match(text, /fails its checksum/);
});

test("a GSTIN that disagrees with its own state is caught", () => {
  // The GSTIN says 33 (Tamil Nadu); the branch claims 29 (Karnataka).
  const text = errorText(invoice({ seller: { ...invoice().seller, stateCode: '29' } }));
  assert.match(text, /begins 33 \(Tamil Nadu\).*set to 29 \(Karnataka\)/s);
});

test('an unregistered customer cannot be registered as B2B', () => {
  const text = errorText(invoice({ buyer: { ...invoice().buyer, gstin: null } }));
  assert.match(text, /Only business-to-business supplies are registered/);
});

test('a customer registered elsewhere than the place of supply is a warning', () => {
  // Billed to a Karnataka registration, delivered in Tamil Nadu. Legitimate,
  // but the commonest cause of a supply taxed the wrong way round.
  const src = invoice({
    supplyType: 'inter',
    placeOfSupply: '29',
    lines: [line({ cgstPaise: 0, sgstPaise: 0, igstPaise: 2_700_00 })],
  });
  const result = preflightEinvoice(src, clean);
  assert.equal(result.ok, true);
  assert.match(result.warnings.map((w) => w.message).join(), /place of supply is Karnataka/);
});

// ── Pre-flight: which tax applies ────────────────────────────────────────────

test('a supply within one state cannot carry IGST', () => {
  const text = errorText(
    invoice({ lines: [line({ cgstPaise: 0, sgstPaise: 0, igstPaise: 2_700_00 })] }),
  );
  assert.match(text, /within one state but the lines carry IGST/);
});

test('a supply between states cannot carry CGST and SGST', () => {
  const text = errorText(invoice({ supplyType: 'inter', placeOfSupply: '29' }));
  assert.match(text, /between states but the lines carry CGST and SGST/);
});

test('CGST and SGST are always the same half', () => {
  const text = errorText(
    invoice({ lines: [line({ cgstPaise: 1_400_00, sgstPaise: 1_300_00 })] }),
  );
  assert.match(text, /CGST \(₹1400\.00\) and SGST \(₹1300\.00\) differ/);
});

test('a zero-rated supply carrying tax is refused', () => {
  const text = errorText(
    invoice({ supplyType: 'sez', placeOfSupply: '29' }),
  );
  assert.match(text, /zero-rated supply carries tax/);
});

// ── Pre-flight: lines ────────────────────────────────────────────────────────

test('a line with no HSN code names the line, not a code number', () => {
  const text = errorText(invoice({ lines: [line({ hsnSac: null })] }));
  assert.match(text, /"Office chair, mesh back" has no HSN code/);
});

test('HSN has to be 4, 6 or 8 digits', () => {
  assert.match(errorText(invoice({ lines: [line({ hsnSac: '940' })] })), /must be 4, 6 or 8 digits/);
  assert.match(errorText(invoice({ lines: [line({ hsnSac: '94013090x' })] })), /must be 4, 6 or 8 digits/);
  assert.equal(preflightEinvoice(invoice({ lines: [line({ hsnSac: '9401' })] }), clean).ok, true);
});

test('a 4-digit HSN warns above 5 crore turnover, and passes below it', () => {
  const src = invoice({ lines: [line({ hsnSac: '9401' })] });
  const above = preflightEinvoice(src, { today: TODAY, aatoAbove5Cr: true });
  assert.match(above.warnings.map((w) => w.message).join(), /is 4 digits.*six are required/s);
  const below = preflightEinvoice(src, { today: TODAY, aatoAbove5Cr: false });
  assert.equal(below.warnings.length, 0);
});

test('goods need a positive quantity and a real unit code', () => {
  assert.match(errorText(invoice({ lines: [line({ qty: 0 })] })), /need a positive quantity/);
  // 'KG' is the mistake; the code is 'KGS'.
  assert.match(errorText(invoice({ lines: [line({ uqc: 'KG' })] })), /not one the portal recognises/);
  assert.match(errorText(invoice({ lines: [line({ uqc: null })] })), /has no unit of measure/);
  assert.equal(preflightEinvoice(invoice({ lines: [line({ uqc: 'kgs' })] }), clean).ok, true,
    'the code is accepted whatever case it is typed in');
});

test('the withdrawn 12% and 28% slabs warn after GST 2.0, and pass before it', () => {
  const at12 = invoice({
    date: '2026-09-01',
    lines: [line({ gstRatePct: 12, cgstPaise: 900_00, sgstPaise: 900_00, lineTotalPaise: 16_800_00 })],
    totalPaise: 16_800_00,
  });
  const after = preflightEinvoice(at12, clean);
  assert.equal(after.ok, true, 'a withdrawn rate is a warning, never a block');
  assert.match(after.warnings.map((w) => w.message).join(), /GST 2\.0 abolished that slab/);

  // The same rate on a pre-reform document is simply correct.
  const before = preflightEinvoice({ ...at12, date: '2025-06-01' }, { ...clean, aatoAbove10Cr: false });
  assert.equal(before.warnings.filter((w) => /abolished/.test(w.message)).length, 0);
});

test('a rate that does not match the tax charged is caught', () => {
  // Marked 18%, but only 5% of tax is actually on the line.
  const text = errorText(
    invoice({
      lines: [line({ cgstPaise: 375_00, sgstPaise: 375_00, lineTotalPaise: 15_750_00 })],
      totalPaise: 15_750_00,
    }),
  );
  assert.match(text, /marked 18% but carries ₹750\.00 of tax/);
});

test('a line whose parts do not add up is caught', () => {
  const text = errorText(
    invoice({ lines: [line({ lineTotalPaise: 20_000_00 })], totalPaise: 20_000_00 }),
  );
  assert.match(text, /totals ₹20000\.00 but its taxable value plus tax comes to ₹17700\.00/);
});

test('a document total that does not reconcile is caught, with the workings', () => {
  const text = errorText(invoice({ totalPaise: 18_000_00 }));
  assert.match(text, /total is ₹18000\.00 but its parts add up to ₹17700\.00/);
  assert.match(text, /taxable ₹15000\.00, tax ₹2700\.00/);
});

test('one rupee of rounding is allowed, as the portal allows', () => {
  assert.equal(preflightEinvoice(invoice({ totalPaise: 17_700_50 }), clean).ok, true);
  assert.equal(preflightEinvoice(invoice({ totalPaise: 17_705_00 }), clean).ok, false);
});

test('an empty invoice has nothing to register', () => {
  assert.match(errorText(invoice({ lines: [], totalPaise: 0 })), /has no lines/);
});

test('the summary lists a few problems and counts the rest', () => {
  const result = preflightEinvoice(
    invoice({
      number: '0042',
      seller: { ...invoice().seller, pincode: null, city: null },
      buyer: { ...invoice().buyer, pincode: null, city: null },
    }),
    clean,
  );
  const text = summarise(result, 2);
  assert.equal(text.split(' ').length > 3, true);
  assert.match(text, /and \d+ more problems\./);
});

// ── E-way bill: when one is needed ───────────────────────────────────────────

const movement = (over: Partial<Parameters<typeof assessEwayBill>[0]> = {}) =>
  assessEwayBill({
    supplyKind: 'goods',
    consignmentPaise: 60_000_00,
    fromStateCode: '33',
    toStateCode: '29',
    reason: 'supply',
    docDate: '2026-09-01',
    today: TODAY,
    ...over,
  });

test('services never need an e-way bill', () => {
  const a = movement({ supplyKind: 'service', consignmentPaise: 10_00_000_00 });
  assert.equal(a.required, false);
  assert.match(a.reason, /Services do not move/);
});

test('the inter-state threshold is 50,000 either side of it', () => {
  assert.equal(movement({ consignmentPaise: 40_000_00 }).required, false);
  assert.equal(movement({ consignmentPaise: 50_000_00 }).required, false, 'the rule says "exceeds"');
  assert.equal(movement({ consignmentPaise: 50_000_01 }).required, true);
});

test('a state that raised its own intra-state limit is respected', () => {
  assert.equal(thresholdPaise('33', '33'), 100_000_00, 'Tamil Nadu, inside the state');
  assert.equal(thresholdPaise('33', '29'), 50_000_00, 'between states it is always 50,000');
  assert.equal(thresholdPaise('29', '29'), 50_000_00, 'Karnataka has not raised it');

  const withinTn = movement({ fromStateCode: '33', toStateCode: '33', consignmentPaise: 60_000_00 });
  assert.equal(withinTn.required, false);
  assert.match(withinTn.reason, /within ₹1,00,000/);

  assert.equal(
    movement({ fromStateCode: '33', toStateCode: '33', consignmentPaise: 150_000_00 }).required,
    true,
  );
});

test('a supply to an SEZ is inter-state, even inside one state', () => {
  // Tamil Nadu to an SEZ unit in Tamil Nadu. The lorry never crosses a border,
  // but the supply is inter-state by statute, so the ₹50,000 floor applies —
  // not the state's own ₹1 lakh.
  const a = movement({
    fromStateCode: '33', toStateCode: '33', consignmentPaise: 58_000_00, interStateSupply: true,
  });
  assert.equal(a.required, true);
  assert.equal(a.thresholdPaise, 50_000_00);
  assert.match(a.reason, /counts as inter-state even inside one state/);

  // Judged on the map alone, the same movement slips under the state limit.
  // That was the bug; this line is what keeps it from coming back.
  assert.equal(
    movement({ fromStateCode: '33', toStateCode: '33', consignmentPaise: 58_000_00 }).required,
    false,
  );
});

test('the job-work rule follows the lorry, not the legal classification', () => {
  // "Sent to a job worker located in any other State" — a physical test. A
  // deemed inter-state supply that never crosses a border does not trigger it.
  const a = movement({
    reason: 'job_work', fromStateCode: '33', toStateCode: '33',
    consignmentPaise: 10_000_00, interStateSupply: true,
  });
  assert.equal(a.required, false);
  assert.equal(a.thresholdPaise, 50_000_00);
});

test('inter-state job work needs a bill at any value at all', () => {
  const a = movement({ reason: 'job_work', consignmentPaise: 10_000_00 });
  assert.equal(a.required, true);
  assert.equal(a.thresholdPaise, null, 'no threshold was applied');
  assert.match(a.reason, /whatever they are worth/);

  // Within one state the ordinary threshold is back.
  assert.equal(
    movement({ reason: 'job_work', consignmentPaise: 10_000_00, toStateCode: '33' }).required,
    false,
  );
});

test('a document older than 180 days blocks generation outright', () => {
  const a = movement({ docDate: '2026-01-01' });
  assert.equal(a.required, true, 'still needed — just impossible');
  assert.equal(a.blockers.length, 1);
  assert.match(a.blockers[0], /252 days old.*180 days/s);
});

test('a mixed goods-and-services document warns that the figure is overstated', () => {
  const a = movement({ supplyKind: 'both' });
  assert.match(a.warnings.join(), /Only the goods count towards the threshold/);
});

// ── E-way bill: how long it lasts ────────────────────────────────────────────

test('validity is one day per 200 km, and never less than one', () => {
  assert.equal(validityDays(0), 1);
  assert.equal(validityDays(100), 1);
  assert.equal(validityDays(200), 1);
  assert.equal(validityDays(201), 2);
  assert.equal(validityDays(400), 2);
  assert.equal(validityDays(450), 3);
});

test('over-dimensional cargo gets a day per 20 km', () => {
  assert.equal(validityDays(20, true), 1);
  assert.equal(validityDays(21, true), 2);
  assert.equal(validityDays(320, true), 16);
});

test('validity runs to midnight of the last day, not to the same clock time', () => {
  // Part B entered at 6pm on a one-day bill: it expires tonight, six hours
  // later — not twenty-four. Getting this wrong is a detained lorry.
  const partB = new Date(2026, 8, 10, 18, 0, 0);
  const ends = validUntil(partB, 150);
  assert.equal(ends.getDate(), 10);
  assert.equal(ends.getHours(), 23);
  assert.equal(ends.getMinutes(), 59);

  // 320 km is two days, so it runs to midnight tomorrow.
  assert.equal(validUntil(partB, 320).getDate(), 11);
  assert.equal(validUntil(partB, 450).getDate(), 12);
});

test('extension is only possible 8 hours either side of expiry', () => {
  const generated = new Date(2026, 8, 10, 9, 0, 0);
  const expires = new Date(2026, 8, 11, 23, 59, 59);

  // A day early.
  const early = canExtend(expires, generated, new Date(2026, 8, 10, 12, 0, 0));
  assert.equal(early.allowed, false);
  assert.match(early.reason, /Too early/);

  // Inside the window, before expiry.
  assert.equal(canExtend(expires, generated, new Date(2026, 8, 11, 18, 0, 0)).allowed, true);
  // Inside the window, after expiry.
  assert.equal(canExtend(expires, generated, new Date(2026, 8, 12, 5, 0, 0)).allowed, true);

  // Too late — and there is no remedy, which the message has to say.
  const late = canExtend(expires, generated, new Date(2026, 8, 12, 10, 0, 0));
  assert.equal(late.allowed, false);
  assert.match(late.reason, /cannot be revived/);
});

test('extension is capped at 360 days from generation', () => {
  const generated = new Date(2025, 8, 1, 9, 0, 0);
  const now = new Date(2026, 8, 10, 12, 0, 0); // ~374 days later
  const expires = new Date(2026, 8, 10, 14, 0, 0);
  const r = canExtend(expires, generated, now);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /cannot be extended past 360 days/);
});

test('a vehicle number is normalised, or refused', () => {
  assert.equal(normaliseVehicleNo('TN-01-AB-1234'), 'TN01AB1234');
  assert.equal(normaliseVehicleNo('tn 01 ab 1234'), 'TN01AB1234');
  assert.equal(normaliseVehicleNo('TN01'), null, 'too short to be one');
  assert.equal(normaliseVehicleNo('TN01AB1234567'), null, 'too long to be one');
});

// ── E-way bill payload ───────────────────────────────────────────────────────

test('a challan movement maps to the right reason code', () => {
  assert.equal(toSubSupplyCode('supply'), '1');
  assert.equal(toSubSupplyCode('job_work'), '4');
  assert.equal(toSubSupplyCode('line_sales'), '10');
  assert.equal(toSubSupplyCode('nonsense'), '8', 'unknown falls back to Others');
});

test('an e-way bill payload splits the rate the way the supply was taxed', () => {
  const p = buildEwayBillPayload({
    direction: 'O',
    subSupplyType: 'job_work',
    docType: 'CHL',
    docNo: 'DC/2026/07',
    docDate: '2026-09-01',
    from: {
      gstin: SELLER_GSTIN, tradeName: 'Coastal Furnishings', address1: '14 Anna Salai',
      place: 'Chennai', pincode: '600002', stateCode: '33',
    },
    to: {
      gstin: null, tradeName: 'Vel Fabrication', address1: '5 GST Road',
      place: 'Hosur', pincode: '635109', stateCode: '33',
    },
    taxablePaise: 80_000_00,
    cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0,
    otherChargesPaise: 0,
    totalPaise: 80_000_00,
    lines: [{
      name: 'Steel frame blanks', description: 'For powder coating', hsnSac: '7326',
      qty: 200, uqc: 'NOS', gstRatePct: 18, intra: true, taxablePaise: 80_000_00,
    }],
    transport: { vehicleNo: 'TN-70-Z-9911', distanceKm: 45, mode: 'road' },
  });

  assert.equal(p.subSupplyType, '4', 'job work');
  assert.equal(p.docType, 'CHL');
  assert.equal(p.docDate, '01/09/2026');
  assert.equal(p.toGstin, 'URP', 'the job worker is unregistered');
  assert.equal(p.fromPincode, 600002);
  assert.equal(p.toPincode, 635109);
  assert.equal(p.transDistance, '45');
  assert.equal(p.vehicleNo, 'TN70Z9911');
  assert.equal(p.vehicleType, 'R');
  // Within one state the rate splits in half on each of CGST and SGST.
  assert.equal(p.itemList[0].cgstRate, 9);
  assert.equal(p.itemList[0].sgstRate, 9);
  assert.equal(p.itemList[0].igstRate, 0);
  assert.equal(p.itemList[0].taxableAmount, 80000);
});

test('distance zero asks the portal for its own figure', () => {
  // Deliberate: NIC's pin-to-pin number is the one an officer sees, so
  // disagreeing with it gains nothing.
  const p = buildEwayBillPayload({
    direction: 'O', subSupplyType: 'supply', docType: 'INV', docNo: 'INV/1', docDate: '2026-09-01',
    from: { gstin: SELLER_GSTIN, tradeName: 'A', address1: 'x', place: 'Chennai', pincode: '600002', stateCode: '33' },
    to: { gstin: BUYER_GSTIN, tradeName: 'B', address1: 'y', place: 'Chennai', pincode: '600006', stateCode: '33' },
    taxablePaise: 100, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0,
    otherChargesPaise: 0, totalPaise: 100, lines: [], transport: null,
  });
  assert.equal(p.transDistance, '0');
});

// ── The stand-in provider ────────────────────────────────────────────────────

test('the stand-in IRN is deterministic, marked, and 64 characters', () => {
  const a = fakeIrn(SELLER_GSTIN, 'INV', 'INV/2026/0042', '2026-09-01');
  const b = fakeIrn(SELLER_GSTIN, 'INV', 'INV/2026/0042', '2026-09-01');
  assert.equal(a, b, 'a retry must not produce a second reference');
  assert.equal(a.length, 64);
  assert.equal(a.startsWith('DEMO'), true, 'never mistakable for a real IRN');

  // A different document, or a different year, is a different fingerprint.
  assert.notEqual(a, fakeIrn(SELLER_GSTIN, 'INV', 'INV/2026/0043', '2026-09-01'));
  assert.notEqual(a, fakeIrn(SELLER_GSTIN, 'INV', 'INV/2026/0042', '2027-09-01'));
  assert.notEqual(a, fakeIrn(BUYER_GSTIN, 'INV', 'INV/2026/0042', '2026-09-01'));
});

test('the stand-in issues an e-way bill only when a vehicle was sent', () => {
  const ctx = { orgId: 1, connectionId: null, gstin: SELLER_GSTIN };

  return Promise.all([
    fakeProvider.generateIrn(buildEinvoicePayload(invoice()), ctx),
    fakeProvider.generateIrn(
      buildEinvoicePayload(invoice({ transport: { vehicleNo: 'TN01AB1234', distanceKm: 320 } })),
      ctx,
    ),
  ]).then(([plain, withVehicle]) => {
    assert.equal(plain.ewbNo, null);
    assert.equal(plain.ewbValidUntil, null);
    assert.match(plain.irn, /^DEMO/);
    assert.equal(plain.ackNo.length, 16);
    // The signed copies are three-segment tokens with an empty signature, so
    // anything that verifies properly refuses them.
    assert.equal(plain.signedQr?.split('.').length, 3);
    assert.equal(plain.signedQr?.endsWith('.'), true, 'no signature, by design');

    assert.equal(typeof withVehicle.ewbNo, 'string');
    assert.equal(withVehicle.ewbNo?.length, 12);
    assert.equal(withVehicle.ewbNo?.startsWith('1'), true);
    assert.equal(typeof withVehicle.ewbValidUntil, 'string');
  });
});
