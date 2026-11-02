import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Custom fields: extra boxes a business adds to its customers, items or
// documents — a vehicle number on an invoice, a dealer code on a customer —
// with a type that is checked, a required flag that is enforced, and a choice
// of whether it prints on the PDF.
//
// A field is never deleted once it has values, only switched off: the values
// already recorded against documents stay readable, as the audit trail wants.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { badRequest, conflict, notFound } from '../http';

export const CUSTOM_FIELD_ENTITIES = ['contact', 'item', 'invoice', 'estimate', 'sales_order', 'bill', 'purchase_order', 'expense', 'project'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];
export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox';

export interface CustomFieldDef {
  id: number; entity: CustomFieldEntity; label: string; key: string; type: CustomFieldType;
  options: string[]; required: boolean; showOnPdf: boolean; order: number; isActive: boolean;
}

const parse = (v: unknown): string[] => {
  if (!v) return [];
  const a = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(a) ? a.map(String) : [];
};

export async function listFields(ex: Executor, orgId: number, entity?: CustomFieldEntity, activeOnly = false): Promise<CustomFieldDef[]> {
  let q = ex.selectFrom('custom_fields').selectAll().where('org_id', '=', orgId);
  if (entity) q = q.where('entity', '=', entity);
  if (activeOnly) q = q.where('is_active', '=', 1);
  const rows = await q.orderBy('entity').orderBy('display_order').orderBy('id').execute();
  return rows.map((r) => ({
    id: r.id, entity: r.entity as CustomFieldEntity, label: r.label, key: r.field_key, type: r.data_type as CustomFieldType,
    options: parse(r.options), required: !!r.is_required, showOnPdf: !!r.show_on_pdf, order: r.display_order, isActive: !!r.is_active,
  }));
}

export interface FieldInput {
  id?: number | null;
  entity: CustomFieldEntity;
  label: string;
  type: CustomFieldType;
  options?: string[];
  required?: boolean;
  showOnPdf?: boolean;
  order?: number;
  isActive?: boolean;
}

export async function saveField(trx: Trx, orgId: number, input: FieldInput): Promise<number> {
  const label = input.label.trim();
  if (!label) throw badRequest('Give the field a label.');
  if (!CUSTOM_FIELD_ENTITIES.includes(input.entity)) throw badRequest('Custom fields go on contacts, items or documents.');
  const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
  if (input.type === 'select' && options.length < 2) throw badRequest('A dropdown needs at least two choices.');
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'field';
  const values = {
    label: label.slice(0, 100), data_type: input.type, options: input.type === 'select' ? JSON.stringify(options) : null,
    is_required: input.required ? 1 : 0, show_on_pdf: input.showOnPdf ? 1 : 0, display_order: input.order ?? 0,
    is_active: input.isActive === false ? 0 : 1,
  };
  if (input.id) {
    const found = await trx.selectFrom('custom_fields').select(['id', 'data_type']).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!found) throw notFound('That field does not exist.');
    // Values already kept as one type would not read as another.
    if (found.data_type !== input.type) {
      const used = await trx.selectFrom('custom_field_values').select('id').where('field_id', '=', found.id).limit(1).executeTakeFirst();
      if (used) throw conflict('That field already has values; its type cannot change. Add a new field instead.');
    }
    await trx.updateTable('custom_fields').set(values).where('id', '=', found.id).execute();
    return found.id;
  }
  const clash = await trx.selectFrom('custom_fields').select('id').where('org_id', '=', orgId).where('entity', '=', input.entity).where('field_key', '=', key).executeTakeFirst();
  if (clash) throw conflict(`There is already a field called ${label} here.`);
  return Number((await trx.insertInto('custom_fields').values({ org_id: orgId, entity: input.entity, field_key: key, ...values }).executeTakeFirstOrThrow()).insertId);
}

export interface FieldValue { fieldId: number; key: string; label: string; type: CustomFieldType; options: string[]; required: boolean; showOnPdf: boolean; value: string | null }

/** Every active field for the entity, with this record's value or null. */
export async function getValues(ex: Executor, orgId: number, entity: CustomFieldEntity, entityId: number): Promise<FieldValue[]> {
  const fields = await listFields(ex, orgId, entity, true);
  if (!fields.length) return [];
  const vals = await ex.selectFrom('custom_field_values').select(['field_id', 'value'])
    .where('org_id', '=', orgId).where('entity_id', '=', entityId).where('field_id', 'in', fields.map((f) => f.id)).execute();
  return fields.map((f) => ({
    fieldId: f.id, key: f.key, label: f.label, type: f.type, options: f.options, required: f.required, showOnPdf: f.showOnPdf,
    value: vals.find((v) => v.field_id === f.id)?.value ?? null,
  }));
}

/** Set a record's values by field key. A key left out is left as it was; null or '' clears it. */
export async function setValues(trx: Trx, orgId: number, entity: CustomFieldEntity, entityId: number, values: Record<string, string | number | boolean | null>) {
  const fields = await listFields(trx, orgId, entity, true);
  const current = await getValues(trx, orgId, entity, entityId);
  for (const f of fields) {
    const has = Object.prototype.hasOwnProperty.call(values, f.key);
    const raw = has ? values[f.key] : current.find((c) => c.fieldId === f.id)?.value ?? null;
    const text = raw == null || raw === '' ? null : String(raw).trim();
    if (f.required && !text) throw badRequest(`${f.label} is required.`);
    if (!has) continue;
    if (text != null) {
      if (f.type === 'number' && !Number.isFinite(Number(text))) throw badRequest(`${f.label} takes a number.`);
      if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw badRequest(`${f.label} takes a date.`);
      if (f.type === 'select' && !f.options.includes(text)) throw badRequest(`${f.label} is one of: ${f.options.join(', ')}.`);
      if (f.type === 'checkbox' && text !== 'true' && text !== 'false') throw badRequest(`${f.label} is ticked or not.`);
    }
    if (text == null) {
      await trx.deleteFrom('custom_field_values').where('field_id', '=', f.id).where('entity_id', '=', entityId).execute();
    } else {
      const r = await trx.updateTable('custom_field_values').set({ value: text.slice(0, 1000) }).where('field_id', '=', f.id).where('entity_id', '=', entityId).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) await trx.insertInto('custom_field_values').values({ org_id: orgId, field_id: f.id, entity_id: entityId, value: text.slice(0, 1000) }).execute();
    }
  }
}
