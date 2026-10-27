'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The AI assistant.
//
// A language model now — OpenAI, through its API — but one that is only ever
// allowed to answer from the books. Every figure it gives comes from a lookup
// it made in this conversation, through the same functions the reports use,
// and the answer links to the report so it can be checked. It can read; it
// cannot write. It sees what the person asking can see, and no more.
//
// The checks that used to be this page's first tab are still here, as the
// "needs attention" list on an empty conversation: rules over the books,
// free to run and exactly right, each one a question away from an
// explanation.
// ─────────────────────────────────────────────────────────────────────────────

import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { CreditMeter, EnablePanel, NotEnabledPanel, UnconfiguredPanel } from '@/components/ai/panels';
import { Workspace } from '@/components/ai/workspace';
import { useCredits } from '@/components/ai/credits-provider';
import { useSession } from '@/components/layout/session-provider';
import { ai, type AiStatus } from '@/lib/api/ai';
import { useApi } from '@/lib/api/use-api';

export default function AiPage() {
  const session = useSession();
  const credits = useCredits();
  const state = useApi<AiStatus>(() => ai.status(), []);

  return (
    <>
      <PageHeader
        title="AI Assistant"
        description="Ask about your books in plain words. Every figure comes from the same reports the app shows, and links back to them."
        actions={state.data && state.data.enabled && state.data.mode !== 'unconfigured' ? <CreditMeter status={state.data} /> : undefined}
      />

      <AsyncPage state={state}>
        {(status) =>
          status.mode === 'unconfigured' ? (
            <UnconfiguredPanel />
          ) : !status.enabled ? (
            status.canManage ? (
              <EnablePanel
                orgName={session.org?.name ?? 'your organisation'}
                onEnabled={() => {
                  void state.refetch();
                  // The balance in the top bar and the corner assistant appear now.
                  void credits.refresh();
                }}
              />
            ) : (
              <NotEnabledPanel />
            )
          ) : (
            <Workspace
              status={status}
              availableMc={credits.wallet?.availableMc ?? status.wallet.availableMc}
              onWallet={(mc) => {
                // Every balance on screen moves at once; the rest of the status
                // (the monthly limit used) is refreshed quietly behind it.
                credits.setAvailable(mc);
                void state.refetch();
              }}
            />
          )
        }
      </AsyncPage>
    </>
  );
}
