'use client';

// Zoho's Vendors list (components/contacts/contact-list.tsx): Name, Company
// Name, Email, Work Phone, Payables, Unused Credits; its views, ⋯ menu and
// bulk actions. Rekonza's own (GSTIN, ITC, TDS, MSME) wait under Customize Columns.

import { ContactList } from '@/components/contacts/contact-list';

export default function VendorsPage() {
  return <ContactList side="vendor" />;
}
