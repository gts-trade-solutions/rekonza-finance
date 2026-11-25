'use client';

// Zoho Books' Edit on a bill: the bill form, filled with the bill as saved,
// saved back over it (PUT /api/bills/[id]: the entry as it was reversed on
// its own date and posted again, the same number, its payments kept).

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { BillForm } from '@/components/forms/bill-form';
import { AsyncPage } from '@/components/shared/async-state';
import { bills as billApi, type BillDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function EditBillPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<BillDetail>(() => billApi.get(id), [id]);
  return (
    <AsyncPage state={state}>
      {(bill) => bill.status === 'void' ? (
        <p className="p-6 text-sm text-muted-foreground" data-slot="edit-void">{bill.internalNo} is void, so it cannot be edited. Clone it to enter it again.</p>
      ) : (
        <Suspense>
          <BillForm editing={bill} />
        </Suspense>
      )}
    </AsyncPage>
  );
}
