# REKONZA AI — Books. Made Smarter.

Double-entry accounting, GST compliance, e-invoicing and banking for Indian business. Next.js 15 on the front, MySQL and a real posting engine behind it — every figure on every report is computed from the journal on request, so no two screens can disagree.

> **Status: MVP.** Every module is built and tested (the unit suite runs with `npm run test:unit`), but it has not yet run a real business's books. The government portals (GST, IRP, e-way bill) go through a built-in stand-in until a GSP and NIC credentials are connected. Email goes out once an SMTP account is set in the environment, online payment once the business connects its own Razorpay account; SMS and WhatsApp messages are sent by hand.

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

## Internal controls

After an auditor's review, the controls around the books are built in and shown, area by area with the evidence, under **Settings → Controls** (`lib/server/services/controls.ts`):

- **Exceptions** (`/exceptions`, `services/exceptions.ts`) — the scheduler finds what is wrong (invoices without an IRN, customers 15/30/60/90 days past due, bills falling due, MSME bills nearing day 45, concentration and credit-limit risks, unreconciled bank lines, bad GSTINs, expiring documents, system errors), gives each an owner and a date, escalates it to the admins when the date passes, and closes it with a resolution — or by itself when the problem goes away.
- **IRNs register themselves** as soon as an invoice is issued (`gst/auto-irn.ts`); a refusal becomes an exception.
- **Perpetual inventory** (`services/stock-ledger.ts`) — each sale posts its cost to Cost of Goods Sold, stock purchases go to Inventory, month end brings Inventory into line with the valuation. Profit is identical to the periodic (Tally) method, which stays the default.
- **Segregation of duties** — whoever entered or approved a bill does not pay it; nobody approves what they submitted.
- **Why, not only who and when** — a book can require a reason for every change; it is kept in the audit trail.
- **Validation** — GSTIN check digit, state and PAN; duplicate GSTINs refused, repeated PANs and names flagged.
- **Credit hold** on customers long past due; **password rules** (length, expiry, history); **error log** with references and resolutions (Settings → System health); **document library** with expiry; **risk analytics** (`/analytics/risk`): journal anomalies, customer risk scores, collections by each customer's own lateness; **dashboard cached** until the books change.

## Zoho Books features

Benchmarked against Zoho Books, the pieces it had and Rekonza did not are built in:

- **Statements of account** for customers and vendors (from the ledger, so they agree with the ageing), to print, export or email; a **vendor page** like the customer one.
- **Sales receipts** — a sale paid at the counter, recorded with its receipt — and **debit notes** (s.34(3)), in their own series, reported in GSTR-1 with the notes as type D, in GSTR-9 4J, and sent to the IRP as DBN.
- **Recurring bills and expenses**, raised on their dates by the scheduler; **mileage** claims.
- **Projects and timesheets** (Time Tracking): billed as a fixed fee, by project, task or staff hours; billable expenses re-charged at cost; profit after the cost of the time.
- **Contact persons**, **custom fields** (printed on the invoice when ticked), **comments and history** on documents, **clone** an invoice.
- **Bills of entry** for imports: duty to cost, IGST to credit in GSTR-3B 4(A)(1).
- **Email** from the app through any SMTP account (`SMTP_HOST` …, see `.env.example`): invoices with a view-and-pay link, statements, and payment reminders on their own.
- **Payment links** through the business's own Razorpay account; the receipt records itself when the customer pays.
- **Workflow rules**: when an invoice, bill, payment … is created and meets the conditions, tell people in the app or send an email.
- **Customer and vendor portal**, laid out as Zoho's (`lib/server/services/portal.ts`): opened from a link or by **signing in at `/portal/login`** with a six-digit code emailed to them (only a hash kept; ten minutes, five tries). A customer has a home page of what they owe, then quotes (accept, or decline with a reason), invoices (pay online), sales orders, retainers, credit notes, payments, statement and projects; a vendor has purchase orders to **accept or decline**, bills, vendor credits, payments and statement. Both **comment** on any of their documents (the business replies from the contact's page), **swap files** with the business, and keep their own email, phone and addresses up to date. A vendor's **new bank account is a request** the business approves after checking it by phone, never applied from the portal. **Portal Activities** reports everything they did.
- **Accountant tools**: **journal templates** (with or without amounts; use one to fill the journal form) and **bulk update** — lines moved from one account to another by one reclassification journal, the posted entries untouched, sub-ledger accounts refused, reversible.
- **Every document prints, saves as a PDF and goes by email**, not only invoices (`lib/print-doc.ts`, `lib/server/services/document-print.ts`): quotes, sales orders, delivery challans (in triplicate, Rule 55), credit notes (naming the invoice, Rule 53), retainer invoices, payment receipts (a receipt voucher with the tax when GST was paid on an advance, Rule 50), purchase orders, vendor credits, payment advices and bills, in the business's invoice template. Each list has a "⋯" menu: print or PDF, email now, send from your own mail app or WhatsApp, copy a link that opens it without signing in; quotes, sales orders and purchase orders **clone**. Select rows on any list to **print them together**, one to a page. The portal opens each of a contact's documents the same way. A quote emailed becomes sent, a purchase order emailed is issued.
- **Email templates** (Settings → Email templates): the business's own wording for every email the books send — the invoice, each other document (quote, sales order, challan, credit note, retainer, payment receipt, purchase order, vendor credit, payment advice), statements, payment reminders and the portal invitation — with placeholders, a preview and a way back to the built-in wording.
- **Report basis: accrual or cash** on the profit and loss, balance sheet, trial balance and Schedule III, as Zoho offers it (`lib/server/reports/statements.ts`): on the cash basis a sale counts when it is paid, in the share paid and on the day paid, a bill when it is paid, and anything paid at once on its own date; a credit note set against an invoice counts for nothing, one refunded counts when refunded; the statements still tie.
- **Merge customers or vendors** (`lib/server/services/contact-merge.ts`): everything of the one merged away — documents, payments, ledger lines, contact persons, addresses, custom fields, comments, files — moves to the one kept, which also takes any email, phone, PAN or address it lacked; the other is archived pointing at it and its portal links stop. Two different GSTINs never merge, nor a party without a GSTIN that has invoices into one with a GSTIN (it would change past returns).
- **Exchange rate feed** (Accountant → Foreign currency): switched on, each day's ECB reference rate for every currency the book deals in is fetched and saved (`FX_FEED_URL` for another source); a rate typed for the day is kept; "Fetch now" does it at once.
- **Landed cost** (`lib/server/services/landed-cost.ts`): freight, duty or clearing on one bill spread over the goods of another (or the same) bill — by quantity, by value or by hand — into their stock value from the charge bill's date, so the cost per unit and everything sold from it include it. A perpetual book also moves it into Inventory; taking it off, or voiding either bill, undoes it.
- **Timer and timesheet approval**: a running timer per person that logs its time when stopped; with approval on (Controls), time waits for someone else to approve it and only approved time is billed.
- **Several addresses per contact**: delivery sites and branches with their state and GSTIN, the default filled in as the invoice's ship-to.
- **Item pictures** on the item list and form; an **account watchlist** and **projects** widget on the dashboard, each person's own; **web tabs** for the websites the team opens every day (sites that refuse to be framed open in a new tab).
- **More imports**: quotes, sales orders, credit notes, purchase orders, expenses and payments received and made, as well as masters, journals, invoices and bills.
- **Zoho's longer report list**: sales summary, receivable and payable details, AP ageing details, vendor credit and purchase order details, purchases by item, expenses by customer and by project, billable expense details, project summary, timesheet details, inventory valuation summary, committed stock, ABC classification, reconciliation status, realised and unrealised exchange gain or loss, system mails and portal activities.
- **Kits** (sold as a set, components out of stock) and **item groups** (variants: size, colour), **invoice templates** (classic, modern, compact, accent colour, footer), **reporting tags** with profit by tag, **saved views** and **bulk actions** on lists, **clone** a bill.
- **GSTR-3B as the portal lays it out** (`lib/server/gst/gstr3b-form.ts`): tables 3.1, 3.1.1, 3.2 by place of supply, 4 (A)(1)–(5), (B), (C), (D), 5, 5.1 and 6.1, in the portal's words, monthly or quarterly. Every figure opens the invoices, bills and journals behind it; blocked credit is shown in 4(A) and reversed in 4(B)(1) per Circular 170/2022; IGST credit is spread where it saves cash (Rule 88A, `set-off.ts`); interest and late fee follow the due date; the return downloads as the GSTN's JSON or as Excel; the ARN is kept once filed.
- **Profit and loss and balance sheet in three formats**, as Zoho offers them: **General** (operating income, cost of goods sold, gross, operating and net profit; current assets as cash, bank, receivables and others, fixed and other assets, current, long-term and other liabilities, equities), **Horizontal** (the T-form trading and P&L account, liabilities beside assets) and **Schedule III**.
- **JSON import and export**: Settings → Export data takes any module out as CSV, Excel or JSON, or the whole book as one JSON backup; customers, vendors, items, accounts, journals, invoices and bills come out in their import's columns, so a JSON export imports straight back (Settings → Import takes JSON as well as CSV and Excel). GSTR-2A as well as 2B JSON is read for ITC reconciliation, and an invoice's e-invoice JSON downloads.
- **Documents**: an inbox for files uploaded before anyone knows their transaction, every file in the book in one list with what it is attached to, the bank statements imports were read from, folders, attach to any transaction, create a bill from a file, and "From Documents" on every record's attachments.
- **GST returns through the GST system** (`lib/server/integrations/gst/returns-service.ts`), as Zoho's GSTN integration: each GSTIN connected with its portal username and the OTP the portal sends; **Push to GSTN** for GSTR-1, IFF and GSTR-3B with the portal's status and error report; **File with EVC**, the ARN kept and the compliance calendar marked; **Fetch GSTR-2B** into the reconciliation; **Fetch details** from a GSTIN on customer and vendor forms. It speaks GSTN's taxpayer API with its encryption, through your GSP (`GST_API_*` in `.env.example`); without one, a stand-in that behaves like the GSTN sandbox (OTP 575757) answers and files nothing.
- **Banking in bulk**: several statements uploaded at once, each finding its account by the account number it names; CSV, TSV, Excel, OFX/QFX, QIF, CAMT.053, MT940 and JSON; columns mapped by hand when the bank's layout is unusual; **Statement lines** to categorise, exclude or delete many lines at once, with a category suggested for each from how similar lines were categorised before; an import can be undone.

## The software checklist

**Software Checklist** (left menu, and a card on the dashboard; `services/checklist.ts`) answers each area of the accounting software checklist — company management, security and audit trail, masters, vouchers, inventory, banking, receivables, payables, fixed assets, payroll, GST, budgeting, reporting, integration — with where it is in the app and what the company's own records show: how many assets are on the register, when depreciation last ran, how many bank lines are reconciled. Among the pieces built for it: the **fund flow statement**, **cheque printing** on the CTS-2010 leaf, the **stock ledger** and **stock ageing**, a **collections** workbench with promises to pay, **balance confirmations** for customers and vendors, **account groups**, bank statements read from **Excel** in the bank's own layout, and **Power BI / Excel feeds** (`/api/bi/…`, read with an API key).

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

## The AI assistant

Ask about the books in plain words: "How much does Apex owe us?", "What returns are due this month?", "Which items are running low?", "How are we doing against the budget?". Every figure is read from the same report the screens use: ledger balances, profit and loss, balance sheet, cash, receivables and payables, invoices and bills, sales and expenses, GST, ratios, cash flow, stock, customer and supplier statements, payments, TDS, the compliance calendar, bank reconciliation, projects, payroll, fixed assets, budgets, open quotes and orders, and collections. A report card (key figures, a chart and a table) sits under each answer. The assistant only reads, and a role is offered only the lookups for what it can see: a salesperson's assistant has no payroll or profit lookup to be talked into.

- With `OPENAI_API_KEY` set, OpenAI answers (`gpt-5-mini` unless `OPENAI_MODEL` says otherwise). It reasons over the figures, compares them and advises.
- Without a key, outside production, a built-in stand-in answers. It reads the question, the names in it ("Apex", "brake pads") and the period ("last month", "in September", "FY 2025-26"), runs the same lookups, writes the figures up plainly, and says that it is the stand-in. On a live server with no key, the assistant says it is not set up, unless `AI_STANDIN=1` allows the stand-in.
- Reading a supplier's bill from a PDF or a photo needs the key.
- Quick and economical (`lib/server/ai/cache.ts`): the lookups of one step run side by side; a lookup already made while the books stood still is reused; the same first question asked again before anything in the books changed is answered at once and charged nothing; and OpenAI is given a prompt-cache key so the unchanging part of every request is billed at its cached price. **Speed & savings** on the AI page shows how it has gone over thirty days.

## Not connected yet

Live IRN registration, and filing returns with the GST system, need a contract with a GST Suvidha Provider; the returns connection is built and switches on with the GSP's details (`GST_API_*`). Automatic bank feeds need an Account Aggregator licence that accounting software does not hold, or each bank's own API agreement; statements are imported (CSV or Excel) meanwhile. SMS and WhatsApp sending need a provider. Email and online payment are built and switch on with the business's own SMTP account (`SMTP_HOST` …) and Razorpay keys (Settings → Integrations). The app says what is and is not connected where you would go looking for it, rather than showing a green "Connected" badge over nothing.

## Not built

The TDS return's FVU text file: the return is laid out as rows for the government's Return Preparation Utility, whose file layout Protean publishes and changes.

From Zoho Books: **digital signatures** with a DSC token (Zoho does it through a desktop utility that talks to the USB token; a web page cannot reach the token by itself), payment gateways other than Razorpay (each needs the business's own account with it), and the developer extras of its top plans (custom buttons, validation rules, custom modules). Sales returns are handled as Zoho Books handles them, by a credit note with the items, which brings the goods back into stock.

## The online demo (no database)

A Vercel deployment with no database configured plays a recording of the demo book instead: every screen and report opens with real figures, and anything that would save says that saving is switched off. `middleware.ts` answers `/api` from the files in `public/demo-snapshot`; nothing else changes. `DEMO_SNAPSHOT=1` turns it on anywhere, `DEMO_SNAPSHOT=0` turns it off.

To record it again after a change, with the app running against a seeded database: `BASE=http://localhost:5001 npx tsx scripts/demo-snapshot.ts`. It opens the demo book through its own door, visits every screen, and blocks every write, so the books are left as they were.

The AI assistant answers on the online demo too, from `lib/server/ai/demo-recording.json`: what every lookup returned for the demo book, for each customer, supplier, item, account and the periods a question is likely to name. With `OPENAI_API_KEY` set on the deployment, OpenAI answers from those figures, limited per visitor and to `DEMO_AI_DAILY_LIMIT` questions a day (default 300); without a key, the stand-in answers. Nothing is charged, and a conversation is kept only in the server's memory. Record it again together with the screens: `npx tsx --conditions=react-server --env-file=.env.local scripts/demo-ai-snapshot.ts`. It only reads.

## Deploying to a VPS

A server of your own runs the full app with its database, backups and TLS: `sudo DOMAIN=… EMAIL=… bash deploy/vps/setup.sh` on Ubuntu, then `sudo bash deploy/vps/update.sh` for each new version. See [docs/vps.md](docs/vps.md).

## Deploying to Vercel

Vercel runs the app; it does not run the database. You need:

1. **A hosted MySQL 8** in Mumbai (the Companies Act wants the books and their backups in India) — Aiven, AWS RDS, DigitalOcean or Railway, or for a demo the free TiDB Cloud from Vercel's Storage tab. A single `DATABASE_URL` (`mysql://user:password@host:port/name`, as Vercel's integrations set it) is used ahead of the `DB_*` settings, with TLS. Put it in `.env.production.local` and run the migrations and the demo book against it from your machine: `node --env-file=.env.production.local scripts/migrate.mjs`, then `npx tsx --conditions=react-server --env-file=.env.production.local scripts/seed.ts`.
2. **A Vercel Blob store** (private, Mumbai) connected to the project, for attachments. Vercel adds `BLOB_READ_WRITE_TOKEN` itself.
3. **Environment variables** in the Vercel project: `DATABASE_URL` (a Vercel database integration adds it), or the `DB_*` set with `DB_SSL=true` (and `DB_SSL_CA` if the provider asks), `APP_ENV=production`, `FIELD_ENCRYPTION_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`, and the mail, GSP and e-invoice settings when the business has them. See `.env.example`.
4. **The go-live check**: `npx tsx --conditions=react-server --env-file=.env.production.local scripts/golive.ts` (or Settings → System health once it is running) tests the database and its TLS, every migration, the encryption key, the cron secret, the site address, file storage and the demo door, and lists which connections are live or on a stand-in. It exits non-zero while anything required is missing.

`vercel.json` runs the functions in Mumbai (`bom1`) and calls `/api/cron/sweep` once a day for the background work (scheduled entries, retries, webhooks, reports, stock alerts, reminders). On a Pro plan, make it every ten minutes: `"*/10 * * * *"`. Backups are the database host's: turn on its daily backups and point-in-time recovery; `npm run db:backup` is for a server you run yourself.

## Checks

```bash
npm run golive         # is this server set up to keep real books (lib/server/golive.ts)
npm run test:unit      # posting engine, money arithmetic, services
npm run test:api       # route handlers against a live server
npm run smoke          # every route renders with no console errors
npm run flows          # end-to-end journeys through the UI
node scripts/onboarding.mjs   # landing page, sign-up, and the demo door
```
