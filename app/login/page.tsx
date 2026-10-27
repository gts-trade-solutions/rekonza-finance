'use client';

// Sign-in. Real credentials against the API — the role picker this replaced was
// a demo affordance, and leaving it in a build that has a database behind it
// would be an unauthenticated door into the books.
//
// The demo book has its own door, at /api/auth/demo, which can only ever open
// onto an organisation flagged is_demo. That is a different thing from a
// password shortcut: no credential is shipped to the browser, and no real
// customer's ledger is reachable through it however the request is shaped.

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, ArrowLeft, ArrowRight, Eye, EyeOff, KeyRound, Loader2, LogIn, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { auth, ApiError } from '@/lib/api/client';
import { BRAND, Logo } from '@/components/brand/logo';

/** The four seeded roles. Each one sees a materially different app. */
const DEMO_ROLES = [
  { role: 'admin' as const, label: 'Admin', blurb: 'Everything, including settings and period locks' },
  { role: 'accountant' as const, label: 'Accountant', blurb: 'Books, banking, GST and journals' },
  { role: 'sales' as const, label: 'Sales', blurb: 'Quotes and invoices; costs stay hidden' },
  { role: 'viewer' as const, label: 'Viewer', blurb: 'Read-only, for auditors' },
];

function LoginInner() {
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState<string | null>(null);
  // Two-step sign-in: the password was right; now the code from the app.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);

  // The landing page links here with ?demo=1, which opens the panel already
  // expanded rather than making a curious visitor hunt for it.
  const [showDemo, setShowDemo] = useState(params.get('demo') === '1');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await auth.login(email.trim(), password);
      if ('mfaRequired' in r) {
        setChallenge(r.challenge);
        setBusy(false);
        return;
      }
      // A full navigation rather than a client push, so every provider
      // re-reads the session that was just established.
      window.location.href = '/dashboard';
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not sign in. Please try again.',
      );
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      const r = await auth.verifyMfa(challenge, code.trim());
      if (r.usedRecoveryCode) window.alert(`Signed in with a recovery code. ${r.recoveryLeft} left — make new ones in Settings → Sign-ins if that is running low.`);
      window.location.href = '/dashboard';
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not sign in. Please try again.';
      setError(message);
      // Expired, or too many wrong codes: back to the password.
      if (err instanceof ApiError && err.status === 403) { setChallenge(null); setCode(''); setPassword(''); }
      setBusy(false);
    }
  };

  const openDemo = async (role: (typeof DEMO_ROLES)[number]['role']) => {
    setError(null);
    setDemoBusy(role);
    try {
      await auth.demo(role);
      window.location.href = '/dashboard';
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The demo book could not be opened.',
      );
      setDemoBusy(null);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-4xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <Link href="/" className="mb-4" aria-label={`${BRAND.display} home`}>
            <Logo width={200} priority />
          </Link>
          <p className="max-w-lg text-sm text-muted-foreground">
            {BRAND.tagline} Double-entry accounting, GST compliance and banking for Indian
            business.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="p-6">
            <h2 className="text-lg font-semibold">Sign in</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Use the email and password your administrator set up.
            </p>

            {challenge ? (
            <form onSubmit={submitCode} className="mt-5 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="code">{recovery ? 'Recovery code' : 'Code from your authenticator app'}</Label>
                <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required disabled={busy}
                  inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" placeholder={recovery ? 'xxxxx-xxxxx' : '123456'}
                  className="font-mono tracking-widest" />
              </div>
              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-[3px] border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <Button type="submit" className="w-full gap-2" disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                {busy ? 'Checking…' : 'Sign in'}
              </Button>
              <div className="flex justify-between text-xs">
                <button type="button" className="text-primary hover:underline" onClick={() => { setRecovery((v) => !v); setCode(''); }}>
                  {recovery ? 'Use the app instead' : 'Lost your phone? Use a recovery code'}
                </button>
                <button type="button" className="text-muted-foreground hover:underline" onClick={() => { setChallenge(null); setCode(''); setError(null); }}>
                  Back
                </button>
              </div>
            </form>
            ) : (
            <form onSubmit={submit} className="mt-5 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  disabled={busy}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={busy}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  data-slot="login-error"
                  className="flex items-start gap-2 rounded-[3px] border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" className="w-full gap-2" disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
            )}

            <p className="mt-5 border-t pt-4 text-sm text-muted-foreground">
              No account yet?{' '}
              <Link href="/register" className="font-medium text-primary hover:underline">
                Create your books
              </Link>
            </p>

            <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              Sessions are held on the server, so signing out ends access immediately on every
              device. Repeated failed attempts lock the account for fifteen minutes.
            </p>
          </Card>

          <Card className="p-6">
            <h2 className="text-lg font-semibold">Try the demo book</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A worked set of books for a fictional auto-parts business — five months of
              invoices, bills, payments and bank lines, with a trial balance that ties.
            </p>

            {showDemo ? (
              <>
                <p className="micro-label mt-5">Sign in as</p>
                <div className="mt-2 space-y-2">
                  {DEMO_ROLES.map((r) => (
                    <button
                      key={r.role}
                      type="button"
                      data-slot="demo-account"
                      data-role={r.role}
                      disabled={demoBusy !== null}
                      onClick={() => void openDemo(r.role)}
                      className="flex w-full items-center gap-3 rounded-[3px] border p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/50 disabled:opacity-60"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{r.label}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{r.blurb}</p>
                      </div>
                      {demoBusy === r.role ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <Button
                variant="outline"
                className="mt-5 w-full gap-1.5"
                onClick={() => setShowDemo(true)}
              >
                Open the demo book <ArrowRight className="size-3.5" />
              </Button>
            )}

            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              The demo is shared by everyone who opens it and is reset periodically. Nothing in
              it is filed with any government portal. Your own books, when you create them, are
              private and start empty.
            </p>

            <Link
              href="/"
              className="mt-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> Back to {BRAND.short}
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary, or the whole route opts out of
  // static rendering and the sign-in page waits on the server for no reason.
  return (
    <Suspense fallback={<div className="min-h-screen bg-muted/40" />}>
      <LoginInner />
    </Suspense>
  );
}
