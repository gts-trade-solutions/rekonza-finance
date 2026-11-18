'use client';

// Zoho's "Edit Customer" page: the same form as a new customer, filled.
// ?tab=address or ?tab=persons opens it on that tab, as the record's pencils do.

import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { ContactForm } from '@/components/contacts/contact-form';
import { AsyncPage } from '@/components/shared/async-state';
import { contacts } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

function EditCustomer() {
  const { id } = useParams<{ id: string }>();
  const tab = useSearchParams().get('tab');
  const state = useApi(() => contacts.get(id), [id]);
  return <AsyncPage state={state}>{(d) => <ContactForm side="customer" editing={d.contact} initialTab={tab} />}</AsyncPage>;
}

export default function EditCustomerPage() {
  return (
    <Suspense>
      <EditCustomer />
    </Suspense>
  );
}
