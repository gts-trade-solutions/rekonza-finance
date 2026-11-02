// The invoice template: how the printed invoice looks, as the business chose
// in Settings → Invoice print. The content is Rule 46's; this is the look —
// a layout, an accent colour, whether the logo and the signature block print,
// and a line at the foot of the page.

export type PrintLayout = 'classic' | 'modern' | 'compact';

export interface PrintTemplate {
  layout: PrintLayout;
  accent: string;
  showLogo: boolean;
  showSignature: boolean;
  footer: string | null;
}

export const DEFAULT_TEMPLATE: PrintTemplate = { layout: 'classic', accent: '#0f172a', showLogo: true, showSignature: true, footer: null };

/** A stored template, or the default, with anything missing or wrong filled from the default. */
export function readTemplate(v: unknown): PrintTemplate {
  let raw: Partial<PrintTemplate> = {};
  try { raw = (typeof v === 'string' ? JSON.parse(v) : v ?? {}) as Partial<PrintTemplate>; } catch { /* the default */ }
  return {
    layout: raw.layout === 'modern' || raw.layout === 'compact' ? raw.layout : 'classic',
    accent: typeof raw.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accent) ? raw.accent : DEFAULT_TEMPLATE.accent,
    showLogo: raw.showLogo !== false,
    showSignature: raw.showSignature !== false,
    footer: typeof raw.footer === 'string' && raw.footer.trim() ? raw.footer.trim().slice(0, 300) : null,
  };
}
