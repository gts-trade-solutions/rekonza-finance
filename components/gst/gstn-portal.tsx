'use client';

// The GST portal, from inside a return (Zoho's GSTN integration): connect a
// GSTIN with its portal username, sign in with the OTP the portal sends, push
// the return, follow what the portal made of it, and file with EVC to get the
// ARN. Shown on GSTR-1, IFF and GSTR-3B; the connections themselves are also
// listed in Settings (GstnConnections).

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CloudUpload, Info, KeyRound, Loader2, Plug, RefreshCw, ShieldCheck, TriangleAlert, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { isValidGstin } from '@/lib/tax/gst';

export type ReturnType = 'GSTR1' | 'IFF' | 'GSTR3B';

export interface GstnConnection {
  branchId: string; branchName: string; gstin: string | null; username: string | null;
  provider: string; providerLabel: string; environment: 'stand-in' | 'sandbox' | 'production'; live: boolean;
  connected: boolean; sessionExpiresAt: string | null; awaitingOtp: boolean; lastVerifiedAt: string | null; lastError: string | null;
}
export interface GstnSubmission {
  id: string; returnType: ReturnType; period: string; action: 'save' | 'file'; provider: string; referenceId: string | null;
  status: 'pending' | 'processed' | 'processed_with_errors' | 'error' | 'filed'; message: string | null; errorReport: unknown;
  arn: string | null; filedAt: string | null; totals: { taxable: number; tax: number } | null; by: string | null; at: string;
}
interface ProviderOption { name: string; label: string; environment: string; live: boolean; missing: string[] }
interface PortalResponse { providers: ProviderOption[]; connections: GstnConnection[]; submissions: GstnSubmission[] }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS: Record<GstnSubmission['status'], { label: string; tone: string }> = {
  pending: { label: 'Processing at the portal', tone: 'border-amber-500/40 text-amber-700 dark:text-amber-400' },
  processed: { label: 'Saved on the portal', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400' },
  processed_with_errors: { label: 'Saved with errors', tone: 'border-amber-500/40 text-amber-700 dark:text-amber-400' },
  error: { label: 'Rejected', tone: 'border-destructive/40 text-destructive' },
  filed: { label: 'Filed', tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
};

export function EnvironmentBadge({ c }: { c: Pick<GstnConnection, 'environment' | 'live'> }) {
  if (c.environment === 'stand-in') return <Badge variant="outline" className="text-[10px]">Stand-in · files nothing</Badge>;
  if (c.environment === 'sandbox') return <Badge variant="outline" className="border-sky-500/40 text-[10px] text-sky-700 dark:text-sky-400">GSP sandbox · test filing</Badge>;
  return <Badge className="bg-emerald-600 text-[10px] hover:bg-emerald-600">Live GST system</Badge>;
}

/** Connect, or sign in again: the username (once), then the OTP the portal sends. */
export function ConnectDialog({ c, providers, onClose, onDone }: { c: GstnConnection; providers: ProviderOption[]; onClose: () => void; onDone: () => void }) {
  const [username, setUsername] = useState(c.username ?? '');
  const [provider, setProvider] = useState(c.provider || 'fake');
  const [step, setStep] = useState<'user' | 'otp'>(c.username && c.awaitingOtp ? 'otp' : 'user');
  const [otp, setOtp] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = providers.find((p) => p.name === provider);

  const send = async () => {
    setBusy(true);
    try {
      const r = username === c.username && provider === c.provider
        ? await api.post<{ message: string }>('/api/gst/portal', { action: 'request-otp', branchId: c.branchId })
        : await api.post<{ message: string }>('/api/gst/portal', { action: 'connect', branchId: c.branchId, username, provider });
      setHint(r.message);
      setStep('otp');
    } catch (e) {
      toast.error(err(e, 'The OTP was not sent'));
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ expiresAt: string }>('/api/gst/portal', { action: 'verify-otp', branchId: c.branchId, otp });
      toast.success('Connected to the GST portal', { description: `Until ${when(r.expiresAt)}.` });
      onDone();
    } catch (e) {
      toast.error(err(e, 'That OTP was not accepted'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {c.gstin} to the GST portal</DialogTitle>
          <DialogDescription>{c.branchName}. The portal sends an OTP to the mobile number registered for this GSTIN.</DialogDescription>
        </DialogHeader>
        {step === 'user' ? (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
              First, on <b>gst.gov.in</b>: sign in, open <b>Profile → Manage API Access</b>, choose <b>Yes</b> and how long the access lasts
              (6 hours to 30 days). Then give your portal username here.
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gst-user">GST portal username</Label>
              <Input id="gst-user" autoFocus value={username} onChange={(e) => setUsername(e.target.value.trim())} placeholder="The name you sign in to gst.gov.in with" />
            </div>
            <div className="space-y-1.5">
              <Label>Filed through</Label>
              <div className="grid gap-2">
                {providers.map((p) => (
                  <button key={p.name} type="button" disabled={p.missing.length > 0} onClick={() => setProvider(p.name)}
                    className={cn('rounded-md border p-2.5 text-left text-sm disabled:opacity-60', provider === p.name ? 'border-primary bg-primary/5' : 'hover:bg-accent/50')}>
                    <span className="font-medium">{p.label}</span>
                    {p.missing.length > 0 && <span className="mt-0.5 block text-[11px] text-muted-foreground">Not set up on this server: {p.missing.join(', ')}</span>}
                  </button>
                ))}
              </div>
              {chosen?.environment === 'stand-in' && <p className="text-[11px] text-muted-foreground">The stand-in behaves like the GSTN sandbox and files nothing. A live connection needs a GSP account (see .env.example, GST_API_*).</p>}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {hint && <p className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">{hint}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="gst-otp">OTP</Label>
              <Input id="gst-otp" autoFocus inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} className="font-mono tracking-[0.4em]" placeholder="······" />
            </div>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setStep('user')}>Change the username, or send the OTP again</button>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {step === 'user'
            ? <Button onClick={() => void send()} disabled={busy || username.length < 3}>{busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />} Send OTP</Button>
            : <Button onClick={() => void verify()} disabled={busy || otp.length !== 6}>{busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />} Verify and connect</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** File with EVC: the OTP goes to the authorised signatory; the ARN comes back. */
function FileDialog({ c, returnType, period, onClose, onDone }: { c: GstnConnection; returnType: ReturnType; period: string; onClose: () => void; onDone: (s: GstnSubmission) => void }) {
  const [sent, setSent] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>('/api/gst/portal', { action: 'evc-otp', branchId: c.branchId, returnType });
      setSent(r.message);
    } catch (e) {
      toast.error(err(e, 'The EVC OTP was not sent'));
    } finally {
      setBusy(false);
    }
  };
  const file = async () => {
    setBusy(true);
    try {
      const s = await api.post<GstnSubmission>('/api/gst/portal', { action: 'file', branchId: c.branchId, returnType, period, otp });
      onDone(s);
    } catch (e) {
      toast.error(err(e, 'The return was not filed'));
    } finally {
      setBusy(false);
    }
  };
  const label = returnType === 'GSTR3B' ? 'GSTR-3B' : returnType === 'IFF' ? 'IFF' : 'GSTR-1';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>File {label} with EVC</DialogTitle>
          <DialogDescription>
            What is filed is what the portal holds from the last push. Filing is final — check the portal&apos;s summary first.
            {returnType === 'GSTR3B' && ' Pay any cash due (PMT-06 or the portal) before filing; the portal sets it off.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">The EVC OTP goes to the mobile of the authorised signatory with PAN <span className="font-mono">{c.gstin?.slice(2, 12)}</span>.</p>
          {!sent ? (
            <Button variant="outline" onClick={() => void ask()} disabled={busy} className="w-full gap-1.5">{busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />} Send EVC OTP</Button>
          ) : (
            <>
              <p className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">{sent}</p>
              <Input autoFocus inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} className="font-mono tracking-[0.4em]" placeholder="EVC OTP" />
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void file()} disabled={busy || !sent || otp.length !== 6}>{busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />} File {label}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ErrorReport({ report }: { report: unknown }) {
  if (!report) return null;
  return (
    <details className="mt-1 text-[11px]">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">The portal&apos;s error report</summary>
      <pre className="mt-1 max-h-48 overflow-auto rounded border bg-muted/40 p-2">{JSON.stringify(report, null, 2)}</pre>
    </details>
  );
}

/**
 * On a return's page: the connection for the chosen GSTIN, Push to GSTN,
 * File with EVC, and what has been sent for this period.
 */
export function GstnReturnBar({ returnType, period }: { returnType: ReturnType; period: string }) {
  const activeBranchId = useAppStore((s) => s.activeBranchId);
  const canPush = usePermission('gst', 'approve');
  const canSignIn = usePermission('gst', 'edit');
  const [branchId, setBranchId] = useState('');
  const state = useApi<PortalResponse>(() => api.get('/api/gst/portal', { returnType, period, branchId: branchId || undefined }), [returnType, period, branchId]);
  const conns = useMemo(() => (state.data?.connections ?? []).filter((c) => c.gstin), [state.data]);
  useEffect(() => {
    if (!branchId && conns.length) setBranchId(conns.find((c) => c.branchId === activeBranchId)?.branchId ?? conns[0].branchId);
  }, [conns, branchId, activeBranchId]);
  const c = conns.find((x) => x.branchId === branchId) ?? null;
  const [connecting, setConnecting] = useState(false);
  const [filing, setFiling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const subs = state.data?.submissions ?? [];
  const lastSave = subs.find((s) => s.action === 'save');
  const filed = subs.find((s) => s.action === 'file' && s.status === 'filed');

  const push = async () => {
    if (!c) return;
    setBusy('push');
    try {
      const s = await api.post<GstnSubmission>('/api/gst/portal', { action: 'push', branchId: c.branchId, returnType, period });
      toast.success(s.status === 'processed' ? 'Saved on the GST portal' : `Pushed: ${STATUS[s.status].label.toLowerCase()}`, { description: `Reference ${s.referenceId}.` });
      void state.refetch();
    } catch (e) {
      toast.error(err(e, 'The return was not pushed'));
      void state.refetch();
    } finally {
      setBusy(null);
    }
  };
  const refresh = async (id: string) => {
    setBusy(id);
    try {
      await api.post('/api/gst/portal', { action: 'refresh', submissionId: id });
      void state.refetch();
    } catch (e) {
      toast.error(err(e, 'Could not ask the portal'));
    } finally {
      setBusy(null);
    }
  };

  if (state.loading && !state.data) return null;
  if (!conns.length) return null;

  return (
    <Card className="space-y-3 p-4 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 text-primary" />
        <span className="text-sm font-semibold">GST portal</span>
        {conns.length > 1 && (
          <select className="h-7 rounded-md border bg-background px-2 text-xs" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="GSTIN">
            {conns.map((x) => <option key={x.branchId} value={x.branchId}>{x.gstin} · {x.branchName}</option>)}
          </select>
        )}
        {c && <EnvironmentBadge c={c} />}
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {!c ? '' : c.connected
            ? <>Connected as <b>{c.username}</b> until {when(c.sessionExpiresAt)}</>
            : c.username ? <>Signed out — {c.username}. Sign in with a fresh OTP to push or file.</> : <>Not connected. Connect {c.gstin} to push and file from here.</>}
        </span>
        {c && canSignIn && (
          <Button size="sm" variant={c.connected ? 'ghost' : 'outline'} className="h-7 gap-1.5" onClick={() => setConnecting(true)}>
            {c.connected ? <RefreshCw className="size-3.5" /> : <Plug className="size-3.5" />} {c.connected ? 'Sign in again' : c.username ? 'Sign in' : 'Connect'}
          </Button>
        )}
        {c?.connected && canPush && !filed && (
          <>
            <Button size="sm" className="h-7 gap-1.5" disabled={!!busy} onClick={() => void push()}>
              {busy === 'push' ? <Loader2 className="size-3.5 animate-spin" /> : <CloudUpload className="size-3.5" />} Push to GSTN
            </Button>
            <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={!!busy || !lastSave || lastSave.status === 'error' || lastSave.status === 'pending'} onClick={() => setFiling(true)}
              title={!lastSave ? 'Push the return first' : undefined}>
              <KeyRound className="size-3.5" /> File with EVC
            </Button>
          </>
        )}
      </div>

      {filed && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          Filed {when(filed.filedAt)} · ARN <span className="font-mono">{filed.arn}</span>
          {filed.provider === 'fake' && <span className="text-muted-foreground">— by the stand-in; nothing reached the GST system</span>}
        </div>
      )}

      {subs.length > 0 && (
        <ul className="divide-y rounded-md border text-xs">
          {subs.slice(0, 5).map((s) => (
            <li key={s.id} className="flex flex-wrap items-start gap-2 px-3 py-2">
              <Badge variant="outline" className={cn('text-[10px]', STATUS[s.status].tone)}>{s.action === 'file' ? 'Filed' : STATUS[s.status].label}</Badge>
              <div className="min-w-0 flex-1">
                <p>
                  {s.action === 'file' ? <>ARN <span className="font-mono">{s.arn}</span></> : <>Pushed · reference <span className="font-mono">{s.referenceId}</span></>}
                  {s.totals && <span className="text-muted-foreground"> · taxable {rupees(s.totals.taxable)}, tax {rupees(s.totals.tax)}</span>}
                </p>
                <p className="text-muted-foreground">{when(s.at)}{s.by ? ` · ${s.by}` : ''}{s.message ? ` · ${s.message}` : ''}</p>
                <ErrorReport report={s.errorReport} />
              </div>
              {s.status === 'pending' && (
                <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[11px]" disabled={busy === s.id} onClick={() => void refresh(s.id)}>
                  {busy === s.id ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Check status
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {c?.lastError && !c.connected && <p className="flex items-center gap-1.5 text-xs text-destructive"><TriangleAlert className="size-3.5" /> {c.lastError}</p>}

      {connecting && c && state.data && (
        <ConnectDialog c={c} providers={state.data.providers} onClose={() => setConnecting(false)} onDone={() => { setConnecting(false); void state.refetch(); }} />
      )}
      {filing && c && (
        <FileDialog c={c} returnType={returnType} period={period} onClose={() => setFiling(false)}
          onDone={(s) => { setFiling(false); toast.success(`Filed: ARN ${s.arn}`, { description: s.provider === 'fake' ? 'By the stand-in — nothing reached the GST system.' : 'The compliance calendar shows it done.' }); void state.refetch(); }} />
      )}
    </Card>
  );
}

/** Settings: every GSTIN's connection, to connect, sign in or disconnect. */
export function GstnConnections({ canEdit }: { canEdit: boolean }) {
  const state = useApi<PortalResponse>(() => api.get('/api/gst/portal'), []);
  const [connecting, setConnecting] = useState<GstnConnection | null>(null);
  const disconnect = async (c: GstnConnection) => {
    if (!window.confirm(`Disconnect ${c.gstin} from the GST portal? The session is ended; the history of returns stays.`)) return;
    try {
      await api.post('/api/gst/portal', { action: 'disconnect', branchId: c.branchId });
      void state.refetch();
    } catch (e) {
      toast.error(err(e, 'Could not disconnect'));
    }
  };
  return (
    <Card className="space-y-3 p-5">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4 text-primary" /> GST returns (GSTN)</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect each GSTIN with its GST portal username and an OTP to push GSTR-1, IFF and GSTR-3B, file with EVC, fetch GSTR-2B and look up GSTINs —
          from inside the app, as Zoho does. Turn on API access first on gst.gov.in (Profile → Manage API Access).
        </p>
      </div>
      {state.data && (
        <div className="divide-y rounded-md border">
          {state.data.connections.map((c) => (
            <div key={c.branchId} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{c.branchName} <span className="font-mono text-xs text-muted-foreground">{c.gstin ?? 'no GSTIN'}</span></p>
                <p className="text-xs text-muted-foreground">
                  {c.connected ? <>Connected as {c.username} until {when(c.sessionExpiresAt)}</> : c.username ? <>{c.username} · signed out</> : 'Not connected'}
                  {' · '}{c.providerLabel}
                </p>
              </div>
              {c.gstin && <EnvironmentBadge c={c} />}
              {canEdit && c.gstin && (
                <>
                  <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => setConnecting(c)}><Plug className="size-3.5" /> {c.username ? 'Sign in' : 'Connect'}</Button>
                  {c.username && <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={() => void disconnect(c)}><Unplug className="size-3.5" /> Disconnect</Button>}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {state.data?.providers.some((p) => p.name === 'gstn' && p.missing.length) && (
        <p className="text-[11px] text-muted-foreground">
          A live connection goes through a GST Suvidha Provider. Set its details on the server to enable it: {state.data.providers.find((p) => p.name === 'gstn')?.missing.join(', ')}.
        </p>
      )}
      {connecting && state.data && (
        <ConnectDialog c={connecting} providers={state.data.providers} onClose={() => setConnecting(null)} onDone={() => { setConnecting(null); void state.refetch(); }} />
      )}
    </Card>
  );
}

/** A GSTIN's registered details from the GST system, to fill in a party. */
export interface GstinDetails {
  gstin: string; legalName: string | null; tradeName: string | null; status: string | null; taxpayerType: string | null;
  constitution: string | null; registeredOn: string | null; cancelledOn: string | null;
  address: { line: string | null; city: string | null; district: string | null; stateCode: string; pincode: string | null } | null;
  fromPortal: boolean;
  /** Characters 3 to 12 of every GSTIN. */
  pan: string;
  /** Where the details came from: the GST system (GSP), a lookup service, or only the number itself. */
  source?: 'gst-system' | 'lookup-service' | 'number';
}

/** A company's details from its CIN (integrations/party-lookup.ts). */
export interface CompanyDetails {
  cin: string; listed: boolean; state: string | null; kind: string | null; incorporatedYear: number;
  incorporatedOn: string | null; name: string | null; status: string | null; source: 'number' | 'lookup-service';
}

/**
 * Said under the GSTIN box when a lookup could only read the number itself.
 * The state and PAN are written in the GSTIN; the registered name, address and
 * registration date are the GST system's record, and need a GSP or a GSTIN
 * lookup service to fetch. A toast once a page used to say this and was
 * missed: the owner typed a GSTIN, saw only the state fill and took the fetch
 * to be broken (2026-11-14). So it stays beside the box for as long as that
 * number is in it, every time.
 */
export function GstinNumberOnlyNote({ details, gstin, publicPage = false }: {
  /** The last lookup's answer, as onFound handed it over. */
  details: GstinDetails | null;
  /** What is in the box now: the note goes as soon as the number changes. */
  gstin: string;
  /** The sign-up page: a visitor has no settings to change, only a name to type. */
  publicPage?: boolean;
}) {
  if (!details || details.fromPortal || details.gstin !== gstin.trim().toUpperCase()) return null;
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-warning" data-slot="gstin-number-only">
      <Info className="mt-px size-3.5 shrink-0" />
      <span>
        {publicPage
          ? 'Only the state and PAN could be read from the GSTIN. Type the business name yourself.'
          : 'Only the state and PAN were filled. The name and address need a GSTIN lookup service: see Settings → System health.'}
      </span>
    </p>
  );
}

/** The GST treatment a registration's taxpayer type means. */
export function gstinTreatment(d: GstinDetails): string {
  const t = (d.taxpayerType ?? '').toLowerCase();
  if (t.includes('composition')) return 'registered_composition';
  if (t.includes('sez')) return 'sez';
  if (t.includes('uin') || t.includes('embass') || t.includes('united nation')) return 'uin';
  return 'registered';
}

/**
 * Fills a customer or vendor in from its GSTIN, by itself as soon as the 15th
 * character is typed (and again from the button): the state, PAN and kind of
 * business at once from the number, then the registered name, address, status
 * and registration date from the GST system or a lookup service.
 */
export function GstinLookupButton({ gstin, onFound, className, auto = true, endpoint = '/api/gst/portal/gstin', compact = false }: {
  gstin: string; onFound: (d: GstinDetails) => void; className?: string;
  /** Look up on its own when a whole GSTIN has been typed. */
  auto?: boolean;
  /** The public sign-up page asks a rate-limited endpoint of its own. */
  endpoint?: string;
  /** Just the icon, where the GSTIN box is narrow and needs the room. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const g = gstin.trim().toUpperCase();
  const shaped = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g);
  // A typo is caught here, from the check digit, before anyone is asked.
  const typo = shaped && !isValidGstin(g);
  const ready = shaped && !typo;
  const found = useRef(onFound);
  found.current = onFound;
  const look = async (number: string) => {
    setBusy(true);
    try {
      const d = await api.get<GstinDetails>(endpoint, { gstin: number });
      setDone(number);
      if (d.status && !/active/i.test(d.status)) toast.warning(`This registration is ${d.status}`, { description: d.cancelledOn ? `Cancelled on ${d.cancelledOn}.` : 'Check before invoicing it as registered.' });
      // A number-only answer is said under the box by GstinNumberOnlyNote, every time.
      if (d.fromPortal) {
        toast.success(`Found ${d.legalName ?? d.gstin}`, { description: [d.taxpayerType, d.status, d.registeredOn ? `registered ${d.registeredOn}` : null].filter(Boolean).join(' · ') });
      }
      found.current(d);
    } catch (e) {
      setDone(number);
      toast.error(err(e, 'Could not look the GSTIN up'));
    } finally {
      setBusy(false);
    }
  };
  // The moment a whole GSTIN is there, once per number.
  useEffect(() => {
    if (typo && auto && g !== done) {
      setDone(g);
      toast.error('That GSTIN’s last character does not match the rest', { description: 'Check it for a typo.' });
      return;
    }
    if (!auto || !ready || g === done) return;
    const t = setTimeout(() => void look(g), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, ready, typo, auto]);
  const label = done === g && ready ? 'Fetch again' : 'Fetch details';
  return (
    <Button type="button" size="sm" variant="outline" className={cn('h-9 shrink-0 gap-1.5', compact && 'w-9 px-0', className)} disabled={!ready || busy} onClick={() => void look(g)}
      title={typo ? 'The GSTIN’s last character does not match the rest: check it for a typo' : 'Fill the name, address, PAN and registration date from the GSTIN'} data-slot="gstin-fetch"
      aria-label={compact ? label : undefined}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />} {!compact && label}
    </Button>
  );
}

/**
 * The same for a company's CIN: the year of incorporation at once from the
 * number, and the exact date and name from the MCA record when a company
 * lookup service is set up.
 */
export function CinLookupButton({ cin, onFound, className, auto = true }: {
  cin: string; onFound: (d: CompanyDetails) => void; className?: string;
  /** Look a complete CIN up as soon as it is typed. Off for the number already saved; the button still asks. */
  auto?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const c = cin.trim().toUpperCase();
  const ready = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(c);
  const found = useRef(onFound);
  found.current = onFound;
  const look = async (number: string) => {
    setBusy(true);
    try {
      const d = await api.get<CompanyDetails>('/api/company-lookup', { cin: number });
      setDone(number);
      if (d.incorporatedOn) toast.success(`Incorporated on ${d.incorporatedOn}`, { description: [d.name, d.kind, d.status].filter(Boolean).join(' · ') });
      else toast.info(`Incorporated in ${d.incorporatedYear}, from the CIN`, { description: 'The exact date comes from the MCA record: set up a company lookup service, or type it from the certificate of incorporation.' });
      found.current(d);
    } catch (e) {
      setDone(number);
      toast.error(err(e, 'Could not look the CIN up'));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!auto || !ready || c === done) return;
    const t = setTimeout(() => void look(c), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, ready, auto]);
  return (
    <Button type="button" size="sm" variant="outline" className={cn('h-9 shrink-0 gap-1.5', className)} disabled={!ready || busy} onClick={() => void look(c)}
      title="Fill the incorporation date from the CIN" data-slot="cin-fetch">
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />} Fetch
    </Button>
  );
}

/** GSTR-2B straight from the portal into the reconciliation, for the connected GSTIN. */
export function FetchGstr2bButton({ period, onDone }: { period: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const fetch2b = async () => {
    setBusy(true);
    try {
      const p = await api.get<PortalResponse>('/api/gst/portal');
      const c = p.connections.find((x) => x.connected) ?? null;
      if (!c) {
        toast.error('No GSTIN is signed in to the GST portal', { description: 'Connect it on GSTR-1 or GSTR-3B, or under Settings → Integrations, then fetch again.' });
        return;
      }
      const r = await api.post<{ inserted: number; updated: number }>('/api/gst/portal', { action: 'fetch-2b', branchId: c.branchId, period });
      toast.success(`GSTR-2B for ${period} fetched from the GST portal`, { description: `${r.inserted} new and ${r.updated} updated supplier lines.` });
      onDone();
    } catch (e) {
      toast.error(err(e, 'GSTR-2B was not fetched'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => void fetch2b()}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CloudUpload className="size-3.5 rotate-180" />} Fetch from GSTN
    </Button>
  );
}
