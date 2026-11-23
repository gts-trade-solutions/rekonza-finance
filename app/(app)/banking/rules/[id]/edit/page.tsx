'use client';

// Edit a transaction rule, as saved.

import { useParams } from 'next/navigation';
import { RuleForm, type RuleRecord } from '@/components/banking/rule-form';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export default function EditRulePage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<{ rule: RuleRecord }>(() => api.get(`/api/banking/rules/${id}`), [id]);
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
      {(d) => <RuleForm editing={d.rule} />}
    </AsyncPage>
  );
}
