'use client';

// The bell: notifications for the person signed in — a scheduled report ready,
// mostly — with how many are unread. Looked at again every minute.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

interface Notice { id: string; kind: string; title: string; body: string | null; href: string | null; read: boolean; at: string }

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString('en-IN');
};

export function NotificationsBell() {
  const router = useRouter();
  const state = useApi(() => api.get<{ unread: number; items: Notice[] }>('/api/notifications'), []);
  const { refetch } = state;
  useEffect(() => {
    const t = setInterval(() => void refetch(), 60_000);
    return () => clearInterval(t);
  }, [refetch]);
  const unread = state.data?.unread ?? 0;
  const items = state.data?.items ?? [];

  const open = async (n: Notice) => {
    if (!n.read) await api.post('/api/notifications', { ids: [n.id] }).catch(() => null);
    void refetch();
    if (n.href) router.push(n.href);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[9px] font-semibold leading-4 text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <button type="button" className="text-xs text-primary hover:underline"
              onClick={() => void api.post('/api/notifications', { ids: 'all' }).then(() => refetch())}>
              Mark all read
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto thin-scroll">
            {items.map((n) => (
              <DropdownMenuItem key={n.id} onClick={() => void open(n)} className={cn('flex flex-col items-start gap-0.5 rounded-none border-b px-3 py-2 last:border-0', !n.read && 'bg-primary/5')}>
                <span className={cn('text-sm', !n.read && 'font-medium')}>{n.title}</span>
                {n.body && <span className="text-xs text-muted-foreground">{n.body}</span>}
                <span className="text-[10px] text-muted-foreground">{ago(n.at)}</span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
