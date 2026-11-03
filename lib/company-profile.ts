// The company's own profile in Settings: the eight kinds of company a business
// in India is registered as, and what it does. The kind is the constitution
// the GST registration and the PAN record; what it does may be several.

export const COMPANY_TYPES = [
  'Sole proprietorship',
  'Partnership firm',
  'Limited liability partnership (LLP)',
  'Private limited company',
  'Public limited company',
  'One person company (OPC)',
  'Hindu undivided family (HUF)',
  'Trust, society or AOP',
] as const;

export const BUSINESS_NATURES = [
  'Manufacturer',
  'Trader (wholesale)',
  'Retailer',
  'Service provider',
  'Importer',
  'Exporter',
  'Works contractor',
  'E-commerce seller',
] as const;

/** The kind a PAN's fourth letter or a CIN's suffix suggests, for filling the dropdown. */
export function companyTypeFrom(hint: string | null | undefined): string | null {
  const h = (hint ?? '').toLowerCase();
  if (!h) return null;
  if (h.includes('one person')) return 'One person company (OPC)';
  if (h.includes('private limited') || h.includes('private company')) return 'Private limited company';
  if (h.includes('public limited') || h.includes('public company')) return 'Public limited company';
  if (h.includes('llp') || h.includes('limited liability')) return 'Limited liability partnership (LLP)';
  if (h.includes('partnership')) return 'Partnership firm';
  if (h.includes('proprietor')) return 'Sole proprietorship';
  if (h.includes('hindu') || h.includes('huf')) return 'Hindu undivided family (HUF)';
  if (h.includes('trust') || h.includes('society') || h.includes('association')) return 'Trust, society or AOP';
  if (h === 'company') return 'Private limited company';
  return null;
}
