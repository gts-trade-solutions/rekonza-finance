'use client';

// Zoho's "New Vendor" page (components/contacts/contact-form.tsx). ?clone=<id>
// starts it from an existing contact, as a customer's "More → Clone → Vendor"
// does: everything but the GSTIN, which is one registration's alone.

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ContactForm } from '@/components/contacts/contact-form';
import { AsyncPage } from '@/components/shared/async-state';
import { contacts } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

function CloneOf({ id }: { id: string }) {
  const state = useApi(() => contacts.get(id), [id]);
  return <AsyncPage state={state}>{(d) => <ContactForm side="vendor" clone={d.contact} />}</AsyncPage>;
}

function NewVendor() {
  const clone = useSearchParams().get('clone');
  return clone ? <CloneOf id={clone} /> : <ContactForm side="vendor" />;
}

export default function NewVendorPage() {
  return (
    <Suspense>
      <NewVendor />
    </Suspense>
  );
}
