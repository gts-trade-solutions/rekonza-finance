'use client';

// Comments and history on a record: the notes people leave each other, and
// what the audit trail says changed — by whom, when, and why when a reason
// was given. One timeline, newest first.

import { useMemo, useState } from 'react';
import { MessageSquare, History } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { comments, type CommentTarget } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';

const when = (at: string) => new Date(at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ActivityPanel({ targetType, targetId }: { targetType: CommentTarget; targetId: string }) {
  const state = useApi(() => comments.list(targetType, targetId), [targetType, targetId]);
  const add = useApiAction(comments.add);
  const [text, setText] = useState('');
  const timeline = useMemo(() => {
    const d = state.data;
    if (!d) return [];
    return [
      ...d.comments.map((c) => ({ kind: 'comment' as const, id: `c${c.id}`, at: c.at, who: c.author, text: c.body, reason: null as string | null })),
      ...d.history.filter((h) => h.action !== 'comment').map((h) => ({ kind: 'history' as const, id: `h${h.id}`, at: h.at, who: h.actor ?? 'System', text: h.detail ?? h.action, reason: h.reason })),
    ].sort((a, b) => b.at.localeCompare(a.at));
  }, [state.data]);

  const post = async () => {
    if (!text.trim()) return;
    if (!(await add.run(targetType, targetId, text.trim()))) { toast.error(add.error ?? 'Not posted'); return; }
    setText('');
    state.refetch();
  };

  return (
    <div className="space-y-4" data-slot="activity">
      <Card className="space-y-2 p-4">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Leave a note for the team — it is kept with this record and cannot be edited later." rows={2} />
        <div className="flex justify-end">
          <Button size="sm" onClick={post} disabled={add.busy || !text.trim()}>{add.busy ? 'Posting…' : 'Comment'}</Button>
        </div>
      </Card>
      <ol className="space-y-3">
        {timeline.map((e) => (
          <li key={e.id} className="flex gap-3 text-sm">
            <span className="mt-0.5 text-muted-foreground">{e.kind === 'comment' ? <MessageSquare className="size-4" /> : <History className="size-4" />}</span>
            <div className="min-w-0">
              <p className={e.kind === 'comment' ? '' : 'text-muted-foreground'}>{e.text}</p>
              {e.reason && <p className="text-xs">Why: {e.reason}</p>}
              <p className="text-xs text-muted-foreground">{e.who} · {when(e.at)}</p>
            </div>
          </li>
        ))}
        {state.data && !timeline.length && <p className="text-sm text-muted-foreground">Nothing yet.</p>}
      </ol>
    </div>
  );
}
