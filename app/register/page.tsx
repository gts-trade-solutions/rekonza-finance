'use client';

// Create an organisation.
//
// Six fields, one of them optional. Everything else a set of books needs — the
// chart of accounts, the numbering series, a cash account — is installed by the
// server; asking someone to configure it before they have raised their first
// invoice is how onboarding forms end up eleven screens long and abandoned.
//
// The one thing worth getting right at this stage is the GST registration,
// because it decides CGST+SGST versus IGST on every invoice this business ever
// raises. So the state is required and the GSTIN, if given, is checked against
// its own check digit and against the state — a typo caught here is a typo that
// never has to be found in a return.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle, ArrowLeft, BadgeCheck, Check, Eye, EyeOff, Loader2, UserPlus, X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { auth, ApiError } from '@/lib/api/client';
import { BRAND, Logo } from '@/components/brand/logo';
import { GST_STATES, isValidGstin } from '@/lib/tax/gst';
import { cn } from '@/lib/utils';

const STATE_OPTIONS = Object.entries(GST_STATES)
  .filter(([code]) => code !== '96')
  .map(([code, name]) => ({ value: code, label: name, sublabel: `State code ${code}` }));

/** The same four checks the server applies, shown as you type. */
function passwordChecks(v: string) {
  return [
    { label: 'At least 8 characters', ok: v.length >= 8 },
    { label: 'A lower-case letter', ok: /[a-z]/.test(v) },
    { label: 'An upper-case letter', ok: /[A-Z]/.test(v) },
    { label: 'A digit', ok: /[0-9]/.test(v) },
  ];
}

export default function RegisterPage() {
  const [businessName, setBusinessName] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [gstin, setGstin] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checks = passwordChecks(password);
  const passwordOk = checks.every((c) => c.ok);

  // Live GSTIN feedback, because the state code is the first two characters and
  // a mismatch is worth catching before the form is submitted.
  const gstinNote = useMemo(() => {
    const g = gstin.trim().toUpperCase();
    if (!g) return null;
    if (g.length < 15) return { ok: false, text: 'A GSTIN is 15 characters.' };
    if (!isValidGstin(g)) return { ok: false, text: 'That GSTIN fails its check digit.' };
    if (stateCode && g.slice(0, 2) !== stateCode) {
      return {
        ok: false,
        text: `This GSTIN is registered in ${GST_STATES[g.slice(0, 2)] ?? 'another state'}.`,
      };
    }
    return { ok: true, text: `Valid — PAN ${g.slice(2, 12)}, ${GST_STATES[g.slice(0, 2)]}` };
  }, [gstin, stateCode]);

  const canSubmit =
    businessName.trim().length >= 2 &&
    stateCode !== '' &&
    name.trim().length >= 2 &&
    email.includes('@') &&
    passwordOk &&
    (!gstin.trim() || gstinNote?.ok === true);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.register({
        businessName: businessName.trim(),
        stateCode,
        gstin: gstin.trim().toUpperCase() || undefined,
        name: name.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim() || undefined,
        password,
      });
      // Full navigation, so every provider re-reads the session the server just
      // set rather than starting from a stale anonymous one.
      window.location.href = '/dashboard';
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not create the account. Please try again.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4 py-10">
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

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start">
          <Card className="p-6">
            <h2 className="text-lg font-semibold">Create an account</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              You will be signed in as the administrator of a new, empty set of books.
            </p>

            <form onSubmit={submit} className="mt-5 space-y-5">
              {/* ── The business ─────────────────────────────────────────── */}
              <div className="space-y-4">
                <p className="micro-label">Your business</p>

                <div className="space-y-1.5">
                  <Label htmlFor="businessName">Business name</Label>
                  <Input
                    id="businessName"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    placeholder="Your registered business name"
                    autoComplete="organization"
                    required
                    disabled={busy}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="stateCode">State of registration</Label>
                    <Combobox
                      options={STATE_OPTIONS}
                      value={stateCode}
                      onChange={setStateCode}
                      placeholder="Select a state"
                      searchPlaceholder="Search states"
                      showAvatar={false}
                    />
                    <p className="text-xs text-muted-foreground">
                      Decides whether a sale is CGST+SGST or IGST.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="gstin">
                      GSTIN <span className="font-normal text-muted-foreground">— optional</span>
                    </Label>
                    <Input
                      id="gstin"
                      value={gstin}
                      onChange={(e) => setGstin(e.target.value.toUpperCase().slice(0, 15))}
                      placeholder="22AAAAA0000A1Z5"
                      className="font-mono uppercase"
                      disabled={busy}
                    />
                    {gstinNote ? (
                      <p
                        className={cn(
                          'flex items-start gap-1.5 text-xs',
                          gstinNote.ok ? 'text-success' : 'text-destructive',
                        )}
                      >
                        {gstinNote.ok ? (
                          <BadgeCheck className="mt-px size-3.5 shrink-0" />
                        ) : (
                          <AlertCircle className="mt-px size-3.5 shrink-0" />
                        )}
                        {gstinNote.text}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Leave blank if you are not registered yet.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* ── You ──────────────────────────────────────────────────── */}
              <div className="space-y-4 border-t pt-5">
                <p className="micro-label">You</p>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="name">Your name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your full name"
                      autoComplete="name"
                      required
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="phone">
                      Phone <span className="font-normal text-muted-foreground">— optional</span>
                    </Label>
                    <Input
                      id="phone"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+91 00000 00000"
                      autoComplete="tel"
                      disabled={busy}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="username"
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
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
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
                  <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                    {checks.map((c) => (
                      <li
                        key={c.label}
                        className={cn(
                          'flex items-center gap-1.5 text-xs',
                          c.ok ? 'text-success' : 'text-muted-foreground',
                        )}
                      >
                        {c.ok ? <Check className="size-3.5" /> : <X className="size-3.5 opacity-50" />}
                        {c.label}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  data-slot="register-error"
                  className="flex items-start gap-2 rounded-[3px] border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" className="w-full gap-2" disabled={busy || !canSubmit}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                {busy ? 'Creating your books…' : 'Create my books'}
              </Button>
            </form>

            <p className="mt-5 border-t pt-4 text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link href="/login" className="font-medium text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </Card>

          <Card className="p-6">
            <h2 className="text-lg font-semibold">What you get on day one</h2>
            <ul className="mt-4 space-y-3.5 text-sm">
              {[
                {
                  t: 'A standard chart of accounts',
                  d: 'Assets, liabilities, equity, income and expenses, with the GST control accounts already in place.',
                },
                {
                  t: 'Numbering that starts at one',
                  d: 'Per registration and per financial year, in the format the GST rules expect.',
                },
                {
                  t: 'A cash account',
                  d: 'So the first receipt can be recorded before any bank is connected.',
                },
                {
                  t: 'An empty ledger',
                  d: 'No sample invoices, no demo customers. Your opening balances go in, and nothing else.',
                },
              ].map((f) => (
                <li key={f.t} className="flex gap-2.5">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div>
                    <p className="font-medium">{f.t}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{f.d}</p>
                  </div>
                </li>
              ))}
            </ul>

            <p className="mt-6 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
              Want to look around first? The{' '}
              <Link href="/login?demo=1" className="font-medium text-primary hover:underline">
                demo book
              </Link>{' '}
              is a fully worked example you can open without signing up.
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
