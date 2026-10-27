import type { Metadata } from 'next';
import { BRAND } from '@/components/brand/logo';

// A layout purely to carry metadata: the sign-in page itself is a client
// component, and a client component cannot export `metadata`. Without this it
// would inherit the home page's title, and two indexed pages sharing one title
// is the sort of thing that quietly costs a search result.

export const metadata: Metadata = {
  title: 'Sign in',
  description: `Sign in to ${BRAND.name}, or open the demo book — a fully worked set of accounts you can explore without an account of your own.`,
  alternates: { canonical: '/login' },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
