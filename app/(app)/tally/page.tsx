'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Tally: the companies a business keeps in TallyPrime, read into the portal.
//
// A connector on the PC running Tally sends each company here, and this page
// lists them with how fresh they are — because a balance sheet is only as good
// as the day it was last synced, and that has to be visible before anybody
// reads a figure. The PCs are listed below, with a way to disconnect one.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronRight, MonitorDown, MonitorX, PlayCircle, Plug, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { PairingDialog } from '@/components/tally/pairing-dialog';
import { TallyTutorialDialog, useFirstVisitTutorial } from '@/components/tally/tutorial-dialog';
import { ago, longDate, presence } from '@/components/tally/format';
import { tally, type TallyCompanyView, type TallyConnectorView, type TallyOverview } from '@/lib/api/tally';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

export default function TallyPage() {
  const canEdit = usePermission('tally', 'edit');
  const state = useApi<TallyOverview>(() => tally.overview(), []);
  const [pairing, setPairing] = useState(false);
  // Opens by itself the first time anyone on this browser comes to Tally.
  const [tutorial, setTutorial] = useFirstVisitTutorial();
  const [disconnecting, setDisconnecting] = useState<TallyConnectorView | null>(null);
  const knownActive = useRef<Set<string>>(new Set());
  const [pairedMachine, setPairedMachine] = useState<string | null>(null);
  const { refetch } = state;

  // While the pairing dialog is open, look for the connector every few seconds.
  useEffect(() => {
    if (!pairing) return;
    knownActive.current = new Set((state.data?.connectors ?? []).filter((c) => c.status === 'active').map((c) => c.id));
    setPairedMachine(null);
    const timer = setInterval(() => void refetch(), 4000);
    return () => clearInterval(timer);
    // Only when the dialog opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing]);

  useEffect(() => {
    if (!pairing || pairedMachine) return;
    const fresh = state.data?.connectors.find((c) => c.status === 'active' && !knownActive.current.has(c.id));
    if (fresh) setPairedMachine(fresh.machineName ?? 'the PC');
  }, [state.data, pairing, pairedMachine]);

  return (
    <>
      <PageHeader
        title="Tally"
        description="Your TallyPrime companies, read from the PC where Tally runs. Read-only here: entries are still made in Tally, and every figure shows the day it was last synced."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setTutorial(true)} data-slot="tally-tutorial-open">
              <PlayCircle className="size-3.5" /> Watch the tutorial
            </Button>
            {/* The other direction: our own documents, sent to Tally. */}
            <Button variant="outline" size="sm" asChild data-slot="tally-export-link">
              <Link href="/tally/export">
                <Upload className="size-3.5" /> Export to Tally
              </Link>
            </Button>
            {canEdit && (
              <Button size="sm" onClick={() => setPairing(true)} data-slot="tally-connect">
                <Plug className="size-3.5" /> Connect a PC
              </Button>
            )}
          </div>
        }
      />

      <AsyncPage state={state}>
        {(d) => (
          <div className="space-y-6">
            {d.companies.length === 0 ? (
              <SetupSteps canEdit={canEdit} onConnect={() => setPairing(true)} hasConnector={d.connectors.some((c) => c.status === 'active')} />
            ) : (
              <section className="space-y-3">
                <h2 className="micro-label">Companies</h2>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {d.companies.map((c) => (
                    <CompanyCard key={c.id} company={c} />
                  ))}
                </div>
              </section>
            )}

            {d.connectors.length > 0 && (
              <section className="space-y-3">
                <h2 className="micro-label">Connected PCs</h2>
                <Card className="divide-y p-0">
                  {d.connectors.map((c) => (
                    <ConnectorRow key={c.id} connector={c} canEdit={canEdit} onDisconnect={() => setDisconnecting(c)} />
                  ))}
                </Card>
              </section>
            )}
          </div>
        )}
      </AsyncPage>

      <TallyTutorialDialog open={tutorial} onOpenChange={setTutorial} />
      <PairingDialog open={pairing} onOpenChange={setPairing} pairedMachine={pairedMachine} />
      <DisconnectDialog connector={disconnecting} onClose={() => setDisconnecting(null)} onDone={() => void refetch()} />
    </>
  );
}

function SetupSteps({ canEdit, onConnect, hasConnector }: { canEdit: boolean; onConnect: () => void; hasConnector: boolean }) {
  return (
    <Card className="space-y-5 p-6" data-slot="tally-setup">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <MonitorDown className="size-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold">
            {hasConnector ? 'Waiting for the first sync' : 'See your Tally books here'}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {hasConnector
              ? 'A PC is connected. Its companies appear here once TallyPrime is open and the connector has sent them.'
              : 'Day Book, ledgers, Trial Balance, Profit & Loss, Balance Sheet and Stock Summary — as your Tally company has them, kept up to date by a small connector on the PC running TallyPrime.'}
          </p>
        </div>
      </div>
      <ol className="grid gap-3 md:grid-cols-3">
        {[
          ['Install the connector', 'On the PC or server where TallyPrime runs — ask REKONZA support for the installer. One connector covers every company on that PC.'],
          ['Turn on Tally’s data port', 'In TallyPrime: F1 Help → Settings → Connectivity → act as server on port 9000, saved with Ctrl+A. The top of the Tally window then reads TallyPrime:9000.'],
          ['Pair it with a code', 'Press Connect a PC here and type the code into the connector. Only the code is typed in — never a password.'],
        ].map(([title, detail], i) => (
          <li key={title} className="rounded-md border p-3.5">
            <p className="text-sm font-medium">
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">{i + 1}</span>
              {title}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
          </li>
        ))}
      </ol>
      {canEdit && !hasConnector && (
        <Button onClick={onConnect}>
          <Plug className="size-4" /> Connect a PC
        </Button>
      )}
    </Card>
  );
}

function CompanyCard({ company: c }: { company: TallyCompanyView }) {
  const stale = !c.lastSyncedAt || Date.now() - new Date(c.lastSyncedAt).getTime() > 24 * 3600_000;
  return (
    <Link href={`/tally/${c.id}`} className="group block" data-slot="tally-company">
      <Card className="h-full space-y-3 p-4 transition-colors group-hover:border-primary/40">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Building2 className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{c.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[c.gstin, c.stateName].filter(Boolean).join(' · ') || 'No GSTIN in Tally'}
            </p>
          </div>
          <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            ['Ledgers', c.ledgers],
            ['Vouchers', c.vouchers],
            ['Stock items', c.stockItems],
          ].map(([label, n]) => (
            <div key={label} className="rounded-md bg-muted/40 px-2 py-1.5">
              <p className="text-sm font-semibold tabular-nums">{Number(n).toLocaleString('en-IN')}</p>
              <p className="text-[10px] text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge
            variant="outline"
            className={cn(
              'text-[10px]',
              c.lastError
                ? 'border-destructive/40 text-destructive'
                : stale
                  ? 'border-warning/50 text-warning'
                  : 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
            )}
          >
            {c.lastError ? 'Sync problem' : stale ? `Synced ${ago(c.lastSyncedAt)}` : `Synced ${ago(c.lastSyncedAt)}`}
          </Badge>
          {c.asOf && <span className="text-muted-foreground">Figures as at {longDate(c.asOf)}</span>}
        </div>
        {c.lastError && <p className="text-xs text-destructive">{c.lastError}</p>}
      </Card>
    </Link>
  );
}

function ConnectorRow({
  connector: c,
  canEdit,
  onDisconnect,
}: {
  connector: TallyConnectorView;
  canEdit: boolean;
  onDisconnect: () => void;
}) {
  const state = c.status === 'revoked' ? 'revoked' : presence(c.lastSeenAt);
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-slot="tally-connector">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          state === 'online' ? 'bg-emerald-500' : state === 'recent' ? 'bg-warning' : 'bg-muted-foreground/40',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{c.machineName ?? 'Unnamed PC'}</p>
        <p className="truncate text-xs text-muted-foreground">
          {state === 'revoked'
            ? 'Disconnected'
            : `${state === 'online' ? 'Online' : 'Last seen'} ${state === 'online' ? '' : ago(c.lastSeenAt)}`.trim()}
          {c.tallyVersion ? ` · ${c.tallyVersion}` : ''}
          {c.connectorVersion ? ` · connector ${c.connectorVersion}` : ''}
          {` · ${c.companies} compan${c.companies === 1 ? 'y' : 'ies'}`}
        </p>
        {c.lastError && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
            <TriangleAlert className="size-3" /> {c.lastError}
          </p>
        )}
      </div>
      {canEdit && c.status === 'active' && (
        <Button size="xs" variant="ghost" onClick={onDisconnect} aria-label={`Disconnect ${c.machineName ?? 'PC'}`}>
          <MonitorX className="size-3" /> Disconnect
        </Button>
      )}
    </div>
  );
}

function DisconnectDialog({
  connector,
  onClose,
  onDone,
}: {
  connector: TallyConnectorView | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!connector) return;
    setBusy(true);
    try {
      await tally.revoke(connector.id);
      toast.success(`${connector.machineName ?? 'The PC'} is disconnected`);
      onDone();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!connector} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {connector?.machineName ?? 'this PC'}?</DialogTitle>
          <DialogDescription>
            It stops sending at once. The Tally figures it already sent stay here, marked with the day they were last
            synced. To connect it again, pair it with a new code.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep it connected
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void go()}>
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
