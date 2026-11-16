import type { Metadata, Viewport } from 'next';
import { Inter, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';
import { OfflineBanner, ServiceWorker } from '@/components/layout/pwa';
import { BRAND } from '@/components/brand/logo';
import { SITE_URL } from '@/lib/seo';

/**
 * Inter, the typeface Zoho Books sets its whole app in (13px body). The client
 * asked for Zoho's look exactly, type and sizes included. Figures use Inter's
 * tabular numerals (see .num / .tabular in globals.css), so columns of amounts
 * still line up digit under digit without a monospaced face.
 */
const inter = Inter({
  variable: '--font-sans-src',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

/** Kept for code: JSON, API keys and file layouts, where a fixed width helps. */
const plexMono = IBM_Plex_Mono({
  variable: '--font-mono-src',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

/**
 * Site-wide metadata.
 *
 * `metadataBase` is what makes every relative OG and canonical URL resolve to
 * an absolute one — without it social crawlers silently drop the card image.
 * The title template lets each page contribute only its own name.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${BRAND.display} — ${BRAND.tagline}`,
    template: `%s — ${BRAND.display}`,
  },
  description: BRAND.description,
  applicationName: BRAND.name,
  keywords: [
    'accounting software India',
    'GST billing software',
    'GST return filing',
    'GSTR-1',
    'GSTR-3B',
    'e-invoicing IRN',
    'e-way bill',
    'double entry accounting',
    'TDS software',
    'MSME 45 day rule',
    'bank reconciliation',
    'invoicing software for small business',
  ],
  authors: [{ name: BRAND.name }],
  creator: BRAND.name,
  publisher: BRAND.name,
  category: 'business',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: BRAND.name,
    locale: 'en_IN',
    url: '/',
    title: `${BRAND.display} — ${BRAND.tagline}`,
    description: BRAND.description,
  },
  twitter: {
    card: 'summary_large_image',
    title: `${BRAND.display} — ${BRAND.tagline}`,
    description: BRAND.description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
  formatDetection: { telephone: false },
};

/** Matches the dark top bar, so mobile browsers tint their bar to suit. */
export const viewport: Viewport = {
  themeColor: '#21263c',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply a saved dark theme before paint to avoid a flash. Light is the
            default whatever the computer prefers, as in Zoho Books: dark is
            something a person chooses (account menu → Dark mode). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('rekonza-theme')==='dark'){document.documentElement.classList.add('dark')}}catch(e){}`,
          }}
        />
      </head>
      <body className={`${inter.variable} ${plexMono.variable} font-sans antialiased`}>
        <OfflineBanner />
        <ServiceWorker />
        {children}
        {/* Lifted clear of the assistant's button in the same corner. */}
        <Toaster position="bottom-right" offset={{ bottom: 88 }} mobileOffset={{ bottom: 88 }} richColors closeButton />
      </body>
    </html>
  );
}
