'use client';

// Zoho's Edit on a bank or card account (the account page's ⚙ menu).

import { useParams } from 'next/navigation';
import { BankAccountForm, type BankAccountRecord } from '@/components/banking/bank-account-form';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function EditBankAccountPage() {
  const { accountId } = useParams<{ accountId: string }>();
  const state = useApi<{ account: BankAccountRecord }>(() => api.get(`/api/banking/accounts/${accountId}`), [accountId]);
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
      {(d) => <BankAccountForm editing={d.account} />}
    </AsyncPage>
  );
}
