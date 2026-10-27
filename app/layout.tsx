import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';
import { OfflineBanner, ServiceWorker } from '@/components/layout/pwa';
import { BRAND } from '@/components/brand/logo';
import { SITE_URL } from '@/lib/seo';

/**
 * Plex Sans is drawn on an engineering grid — even stroke, open counters, no
 * decorative flourish. It sets the precise, technical tone the interface wants.
 */
const plexSans = IBM_Plex_Sans({
  variable: '--font-sans-src',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

/**
 * Every figure in the app is set in Plex Mono. Monospaced numerals column up
 * exactly, which is what makes a ledger scannable — you compare digit
 * positions, not word shapes.
 */
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

/** Matches the navy chrome, so mobile browsers tint their bar to suit. */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#002F6E' },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply saved theme before paint to avoid a flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('rekonza-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}`,
          }}
        />
      </head>
      <body className={`${plexSans.variable} ${plexMono.variable} font-sans antialiased`}>
        <OfflineBanner />
        <ServiceWorker />
        {children}
        {/* Lifted clear of the assistant's button in the same corner. */}
        <Toaster position="bottom-right" offset={{ bottom: 88 }} mobileOffset={{ bottom: 88 }} richColors closeButton />
      </body>
    </html>
  );
}
