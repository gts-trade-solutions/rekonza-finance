'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The bridge between the server session and the app shell.
//
// Authentication is entirely server-side now: the browser holds an httpOnly
// cookie it cannot read, and /api/auth/me is the only way to learn who is
// signed in. This component makes that call, gates the shell on it, and hands
// the answer to migrated pages through a context.
//
// Nothing is seeded into the store here any more. Every screen reads its
// documents from the API, and MastersGate fills in the organisation, contacts,
// items, accounts and bank accounts from the server a moment later — so what
// the app shows belongs to the organisation that is actually signed in.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth, ApiError, type SessionResponse } from '@/lib/api/client';
import { useAppStore } from '@/lib/store';
import { setCustomPermissionSource } from '@/lib/rbac';

export type SessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; session: SessionResponse }
  | { status: 'anonymous' }
  | { status: 'error'; message: string };

const SessionContext = createContext<SessionResponse | null>(null);

/** The signed-in user, org and branches as the server sees them. */
export function useSession(): SessionResponse {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used inside the app shell, which provides it.');
  }
  return ctx;
}

export function SessionGate({
  children,
  fallback,
  onError,
}: {
  children: (session: SessionResponse) => React.ReactNode;
  fallback: React.ReactNode;
  onError: (message: string) => React.ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    auth
      .me()
      .then((session) => {
        if (cancelled) return;
        // Every permission check in the browser reads the custom role from here.
        setCustomPermissionSource(() => session.user.permissions ?? null);
        // Nothing else will answer until two-step sign-in is set up.
        if (session.user.passwordChangeRequired) {
          router.replace('/change-password');
          return;
        }
        if (session.user.mfaSetupRequired) {
          router.replace('/two-step-setup');
          return;
        }

        // The session points at the server's user id, because MastersGate is
        // about to replace the store's user list with the server's. The role
        // always comes from the server too — a locally-edited role would change
        // which buttons render, and the API would refuse the click anyway.
        useAppStore.setState({
          session: { userId: session.user.id, role: session.user.role },
          activeBranchId: session.user.activeBranchId ?? session.user.branchId ?? '',
        });

        setState({ status: 'authenticated', session });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.isAuthFailure) {
          setState({ status: 'anonymous' });
          router.replace('/login');
          return;
        }
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Could not reach the server.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state.status === 'error') return <>{onError(state.message)}</>;
  if (state.status !== 'authenticated') return <>{fallback}</>;

  return (
    <SessionContext.Provider value={state.session}>
      {children(state.session)}
    </SessionContext.Provider>
  );
}
