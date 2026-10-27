'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The organisation's AI credit balance, held once for the whole app.
//
// The top bar, the corner assistant and the assistant's page all show the
// same number from here, so an answered question or a purchase moves every
// one of them at once. It also owns the two things any screen may want to
// open: the top-up dialog, and the corner assistant.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { TopUpDialog } from '@/components/billing/topup-dialog';
import { ai, type AiWallet } from '@/lib/api/ai';
import { usePermission } from '@/lib/store/hooks';

export interface CreditsContextValue {
  /** Null until loaded, and for anyone whose role has no assistant. */
  wallet: AiWallet | null;
  refresh: () => Promise<void>;
  /** An answer settled with this balance: move every display without a round trip. */
  setAvailable: (mc: number) => void;
  /** Open the top-up dialog. Does nothing for someone who cannot buy. */
  topUp: () => void;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
}

const noop = () => {};

const CreditsContext = createContext<CreditsContextValue>({
  wallet: null,
  refresh: async () => {},
  setAvailable: noop,
  topUp: noop,
  assistantOpen: false,
  setAssistantOpen: noop,
});

export function CreditsProvider({ children }: { children: React.ReactNode }) {
  const canUseAi = usePermission('ai', 'view');
  const [wallet, setWallet] = useState<AiWallet | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!canUseAi) {
      setWallet(null);
      return;
    }
    try {
      setWallet(await ai.wallet());
    } catch {
      // The balance is a convenience. The app works without it, and the next
      // refresh will try again.
    }
  }, [canUseAi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Coming back to the tab after paying in another one, or after a Razorpay
  // window: catch up rather than show the old balance.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const setAvailable = useCallback((mc: number) => setWallet((w) => (w ? { ...w, availableMc: mc } : w)), []);
  const topUp = useCallback(() => setTopUpOpen(true), []);

  const value = useMemo<CreditsContextValue>(
    () => ({ wallet, refresh, setAvailable, topUp, assistantOpen, setAssistantOpen }),
    [wallet, refresh, setAvailable, topUp, assistantOpen],
  );

  return (
    <CreditsContext.Provider value={value}>
      {children}
      {wallet?.canManage && (
        <TopUpDialog
          open={topUpOpen}
          onOpenChange={setTopUpOpen}
          availableMc={wallet.availableMc}
          onPurchased={() => void refresh()}
        />
      )}
    </CreditsContext.Provider>
  );
}

export const useCredits = (): CreditsContextValue => useContext(CreditsContext);
