import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Status review 7, item 11 (GST return filing reports), in the demo book.
//
// The reviewers judge the returns from the demo's screens, and a return with
// an empty table reads as "missing". So the book is given, through the same
// services a user's clicks go through, something for every table of GSTR-1
// and every section of GSTR-3B, a GSTR-2B with matches and mismatches and the
// claim decisions on it, earlier periods filed with their ARNs (one GSTR-3B
// filed late, so table 5.1 has interest and a late fee), a document of a
// filed GSTR-1 corrected afterwards (an amendment in table 9A), the year
// before this one in full for GSTR-9, and the GST TDS (GSTR-7) and
// e-commerce TCS (GSTR-8) roles at work.
//
// The year before is a trading year that nets to nothing in the accounts as
// they stand today: what was bought was sold at cost, both settled through
// ICICI the same day, and each month's GSTR-3B was met entirely from input
// credit and recorded as such. So the opening balances of 1 April, which the
// demo book already carries, stay true, and the year still has a GSTR-1, a
// GSTR-3B, a GSTR-2B and a GSTR-9 to read.
//
// The demo's items carried 4-digit HSN codes. A business above ₹5 crore must
// report 6 digits (Notification 78/2020-CT), so the codes are given their six
// digits here, on the items and on the lines already written.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import type { IdMap } from './bootstrap';
import { DEMO_TODAY } from './demo-book';
import { createInvoice, updateInvoice, type CreateInvoiceInput } from '../services/sales';
import { createBill, postBill } from '../services/purchases';
import { approve } from '../services/approvals';
import { applyPayment, makePayment, receivePayment } from '../services/payments';
import { createCreditNote } from '../services/sales-documents';
import { recordBillOfEntry } from '../services/bill-of-entry';
import { postRule37, reclaimRule37 } from '../gst/itc-reversals';
import { recordGstTds, recordGstr7Payment } from '../gst/gstr7';
import { recordEcoSupply, recordGstr8Payment } from '../gst/gstr8';
import { recordGstr3bPayment } from '../gst/gstr3b-payment';
import { snapshotReturn } from '../gst/filed-snapshots';
import { gstinCheckChar } from '../../gst/withholding';
import { toPaiseFromSql } from '../money-sql';

const R = (rupees: number) => Math.round(rupees * 100);
const pad = (n: number) => String(n).padStart(2, '0');
const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const monthOf = (iso: string) => iso.slice(0, 7);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
const lastDay = (m: string) => `${m}-${pad(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate())}`;

/** Four digits to the six a business above ₹5 crore reports, item by item. */
const SIX_DIGITS: Record<string, string> = {
  'Air Filter – Creta 1.5': '842131', 'Cabin AC Filter – Universal': '842139', 'Oil Filter – Universal M20': '842123',
  'Alternator 90A – Verna': '851150', 'Spark Plug Iridium (4-pack)': '851110',
  'Brake Pad Set – Swift/Baleno': '870830', 'Clutch Plate Assembly – i20': '870893', 'Radiator Assembly – Innova': '870891', 'Shock Absorber Rear – WagonR': '870880',
  'Battery 35Ah – Amaron': '850710', 'Coolant Premix 1L': '382000', 'Engine Oil 5W-30 Synthetic 3.5L': '271019', 'Chassis Grease Kit 500g': '271019',
  'Headlamp Assembly LH – Nexon': '851220', 'Horn Set 12V Twin': '851230', 'Wiper Blade Pair 24"/16"': '851240',
  'Side Mirror Electric RH – Baleno': '700910', 'Timing Belt Kit – City': '401036', 'Tyre 185/65 R15 – MRF ZVTV': '401110',
};
const HSN_TEXT: Record<string, string> = {
  '842131': 'Intake air filters for internal combustion engines', '842139': 'Filtering machinery for gases, other', '842123': 'Oil or petrol filters for IC engines',
  '851150': 'Generators and alternators for IC engines', '851110': 'Sparking plugs', '870830': 'Brakes and servo-brakes, and parts', '870893': 'Clutches and parts',
  '870891': 'Radiators and parts', '870880': 'Suspension systems and shock absorbers', '850710': 'Lead-acid batteries for starting engines',
  '382000': 'Anti-freezing preparations and de-icing fluids', '271019': 'Lubricating oils and greases', '851220': 'Lighting or visual signalling equipment',
  '851230': 'Sound signalling equipment (horns)', '851240': 'Windscreen wipers', '700910': 'Rear-view mirrors for vehicles', '401036': 'Endless synchronous belts',
  '401110': 'New pneumatic tyres for motor cars',
};

/** The document line tables that carry an HSN code. Every one has its own org_id. */
const LINE_TABLES = ['invoice_lines', 'credit_note_lines', 'bill_lines', 'estimate_lines', 'sales_order_lines', 'delivery_challan_lines', 'purchase_order_lines', 'vendor_credit_lines'] as const;
/** Lines written without an item: their four-digit code to six. */
const GENERIC_SIX: Record<string, string> = { '8708': '870899', '8421': '842123', '8511': '851110', '8512': '851220', '2710': '271019', '4011': '401110', '8507': '850710', '3820': '382000', '7009': '700910', '4010': '401036' };

/**
 * The demo book reports as a business above ₹5 crore, so its HSN codes get six
 * digits (Notification 78/2020-CT): each item's own code, and on every line of
 * that item; then the free-text lines, by their four-digit code.
 *
 * Every UPDATE is held to this book's org_id. The free-text pass once ran over
 * the whole table, so seeding the demo on a database that also held a real
 * company rewrote that company's lines: an item saved with HSN 8708 showed
 * 870899 on its older bills and invoices, and GSTR-1 table 12 split it between
 * the two codes (auditor check, 2026-11-28; migration 135 gives those lines
 * their item's code back).
 */
export async function sixDigitHsnCodes(trx: Trx, org: number): Promise<void> {
  const items = await trx.selectFrom('items').select(['id', 'name', 'hsn_sac']).where('org_id', '=', org).execute();
  for (const it of items) {
    // Named items take their own six digits; any other item still on a four-digit
    // code the free-text pass knows takes that code, so an item and its lines never differ.
    const six = SIX_DIGITS[it.name] ?? GENERIC_SIX[it.hsn_sac ?? ''];
    if (!six || it.hsn_sac === six) continue;
    await trx.updateTable('items').set({ hsn_sac: six }).where('id', '=', it.id).where('org_id', '=', org).execute();
    for (const t of LINE_TABLES) {
      await sql`UPDATE ${sql.table(t)} SET hsn_sac = ${six} WHERE org_id = ${org} AND item_id = ${it.id}`.execute(trx).catch(() => undefined);
    }
  }
  // Lines written without an item keep their own code: given their six digits too.
  for (const [four, six] of Object.entries(GENERIC_SIX)) {
    for (const t of LINE_TABLES) {
      await sql`UPDATE ${sql.table(t)} SET hsn_sac = ${six} WHERE org_id = ${org} AND item_id IS NULL AND hsn_sac = ${four}`.execute(trx).catch(() => undefined);
    }
  }
  const text: Record<string, string> = { ...HSN_TEXT, '870899': 'Other parts and accessories of motor vehicles' };
  for (const [code, description] of Object.entries(text)) {
    const have = await trx.selectFrom('hsn_codes').select('id').where('org_id', '=', org).where('code', '=', code).executeTakeFirst();
    if (!have) await trx.insertInto('hsn_codes').values({ org_id: org, code, kind: 'hsn', description, gst_rate_pct: code.startsWith('87') || code.startsWith('85') || code.startsWith('40') || code.startsWith('70') ? 28 : 18, is_active: 1 } as never).execute();
  }
}

export async function seedDemoSr7d(trx: Trx, ids: IdMap): Promise<void> {
  const org = ids.orgId;
  const admin = ids.users.u_arun;
  const accountant = ids.users.u_priya ?? admin;
  const branch = ids.branches.br_chennai;
  const today = DEMO_TODAY;
  const cur = monthOf(today);
  const prev = addMonths(cur, -1);
  const todayDay = Number(today.slice(8, 10));
  /** A day of the current month, never after today. */
  const inCur = (d: number) => `${cur}-${pad(Math.min(d, todayDay))}`;
  const fyNow = Number(cur.slice(5)) >= 4 ? Number(cur.slice(0, 4)) : Number(cur.slice(0, 4)) - 1;
  const lastFy = fyNow - 1;

  const contactId = async (name: string) => (await trx.selectFrom('contacts').select('id').where('org_id', '=', org).where('display_name', '=', name).executeTakeFirstOrThrow()).id;
  const bankId = async (name: string) => (await trx.selectFrom('bank_accounts').select('id').where('org_id', '=', org).where('name', '=', name).executeTakeFirstOrThrow()).id;
  const icici = await bankId('ICICI Bank – Current');
  const purchasesAccount = (await trx.selectFrom('accounts').select('id').where('org_id', '=', org).where('code', '=', '5200').executeTakeFirstOrThrow()).id;

  // ── 1. HSN codes to six digits ──────────────────────────────────────────
  await sixDigitHsnCodes(trx, org);

  // ── 2. The withholding roles, with their own registrations ──────────────
  const tdsGstin = gstin('33CHER07532A1D');
  const ecoGstin = gstin('33AAGCR4231F1C');
  await trx.updateTable('organizations').set({ gst_tds_deductor: 1, gst_tds_gstin: tdsGstin, gst_eco_operator: 1, gst_eco_gstin: ecoGstin }).where('id', '=', org).execute();

  // ── 3. The parties and items the returns need ───────────────────────────
  const addContact = async (v: Record<string, unknown>) =>
    Number((await trx.insertInto('contacts').values({ org_id: org, ...v } as never).executeTakeFirstOrThrow()).insertId);
  const eou = await addContact({ kind: 'customer', display_name: 'Coastal Components (EOU)', gst_treatment: 'deemed_export', state_code: '33', gstin: gstin('33AAFCC5521K1Z'), billing_city: 'Chennai' });
  const mysuruBuyer = await addContact({ kind: 'customer', display_name: 'Mysuru walk-in buyer', gst_treatment: 'unregistered', state_code: '29', billing_city: 'Mysuru' });
  const compoBuyer = await addContact({ kind: 'customer', display_name: 'Hubli Auto Stores (Composition)', gst_treatment: 'registered_composition', state_code: '29', gstin: gstin('29AAKFH7781M1Z') });
  const uinBuyer = await addContact({ kind: 'customer', display_name: 'Embassy Motor Pool (UIN holder)', gst_treatment: 'uin', state_code: '07' });
  const contractor = await addContact({ kind: 'vendor', display_name: 'Sri Balaji Constructions', gst_treatment: 'registered', state_code: '33', gstin: gstin('33AAMFS4410B1Z') });
  const electrician = await addContact({ kind: 'vendor', display_name: 'Velachery Electricals', gst_treatment: 'registered', state_code: '33', gstin: gstin('33AAHFV2290C1Z') });
  const seller1 = await addContact({ kind: 'vendor', display_name: 'Anna Nagar Auto Accessories (marketplace seller)', gst_treatment: 'registered', state_code: '33', gstin: gstin('33ABCFA6123D1Z') });
  const seller2 = await addContact({ kind: 'vendor', display_name: 'Pune Car Gadgets (marketplace seller)', gst_treatment: 'registered', state_code: '27', gstin: gstin('27ABCFP7345E1Z') });
  const seller95 = await addContact({ kind: 'vendor', display_name: 'Doorstep Car Spa (via the app, unregistered)', gst_treatment: 'unregistered', state_code: '33' });
  const cloudVendor = await addContact({ kind: 'vendor', display_name: 'PartsCloud Inc (USA)', gst_treatment: 'overseas', state_code: '96' });

  const addItem = async (v: Record<string, unknown>) =>
    Number((await trx.insertInto('items').values({ org_id: org, track_inventory: 0, ...v } as never).executeTakeFirstOrThrow()).insertId);
  const pulses = await addItem({ kind: 'goods', name: 'Tur dal for the staff canteen (unbranded)', description: 'Unbranded pulses sold on to staff at cost: nil-rated', hsn_sac: '071360', uqc: 'KGS', gst_rate_pct: '0', tax_pref: 'nil', sale_price: '120' });
  const vegetables = await addItem({ kind: 'goods', name: 'Fresh vegetables (canteen surplus)', description: 'Surplus from the canteen order: exempt from GST', hsn_sac: '070999', uqc: 'KGS', gst_rate_pct: '0', tax_pref: 'exempt', sale_price: '60' });
  const petrol = await addItem({ kind: 'goods', name: 'Petrol for test drives', description: 'Fuel recharged to customers for test drives: outside GST', hsn_sac: '271012', uqc: 'LTR', gst_rate_pct: '0', tax_pref: 'non_gst', sale_price: '102' });
  const lubeDrum = await addItem({ kind: 'goods', name: 'Lubricant drum 210L (traded, not stocked)', description: 'Engine oil in 210-litre drums, bought to order and sold on', hsn_sac: '271019', uqc: 'NOS', gst_rate_pct: '18', tax_pref: 'taxable', sale_price: '42000', purchase_price: '42000' });
  const labour = (await trx.selectFrom('items').select('id').where('org_id', '=', org).where('name', '=', 'Fitment & Labour Charges').executeTakeFirstOrThrow()).id;

  const sharma = await contactId('Sharma Traders');
  const ridez = await contactId('RideZ (B2C walk-in)');
  const speedwell = await contactId('Speedwell Garages');
  const mrf = await contactId('MRF Tyres Regional Depot');
  const lumax = await contactId('Lumax Lighting Co');
  const sundaram = await contactId('Sundaram Fasteners Agency');
  const gabriel = await contactId('Gabriel Shockers Ltd');
  const kamal = await contactId('Kamal Enterprises (Composition)');
  const bpcl = await contactId('Bharat Petroleum (Fuel Card)');

  const sell = (customerId: number, date: string, lines: CreateInvoiceInput['lines'], extra: Partial<CreateInvoiceInput> = {}) =>
    createInvoice(trx, org, admin, { branchId: branch, customerId, date, dueDate: date, status: 'approved', lines, ...extra });
  // The demo's rule: bills of ₹1 lakh and above are approved by an admin before they post.
  const buy = async (vendorId: number, vendorInvoiceNo: string, date: string, lines: Parameters<typeof createBill>[3]['lines'], extra: Partial<Parameters<typeof createBill>[3]> = {}) => {
    const b = await createBill(trx, org, accountant, { branchId: branch, vendorId, vendorInvoiceNo, date, dueDate: date, lines, holdForApproval: true, ...extra });
    if (b.heldForApproval) await approve(trx, org, { userId: admin, role: 'admin' }, 'bill', b.id, postBill, 'Within the budget for the month');
    return b;
  };
  const settleInvoice = (customerId: number, date: string, inv: { id: number; totalPaise: number }) =>
    receivePayment(trx, org, accountant, { branchId: branch, contactId: customerId, date, mode: 'neft', amountPaise: inv.totalPaise, bankAccountId: icici, allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }] });
  const settleBill = (vendorId: number, date: string, b: { id: number; totalPaise: number }) =>
    makePayment(trx, org, accountant, { branchId: branch, contactId: vendorId, date, mode: 'neft', amountPaise: b.totalPaise, bankAccountId: icici, allocations: [{ targetType: 'bill', targetId: b.id, amountPaise: b.totalPaise }] });
  const file = async (key: string, period: string, doneOn: string, arn: string) => {
    const values = { done_on: doneOn, reference: arn, note: 'Filed on the GST portal (offline upload)', created_by_user_id: accountant };
    await trx.insertInto('compliance_filings').values({ org_id: org, item_key: key, period, ...values }).onDuplicateKeyUpdate(values).execute();
    await snapshotReturn(trx, org, key, period);
  };
  const twoB = (period: string, vendorGstin: string, vendorName: string, invoiceNo: string, invoiceDate: string, taxable: number, heads: { cgst?: number; sgst?: number; igst?: number }, extra: Record<string, unknown> = {}) =>
    trx.insertInto('gstr2b_entries').values({
      org_id: org, return_period: `${period.slice(5, 7)}${period.slice(0, 4)}`, recipient_gstin: '33AAGCR4231F1ZR', vendor_gstin: vendorGstin, vendor_name: vendorName,
      doc_type: 'invoice', invoice_no: invoiceNo, invoice_date: invoiceDate, taxable: String(taxable), cgst: String(heads.cgst ?? 0), sgst: String(heads.sgst ?? 0), igst: String(heads.igst ?? 0),
      itc_available: 1, is_reverse_charge: 0, source: 'seed', ...extra,
    } as never).execute();

  // ── 4. The year before, for GSTR-9 ─────────────────────────────────────
  const mrfGstin = (await trx.selectFrom('contacts').select('gstin').where('id', '=', mrf).executeTakeFirstOrThrow()).gstin!;
  for (let i = 0; i < 12; i++) {
    const m = addMonths(`${lastFy}-04`, i);
    const drums = 2 + (i % 3);
    const labourRupees = 18_000 + i * 1_500;
    const bill = await buy(mrf, `MRF/LUB/${lastFy % 100}-${(lastFy + 1) % 100}/${pad(i + 1)}`, `${m}-04`, [
      { itemId: lubeDrum, description: 'Lubricant drum 210L', hsnSac: '271019', qty: drums, ratePaise: R(42_000), gstRatePct: 18 },
      { description: 'Workshop consumables and labour supply', hsnSac: '998729', qty: 1, ratePaise: R(labourRupees), gstRatePct: 18, accountId: purchasesAccount },
    ]);
    await settleBill(mrf, `${m}-06`, bill);
    const b2b = await sell(sharma, `${m}-12`, [{ itemId: lubeDrum, description: 'Lubricant drum 210L', hsnSac: '271019', qty: drums, ratePaise: R(42_000), gstRatePct: 18 }]);
    await settleInvoice(sharma, `${m}-14`, b2b);
    const b2c = await sell(ridez, `${m}-18`, [{ itemId: labour, description: 'Fitment & Labour Charges', hsnSac: '998729', qty: 1, ratePaise: R(labourRupees), gstRatePct: 18 }]);
    await settleInvoice(ridez, `${m}-18`, b2c);
    const billTax = (drums * 42_000 + labourRupees) * 0.18;
    await twoB(m, mrfGstin, 'MRF Tyres Regional Depot', `MRF/LUB/${lastFy % 100}-${(lastFy + 1) % 100}/${pad(i + 1)}`, `${m}-04`, drums * 42_000 + labourRupees, { cgst: billTax / 2, sgst: billTax / 2 });
    const next = addMonths(m, 1);
    await file('gstr1', m, `${next}-10`, `AA33${m.slice(5, 7)}${m.slice(2, 4)}0${String(70000 + i * 13).padStart(7, '0')}`);
    // March is set off on its last day, so no GST is left open across 1 April.
    const setOffOn = i === 11 ? lastDay(m) : `${next}-19`;
    await file('gstr3b', m, setOffOn, `AB33${m.slice(5, 7)}${m.slice(2, 4)}0${String(80000 + i * 17).padStart(7, '0')}`);
    await recordGstr3bPayment(trx, org, accountant, { period: m, paidOn: setOffOn, cpin: null, bankAccountId: null, notes: 'Met entirely from input credit' }, today);
  }

  // ── 5. Last month: a filed GSTR-7 and GSTR-8, an advance, an amended invoice ─
  // Works contract for the workshop shed: credit blocked (s.17(5)(d)), GST TDS deducted at 2%.
  const shed1 = await buy(contractor, 'SBC/WC/0141', `${prev}-08`, [{ description: 'Workshop shed civil works (works contract), running bill 1', hsnSac: '995411', qty: 1, ratePaise: R(3_00_000), gstRatePct: 18, itcEligibility: 'ineligible', accountId: purchasesAccount }]);
  await recordGstTds(trx, org, accountant, { billId: shed1.id, deductionDate: `${prev}-24`, contractRef: 'SBC/2026/WC-07 (workshop shed)', contractValuePaise: R(5_80_000), notes: 'Running bill 1 of the shed contract' });
  await recordGstr7Payment(trx, org, accountant, { period: prev, paidOn: `${cur}-${pad(Math.min(8, todayDay))}`, cpin: '33062600014471', bankAccountId: icici, igstPaise: 0, cgstPaise: R(3_000), sgstPaise: R(3_000), interestPaise: 0, lateFeePaise: 0, notes: null });
  await file('gstr7', prev, `${cur}-${pad(Math.min(9, todayDay))}`, `AD33${prev.slice(5, 7)}${prev.slice(2, 4)}0007781`);

  // Supplies through this book's marketplace (s.52): TCS on the sellers.
  await recordEcoSupply(trx, org, accountant, { supplierId: seller1, entryDate: lastDay(prev), section: '52', placeOfSupply: '33', grossRegisteredPaise: R(1_20_000), returnsRegisteredPaise: R(8_000), grossUnregisteredPaise: R(2_40_000), returnsUnregisteredPaise: R(12_000), notes: 'October settlement' });
  await recordEcoSupply(trx, org, accountant, { supplierId: seller2, entryDate: lastDay(prev), section: '52', placeOfSupply: '29', grossRegisteredPaise: R(60_000), returnsRegisteredPaise: 0, grossUnregisteredPaise: R(1_50_000), returnsUnregisteredPaise: R(5_000), notes: 'October settlement' });
  const tcsPrev = await trx.selectFrom('gst_eco_supplies').select([sql<string>`SUM(igst)`.as('igst'), sql<string>`SUM(cgst)`.as('cgst'), sql<string>`SUM(sgst)`.as('sgst')])
    .where('org_id', '=', org).where('period', '=', prev).where('section', '=', '52').executeTakeFirstOrThrow();
  await recordGstr8Payment(trx, org, accountant, {
    period: prev, paidOn: `${cur}-${pad(Math.min(9, todayDay))}`, cpin: '33062600014502', bankAccountId: icici,
    igstPaise: toPaiseFromSql(tcsPrev.igst), cgstPaise: toPaiseFromSql(tcsPrev.cgst), sgstPaise: toPaiseFromSql(tcsPrev.sgst), interestPaise: 0, lateFeePaise: 0, notes: null,
  });
  await file('gstr8', prev, `${cur}-${pad(Math.min(10, todayDay))}`, `AE33${prev.slice(5, 7)}${prev.slice(2, 4)}0008814`);

  // An advance for services received last month, invoiced this month (11A then 11B).
  const advance = await receivePayment(trx, org, accountant, {
    branchId: branch, contactId: speedwell, date: `${prev}-20`, mode: 'neft', amountPaise: R(59_000), bankAccountId: icici,
    advanceGst: { ratePct: 18, placeOfSupply: '33' }, notes: 'Advance for the annual fleet maintenance contract',
  });
  // An invoice of last month, in its filed GSTR-1, corrected after filing (table 9A this month).
  const amended = await sell(sharma, `${prev}-27`, [{ description: 'Brake Pad Set – Swift/Baleno', hsnSac: '870830', qty: 4, ratePaise: R(2_400), gstRatePct: 28 }]);

  // Every GSTR-1 filed so far is kept as filed, document by document.
  const filed = await trx.selectFrom('compliance_filings').select(['item_key', 'period']).where('org_id', '=', org).where('item_key', 'in', ['gstr1']).execute();
  for (const f of filed) await snapshotReturn(trx, org, f.item_key, f.period);
  // August's GSTR-3B went in four days late: table 5.1 carries interest and the late fee.
  const aug = `${fyNow}-08`;
  await trx.updateTable('compliance_filings').set({ done_on: `${fyNow}-09-24`, note: 'Filed four days late: the portal charged the late fee and interest with it' })
    .where('org_id', '=', org).where('item_key', '=', 'gstr3b').where('period', '=', aug).execute();
  // The correction: five sets were supplied, not four.
  await updateInvoice(trx, org, admin, amended.id, {
    branchId: branch, customerId: sharma, date: `${prev}-27`, dueDate: `${prev}-27`, status: 'approved',
    lines: [{ description: 'Brake Pad Set – Swift/Baleno', hsnSac: '870830', qty: 5, ratePaise: R(2_400), gstRatePct: 28 }],
    notes: 'Corrected after GSTR-1 was filed: five sets were supplied, not four',
  });

  // ── 6. This month: every table of GSTR-1 and every section of GSTR-3B ───
  // 6C deemed export (to an EOU), 5 B2C large, 3.2 (composition, UIN, unregistered).
  await sell(eou, inCur(4), [{ description: 'Radiator Assembly – Innova (to the EOU, deemed export)', hsnSac: '870891', qty: 10, ratePaise: R(6_800), gstRatePct: 28 }]);
  await sell(mysuruBuyer, inCur(6), [{ description: 'Alternator 90A – Verna', hsnSac: '851150', qty: 12, ratePaise: R(9_500), gstRatePct: 28 }]);
  await sell(compoBuyer, inCur(7), [{ description: 'Oil Filter – Universal M20', hsnSac: '842123', qty: 40, ratePaise: R(320), gstRatePct: 18 }]);
  await sell(uinBuyer, inCur(9), [{ description: 'Battery 35Ah – Amaron', hsnSac: '850710', qty: 6, ratePaise: R(4_650), gstRatePct: 28 }]);
  // 8 / 3.1(c) / 3.1(e): nil-rated, exempt and non-GST, on one invoice.
  await sell(ridez, inCur(10), [
    { itemId: pulses, description: 'Tur dal (unbranded)', hsnSac: '071360', qty: 50, ratePaise: R(120), gstRatePct: 0 },
    { itemId: vegetables, description: 'Fresh vegetables', hsnSac: '070999', qty: 40, ratePaise: R(60), gstRatePct: 0 },
    { itemId: petrol, description: 'Petrol', hsnSac: '271012', qty: 30, ratePaise: R(102), gstRatePct: 0 },
  ]);
  // 14(a) through an operator that collects TCS; 14(b) / 3.1.1(ii) through one that pays the tax under s.9(5).
  const marketplace = gstin('29AAICM9032Q1C');
  await sell(ridez, inCur(11), [{ description: 'Wiper Blade Pair 24"/16" (sold on the marketplace)', hsnSac: '851240', qty: 30, ratePaise: R(650), gstRatePct: 28 }], { eco: { gstin: marketplace, section: '52' } });
  await sell(ridez, inCur(12), [{ itemId: labour, description: 'Doorstep car wash, booked through UrbanServe (section 9(5))', hsnSac: '998533', qty: 20, ratePaise: R(450), gstRatePct: 18 }], { eco: { gstin: gstin('29AAFCU5512R1C'), section: '9_5' } });
  // 4B: a supply on which the registered buyer pays the tax (reverse charge).
  await sell(speedwell, inCur(13), [{ itemId: labour, description: 'Goods transport for the customer (GTA, tax on the recipient)', hsnSac: '996511', qty: 1, ratePaise: R(18_000), gstRatePct: 5 }], { reverseCharge: true });
  // 11B: last month's advance set against this month's invoice.
  const serviceInv = await sell(speedwell, inCur(14), [{ itemId: labour, description: 'Fleet maintenance, first quarter', hsnSac: '998729', qty: 1, ratePaise: R(50_000), gstRatePct: 18 }]);
  await applyPayment(trx, org, accountant, advance.id, { date: inCur(14), allocations: [{ targetType: 'invoice', targetId: serviceInv.id, amountPaise: R(59_000) }] });
  // 11A: an advance received this month, not yet invoiced.
  await receivePayment(trx, org, accountant, {
    branchId: branch, contactId: sharma, date: inCur(15), mode: 'neft', amountPaise: R(35_400), bankAccountId: icici,
    advanceGst: { ratePct: 18, placeOfSupply: '33' }, notes: 'Advance for the workshop training programme',
  });
  // 9B CDNUR: a credit note against this month's export.
  const exportInv = await trx.selectFrom('invoices').select(['id', 'customer_id']).where('org_id', '=', org).where('supply_type', 'in', ['export_lut', 'export_with_tax'])
    .where('invoice_date', '>=', `${cur}-01`).orderBy('invoice_date').executeTakeFirst();
  if (exportInv) {
    const line = await trx.selectFrom('invoice_lines').select(['description', 'hsn_sac', 'rate', 'gst_rate_pct']).where('invoice_id', '=', exportInv.id).orderBy('line_no').executeTakeFirstOrThrow();
    await createCreditNote(trx, org, admin, {
      branchId: branch, customerId: exportInv.customer_id, date: inCur(16), reason: 'Two pieces damaged in transit, credited to the buyer abroad', againstInvoiceId: exportInv.id,
      lines: [{ description: line.description ?? 'Returned', hsnSac: line.hsn_sac ?? undefined, qty: 2, ratePaise: toPaiseFromSql(line.rate), gstRatePct: Number(line.gst_rate_pct) }],
    } as never);
  }

  // Purchases: 4A1 import of goods, 4A2 import of services, 4B1 blocked, 5 composition and non-GST.
  await recordBillOfEntry(trx, org, accountant, {
    branchId: branch, boeNo: '6633841', boeDate: inCur(5), portCode: 'INMAA1', assessablePaise: R(80_000), customsDutyPaise: R(8_000), igstPaise: R(15_840),
    itcEligibility: 'eligible', dutyAccountId: purchasesAccount, paidThroughBankAccountId: icici, notes: 'Imported ECU test harness',
  });
  await buy(cloudVendor, 'PC-INV-22871', inCur(5), [{ description: 'Parts catalogue software subscription (import of services)', hsnSac: '997331', qty: 1, ratePaise: R(25_000), gstRatePct: 18, accountId: purchasesAccount }], { isRcm: true });
  await buy(mrf, `MRF/CAN/${cur.slice(2, 4)}${cur.slice(5)}`, inCur(8), [
    { description: 'Tyre 185/65 R15 – MRF ZVTV', hsnSac: '401110', qty: 4, ratePaise: R(4_600), gstRatePct: 28 },
    { description: 'Diwali sweets and lunch for staff (blocked, s.17(5)(b))', hsnSac: '996331', qty: 1, ratePaise: R(12_000), gstRatePct: 18, itcEligibility: 'ineligible', accountId: purchasesAccount },
  ]);
  await buy(kamal, `KE/${cur.slice(5)}/118`, inCur(9), [{ description: 'Packing material from a composition dealer', hsnSac: '481910', qty: 1, ratePaise: R(14_500), gstRatePct: 0, accountId: purchasesAccount }]);
  await buy(bpcl, `BPCL/FC/${cur.slice(5)}`, inCur(10), [{ itemId: petrol, description: 'Petrol on the fuel card (non-GST)', hsnSac: '271012', qty: 120, ratePaise: R(102), gstRatePct: 0, accountId: purchasesAccount }]);

  // 4B(2): suppliers unpaid for more than 180 days (Rule 37), from April and May;
  // 4D(1): the April one paid since, its credit taken again.
  const oldBill = await buy(gabriel, 'GSL/26-27/0218', `${fyNow}-04-20`, [{ description: 'Shock Absorber Rear – WagonR', hsnSac: '870880', qty: 8, ratePaise: R(2_150), gstRatePct: 28 }]);
  await buy(gabriel, 'GSL/26-27/0361', `${fyNow}-05-18`, [{ description: 'Shock Absorber Rear – WagonR', hsnSac: '870880', qty: 4, ratePaise: R(2_150), gstRatePct: 28 }]);
  await postRule37(trx, org, accountant, cur);
  await settleBill(gabriel, inCur(26), oldBill);
  await reclaimRule37(trx, org, accountant, cur);

  // GSTR-7 this month: the shed's second running bill (deducted), an electrical contract (not yet).
  const shed2 = await buy(contractor, 'SBC/WC/0157', inCur(6), [{ description: 'Workshop shed civil works (works contract), running bill 2', hsnSac: '995411', qty: 1, ratePaise: R(2_80_000), gstRatePct: 18, itcEligibility: 'ineligible', accountId: purchasesAccount }]);
  await recordGstTds(trx, org, accountant, { billId: shed2.id, deductionDate: inCur(18), contractRef: 'SBC/2026/WC-07 (workshop shed)', contractValuePaise: R(5_80_000), notes: 'Running bill 2' });
  await buy(electrician, 'VE/2026/331', inCur(20), [{ description: 'Workshop electrical installation (works contract)', hsnSac: '995461', qty: 1, ratePaise: R(2_65_000), gstRatePct: 18, itcEligibility: 'ineligible', accountId: purchasesAccount }]);

  // GSTR-8 this month, and a s.9(5) supply the operator pays tax on (3.1.1(i), GSTR-1 table 15).
  await recordEcoSupply(trx, org, accountant, { supplierId: seller1, entryDate: inCur(25), section: '52', placeOfSupply: '33', grossRegisteredPaise: R(1_45_000), returnsRegisteredPaise: 0, grossUnregisteredPaise: R(2_10_000), returnsUnregisteredPaise: R(9_500), notes: 'November settlement' });
  await recordEcoSupply(trx, org, accountant, { supplierId: seller2, entryDate: inCur(25), section: '52', placeOfSupply: '33', grossRegisteredPaise: R(40_000), returnsRegisteredPaise: R(2_000), grossUnregisteredPaise: R(95_000), returnsUnregisteredPaise: 0, notes: 'November settlement' });
  await recordEcoSupply(trx, org, accountant, { supplierId: seller95, entryDate: inCur(25), section: '9_5', placeOfSupply: '33', grossRegisteredPaise: 0, returnsRegisteredPaise: 0, grossUnregisteredPaise: R(48_000), returnsUnregisteredPaise: 0, gstRatePct: 18, notes: 'Doorstep car-spa bookings: housekeeping-type service, tax paid by the operator' });

  // ── 7. GSTR-2B for this month: matches, a mismatch, missing either side, and the decisions ─
  const lumaxBill = await buy(lumax, 'LLC/DL/26-27/4410', inCur(12), [{ description: 'Headlamp Assembly LH – Nexon', hsnSac: '851220', qty: 6, ratePaise: R(5_200), gstRatePct: 28 }]);
  const sundaramBill = await buy(sundaram, 'SFA/26-27/9031', inCur(19), [{ description: 'Fasteners and clips assortment', hsnSac: '731815', qty: 1, ratePaise: R(18_500), gstRatePct: 18, accountId: purchasesAccount }]);
  const mrfBill = await trx.selectFrom('bills').select(['vendor_invoice_no', 'bill_date', 'subtotal', 'cgst', 'sgst']).where('org_id', '=', org).where('vendor_id', '=', mrf)
    .where('bill_date', '>=', `${cur}-01`).orderBy('id', 'desc').executeTakeFirstOrThrow();
  // The supplier's figure differs from the bill by ₹180: a mismatch to resolve.
  await twoB(cur, mrfGstin, 'MRF Tyres Regional Depot', mrfBill.vendor_invoice_no, String(mrfBill.bill_date).slice(0, 10), Number(mrfBill.subtotal),
    { cgst: Number(mrfBill.cgst) + 90, sgst: Number(mrfBill.sgst) + 90 });
  // Filed by a supplier, not in the books.
  const bosch = await trx.selectFrom('contacts').select('gstin').where('org_id', '=', org).where('display_name', '=', 'Bosch Automotive Distributors').executeTakeFirstOrThrow();
  await twoB(cur, bosch.gstin!, 'Bosch Automotive Distributors', 'BAD/26-27/7781', inCur(3), 20_000, { igst: 3_600 });
  // Not in 2B: Lumax has not filed its invoice yet — held back; Sundaram's is in next month's 2B — claimed then.
  await trx.insertInto('gst_itc_claims').values([
    { org_id: org, bill_id: lumaxBill.id, decision: 'defer', claim_period: null, note: 'Not in GSTR-2B: Lumax has not filed it yet. Chased on email.', decided_by_user_id: accountant },
    { org_id: org, bill_id: sundaramBill.id, decision: 'claim_later', claim_period: addMonths(cur, 1), note: 'Filed by Sundaram after the 2B cut-off; in next month\'s 2B', decided_by_user_id: accountant },
  ]).execute();
}
