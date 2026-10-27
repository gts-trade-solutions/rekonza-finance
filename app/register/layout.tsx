import type { Metadata } from 'next';
import { BRAND } from '@/components/brand/logo';

// See app/login/layout.tsx — metadata for a client-component page.

export const metadata: Metadata = {
  title: 'Create your books',
  description: `Open a free ${BRAND.name} account: a standard chart of accounts, GST-compliant numbering from one, and an empty ledger that is yours alone.`,
  alternates: { canonical: '/register' },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
