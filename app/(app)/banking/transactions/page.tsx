'use client';

// A bank or card account's page, at Zoho's own address
// (/banking/transactions?account_id=…&filter_by=Status.Uncategorized).

import { Suspense } from 'react';
import { BankAccountPage } from '@/components/banking/account-page';
import { LoadingRows } from '@/components/shared/async-state';

export default function BankTransactionsPage() {
  return (
    <Suspense fallback={<LoadingRows rows={8} />}>
      <BankAccountPage />
    </Suspense>
  );
}
