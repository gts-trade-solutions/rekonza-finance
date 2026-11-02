'use client';

// A customer's statement of account to print or save as PDF.

import { useParams, useSearchParams } from 'next/navigation';
import { AsyncPage } from '@/components/shared/async-state';
import { StatementPrint } from '@/components/print/statement-print';
import { statementPeriod } from '@/components/shared/party-statement';
import { contacts, type PartyStatement } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function CustomerStatementPrintPage() {
  const { id } = useParams<{ id: string }>();
  const { from, to } = statementPeriod(useSearchParams());
  const state = useApi<PartyStatement>(() => contacts.statement(id, { side: 'customer', from, to }), [id, from, to]);
  return <AsyncPage state={state}>{(s) => <StatementPrint s={s} backHref={`/sales/customers/${id}`} />}</AsyncPage>;
}
