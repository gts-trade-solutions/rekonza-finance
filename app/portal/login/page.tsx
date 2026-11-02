'use client';

// Signing in to the customer or vendor portal (services/portal-login.ts), as
// Zoho Books' portal does it: the email address the business has for you, a
// six-digit code by email, and you are in. More than one account on the
// address — a customer of two businesses, or both a customer and a supplier —
// and you choose which to open.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, KeyRound, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api/client';

interface PortalChoice { orgName: string; contactName: string; side: 'customer' | 'vendor'; path: string }

export default function PortalLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code' | 'choose'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [portals, setPortals] = useState<PortalChoice[]>([]);

  const request = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>('/api/portal/login', { action: 'request', email });
      setMessage(r.message);
      setStep('code');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ portals: PortalChoice[] }>('/api/portal/login', { action: 'verify', email, code });
      if (!r.portals.length) { toast.error('There is no portal on that address any more. Ask the business to turn it on again.'); return; }
      if (r.portals.length === 1) { router.push(r.portals[0].path); return; }
      setPortals(r.portals);
      setStep('choose');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <Card className="w-full max-w-sm space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Your account portal</h1>
          <p className="text-sm text-muted-foreground">See your invoices, quotes, orders, payments and statement with a business that uses Rekonza.</p>
        </div>

        {step === 'email' && (
          <form onSubmit={request} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="portal-email">Email address</Label>
              <Input id="portal-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="The address the business has for you" />
            </div>
            <Button type="submit" className="w-full gap-1.5" disabled={busy || !email.trim()}><Mail className="size-4" /> {busy ? 'Sending…' : 'Send me a code'}</Button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={verify} className="space-y-3">
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs">{message}</p>
            <div className="space-y-1">
              <Label htmlFor="portal-code">Code from the email to {email}</Label>
              <Input id="portal-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="six digits" className="tracking-[0.3em]" />
            </div>
            <Button type="submit" className="w-full gap-1.5" disabled={busy || code.length !== 6}><KeyRound className="size-4" /> {busy ? 'Checking…' : 'Sign in'}</Button>
            <div className="flex justify-between text-xs">
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { setStep('email'); setCode(''); }}>Use another address</button>
              <button type="button" className="text-primary hover:underline" disabled={busy} onClick={() => request()}>Send a new code</button>
            </div>
          </form>
        )}

        {step === 'choose' && (
          <div className="space-y-2">
            <p className="text-sm">Which account do you want to open?</p>
            {portals.map((x) => (
              <button key={x.path} onClick={() => router.push(x.path)} className="flex w-full items-center gap-3 rounded-md border p-3 text-left text-sm hover:bg-muted/50">
                <Building2 className="size-4 text-muted-foreground" />
                <span className="flex-1">
                  <span className="block font-medium">{x.orgName}</span>
                  <span className="block text-xs text-muted-foreground">{x.contactName} · as {x.side === 'customer' ? 'a customer' : 'a supplier'}</span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground">No code arriving? Open the portal from the link in your last email from the business, or ask them to check the address they have for you.</p>
      </Card>
    </main>
  );
}
