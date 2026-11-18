'use client';

// A customer, as Zoho Books opens it beside the list (components/contacts/contact-record.tsx).

import { useParams } from 'next/navigation';
import { ContactRecord } from '@/components/contacts/contact-record';

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  return <ContactRecord id={id} side="customer" />;
}
