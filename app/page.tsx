import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight, BadgeIndianRupee, BookOpenCheck, FileCheck2, Landmark,
  Layers, LineChart, Lock, ScrollText, ShieldCheck, Truck,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BRAND, Logo, LogoMark } from '@/components/brand/logo';
import { SITE_URL } from '@/lib/seo';

// ─────────────────────────────────────────────────────────────────────────────
// The landing page.
//
// Deliberately a static server component: no session read, no client bundle.
// A marketing page that waits on an API call to decide what to render is a
// marketing page that renders late, and a crawler will not wait.
//
// The claims here are the ones the code can actually stand behind. Where a
// capability depends on a contract we do not yet hold — a GSP for live IRNs,
// an aggregator licence for bank feeds — the page says so rather than implying
// otherwise. An accounting product that oversells on the landing page has
// already told its first lie.
// ─────────────────────────────────────────────────────────────────────────────

export const metadata: Metadata = {
  // Spelled out rather than left to the layout's `%s — REKONZA AI` template:
  // the home page is the one result where the brand has to lead, and a title
  // that depends on a template is a title that can silently lose the name.
  title: {
    absolute: `${BRAND.display} — Accounting & GST Software for Indian Business`,
  },
  description: BRAND.description,
  alternates: { canonical: '/' },
};

const PILLARS = [
  {
    icon: BookOpenCheck,
    title: 'Books that prove themselves',
    body:
      'Every document posts a balanced double-entry journal or it does not post at all. Nothing is edited after the fact — a correction is a reversal, and both stay on the record.',
  },
  {
    icon: BadgeIndianRupee,
    title: 'GST built in, not bolted on',
    body:
      'Place of supply decides CGST+SGST or IGST on every line. GSTR-1 comes out section by section with the portal JSON, and GSTR-3B applies the set-off order the law actually prescribes.',
  },
  {
    icon: ShieldCheck,
    title: 'The rules other software skips',
    body:
      'Section 43B(h) counts the 45 days on every MSME bill. Section 17(5) blocks the credit you cannot claim. The 30-day IRN window is a countdown, not a footnote.',
  },
];

const FEATURES = [
  { icon: FileCheck2, title: 'Sales', body: 'Quotes, orders, challans, invoices, credit notes and retainers — with the conversion chain between them.' },
  { icon: Layers, title: 'Purchases', body: 'Purchase orders, bills, expenses and vendor credits, with input credit, reverse charge and TDS worked out for you.' },
  { icon: Landmark, title: 'Banking', body: 'Statement import with duplicate detection, rules that categorise the repeats, and a reconciliation workspace.' },
  { icon: ScrollText, title: 'Accountant', body: 'Manual journals, chart of accounts, opening balances, budgets, recurring entries and per-module period locks.' },
  { icon: Truck, title: 'Compliance', body: 'E-invoice queue, e-way bills, GSTR-2B reconciliation and a TDS register that respects annual thresholds.' },
  { icon: LineChart, title: 'Reports', body: 'Thirty-two of them, every figure computed from the journal on request — so no two can disagree.' },
];

const PROOFS = [
  { claim: 'Trial balance ties', detail: 'debits equal credits to the paisa' },
  { claim: 'Balance sheet balances', detail: 'assets equal liabilities plus equity' },
  { claim: 'Profit reconciles', detail: 'P&L net profit equals balance-sheet earnings' },
  { claim: 'Ageing ties to its control account', detail: 'at every date, not just today' },
];

/**
 * Structured data. Two graphs: the organisation behind the product, and the
 * product itself, so a search result can show either.
 */
const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: BRAND.name,
      url: SITE_URL,
      logo: `${SITE_URL}/logo.png`,
      slogan: BRAND.tagline,
      areaServed: 'IN',
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: BRAND.name,
      publisher: { '@id': `${SITE_URL}/#organization` },
      inLanguage: 'en-IN',
    },
    {
      '@type': 'SoftwareApplication',
      name: BRAND.name,
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Accounting Software',
      operatingSystem: 'Web',
      description: BRAND.description,
      url: SITE_URL,
      publisher: { '@id': `${SITE_URL}/#organization` },
      featureList: [
        'Double-entry accounting',
        'GST invoicing and returns (GSTR-1, GSTR-3B)',
        'E-invoicing and e-way bills',
        'Bank reconciliation',
        'TDS and MSME compliance',
        'Financial statements and reports',
      ],
    },
  ],
};

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      <div className="flex min-h-screen flex-col bg-[var(--surface)] text-foreground">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="sticky top-0 z-40 border-b bg-[var(--surface)]/85 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
            <Link href="/" className="flex items-center" aria-label={`${BRAND.display} home`}>
              <Logo width={158} priority />
            </Link>
            <nav className="ml-auto hidden items-center gap-7 text-sm text-muted-foreground md:flex">
              <a href="#what" className="transition-colors hover:text-foreground">Why it&apos;s different</a>
              <a href="#modules" className="transition-colors hover:text-foreground">Modules</a>
              <a href="#proof" className="transition-colors hover:text-foreground">How it holds together</a>
            </nav>
            {/*
              Plain links carrying the button's styles, not <Button asChild>.
              Base UI's Button stamps role="button" on whatever it renders, and
              a navigation control announced as a button is one a screen-reader
              user cannot tell will leave the page.
            */}
            <div className="ml-auto flex items-center gap-2 md:ml-0">
              <Link href="/login" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}>
                Sign in
              </Link>
              <Link href="/register" className={cn(buttonVariants({ size: 'sm' }), 'gap-1.5')}>
                Get started <ArrowRight className="size-3.5" />
              </Link>
            </div>
          </div>
        </header>

        <main className="flex-1">
          {/* ── Hero ─────────────────────────────────────────────────────── */}
          <section className="relative overflow-hidden border-b">
            {/*
              A wash rather than a block. The brand is navy, but a full navy
              hero would fight the navy wordmark sitting on top of it — so the
              colour arrives as a faint bloom behind the headline instead, and
              the accent rule under the header carries the blue-to-teal pair
              from the logo at full strength.
            */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-primary via-[#00CFC0] to-primary/40"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(75%_55%_at_50%_-12%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
            />
            <div className="relative mx-auto max-w-6xl px-5 py-20 text-center sm:py-28">
              <p className="micro-label mx-auto mb-5 w-fit rounded-full border bg-background px-3 py-1">
                Built for Indian business
              </p>
              <h1 className="mx-auto max-w-3xl text-balance text-4xl font-semibold tracking-[-0.03em] sm:text-6xl">
                {BRAND.tagline}
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground sm:text-lg">
                Double-entry accounting, GST and banking in one ledger — where every figure on
                every report traces back to the document that created it.
              </p>

              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <Link
                  href="/register"
                  className={cn(buttonVariants({ size: 'lg' }), 'h-11 gap-2 px-6 text-[0.95rem]')}
                >
                  Create your books <ArrowRight className="size-4" />
                </Link>
                <Link
                  href="/login?demo=1"
                  className={cn(
                    buttonVariants({ size: 'lg', variant: 'outline' }),
                    'h-11 px-6 text-[0.95rem]',
                  )}
                >
                  Explore the demo book
                </Link>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                The demo opens a fully worked set of books. Your own start empty.
              </p>

              {/*
                A real screenshot of the demo book, not an illustration. The
                page claims the trial balance ties; showing a mock-up would be
                an odd way to make that argument.
              */}
              <div className="mx-auto mt-14 max-w-5xl">
                <div className="overflow-hidden rounded-xl border bg-[var(--surface)] shadow-[0_20px_60px_-30px_rgb(0_32_96/0.45)]">
                  <Image
                    src="/product-dashboard.png"
                    alt="The Rekonza dashboard: receivables, payables, cash and profit for the financial year, with alerts for invoices awaiting an IRN and MSME bills nearing the 45-day limit."
                    width={2400}
                    height={1500}
                    priority
                    sizes="(max-width: 1024px) 100vw, 1024px"
                    className="h-auto w-full dark:hidden"
                  />
                  {/* The same screen in the app's dark theme, so the hero does
                      not become a light rectangle on a dark page. */}
                  <Image
                    src="/product-dashboard-dark.png"
                    alt=""
                    aria-hidden
                    width={2400}
                    height={1500}
                    sizes="(max-width: 1024px) 100vw, 1024px"
                    className="hidden h-auto w-full dark:block"
                  />
                </div>
              </div>

              {/* The four invariants, stated as the product promise they are. */}
              <dl className="mx-auto mt-14 grid max-w-4xl gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
                {PROOFS.map((p) => (
                  <div key={p.claim} className="bg-[var(--surface)] px-5 py-6 text-left">
                    <dt className="flex items-start gap-2 text-sm font-medium">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                      {p.claim}
                    </dt>
                    <dd className="mt-1.5 pl-3.5 text-xs leading-relaxed text-muted-foreground">
                      {p.detail}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>

          {/* ── Why different ────────────────────────────────────────────── */}
          <section id="what" className="border-b py-20 sm:py-24">
            <div className="mx-auto max-w-6xl px-5">
              <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-[-0.02em]">
                Most accounting software records what you type. This one checks it.
              </h2>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                The difference shows up at year end, when a figure has to be defended rather
                than merely displayed.
              </p>

              <div className="mt-12 grid gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-3">
                {PILLARS.map((p) => (
                  <div key={p.title} className="bg-[var(--surface)] p-7">
                    <span className="grid size-10 place-items-center rounded-lg bg-primary/10">
                      <p.icon className="size-5 text-primary" />
                    </span>
                    <h3 className="mt-5 font-semibold">{p.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ── Modules ──────────────────────────────────────────────────── */}
          <section id="modules" className="border-b bg-background py-20 sm:py-24">
            <div className="mx-auto max-w-6xl px-5">
              <h2 className="text-balance text-3xl font-semibold tracking-[-0.02em]">
                Everything a set of books needs
              </h2>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                One ledger underneath all of it. Raise an invoice and the journal entry, the GST
                liability, the receivable and every report that reads them move together.
              </p>

              <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {FEATURES.map((f) => (
                  <div
                    key={f.title}
                    className="rounded-xl border bg-card p-6 transition-colors hover:border-primary/40"
                  >
                    <div className="flex items-center gap-2.5">
                      <f.icon className="size-4 text-primary" />
                      <h3 className="font-semibold">{f.title}</h3>
                    </div>
                    <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ── Proof ────────────────────────────────────────────────────── */}
          <section id="proof" className="border-b py-20 sm:py-24">
            <div className="mx-auto grid max-w-6xl gap-12 px-5 lg:grid-cols-2 lg:gap-16">
              <div>
                <h2 className="text-balance text-3xl font-semibold tracking-[-0.02em]">
                  How it holds together
                </h2>
                <div className="mt-8 space-y-7">
                  <div>
                    <h3 className="flex items-center gap-2 font-medium">
                      <Lock className="size-4 text-primary" /> Nothing is ever edited
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      A posted entry is permanent. Correcting one writes a reversal, so the
                      history shows what happened and what was done about it. That is what an
                      audit trail is for, and why ours has no off switch.
                    </p>
                  </div>
                  <div>
                    <h3 className="flex items-center gap-2 font-medium">
                      <ShieldCheck className="size-4 text-primary" /> Locks the software enforces
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      Close a period and the posting engine itself refuses anything dated into
                      it. Not a hidden button — a refusal, from every screen and every route at
                      once.
                    </p>
                  </div>
                  <div>
                    <h3 className="flex items-center gap-2 font-medium">
                      <BadgeIndianRupee className="size-4 text-primary" /> Money that cannot drift
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      Every amount is held in whole paise, start to finish. No floating point
                      anywhere, so ten thousand additions land on exactly the figure they should.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border bg-background p-7">
                <p className="micro-label">Straight about what is not connected</p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  Live IRN registration needs a GST Suvidha Provider contract. Automatic bank
                  feeds need an Account Aggregator licence that accounting software does not
                  hold. Neither is wired up yet, and the app says so where you would look for
                  them rather than pretending otherwise.
                </p>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                  What is real today: the ledger, the GST computation, the returns and their
                  portal JSON, statement import and reconciliation, and every report.
                </p>
                <div className="mt-6 border-t pt-5">
                  <p className="text-sm font-medium">See for yourself</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The demo book has five months of trading in it — invoices, bills, payments,
                    bank lines and a trial balance that ties.
                  </p>
                  <Link
                    href="/login?demo=1"
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4 gap-1.5')}
                  >
                    Open the demo <ArrowRight className="size-3.5" />
                  </Link>
                </div>
              </div>
            </div>
          </section>

          {/* ── Close ────────────────────────────────────────────────────── */}
          <section className="py-20 sm:py-24">
            <div className="mx-auto max-w-3xl px-5 text-center">
              <h2 className="text-balance text-3xl font-semibold tracking-[-0.02em]">
                Start with an empty, honest set of books
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
                Your chart of accounts is installed and your numbering series begins at one.
                Nothing else — because a book that starts with somebody else&apos;s data is not
                your book.
              </p>
              <Link
                href="/register"
                className={cn(
                  buttonVariants({ size: 'lg' }),
                  'mt-8 h-11 gap-2 px-6 text-[0.95rem]',
                )}
              >
                Create your books <ArrowRight className="size-4" />
              </Link>
            </div>
          </section>
        </main>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <footer className="border-t bg-background">
          <div className="mx-auto max-w-6xl px-5 py-12">
            <div className="flex flex-wrap items-start justify-between gap-8">
              <div className="max-w-xs">
                <div className="flex items-center gap-2.5">
                  <LogoMark size={26} />
                  <span className="font-semibold tracking-[-0.02em]">{BRAND.display}</span>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  {BRAND.tagline} Accounting, GST and banking for Indian business.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-x-14 gap-y-2 text-sm sm:grid-cols-3">
                <div className="space-y-2">
                  <p className="micro-label">Product</p>
                  <a href="#what" className="block text-muted-foreground hover:text-foreground">Why it&apos;s different</a>
                  <a href="#modules" className="block text-muted-foreground hover:text-foreground">Modules</a>
                  <a href="#proof" className="block text-muted-foreground hover:text-foreground">How it works</a>
                </div>
                <div className="space-y-2">
                  <p className="micro-label">Compliance</p>
                  <span className="block text-muted-foreground">GST &amp; GSTR filing</span>
                  <span className="block text-muted-foreground">E-invoicing &amp; e-way bills</span>
                  <span className="block text-muted-foreground">TDS &amp; MSME 43B(h)</span>
                </div>
                <div className="space-y-2">
                  <p className="micro-label">Account</p>
                  <Link href="/login" className="block text-muted-foreground hover:text-foreground">Sign in</Link>
                  <Link href="/register" className="block text-muted-foreground hover:text-foreground">Create an account</Link>
                  <Link href="/login?demo=1" className="block text-muted-foreground hover:text-foreground">Demo book</Link>
                </div>
              </div>
            </div>

            <p className="mt-10 border-t pt-6 text-xs text-muted-foreground">
              © {new Date().getFullYear()} {BRAND.name}. Figures shown in the demo are
              illustrative and are not filed with any government portal.
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
