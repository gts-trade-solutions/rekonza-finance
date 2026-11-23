'use client';

// Zoho's "Add Manually" on the Banking Overview: Add Bank or Credit Card.

import { BankAccountForm } from '@/components/banking/bank-account-form';
import { usePermission } from '@/lib/store/hooks';
import { EmptyState } from '@/components/shared/empty-state';
import { Landmark } from 'lucide-react';

export default function NewBankAccountPage() {
  const canCreate = usePermission('banking', 'create');
  if (!canCreate) return <EmptyState icon={Landmark} title="Your role cannot add accounts" description="Ask an admin to add the bank or card account." />;
  return <BankAccountForm />;
}
