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

const BASE_CUSTOMERS: Contact[] = [
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
  // Buys workshop advice, not parts: an export of services.
  cust('c_gulf', 'Gulf Fleet Services LLC', '96', {
    gstTreatment: 'overseas',
    billingAddress: addr('Sheikh Zayed Road', 'Dubai', '96', '—'),
    paymentTermsDays: 30,
    email: 'accounts@gulffleet.ae',
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

/**
 * Who the shop deals with at each customer, as Zoho's customer page shows
 * them: the primary contact, a mobile, the website, the remarks kept for the
 * team, and the other people there.
 */
const CUSTOMER_PEOPLE: Record<string, Partial<Contact>> = {
  c_sharma: {
    salutation: 'Mr.', firstName: 'Rajesh', lastName: 'Sharma', mobile: '+91 94440 12345', website: 'www.sharmatraders.in',
    remarks: 'Pays by NEFT on the 10th. Wants invoices by email, not by courier.',
    persons: [{ salutation: 'Ms.', firstName: 'Kavita', lastName: 'Iyer', email: 'kavita@sharma.in', phone: '044 2852 1100', designation: 'Accounts' }],
  },
  c_apex: {
    salutation: 'Mr.', firstName: 'Karthik', lastName: 'Rao', mobile: '+91 98450 22113', website: 'www.apexmotors.in',
    remarks: 'Deducts TDS on our invoices: chase the Form 16A every quarter.',
    shippingAddress: { label: 'Shipping', line1: 'Plot 22, Bommasandra Industrial Area', city: 'Bengaluru', stateCode: '29', pincode: '560099' },
    persons: [
      { salutation: 'Ms.', firstName: 'Divya', lastName: 'Menon', email: 'divya@apex.in', mobile: '+91 98860 44120', designation: 'Purchase Manager' },
      { salutation: 'Mr.', firstName: 'Suresh', lastName: 'Babu', email: 'suresh@apex.in', phone: '080 4110 2200', designation: 'Accounts' },
    ],
  },
  c_velocity: {
    salutation: 'Mr.', firstName: 'Amit', lastName: 'Kulkarni', mobile: '+91 98220 33114',
    remarks: 'A workshop chain: orders every Monday for the week.',
    shippingAddress: { label: 'Shipping', line1: 'Unit 4, Bhosari MIDC', city: 'Pune', stateCode: '27', pincode: '411026' },
    persons: [{ salutation: 'Mr.', firstName: 'Rohan', lastName: 'Joshi', email: 'rohan@velocity.in', mobile: '+91 98230 11220', designation: 'Stores In-charge' }],
  },
  c_speedwell: {
    salutation: 'Mr.', firstName: 'Senthil', lastName: 'Kumar', mobile: '+91 94442 55116',
    remarks: 'Collect cheques on Fridays.',
    persons: [{ salutation: 'Ms.', firstName: 'Priya', lastName: 'Natarajan', email: 'priya@speedwell.in', designation: 'Accounts' }],
  },
  c_national: {
    salutation: 'Mr.', firstName: 'Vikas', lastName: 'Gupta', mobile: '+91 98110 66117', website: 'www.nationalspares.co.in',
    remarks: 'Goods go by road freight; send the LR copy with each invoice.',
    persons: [{ salutation: 'Mr.', firstName: 'Anil', lastName: 'Bansal', email: 'anil@national.in', mobile: '+91 98111 22330', designation: 'Purchase' }],
  },
  c_marina: {
    salutation: 'Ms.', firstName: 'Lakshmi', lastName: 'Narayanan', mobile: '+91 98400 77118',
    remarks: '15-day terms agreed in June 2026.',
    persons: [{ salutation: 'Mr.', firstName: 'Arjun', lastName: 'Pillai', email: 'arjun@marina.in', designation: 'Service Manager' }],
  },
  c_hosur: {
    salutation: 'Mr.', firstName: 'Murugan', lastName: 'Selvam', mobile: '+91 94431 88119',
    persons: [{ salutation: 'Ms.', firstName: 'Deepa', lastName: 'Raman', email: 'deepa@hosur.in', designation: 'Accounts' }],
  },
  c_deccan: {
    salutation: 'Mr.', firstName: 'Srinivas', lastName: 'Reddy', mobile: '+91 98490 99120',
    persons: [{ salutation: 'Mr.', firstName: 'Imran', lastName: 'Khan', email: 'imran@deccan.in', mobile: '+91 98491 00330', designation: 'Purchase' }],
  },
  c_kochi: {
    salutation: 'Mr.', firstName: 'Thomas', lastName: 'Varghese', mobile: '+91 98470 10121',
    persons: [{ salutation: 'Ms.', firstName: 'Anju', lastName: 'Mathew', email: 'anju@kochi.in', designation: 'Accounts' }],
  },
  c_ridez: { remarks: 'Counter sales to walk-in buyers, billed as B2C.' },
  c_sez: {
    salutation: 'Mr.', firstName: 'Ganesh', lastName: 'Iyer', mobile: '+91 98410 21122',
    remarks: 'An SEZ unit: supplies go zero-rated under our LUT. Quote their SEZ authorisation on each invoice.',
    persons: [{ salutation: 'Ms.', firstName: 'Revathi', lastName: 'Subramanian', email: 'revathi@sez.in', designation: 'Logistics' }],
  },
  c_lanka: {
    salutation: 'Mr.', firstName: 'Nuwan', lastName: 'Perera', mobile: '+94 77 123 4567', countryName: 'Sri Lanka',
    remarks: 'Ships through Chennai port. Invoiced in US dollars.',
    persons: [{ salutation: 'Ms.', firstName: 'Dilani', lastName: 'Fernando', email: 'dilani@lanka.in', designation: 'Imports' }],
  },
  c_gulf: {
    salutation: 'Mr.', firstName: 'Omar', lastName: 'Al Farsi', mobile: '+971 50 123 4567', countryName: 'United Arab Emirates', website: 'www.gulffleet.ae',
    remarks: 'Buys workshop training and advice; pays by SWIFT transfer.',
  },
  c_orbit: {
    salutation: 'Mr.', firstName: 'Naveen', lastName: 'Hegde', mobile: '+91 98450 31123',
    remarks: 'Deducts TDS on our invoices.',
    persons: [{ salutation: 'Ms.', firstName: 'Shruti', lastName: 'Bhat', email: 'shruti@orbit.in', mobile: '+91 98451 40220', designation: 'Fleet Manager' }],
  },
  c_bluehill: {
    salutation: 'Mr.', firstName: 'Joseph', lastName: "D'Souza", mobile: '+91 94430 41124',
    remarks: 'A fleet of twelve vehicles, serviced every month.',
  },
  c_trichy: { salutation: 'Mr.', firstName: 'Balaji', lastName: 'Krishnan', mobile: '+91 94433 51125' },
};

export const SEED_CUSTOMERS: Contact[] = BASE_CUSTOMERS.map((c) => ({ ...c, ...CUSTOMER_PEOPLE[c.id] }));

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
