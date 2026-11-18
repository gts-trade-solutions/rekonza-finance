// Zoho's customer and vendor fields (migration 112), as the contact endpoints
// read and write them: the API's camelCase name for each column.

/** The camelCase API name of each of Zoho's columns (migration 112). */
export const ZOHO_COLUMNS = {
  contactType: 'contact_type', salutation: 'salutation', firstName: 'first_name', lastName: 'last_name', mobile: 'mobile',
  language: 'language', website: 'website', twitter: 'twitter', facebook: 'facebook', skype: 'skype',
  department: 'department', designation: 'designation', taxPreference: 'tax_preference', taxExemptionReason: 'tax_exemption_reason',
  billingAttention: 'billing_attention', billingStreet2: 'billing_street2', billingCity: 'billing_city', billingState: 'billing_state',
  billingPincode: 'billing_pincode', billingCountry: 'billing_country', billingPhone: 'billing_phone', billingFax: 'billing_fax',
  shippingAttention: 'shipping_attention', shippingStreet2: 'shipping_street2', shippingCity: 'shipping_city', shippingState: 'shipping_state',
  shippingPincode: 'shipping_pincode', shippingCountry: 'shipping_country', shippingPhone: 'shipping_phone', shippingFax: 'shipping_fax',
} as const;
export type ZohoKey = keyof typeof ZOHO_COLUMNS;

/** A row's Zoho fields, as the API returns them. */
export function zohoFields(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(ZOHO_COLUMNS).map(([k, col]) => [k, row[col] ?? null])) as Record<ZohoKey, string | null>;
}
