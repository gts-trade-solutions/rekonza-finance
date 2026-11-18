// Zoho's custom views: the criteria a list's rows must meet (lib/custom-views.ts).
//
//   npx tsx --test scripts/tests/custom-views.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyView, takesValue, type ViewField } from '../../lib/custom-views';

interface Row { name: string; kind: string; rate: number; sku: string | null; created: string }
const rows: Row[] = [
  { name: 'Brake Pad Set', kind: 'Goods', rate: 1450, sku: 'BP-101', created: '2026-04-02' },
  { name: 'Air Filter', kind: 'Goods', rate: 520, sku: null, created: '2026-05-10' },
  { name: 'Fitment & Labour', kind: 'Service', rate: 500, sku: 'SRV-FIT', created: '2026-06-01' },
];
const fields: ViewField<Row>[] = [
  { key: 'name', label: 'Name', type: 'text', value: (r) => r.name },
  { key: 'kind', label: 'Type', type: 'choice', options: ['Goods', 'Service'], value: (r) => r.kind },
  { key: 'rate', label: 'Rate', type: 'number', value: (r) => r.rate },
  { key: 'sku', label: 'SKU', type: 'text', value: (r) => r.sku },
  { key: 'created', label: 'Created', type: 'date', value: (r) => r.created },
];
const names = (rs: Row[]) => rs.map((r) => r.name);

test('every criterion met (AND), or any one (OR)', () => {
  const crit = [{ field: 'kind', op: 'is' as const, value: 'Goods' }, { field: 'rate', op: 'gt' as const, value: '1000' }];
  assert.deepEqual(names(applyView(rows, { match: 'all', criteria: crit }, fields)), ['Brake Pad Set']);
  assert.deepEqual(names(applyView(rows, { match: 'any', criteria: crit }, fields)), ['Brake Pad Set', 'Air Filter']);
});

test('text, number and date comparators; empty values; case does not matter', () => {
  const one = (field: string, op: Parameters<typeof applyView>[1]['criteria'][number]['op'], value?: string) => names(applyView(rows, { match: 'all', criteria: [{ field, op, value }] }, fields));
  assert.deepEqual(one('name', 'contains', 'FILTER'), ['Air Filter']);
  assert.deepEqual(one('name', 'starts', 'brake'), ['Brake Pad Set']);
  assert.deepEqual(one('name', 'not_contains', 'a'), [], 'every name has an a');
  assert.deepEqual(one('sku', 'empty'), ['Air Filter']);
  assert.deepEqual(one('sku', 'not_empty'), ['Brake Pad Set', 'Fitment & Labour']);
  assert.deepEqual(one('rate', 'le', '520'), ['Air Filter', 'Fitment & Labour']);
  assert.deepEqual(one('rate', 'eq', 'abc'), [], 'a value that is not a number matches nothing');
  assert.deepEqual(one('created', 'before', '2026-05-01'), ['Brake Pad Set']);
  assert.deepEqual(one('created', 'after', '2026-05-10'), ['Fitment & Labour']);
  assert.deepEqual(one('kind', 'is_not', 'Goods'), ['Fitment & Labour']);
});

test('a criterion on a field the list no longer has is ignored, and no criteria keep every row', () => {
  assert.equal(applyView(rows, { match: 'all', criteria: [{ field: 'gone', op: 'is', value: 'x' }] }, fields).length, 3);
  assert.equal(applyView(rows, { match: 'all', criteria: [] }, fields).length, 3);
  assert.equal(takesValue('empty'), false);
  assert.equal(takesValue('contains'), true);
});
