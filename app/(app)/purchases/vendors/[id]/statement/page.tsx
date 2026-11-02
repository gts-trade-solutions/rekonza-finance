'use client';

// A vendor's account to print or save as PDF, to check against the statement they send.

import { useParams, useSearchParams } from 'next/navigation';
import { AsyncPage } from '@/components/shared/async-state';
import { StatementPrint } from '@/components/print/statement-print';
import { statementPeriod } from '@/components/shared/party-statement';
import { contacts, type PartyStatement } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function VendorStatementPrintPage() {
  const { id } = useParams<{ id: string }>();
  const { from, to } = statementPeriod(useSearchParams());
  const state = useApi<PartyStatement>(() => contacts.statement(id, { side: 'vendor', from, to }), [id, from, to]);
  return <AsyncPage state={state}>{(s) => <StatementPrint s={s} backHref={`/purchases/vendors/${id}`} />}</AsyncPage>;
}
