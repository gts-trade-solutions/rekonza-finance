'use client';

// A vendor, as Zoho Books opens it beside the list (components/contacts/contact-record.tsx).

import { useParams } from 'next/navigation';
import { ContactRecord } from '@/components/contacts/contact-record';

export default function VendorPage() {
  const { id } = useParams<{ id: string }>();
  return <ContactRecord id={id} side="vendor" />;
}
