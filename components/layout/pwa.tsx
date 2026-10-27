'use client';

// The installable, read-when-offline app: registers the service worker (in a
// production build — in development it would cache pages being changed), and
// says plainly when there is no connection: what was last seen can be read,
// and the everyday entries are kept on the device and sent later (offline-sync.tsx).

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline reading is a bonus, never a blocker */ });
  }, []);
  return null;
}

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  if (!offline) return null;
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-xs font-medium text-amber-950">
      <WifiOff className="size-3.5" />
      Offline: showing what was last seen on this device. New invoices, bills, expenses, payments and journals are kept here and sent when the connection is back; anything else waits for it.
    </div>
  );
}

