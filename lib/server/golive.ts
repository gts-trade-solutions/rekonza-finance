import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The go-live check: is this server set up to keep real books? Everything a
// production deployment needs, tested where it can be (the database answers,
// every migration is in, the encryption key opens what it sealed) and named
// where only a person can do it (the database host's backups). Each item says
// what is wrong and what to do; no secret is ever shown, only whether it is set.
//
// Shown to admins under Settings → System health, and run before a deployment
// with `npm run golive` against the production settings.
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'kysely';
import { db, ping } from './db';
import { mailStatus } from './mail/mailer';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'manual';
export interface GoLiveCheck { id: string; group: 'required' | 'connections' | 'data'; label: string; status: CheckStatus; detail: string; fix?: string }

const set = (name: string) => !!process.env[name]?.trim();

function keyValid(): boolean {
  const raw = process.env.FIELD_ENCRYPTION_KEY?.trim();
  if (!raw) return false;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32;
}

function migrationFiles(): string[] | null {
  try {
    return readdirSync(path.join(process.cwd(), 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return null;
  }
}

/** Every check, in the order to fix them. */
export async function goLiveChecks(): Promise<GoLiveCheck[]> {
  const out: GoLiveCheck[] = [];
  const add = (c: GoLiveCheck) => out.push(c);
  const production = process.env.APP_ENV === 'production';
  const onVercel = !!process.env.VERCEL;

  // ── Required ────────────────────────────────────────────────────────────
  add({
    id: 'app-env', group: 'required', label: 'Marked as production', status: production ? 'ok' : 'fail',
    detail: production ? 'APP_ENV is production.' : `APP_ENV is ${process.env.APP_ENV || 'not set'}.`,
    fix: 'Set APP_ENV=production. It stops anything that wipes data (the demo seed) from running against these books.',
  });
  const demoMode = process.env.DEMO_SNAPSHOT === '1';
  add({
    id: 'demo-mode', group: 'required', label: 'Demo playback off', status: demoMode ? 'fail' : 'ok',
    detail: demoMode ? 'DEMO_SNAPSHOT=1: every screen plays the recording and nothing is saved.' : 'Screens read the real database.',
    fix: 'Remove DEMO_SNAPSHOT, or set it to 0.',
  });

  const database = await ping();
  const url = process.env.DATABASE_URL ? (() => { try { return new URL(process.env.DATABASE_URL!); } catch { return null; } })() : null;
  const host = url?.hostname || process.env.DB_HOST || 'localhost';
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(host);
  const tls = process.env.DB_SSL === 'true' || (!!url && (/ssl/i.test(url.search) || /tidbcloud\.com$/i.test(url.hostname)));
  add({
    id: 'database', group: 'required', label: 'Database', status: database.ok ? (local || tls ? 'ok' : 'fail') : 'fail',
    detail: !database.ok ? 'The database does not answer.' : local ? 'Answers, on this machine.' : tls ? `Answers over TLS (${host}).` : `Answers, but without TLS (${host}).`,
    fix: !database.ok
      ? 'Set DATABASE_URL (mysql://user:password@host:port/name) to a MySQL 8 in Mumbai, and check the host lets this server in.'
      : 'Set DB_SSL=true (and DB_SSL_CA if the provider gives a certificate): books must not cross the internet unencrypted.',
  });

  if (database.ok) {
    const files = migrationFiles();
    const { rows } = await sql<{ filename: string }>`SELECT filename FROM schema_migrations`.execute(db).catch(() => ({ rows: [] as { filename: string }[] }));
    const applied = new Set(rows.map((r) => r.filename));
    const missing = files ? files.filter((f) => !applied.has(f)) : [];
    add({
      id: 'migrations', group: 'required', label: 'Database tables up to date',
      status: !files ? (applied.size ? 'ok' : 'fail') : missing.length ? 'fail' : 'ok',
      detail: !files ? `${applied.size} changes applied.` : missing.length ? `${missing.length} of ${files.length} not applied, from ${missing[0]}.` : `All ${files.length} applied.`,
      fix: 'From a machine with the production settings: node --env-file=.env.production.local scripts/migrate.mjs',
    });
  }

  const keyOk = keyValid();
  add({
    id: 'encryption-key', group: 'required', label: 'Encryption key for bank details and saved logins', status: keyOk ? 'ok' : 'fail',
    detail: keyOk ? 'FIELD_ENCRYPTION_KEY is set and is 32 bytes.' : set('FIELD_ENCRYPTION_KEY') ? 'FIELD_ENCRYPTION_KEY is set but is not 32 bytes.' : 'FIELD_ENCRYPTION_KEY is not set.',
    fix: 'Make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))", set it, and keep a copy somewhere safe — without it sealed details cannot be read again.',
  });
  if (database.ok && keyOk) {
    // Bank account numbers typed before the key existed sit in plain text until sealed.
    const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM contacts WHERE bank_account_no IS NOT NULL AND bank_account_no <> '' AND bank_account_no NOT LIKE 'enc:v1:%'`.execute(db).catch(() => ({ rows: [{ n: 0 }] }));
    const plain = Number(rows[0]?.n ?? 0);
    add({
      id: 'sealed', group: 'required', label: 'Bank details sealed', status: plain ? 'warn' : 'ok',
      detail: plain ? `${plain} contact bank account number${plain === 1 ? ' is' : 's are'} stored in plain text.` : 'Every stored bank account number is sealed.',
      fix: 'Run npm run fields:seal once against the production database.',
    });
  }

  const cron = process.env.CRON_SECRET?.trim() ?? '';
  add({
    id: 'cron', group: 'required', label: 'Background work (reminders, retries, rates)', status: cron.length >= 32 ? 'ok' : 'fail',
    detail: cron ? (cron.length >= 32 ? 'CRON_SECRET is set.' : 'CRON_SECRET is shorter than 32 characters.') : 'CRON_SECRET is not set, so the daily sweep is refused.',
    fix: 'Set CRON_SECRET to a long random string (32+ characters); Vercel sends it with each scheduled call.',
  });

  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? '';
  add({
    id: 'site-url', group: 'required', label: 'Site address', status: /^https:\/\//.test(site) ? 'ok' : 'fail',
    detail: site ? (/^https:\/\//.test(site) ? site : `${site} is not https.`) : 'NEXT_PUBLIC_SITE_URL is not set.',
    fix: 'Set NEXT_PUBLIC_SITE_URL to the https address customers will open (links in emails and the portal use it).',
  });

  const blob = set('BLOB_READ_WRITE_TOKEN');
  add({
    id: 'files', group: 'required', label: 'File storage for attachments',
    status: blob ? 'ok' : onVercel ? 'fail' : 'warn',
    detail: blob ? 'Vercel Blob store connected.' : onVercel ? 'No Blob store: uploads would vanish with each deployment.' : `Files kept on this server's disk (${process.env.FILE_STORAGE_DIR || 'storage/files'}).`,
    fix: onVercel ? 'Create a private Blob store in Mumbai under the Vercel project’s Storage tab; Vercel adds BLOB_READ_WRITE_TOKEN.' : 'Make sure that folder is on a disk that is backed up.',
  });

  add({
    id: 'backups', group: 'required', label: 'Database backups', status: 'manual',
    detail: 'Backups are the database host’s; this server cannot see them.',
    fix: 'Turn on daily backups and point-in-time recovery at the database host, and restore one once to see it works.',
  });

  // ── Connections ─────────────────────────────────────────────────────────
  const mail = mailStatus();
  add({
    id: 'email', group: 'connections', label: 'Email', status: mail.configured ? 'ok' : 'warn',
    detail: mail.configured ? `Sends through ${mail.host} as ${mail.from}.` : 'No mail server: documents cannot be emailed, and customers cannot sign in to the portal by code.',
    fix: 'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and MAIL_FROM (any business mail account, Google Workspace, Zoho Mail, SES …).',
  });
  const gsp = set('GST_API_BASE_URL') && set('GST_API_CLIENT_ID') && set('GST_API_CLIENT_SECRET');
  add({
    id: 'gst', group: 'connections', label: 'GST returns (GSP)', status: gsp ? 'ok' : 'warn',
    detail: gsp ? `Connected (${process.env.GST_API_ENV || 'sandbox'}).` : 'No GSP: returns are prepared and downloaded, but pushing and filing go to a stand-in that files nothing.',
    fix: 'Contract a GST Suvidha Provider and set the GST_API_* settings from them.',
  });
  const nic = set('NIC_EINV_CLIENT_ID') && set('NIC_EINV_CLIENT_SECRET');
  add({
    id: 'einvoice', group: 'connections', label: 'E-invoicing (IRN)', status: nic ? 'ok' : 'warn',
    detail: nic ? 'Registered with the NIC e-invoice system.' : 'No NIC credentials: IRNs come from a stand-in and are not valid on real invoices.',
    fix: 'Register for API access on the NIC e-invoice portal (or through the GSP) and set the NIC_EINV_* settings. Needed only above the e-invoicing turnover limit.',
  });
  add({
    id: 'ai', group: 'connections', label: 'AI assistant', status: set('OPENAI_API_KEY') ? 'ok' : 'warn',
    detail: set('OPENAI_API_KEY') ? 'OpenAI answers.' : 'No OpenAI key: a built-in stand-in answers the common questions.',
    fix: 'Set OPENAI_API_KEY from an OpenAI account.',
  });

  // ── Data ────────────────────────────────────────────────────────────────
  if (database.ok) {
    const orgs = await db.selectFrom('organizations').select(['id', 'name', 'is_demo']).execute().catch(() => []);
    const real = orgs.filter((o) => !o.is_demo);
    const demo = orgs.filter((o) => o.is_demo);
    add({
      id: 'company', group: 'data', label: 'The client’s company', status: real.length ? 'ok' : 'warn',
      detail: real.length ? `${real.length} compan${real.length === 1 ? 'y' : 'ies'}: ${real.slice(0, 3).map((o) => o.name).join(', ')}${real.length > 3 ? ' …' : ''}.` : 'Only the demo book is here.',
      fix: 'Register the company at /register, then bring in its masters and opening balances (Settings → Import).',
    });
    add({
      id: 'demo-book', group: 'data', label: 'No demo book in production', status: demo.length && production ? 'warn' : 'ok',
      detail: demo.length ? 'The demo book is here, and the sign-in page’s demo door opens it to anyone.' : 'No demo book.',
      fix: 'Keep the demo on the separate demo deployment; do not run the seed against production.',
    });
    const gateways = await db.selectFrom('payment_gateways').select('org_id').where('is_active', '=', 1).execute().catch(() => []);
    add({
      id: 'payments', group: 'connections', label: 'Online payments (Razorpay)', status: gateways.length ? 'ok' : 'warn',
      detail: gateways.length ? `Connected for ${gateways.length} compan${gateways.length === 1 ? 'y' : 'ies'}.` : 'No company has connected Razorpay: invoices carry no Pay button.',
      fix: 'Each company connects its own Razorpay keys under Settings → Integrations.',
    });
  }
  return out;
}
