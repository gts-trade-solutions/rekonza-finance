// ─────────────────────────────────────────────────────────────────────────────
// Entries made without a connection, kept on this device until they can be sent.
//
// Each carries a key of its own, sent with it as Idempotency-Key: the server
// keeps the key with its reply, so an entry that reached it once — and whose
// reply was lost on the way back — is not made twice when it is sent again.
// Entries go in the order they were made. One the server refuses stays here,
// with the reason, until someone fixes it in the app and discards this copy.
// ─────────────────────────────────────────────────────────────────────────────

export interface OutboxItem {
  key: string;
  /** Who made it: sent only under their own sign-in, never someone else's on the same device. */
  owner: string;
  method: 'POST';
  path: string;
  body: unknown;
  label: string;
  createdAt: string;
  status: 'waiting' | 'failed';
  error?: string;
}

/** What may be made offline: the everyday entries, each a POST that creates one record. */
export const OFFLINE_PATHS: Record<string, string> = {
  '/api/invoices': 'Invoice',
  '/api/bills': 'Bill',
  '/api/expenses': 'Expense',
  '/api/payments': 'Payment',
  '/api/journal': 'Journal entry',
  '/api/payroll/claims': 'Expense claim',
};

const DB = 'rekonza-offline';
const STORE = 'outbox';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(r ? r.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

const changed = () => window.dispatchEvent(new Event('rekonza-outbox'));

let owner: string | null = null;
/** Set by the signed-in shell: whose entries these are. */
export function setOutboxOwner(who: string | null) {
  owner = who;
}

export async function enqueue(path: string, body: unknown): Promise<OutboxItem> {
  if (!owner) throw new Error('Not signed in on this device.');
  const item: OutboxItem = {
    key: crypto.randomUUID(), owner, method: 'POST', path, body, label: OFFLINE_PATHS[path] ?? 'Entry',
    createdAt: new Date().toISOString(), status: 'waiting',
  };
  await tx('readwrite', (s) => s.put(item));
  changed();
  return item;
}

export async function listOutbox(): Promise<OutboxItem[]> {
  if (typeof indexedDB === 'undefined') return [];
  const all = (await tx<OutboxItem[]>('readonly', (s) => s.getAll() as IDBRequest<OutboxItem[]>)) ?? [];
  return all.filter((i) => i.owner === owner).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function removeItem(key: string) {
  await tx('readwrite', (s) => s.delete(key));
  changed();
}

export async function markFailed(key: string, error: string) {
  const all = await listOutbox();
  const item = all.find((i) => i.key === key);
  if (!item) return;
  await tx('readwrite', (s) => s.put({ ...item, status: 'failed', error }));
  changed();
}

/**
 * Send what is waiting, oldest first. Stops at the first that cannot reach the
 * server (still offline); one the server refuses is set aside with its reason.
 */
export async function flushOutbox(): Promise<{ sent: OutboxItem[]; failed: OutboxItem[] }> {
  const sent: OutboxItem[] = [];
  const failed: OutboxItem[] = [];
  for (const item of await listOutbox()) {
    if (item.status !== 'waiting') continue;
    let res: Response;
    try {
      res = await fetch(item.path, {
        method: item.method, credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': item.key },
        body: JSON.stringify(item.body),
      });
    } catch {
      break;
    }
    if (res.ok) {
      await removeItem(item.key);
      sent.push(item);
    } else if (res.status === 401 || res.status >= 500) {
      // Signed out, or the server is struggling: try again later, as it is.
      break;
    } else {
      const text = await res.text().catch(() => '');
      let message = `Refused (${res.status})`;
      try { message = (JSON.parse(text) as { error?: string }).error ?? message; } catch { /* plain text */ }
      await markFailed(item.key, message);
      failed.push({ ...item, status: 'failed', error: message });
    }
  }
  return { sent, failed };
}
