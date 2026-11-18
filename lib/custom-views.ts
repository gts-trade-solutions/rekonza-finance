// Zoho's custom views ("New View" in a list's view menu): a name, criteria the
// rows must meet (all of them, or any), and the columns the view shows. Kept
// through /api/saved-views; matched here, in the browser, over the list's rows.

export type ViewFieldType = 'text' | 'number' | 'date' | 'choice';

/** A field a criterion can test, as the list knows its rows. */
export interface ViewField<T> {
  key: string;
  label: string;
  type: ViewFieldType;
  /** The choices of a 'choice' field (Goods, Service; Active, Inactive…). */
  options?: string[];
  value: (row: T) => string | number | null | undefined;
}

export type ViewOp =
  | 'is' | 'is_not' | 'contains' | 'not_contains' | 'starts' | 'ends' | 'empty' | 'not_empty'
  | 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'before' | 'after';

export interface ViewCriterion { field: string; op: ViewOp; value?: string }

export interface CustomView {
  match: 'all' | 'any';
  criteria: ViewCriterion[];
  /** The columns the view shows, in order; empty keeps the list's own. */
  columns?: string[];
}

/** The comparators Zoho offers for each kind of field. */
export const OPS: Record<ViewFieldType, { op: ViewOp; label: string }[]> = {
  text: [
    { op: 'is', label: 'is' }, { op: 'is_not', label: "isn't" }, { op: 'contains', label: 'contains' },
    { op: 'not_contains', label: "doesn't contain" }, { op: 'starts', label: 'starts with' }, { op: 'ends', label: 'ends with' },
    { op: 'empty', label: 'is empty' }, { op: 'not_empty', label: 'is not empty' },
  ],
  number: [
    { op: 'eq', label: '=' }, { op: 'ne', label: '≠' }, { op: 'lt', label: '<' }, { op: 'le', label: '≤' },
    { op: 'gt', label: '>' }, { op: 'ge', label: '≥' }, { op: 'empty', label: 'is empty' }, { op: 'not_empty', label: 'is not empty' },
  ],
  date: [
    { op: 'is', label: 'is' }, { op: 'before', label: 'is before' }, { op: 'after', label: 'is after' },
    { op: 'empty', label: 'is empty' }, { op: 'not_empty', label: 'is not empty' },
  ],
  choice: [{ op: 'is', label: 'is' }, { op: 'is_not', label: "isn't" }],
};

/** Whether an operator takes a value to compare with. */
export const takesValue = (op: ViewOp) => op !== 'empty' && op !== 'not_empty';

function test<T>(row: T, c: ViewCriterion, f: ViewField<T>): boolean {
  const raw = f.value(row);
  const blank = raw === null || raw === undefined || raw === '';
  if (c.op === 'empty') return blank;
  if (c.op === 'not_empty') return !blank;
  const want = (c.value ?? '').trim();
  if (f.type === 'number') {
    if (blank) return false;
    const a = Number(raw);
    const b = Number(want);
    if (!Number.isFinite(b)) return false;
    switch (c.op) {
      case 'eq': return a === b;
      case 'ne': return a !== b;
      case 'lt': return a < b;
      case 'le': return a <= b;
      case 'gt': return a > b;
      case 'ge': return a >= b;
      default: return false;
    }
  }
  if (f.type === 'date') {
    if (blank) return false;
    const a = String(raw).slice(0, 10);
    if (c.op === 'is') return a === want;
    if (c.op === 'before') return a < want;
    if (c.op === 'after') return a > want;
    return false;
  }
  const a = blank ? '' : String(raw).toLowerCase();
  const b = want.toLowerCase();
  switch (c.op) {
    case 'is': return a === b;
    case 'is_not': return a !== b;
    case 'contains': return a.includes(b);
    case 'not_contains': return !a.includes(b);
    case 'starts': return a.startsWith(b);
    case 'ends': return a.endsWith(b);
    default: return false;
  }
}

/** The rows the view keeps: every criterion met ('all'), or at least one ('any'). A criterion on an unknown field is ignored. */
export function applyView<T>(rows: T[], view: CustomView, fields: ViewField<T>[]): T[] {
  const live = view.criteria
    .map((c) => ({ c, f: fields.find((x) => x.key === c.field) }))
    .filter((x): x is { c: ViewCriterion; f: ViewField<T> } => !!x.f);
  if (!live.length) return rows;
  return rows.filter((r) => (view.match === 'any' ? live.some(({ c, f }) => test(r, c, f)) : live.every(({ c, f }) => test(r, c, f))));
}
