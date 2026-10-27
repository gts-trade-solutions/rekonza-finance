# REKONZA AI — Books. Made Smarter.

Double-entry accounting, GST compliance, e-invoicing and banking for Indian business. Next.js 15 on the front, MySQL and a real posting engine behind it — every figure on every report is computed from the journal on request, so no two screens can disagree.

> **Status: MVP.** Every module is built and tested (516 unit tests), but it has not yet run a real business's books. The government portals (GST, IRP, e-way bill) go through a built-in stand-in until a GSP and NIC credentials are connected, and messages go out by hand until an email/SMS/WhatsApp provider is.

```bash
npm install
cp .env.example .env.local     # DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
npm run db:migrate             # hand-numbered SQL migrations, checksum-enforced
npm run db:seed                # builds the demo organisation
npm run dev                    # http://localhost:5000
```

Then either **create an account** at `/register` — which gives you an empty, private set of books — or open the **demo book** from the sign-in page, which is a fully worked example you can click through without signing up.

---

## What makes this more than a mockup

Under the screens sits a real double-entry ledger in MySQL. Every invoice, bill and payment posts a balanced journal entry inside the same transaction that writes the document, and the Trial Balance, Profit & Loss and Balance Sheet are derived from those entries on every request. Nothing is cached, and nothing is faked with hard-coded numbers.

- **The books always balance.** `lib/server/ledger/posting.ts` rejects any entry whose debits and credits differ — by construction, not by checking afterwards. It is the only writer of journal lines in the codebase.
- **Nothing is ever edited.** Voiding a document posts an opposite, cancelling entry; both stay visible. MCA Rule 11(g) requires an audit trail that cannot be switched off, so there is no update or delete path anywhere in `lib/server/audit.ts`.
- **The GST engine is real.** `lib/tax/gst.ts` resolves CGST+SGST versus IGST from the supplier's registration and the place of supply, handles exports, SEZ, reverse charge and composition dealers, and validates GSTIN mod-36 checksums.
- **Money never drifts.** Every amount is held as integer paise end to end — `DECIMAL(19,4)` in the database, string and BigInt arithmetic in between. No floating point touches a rupee value.
- **TDS thresholds accumulate across the year.** Bill a contractor past ₹1,00,000 in a financial year and the app starts withholding, at the rate the vendor's PAN status actually earns.

## A five-minute walkthrough

Open the demo book as **Admin** from the sign-in page.

1. **Dashboard** — receivables, cash, profit, and the two deadlines that cost money: invoices without an IRN, and MSME bills approaching day 45.
2. **Sales → Invoices → New invoice.** Pick *Sharma Traders* (Tamil Nadu) and the tax panel resolves to **CGST + SGST**. Switch to *Apex Motors* (Karnataka) and it flips to **IGST** — same goods, different tax, decided by geography.
3. Save it, then open the **Journal** tab. That is the double-entry the customer never sees.
4. **Banking → Reconcile.** Statement lines on the left, suggested matches on the right, ↑ ↓ and Enter to work through them. The statement-versus-ledger delta at the top is the number that has to reach zero.
5. **Reports → Trial Balance.** Debits equal credits to the paisa. Do anything you like in the app first; it will still balance.
6. **GST → GSTR-1.** Section by section, with the portal JSON.
7. **Purchases → MSME 45-day tracker.** A countdown on unpaid small-supplier bills, because paying them late costs the deduction under Section 43B(h).

## Module map

| Area | What's in it |
|---|---|
| **Dashboard** | Cash, receivables, payables, profit, compliance alerts |
| **Sales** | Customers · Items · Estimates · Sales orders · Delivery challans · Invoices · Retainers · Payments · Credit notes · Recurring profiles |
| **Purchases** | Vendors · Expenses · Purchase orders · Bills (ITC / reverse charge / TDS) · Payment runs · Vendor credits · MSME tracker |
| **Banking** | Accounts · Reconciliation workspace · Statement import · Rules · Transfers · Cheques & PDCs |
| **Accountant** | Manual journals · Chart of accounts · Opening balances · Budgets · Recurring journals · Period close · Transaction locks · Audit trail |
| **GST & taxes** | E-invoices · E-way bills · GSTR-1 · GSTR-3B with the Section 49A set-off order · GSTR-2B reconciliation · TDS & TCS |
| **Inventory** | Stock on hand · Adjustments · Warehouses |
| **Reports** | 32 reports, every one derived from the journal, all exportable |
| **Settings** | Organisation · Numbering · HSN master · Custom fields · Automation · Integrations |
| **Portal** | Customer-facing view at `/portal`, currently a signed-in preview |

## How it's put together

```
app/
  page.tsx           the landing page (static, no session read)
  login/ register/   sign in, sign up, and the demo door
  (app)/…            the application, grouped by module
  api/…              route handlers; every write goes through a service
  portal/            customer-facing surface
components/
  brand/logo.tsx     the single source of the name, tagline and artwork
  ui/                shadcn primitives on Base UI
  shared/ layout/ charts/
lib/
  server/
    ledger/posting   the only writer of journal entries
    ledger/chart-of-accounts
    services/        invoices, bills, payments, banking, GST — the write layer
    reports/         TB · P&L · BS · GL · ageing, computed on request
    gst/             returns, e-invoicing, ITC reconciliation
    seed/            the demo organisation
    auth/            argon2id passwords, server-side sessions
  tax/gst.ts         supply-type resolver + GSTIN checksum
  tax/tds.ts         section master + threshold logic
  api/client.ts      the typed browser-side API surface
db/migrations/       hand-numbered SQL, checksum-enforced
```

## The demo book, and real books

The demo organisation is a real row in the database carrying `is_demo = 1`. That flag is what the app keys off:

- the sign-in page's one-click door only ever opens onto an organisation with it set;
- the top bar shows "Demo book · nothing here is filed with any portal" only when it is set;
- `npm run db:seed -- --fresh` deletes and rebuilds **only** organisations with it set, so a customer's ledger is never in range of the seed script.

Nothing that comes through the sign-up form can set it. A new organisation gets the standard chart of accounts, a Cash in Hand account, numbering that starts at one, and nothing else.

## Not connected yet

Live IRN registration needs a contract with a GST Suvidha Provider. Automatic bank feeds need an Account Aggregator licence that accounting software does not hold. Outbound email needs a mail transport, and the payment button needs a merchant account. None of these are wired up, and the app says so where you would go looking for them rather than showing a green "Connected" badge over nothing.

## Not built

The TDS return's FVU text file: the return is laid out as rows for the government's Return Preparation Utility, whose file layout Protean publishes and changes.

## Deploying to Vercel

Vercel runs the app; it does not run the database. You need:

1. **A hosted MySQL 8** in Mumbai (the Companies Act wants the books and their backups in India) — Aiven, AWS RDS, DigitalOcean or Railway, or for a demo the free TiDB Cloud from Vercel's Storage tab. A single `DATABASE_URL` (`mysql://user:password@host:port/name`, as Vercel's integrations set it) is used ahead of the `DB_*` settings, with TLS. Put it in `.env.production.local` and run the migrations and the demo book against it from your machine: `node --env-file=.env.production.local scripts/migrate.mjs`, then `npx tsx --conditions=react-server --env-file=.env.production.local scripts/seed.ts`.
2. **A Vercel Blob store** (private, Mumbai) connected to the project, for attachments. Vercel adds `BLOB_READ_WRITE_TOKEN` itself.
3. **Environment variables** in the Vercel project: `DATABASE_URL` (a Vercel database integration adds it), or the `DB_*` set with `DB_SSL=true` (and `DB_SSL_CA` if the provider asks), `SESSION_SECRET`, `FIELD_ENCRYPTION_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`. See `.env.example`.

`vercel.json` runs the functions in Mumbai (`bom1`) and calls `/api/cron/sweep` once a day for the background work (scheduled entries, retries, webhooks, reports, stock alerts, reminders). On a Pro plan, make it every ten minutes: `"*/10 * * * *"`. Backups are the database host's: turn on its daily backups and point-in-time recovery; `npm run db:backup` is for a server you run yourself.

## Checks

```bash
npm run test:unit      # posting engine, money arithmetic, services
npm run test:api       # route handlers against a live server
npm run smoke          # every route renders with no console errors
npm run flows          # end-to-end journeys through the UI
node scripts/onboarding.mjs   # landing page, sign-up, and the demo door
```
