import type { Branch, Org, User } from '../../types';

export const SEED_ORG: Org = {
  id: 'org_race',
  name: 'Race Auto Spares Pvt Ltd',
  pan: 'AAGCR4231F',
  gstRegistrationType: 'regular',
  aatoAbove5Cr: true, // e-invoicing mandate applies — demos the IRP flow
  fiscalYearLabel: 'FY 2026-27',
  fiscalYearStart: '2026-04-01',
  fiscalYearEnd: '2027-03-31',
  baseCurrency: 'INR',
  address: '42, Anna Salai, Guindy, Chennai 600032',
  email: 'accounts@raceautospares.in',
  phone: '+91 98400 12345',
};

export const FY_SHORT = '26-27';

export const SEED_BRANCHES: Branch[] = [
  {
    id: 'br_chennai',
    name: 'Chennai HO',
    gstin: '33AAGCR4231F1ZR',
    stateCode: '33',
    address: '42, Anna Salai, Guindy',
    city: 'Chennai',
    pincode: '600032',
    isPrimary: true,
  },
  {
    id: 'br_bengaluru',
    name: 'Bengaluru Depot',
    gstin: '29AAGCR4231F1ZG',
    stateCode: '29',
    address: '18, Hosur Road, Bommanahalli',
    city: 'Bengaluru',
    pincode: '560068',
    isPrimary: false,
  },
];

export const SEED_USERS: User[] = [
  // Arun and Priya work across both registrations; Vikram sells out of the
  // Bengaluru depot only, which is the common case — a user has one branch.
  {
    id: 'u_arun', name: 'Arun Kumar', email: 'arun@raceautospares.in',
    role: 'admin', avatarColor: '#4f7ce8',
    branchId: 'br_chennai', branchAccess: ['br_chennai', 'br_bengaluru'],
  },
  {
    id: 'u_priya', name: 'Priya Raman', email: 'priya@raceautospares.in',
    role: 'accountant', avatarColor: '#2fa4a0',
    branchId: 'br_chennai', branchAccess: ['br_chennai', 'br_bengaluru'],
  },
  {
    id: 'u_vikram', name: 'Vikram Shetty', email: 'vikram@raceautospares.in',
    role: 'sales', avatarColor: '#e0883a',
    branchId: 'br_bengaluru',
  },
  {
    id: 'u_deepa', name: 'Deepa Nair', email: 'deepa@raceautospares.in',
    role: 'viewer', avatarColor: '#3f9f5f',
    branchId: 'br_chennai',
  },
];
