'use client';

// The customer list, as Zoho Books has it (components/contacts/contact-list.tsx).
// Each customer's balance is added up in SQL, not here: a book with ten
// thousand invoices should not ship all of them to the browser.

import { ContactList } from '@/components/contacts/contact-list';

export default function CustomersPage() {
  return <ContactList side="customer" />;
}
