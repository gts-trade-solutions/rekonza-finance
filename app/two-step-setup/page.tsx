'use client';

// Where a user lands when the book requires two-step sign-in of them and they
// have not set it up. The server refuses everything else until they do.

import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TwoStepPanel } from '@/components/settings/two-step-panel';
import { auth } from '@/lib/api/client';
import { BRAND, Logo } from '@/components/brand/logo';

export default function TwoStepSetupPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-2xl space-y-4">
        <div className="flex flex-col items-center text-center">
          <Logo width={180} priority />
          <h1 className="mt-4 text-lg font-semibold">Set up two-step sign-in to carry on</h1>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            This book asks for a code from an authenticator app as well as the password. It takes a minute, and
            {` ${BRAND.short}`} opens as soon as it is on.
          </p>
        </div>
        <TwoStepPanel onEnabled={() => { window.location.href = '/dashboard'; }} />
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" className="gap-1.5"
            onClick={() => void auth.logout().finally(() => { window.location.href = '/login'; })}>
            <LogOut className="size-3.5" /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
