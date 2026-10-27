// Seeded customers & vendors — realistic Indian auto-trade names, mixed
// states (to demo CGST/SGST vs IGST), MSME vendors, a composition vendor,
// an SEZ customer and an overseas customer (to demo zero-rated exports).

import type { Contact } from '../../types';

const addr = (line1: string, city: string, stateCode: string, pincode: string) => ({
  label: 'Billing',
  line1,
  city,
  stateCode,
  pincode,
});

const cust = (
  id: string,
  displayName: string,
  stateCode: string,
  o: Partial<Contact> = {},
): Contact => ({
  id,
  kind: 'customer',
  displayName,
  companyName: displayName,
  gstin: o.gstin ?? null,
  gstTreatment: o.gstTreatment ?? 'registered',
  pan: o.pan ?? null,
  stateCode,
  email: o.email ?? `accounts@${id.replace('c_', '')}.in`,
  phone: o.phone ?? '+91 98000 00000',
  billingAddress: o.billingAddress ?? addr('—', '—', stateCode, '600001'),
  paymentTermsDays: o.paymentTermsDays ?? 30,
  creditLimit: o.creditLimit ?? null,
  isMsme: false,
  customerDeductsTds: o.customerDeductsTds ?? false,
  openingBalance: o.openingBalance ?? 0,
  portalEnabled: o.portalEnabled ?? true,
  isArchived: false,
  ...o,
});

const vend = (
  id: string,
  displayName: string,
  stateCode: string,
  o: Partial<Contact> = {},
): Contact => ({
  id,
  kind: 'vendor',
  displayName,
  companyName: displayName,
  gstin: o.gstin ?? null,
  gstTreatment: o.gstTreatment ?? 'registered',
  pan: o.pan ?? 'AAACX0000X',
  stateCode,
  email: o.email ?? `sales@${id.replace('v_', '')}.in`,
  phone: o.phone ?? '+91 99000 00000',
  billingAddress: o.billingAddress ?? addr('—', '—', stateCode, '600001'),
  paymentTermsDays: o.paymentTermsDays ?? 30,
  creditLimit: null,
  isMsme: o.isMsme ?? false,
  openingBalance: o.openingBalance ?? 0,
  isArchived: false,
  ...o,
});

export const SEED_CUSTOMERS: Contact[] = [
  cust('c_sharma', 'Sharma Traders', '33', {
    gstin: '33ABCDE1234F1Z7',
    billingAddress: addr('12 Mount Road', 'Chennai', '33', '600002'),
    creditLimit: 5_00_000_00,
  }),
  cust('c_apex', 'Apex Motors Pvt Ltd', '29', {
    gstin: '29AABCA1111A1ZN',
    billingAddress: addr('4 MG Road', 'Bengaluru', '29', '560001'),
    creditLimit: 10_00_000_00,
    customerDeductsTds: true,
  }),
  cust('c_velocity', 'Velocity Auto Works', '27', {
    gstin: '27AABCV2222B1ZY',
    billingAddress: addr('88 FC Road', 'Pune', '27', '411004'),
  }),
  cust('c_speedwell', 'Speedwell Garages', '33', {
    gstin: '33AABCS3333C1Z0',
    billingAddress: addr('5 GST Road', 'Chengalpattu', '33', '603001'),
  }),
  cust('c_national', 'National Spares Co', '07', {
    gstin: '07AABCN4444D1ZS',
    billingAddress: addr('21 Kashmere Gate', 'Delhi', '07', '110006'),
  }),
  cust('c_marina', 'Marina Car Care', '33', {
    gstin: '33AABCM5555E1ZQ',
    billingAddress: addr('9 ECR', 'Chennai', '33', '600041'),
    paymentTermsDays: 15,
  }),
  cust('c_hosur', 'Hosur Auto Agencies', '33', {
    gstin: '33AABCH6666F1ZN',
    billingAddress: addr('3 Bagalur Rd', 'Hosur', '33', '635109'),
  }),
  cust('c_deccan', 'Deccan Wheels', '36', {
    gstin: '36AABCD7777G1ZD',
    billingAddress: addr('14 Begum Bazaar', 'Hyderabad', '36', '500012'),
  }),
  cust('c_kochi', 'Kochi Motor Mart', '32', {
    gstin: '32AABCK8888H1Z6',
    billingAddress: addr('7 Marine Drive', 'Kochi', '32', '682031'),
  }),
  cust('c_ridez', 'RideZ (B2C walk-in)', '33', {
    gstTreatment: 'unregistered',
    billingAddress: addr('Counter Sale', 'Chennai', '33', '600032'),
    paymentTermsDays: 0,
    portalEnabled: false,
  }),
  cust('c_sez', 'Falcon Exports (SEZ Unit)', '33', {
    gstin: '33AABCF9999J1ZY',
    gstTreatment: 'sez',
    billingAddress: addr('MEPZ SEZ, Tambaram', 'Chennai', '33', '600045'),
  }),
  cust('c_lanka', 'Colombo Auto Imports', '96', {
    gstTreatment: 'overseas',
    billingAddress: addr('Union Place', 'Colombo', '96', '—'),
    paymentTermsDays: 45,
  }),
  cust('c_orbit', 'Orbit Fleet Services', '29', {
    gstin: '29AABCO1212K1ZM',
    billingAddress: addr('2 Whitefield Main Rd', 'Bengaluru', '29', '560066'),
    customerDeductsTds: true,
  }),
  cust('c_bluehill', 'Blue Hill Resorts (Fleet)', '33', {
    gstin: '33AABCB3434L1ZW',
    billingAddress: addr('Ooty Main Rd', 'Ooty', '33', '643001'),
  }),
  cust('c_trichy', 'Trichy Spare Point', '33', {
    gstin: '33AABCT5656M1Z0',
    billingAddress: addr('11 Big Bazaar St', 'Trichy', '33', '620008'),
  }),
];

export const SEED_VENDORS: Contact[] = [
  vend('v_bosch', 'Bosch Automotive Distributors', '29', {
    gstin: '29AAACB2222N1ZQ',
    pan: 'AAACB2222N',
    billingAddress: addr('Hosur Road', 'Bengaluru', '29', '560030'),
  }),
  vend('v_lumax', 'Lumax Lighting Co', '07', {
    gstin: '07AAACL3333P1ZC',
    pan: 'AAACL3333P',
    billingAddress: addr('Okhla Phase II', 'Delhi', '07', '110020'),
  }),
  vend('v_mrf', 'MRF Tyres Regional Depot', '33', {
    gstin: '33AAACM4444Q1Z8',
    pan: 'AAACM4444Q',
    billingAddress: addr('Tiruvottiyur', 'Chennai', '33', '600019'),
  }),
  vend('v_gabriel', 'Gabriel Shockers Ltd', '27', {
    gstin: '27AAACG5555R1ZZ',
    pan: 'AAACG5555R',
    billingAddress: addr('Chakan MIDC', 'Pune', '27', '410501'),
  }),
  vend('v_sundaram', 'Sundaram Fasteners Agency', '33', {
    gstin: '33AAACS6666S1ZM',
    pan: 'AAACS6666S',
    isMsme: true,
    udyamNo: 'UDYAM-TN-02-0012345',
    billingAddress: addr('Padi', 'Chennai', '33', '600050'),
  }),
  vend('v_swift', 'Swift Logistics (Transporter)', '33', {
    gstin: '33AAACS7777T1ZE',
    pan: 'AAACS7777T',
    tdsSection: '194C',
    billingAddress: addr('Madhavaram', 'Chennai', '33', '600060'),
  }),
  vend('v_menon', 'Menon & Associates (CA firm)', '33', {
    gstin: '33AAACM8888U1ZC',
    pan: 'AAACM8888U',
    tdsSection: '194J',
    isMsme: true,
    udyamNo: 'UDYAM-TN-02-0067890',
    billingAddress: addr('T Nagar', 'Chennai', '33', '600017'),
  }),
  vend('v_kamal', 'Kamal Enterprises (Composition)', '33', {
    gstin: '33AAACK9999V1Z6',
    pan: 'AAACK9999V',
    gstTreatment: 'registered_composition',
    billingAddress: addr('Ambattur', 'Chennai', '33', '600053'),
  }),
  vend('v_cityprop', 'City Properties (Landlord)', '33', {
    gstin: null,
    pan: 'AAACC1010W',
    gstTreatment: 'unregistered',
    tdsSection: '194I',
    billingAddress: addr('Nungambakkam', 'Chennai', '33', '600034'),
  }),
  vend('v_bharat', 'Bharat Petroleum (Fuel Card)', '33', {
    gstin: '33AAACB1212X1ZL',
    pan: 'AAACB1212X',
    billingAddress: addr('Guindy', 'Chennai', '33', '600032'),
  }),
];
