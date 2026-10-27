import type { MetadataRoute } from 'next';
import { BRAND } from '@/components/brand/logo';

// The web app manifest. Small, but it is what decides how the app looks when
// someone adds it to a home screen — without it, Chrome invents a name from the
// title and an icon from the favicon, and the result is rarely the brand.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRAND.display} — ${BRAND.tagline}`,
    short_name: BRAND.short,
    description: BRAND.description,
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#002F6E',
    lang: 'en-IN',
    categories: ['business', 'finance', 'productivity'],
    icons: [
      { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/apple-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  };
}
