'use client';

// The settings menu beside this setting, as on every Zoho settings page (components/settings/all-settings.tsx).

import { SettingsFrame } from '@/components/settings/all-settings';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <SettingsFrame href="/settings/hsn-codes">{children}</SettingsFrame>;
}
