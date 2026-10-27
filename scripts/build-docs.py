# Builds the project documentation as a Word file.
#   python scripts/build-docs.py
#
# Written as a script rather than a hand-made .docx so the document can be
# regenerated when the app changes, and so the figures in it — table counts,
# route counts, report counts — are read from the repository instead of typed
# from memory and quietly going stale.
#
# Output: REKONZA-AI-Project-Documentation.docx in the project root.

import os
import re
import subprocess
from datetime import date

from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'REKONZA-AI-Project-Documentation.docx')

# ── Brand ───────────────────────────────────────────────────────────────────
NAVY = RGBColor(0x00, 0x2F, 0x6E)
BLUE = RGBColor(0x0A, 0x5C, 0xC8)
GREY = RGBColor(0x55, 0x5F, 0x6D)
MUTED = RGBColor(0x6B, 0x74, 0x82)


# ── Facts read from the repository, so the document cannot drift ────────────
def count_files(pattern_dir, name):
    n = 0
    for base, dirs, files in os.walk(os.path.join(ROOT, pattern_dir)):
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.next')]
        n += sum(1 for f in files if f == name)
    return n


def read(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as f:
        return f.read()


MIGRATIONS = sorted(f for f in os.listdir(os.path.join(ROOT, 'db/migrations')) if f.endswith('.sql'))
TABLES = []
for m in MIGRATIONS:
    for t in re.findall(r'CREATE TABLE IF NOT EXISTS (\w+)', read(f'db/migrations/{m}')):
        TABLES.append((t, m))

API_ROUTES = []
for base, dirs, files in os.walk(os.path.join(ROOT, 'app/api')):
    if 'route.ts' in files:
        rel = os.path.relpath(base, os.path.join(ROOT, 'app')).replace(os.sep, '/')
        API_ROUTES.append('/' + rel)
API_ROUTES.sort()

REPORTS = sorted(
    d for d in os.listdir(os.path.join(ROOT, 'app/(app)/reports'))
    if os.path.isdir(os.path.join(ROOT, 'app/(app)/reports', d))
)

PAGE_COUNT = count_files('app/(app)', 'page.tsx')

# The accounts installed with every new organisation.
CHART_SIZE = len(re.findall(r'^  \{ code:', read('lib/server/ledger/chart-of-accounts.ts'), re.M))

try:
    COMMIT = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT).decode().strip()
except Exception:
    COMMIT = 'unversioned'

FACTS = {
    'tables': len(TABLES),
    'migrations': len(MIGRATIONS),
    'routes': len(API_ROUTES),
    'reports': len(REPORTS),
    'pages': PAGE_COUNT,
    'chart': CHART_SIZE,
    'commit': COMMIT,
    'date': date.today().strftime('%d %B %Y'),
}

doc = Document()

# ── Page setup and base styles ──────────────────────────────────────────────
for s in doc.sections:
    s.top_margin = Inches(1.0)
    s.bottom_margin = Inches(1.0)
    s.left_margin = Inches(1.0)
    s.right_margin = Inches(1.0)

normal = doc.styles['Normal']
normal.font.name = 'Calibri'
normal.font.size = Pt(10.5)
normal.paragraph_format.space_after = Pt(7)
normal.paragraph_format.line_spacing = 1.15
normal.element.rPr.rFonts.set(qn('w:eastAsia'), 'Calibri')

for name, size, colour, bold, before, after in [
    ('Heading 1', 19, NAVY, True, 20, 8),
    ('Heading 2', 14, NAVY, True, 15, 6),
    ('Heading 3', 11.5, BLUE, True, 11, 4),
]:
    st = doc.styles[name]
    st.font.name = 'Calibri'
    st.font.size = Pt(size)
    st.font.color.rgb = colour
    st.font.bold = bold
    st.paragraph_format.space_before = Pt(before)
    st.paragraph_format.space_after = Pt(after)
    st.paragraph_format.keep_with_next = True


def para(text='', style=None, size=None, bold=False, italic=False, colour=None,
         align=None, space_after=None):
    p = doc.add_paragraph(style=style)
    if text:
        r = p.add_run(text)
        r.bold = bold
        r.italic = italic
        if size:
            r.font.size = Pt(size)
        if colour:
            r.font.color.rgb = colour
    if align is not None:
        p.alignment = align
    if space_after is not None:
        p.paragraph_format.space_after = Pt(space_after)
    return p


def rich(parts, style=None, space_after=None):
    """A paragraph built from plain strings or (text, bold, italic, mono) tuples."""
    p = doc.add_paragraph(style=style)
    for t in parts:
        if isinstance(t, str):
            t = (t,)
        text, bold, italic, mono = (tuple(t) + (False,) * 4)[:4]
        r = p.add_run(text)
        r.bold = bold
        r.italic = italic
        if mono:
            r.font.name = 'Consolas'
            r.font.size = Pt(9.5)
    if space_after is not None:
        p.paragraph_format.space_after = Pt(space_after)
    return p


def bullet(text, level=0):
    p = doc.add_paragraph(text, style='List Bullet')
    p.paragraph_format.left_indent = Inches(0.25 + 0.25 * level)
    p.paragraph_format.space_after = Pt(3)
    return p


def mono(text):
    p = doc.add_paragraph()
    r = p.add_run(text)
    r.font.name = 'Consolas'
    r.font.size = Pt(9)
    p.paragraph_format.left_indent = Inches(0.3)
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(8)
    return p


def shade(cell, hexcolour):
    el = OxmlElement('w:shd')
    el.set(qn('w:val'), 'clear')
    el.set(qn('w:fill'), hexcolour)
    cell._tc.get_or_add_tcPr().append(el)


def table(headers, rows, widths=None, font=9):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ''
        r = hdr[i].paragraphs[0].add_run(h)
        r.bold = True
        r.font.size = Pt(font)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        hdr[i].paragraphs[0].paragraph_format.space_after = Pt(2)
        shade(hdr[i], '002F6E')
    for ri, row in enumerate(rows):
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ''
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            r = p.add_run(str(v))
            r.font.size = Pt(font)
            if i == 0 and len(headers) > 1:
                r.bold = True
        if ri % 2 == 1:
            for c in cells:
                shade(c, 'F3F6FB')
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Inches(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    return t


def callout(title, body, fill='FFF6E5'):
    t = doc.add_table(rows=1, cols=1)
    t.style = 'Table Grid'
    c = t.rows[0].cells[0]
    c.text = ''
    p1 = c.paragraphs[0]
    r = p1.add_run(title)
    r.bold = True
    r.font.size = Pt(9.5)
    p1.paragraph_format.space_after = Pt(2)
    p2 = c.add_paragraph()
    r2 = p2.add_run(body)
    r2.font.size = Pt(9.5)
    p2.paragraph_format.space_after = Pt(1)
    shade(c, fill)
    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    return t


def pagebreak():
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


# ═══════════════════════════════════════════════════════════════════════════
# Title page
# ═══════════════════════════════════════════════════════════════════════════
for _ in range(4):
    doc.add_paragraph()

logo = os.path.join(ROOT, 'public', 'wordmark.png')
if os.path.exists(logo):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run().add_picture(logo, width=Inches(3.4))

para('Books. Made Smarter.', size=15, colour=GREY, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=26)
para('Project Documentation', size=27, bold=True, colour=NAVY,
     align=WD_ALIGN_PARAGRAPH.CENTER, space_after=6)
para('Double-entry accounting, tax compliance and banking\nfor businesses trading across borders',
     size=12, colour=GREY, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=30)

t = doc.add_table(rows=0, cols=2)
t.alignment = WD_TABLE_ALIGNMENT.CENTER
for k, v in [
    ('Product', 'REKONZA AI'),
    ('Document', 'Functional and technical documentation'),
    ('Version', f'1.0 — build {FACTS["commit"]}'),
    ('Date', FACTS['date']),
    ('Status', 'Feature-complete build; pre-production'),
]:
    cells = t.add_row().cells
    cells[0].width = Inches(1.4)
    cells[1].width = Inches(3.6)
    r = cells[0].paragraphs[0].add_run(k)
    r.bold = True
    r.font.size = Pt(10)
    r.font.color.rgb = MUTED
    r2 = cells[1].paragraphs[0].add_run(v)
    r2.font.size = Pt(10)

pagebreak()

# ═══════════════════════════════════════════════════════════════════════════
doc.add_heading('Contents', level=1)
CONTENTS = [
    ('1', 'What this product is', 'Scope, audience and the problem it solves'),
    ('2', 'Design principles', 'The five rules the whole system is built on'),
    ('3', 'Technology and architecture', 'Stack, layering and the path of a request'),
    ('4', 'The data model', 'Schema by area, and why it is shaped this way'),
    ('5', 'Parties and party linking', 'Customers, vendors, and how they tie to the ledger'),
    ('6', 'Functional modules', 'Every screen, module by module'),
    ('7', 'Trading internationally', 'Cross-border supply, currency, and the jurisdiction layer'),
    ('8', 'Tax compliance by jurisdiction', 'The pluggable layer, and India as the first regime'),
    ('9', 'Money and arithmetic', 'Why nothing is stored as a floating-point number'),
    ('10', 'Security and audit', 'Authentication, roles, and the audit trail'),
    ('11', 'Organisations and the demo book', 'Tenancy, sign-up, and how the demo is kept apart'),
    ('12', 'Brand and public site', 'Identity, landing page and search visibility'),
    ('13', 'Accounting-system integrations', 'Planned — Tally first, and the pattern it sets'),
    ('14', 'What is not connected yet', 'An honest list of the gaps'),
    ('15', 'Running and deploying', 'Environment, migrations, seeding'),
    ('16', 'Testing and verification', 'What is checked, and how'),
    ('17', 'Roadmap', 'What comes next, in order'),
    ('A', 'Appendix — API endpoints', f'{FACTS["routes"]} route handlers'),
    ('B', 'Appendix — Database tables', f'{FACTS["tables"]} tables'),
    ('C', 'Appendix — Reports', f'{FACTS["reports"]} reports'),
]
table(['#', 'Section', 'Covers'], CONTENTS, widths=[0.4, 2.3, 3.8])

pagebreak()

# ═══════════════════════════════════════════════════════════════════════════
doc.add_heading('1. What this product is', level=1)

para('REKONZA AI is an accounting platform for small and medium businesses. It keeps a '
     'double-entry ledger in a relational database, computes the tax due on every transaction, '
     'prepares the statutory returns, reconciles the bank, and derives every financial statement '
     'from the journal on request.')

para('It is one system rather than a billing tool with an accounting add-on. Raising an invoice '
     'moves the journal entry, the tax liability, the receivable, the customer balance and every '
     'report that reads them at the same instant and inside the same database transaction. There '
     'is no overnight posting run, and no second copy of a figure to fall out of step.')

doc.add_heading('1.1  A jurisdiction-neutral core', level=2)

para('Accounting itself does not vary by country. Double entry, the chart of accounts, parties, '
     'documents, ageing, bank reconciliation, the audit trail and the financial statements do not '
     'change when a business crosses a border. Tax does, and so do the statutory returns that '
     'report it.')

para('The system is built along that seam. Everything in the first column below is shared by every '
     'business the platform serves, wherever it trades. Everything in the second is supplied by a '
     'jurisdiction module, so adding a country means writing one of those rather than reaching '
     'into the ledger.')

table(
    ['Shared by every jurisdiction', 'Supplied per jurisdiction'],
    [
        ('Double-entry ledger and posting engine', 'Which taxes apply, and at what rate'),
        ('Chart of accounts and account types', 'How a supply is classified for tax'),
        ('Parties, items, documents and their workflows', 'Registration numbers and their validation'),
        ('Payments, allocation and bank reconciliation', 'Statutory return formats and filing'),
        ('Trial balance, P&L, balance sheet, cash flow, ageing', 'Withholding rules and thresholds'),
        ('Audit trail, roles, period locks, numbering', 'Statutory record-keeping obligations'),
    ],
    widths=[3.1, 3.1], font=8.5,
)

doc.add_heading('1.2  Where it stands today', level=2)

table(
    ['Capability', 'Status'],
    [
        ('Accounting core, banking, reporting, audit', 'Complete, and jurisdiction-neutral'),
        ('Cross-border sales — exports, zero-rating, special economic zones',
         'Working today; see section 7'),
        ('India — GST, e-invoicing, transport documents, withholding tax, small-supplier rules',
         'The first jurisdiction, fully implemented; see section 8'),
        ('Multi-currency with exchange rates',
         'Roadmap. The base-currency field exists; per-document rates do not'),
        ('Further tax jurisdictions', 'Roadmap. The layer they plug into is built'),
    ],
    widths=[3.6, 2.6], font=8.5,
)

callout(
    'How to read this document',
    'Sections 2 to 6 and 9 to 12 describe the platform and apply to a business anywhere. Section 7 '
    'covers trading across borders. Section 8 covers tax, and is written against India because '
    'India is the jurisdiction implemented today — read it as the worked example of what a '
    'jurisdiction module contains, not as the boundary of the product.',
    'EAF2FF',
)

doc.add_heading('1.3  Who it is for', level=2)
bullet('Trading and service businesses that need real books rather than an invoice generator — '
       'ones whose figures will be read by an auditor, a lender or a buyer.')
bullet('Businesses selling across borders, where the same goods are taxed one way at home, '
       'another way into a neighbouring jurisdiction, and zero-rated on export.')
bullet('Businesses holding more than one tax registration, where each registration keeps its own '
       'document number series and files its own return.')
bullet('Owners and accountants who need the books to stand up to an audit, not merely to produce '
       'an invoice.')

doc.add_heading('Scale of the build', level=2)
table(
    ['Measure', 'Count'],
    [
        ('Application screens', FACTS['pages']),
        ('API route handlers', FACTS['routes']),
        ('Database tables', FACTS['tables']),
        ('Schema migrations applied', FACTS['migrations']),
        ('Financial and operational reports', FACTS['reports']),
        ('Accounts in the standard chart', FACTS['chart']),
    ],
    widths=[3.6, 1.4],
)

# ═══════════════════════════════════════════════════════════════════════════
doc.add_heading('2. Design principles', level=1)

para('Five rules run through the entire system. They are stated here because most of the design '
     'decisions in later sections follow from them, and because each one is enforced by the code '
     'rather than left to discipline.')

doc.add_heading('2.1  The books balance by construction', level=2)
para('Every document posts a balanced journal entry or it does not post at all. The posting engine '
     'sums the debits and the credits and refuses the entry if they differ — it does not write the '
     'entry and check afterwards. One module is the only writer of journal lines in the codebase, '
     'so there is no second path that could bypass the check.')

doc.add_heading('2.2  Nothing is ever edited', level=2)
para('A posted entry is permanent. Correcting one writes a reversing entry, and both stay visible '
     'with the correction linked to the original. Rule 11(g) of the Companies (Accounts) Rules '
     'requires accounting software used by companies in India to keep an audit trail that cannot '
     'be disabled, retained for eight years, and comparable obligations exist in most '
     'jurisdictions. The audit module therefore has an insert path and no update or delete path at '
     'all, everywhere — rather than a switch that turns it on for the countries that demand it.')

doc.add_heading('2.3  Reports are derived, never stored', level=2)
para('The trial balance, profit and loss, balance sheet, general ledger and ageing are all computed '
     'in SQL from the journal on each request. No total is cached, so no two reports can disagree '
     'and there is no rebuild job to forget to run. The cost is a query; the benefit is that the '
     'statements cannot silently go stale.')

doc.add_heading('2.4  Money is held in whole paise', level=2)
para('Every amount is an integer number of paise from the browser to the database and back. '
     'Floating-point arithmetic does not touch a rupee value anywhere, which is what stops ten '
     'thousand additions landing a few paise away from the figure they should.')

doc.add_heading('2.5  The server is the control', level=2)
para('Permissions are checked on the server using the same matrix the interface uses to decide '
     'which buttons to render. A hidden button is a courtesy; the route handler is what actually '
     'refuses the request. Every write goes through a service that re-validates its input '
     'regardless of what the form allowed.')

pagebreak()

# ═══════════════════════════════════════════════════════════════════════════
doc.add_heading('3. Technology and architecture', level=1)

doc.add_heading('3.1  Stack', level=2)
table(
    ['Layer', 'Technology', 'Why'],
    [
        ('Framework', 'Next.js 15 (App Router), React 19',
         'Server and client components in one codebase; route handlers are the API'),
        ('Language', 'TypeScript, strict mode',
         'The domain has many near-identical shapes; the compiler catches the mix-ups'),
        ('Database', 'MySQL 8, READ COMMITTED',
         'Mature, hosted in every region, and strong enough on constraints to enforce the model'),
        ('Query layer', 'Kysely (typed SQL builder)',
         'Types from the schema without an ORM hiding the SQL the reports depend on'),
        ('Styling', 'Tailwind CSS v4, shadcn/ui on Base UI',
         'A dense, consistent interface without a bespoke component library to maintain'),
        ('Client state', 'Zustand',
         'Holds master data the forms read synchronously; documents always come from the API'),
        ('Passwords', '@node-rs/argon2 (argon2id)',
         'The OWASP recommendation; memory cost is what defeats GPU attacks'),
        ('Charts', 'Recharts', 'Dashboard and report visuals'),
        ('Testing', 'node:test, Playwright', 'Unit and API tests, plus browser walkthroughs'),
    ],
    widths=[1.1, 1.9, 3.2], font=8.5,
)

doc.add_heading('3.2  Layering', level=2)
para('Each layer may only call the one below it. The rule matters most at the bottom: nothing '
     'reaches the journal except through the posting engine.')

mono(
    'Screens          app/(app)/…            React components, no SQL\n'
    '      ↓\n'
    'API client       lib/api/client.ts      One typed function per endpoint\n'
    '      ↓  HTTP\n'
    'Route handlers   app/api/…              Auth, permissions, input validation\n'
    '      ↓\n'
    'Services         lib/server/services/   Business rules; one transaction each\n'
    '      ↓\n'
    'Posting engine   lib/server/ledger/     The only writer of journal lines\n'
    '      ↓\n'
    'Database         MySQL'
)

doc.add_heading('3.3  The path of a request', level=2)
para('Saving an invoice is the representative case:')
bullet('The form posts to /api/invoices with customer, lines, dates and branch.')
bullet('The route handler authenticates the session cookie, checks that the role may create in '
       'the sales module, and validates the body against a schema.')
bullet('The service opens one database transaction. Inside it: the tax is resolved from the '
       'branch state and the place of supply; the invoice number is allocated from the series for '
       'that branch and financial year; the invoice and its lines are written; the journal entry '
       'is posted; the audit row is written.')
bullet('If any step fails the whole transaction rolls back. There is no state in which the '
       'invoice exists but its journal entry does not.')

callout(
    'Why the number is allocated inside the transaction',
    'A number handed out before the document is saved leaves a gap in the series when the save '
    'fails, and a gap in a GST invoice series is a question at assessment time. Forms show a '
    'peeked number — what the next one would be — which never consumes anything.',
    'EAF2FF',
)

# ═══════════════════════════════════════════════════════════════════════════
pagebreak()
doc.add_heading('4. The data model', level=1)

para(f'{FACTS["tables"]} tables across {FACTS["migrations"]} hand-numbered migrations. Migrations '
     'are applied in order and checksummed, so a file edited after it has been applied is refused '
     'rather than silently skipped.')

doc.add_heading('4.1  Areas', level=2)
table(
    ['Area', 'Tables', 'Holds'],
    [
        ('Core', 'organizations, branches, users, user_branches, sessions, audit_log',
         'The company, its GST registrations, who may sign in, and the trail'),
        ('Ledger', 'accounts, journal_entries, journal_lines, number_series, sequences, '
                   'transaction_locks',
         'The chart of accounts, every posting, and the period locks'),
        ('Masters', 'contacts, items, hsn_codes',
         'Parties, the catalogue, and the approved HSN/SAC list'),
        ('Sales', 'invoices, estimates, sales_orders, delivery_challans, credit_notes, '
                  'retainer_invoices and their line tables',
         'The full quote-to-cash chain'),
        ('Purchases', 'bills, expenses, purchase_orders, vendor_credits and their line tables',
         'Procure-to-pay, with input credit and TDS'),
        ('Money', 'payments, payment_allocations, bank_accounts, bank_transactions, '
                  'bank_statement_imports, bank_rules, bank_transfers, cheques',
         'Receipts, payments, statements and reconciliation'),
        ('Compliance', 'einvoices, eway_bills, gstr2b_entries',
         'IRN queue, consignment notes, and supplier-return matching'),
        ('Platform', 'settings, files, jobs, custom_fields, custom_field_values, approval_rules, '
                     'workflow_rules, recurring_invoices, recurring_journals, budgets, api_tokens',
         'Configuration, automation and extension points'),
        ('Inventory', 'warehouses, stock_adjustments',
         'Locations, and the movements that no document explains'),
    ],
    widths=[0.9, 2.5, 2.8], font=8.5,
)

doc.add_heading('4.2  Three decisions worth explaining', level=2)

doc.add_heading('Every table carries org_id', level=3)
para('The install serves many organisations from one database. The tenant key is present on all '
     f'{FACTS["tables"] - 3} business tables — everything except organizations, the migration '
     'ledger, and the user-to-branch grant table — and every query filters on it. Adding a tenant '
     'key to forty tables afterwards means rewriting every query, index and foreign key at once; '
     'the column costs eight bytes a row and saves that migration.')

doc.add_heading('A branch is a registration, not an office', level=3)
para('Each state a business operates in needs its own GSTIN, and each GSTIN keeps its own invoice '
     'number series. Modelling a branch as a GST registration rather than a location is what makes '
     'the numbering, the place-of-supply resolution and the branch-wise GSTR-1 fall out naturally '
     'instead of needing special cases.')

doc.add_heading('Stock on hand is not stored', level=3)
para('It is derived: opening quantity, plus what the bills brought in, less what the invoices sent '
     'out, plus or minus adjustments. A stored running quantity would be a second copy of a figure '
     'the documents already determine, and a stock number that disagrees with the purchase and '
     'sales history is worse than no number. What cannot be derived — damage, theft, a stocktake '
     'correction — has no document behind it, so those get a table.')

doc.add_heading('4.3  The chart of accounts', level=2)
para(f'{FACTS["chart"]} accounts are installed with every new organisation, numbered so the type is '
     'readable from the code. System accounts cannot be deleted because the posting engine names '
     'them directly.')
table(
    ['Range', 'Type', 'Examples'],
    [
        ('1000–1999', 'Assets', '1100 Accounts Receivable · 1290 Cash in Hand · '
                                '1310/1320/1330 Input GST · 1400 TDS Receivable'),
        ('2000–2999', 'Liabilities', '2100 Accounts Payable · 2210/2220/2230 Output GST · '
                                     '2240 RCM Payable · 2300 TDS Payable · 2400 Unearned Revenue'),
        ('3000–3999', 'Equity', '3100 Capital · 3200 Retained Earnings · '
                                '3300 Opening Balance Equity'),
        ('4000–4999', 'Income', '4100 Sales · 4200 Service Income · 4300 Shipping Income'),
        ('5000–6999', 'Expenses', '5100 Cost of Goods Sold · 5200 Purchases · '
                                  '6100 Rent · 6200 Salaries'),
    ],
    widths=[0.9, 0.9, 4.4], font=8.5,
)

# ═══════════════════════════════════════════════════════════════════════════
pagebreak()
doc.add_heading('5. Parties and party linking', level=1)

para('A party is a customer, a vendor, or both. Everything the system knows about who a business '
     'trades with lives in one table, and every document, payment and journal line that concerns a '
     'party points back at that row. This section describes that linking, because it is what makes '
     'a party balance answerable at any date rather than only today.')

doc.add_heading('5.1  One table, three roles', level=2)
para('The columns below are named after the implemented jurisdiction, because that is what the '
     'schema calls them. Every one of them is an instance of something a party record needs '
     'anywhere: a tax status, a registration number, a place of establishment, a withholding '
     'rule, and a payment obligation the law attaches to a class of supplier.')
para('Parties are held in contacts, with a kind of customer, vendor or both. A single record can '
     'be both — the same firm may buy from you and supply to you — and when it is, its receivable '
     'and its payable stay on opposite sides of the ledger rather than being netted. Netting them '
     'would hide a debt behind a credit and produce a balance sheet that understates both.')

table(
    ['Field', 'Why it exists'],
    [
        ('gst_treatment', 'Registered, unregistered, composition, overseas, SEZ, deemed export or '
                          'UIN. Decides whether tax is charged, who pays it, and which GSTR-1 '
                          'table the supply lands in. It drives the arithmetic, it is not a label.'),
        ('gstin', 'Validated on its mod-36 check digit. Characters 3 to 12 are the party PAN, so '
                  'the PAN never has to be asked for twice.'),
        ('state_code', 'The first two characters of the GSTIN. Together with the branch state it '
                       'decides CGST+SGST versus IGST on every document.'),
        ('is_msme, msme_udyam_no', 'A registered micro or small supplier starts the Section 43B(h) '
                                   'clock — pay within 45 days or lose the deduction for the year. '
                                   'The flag has to live on the vendor, not in a spreadsheet.'),
        ('tds_section', 'Which section applies to payments to this vendor. Thresholds are annual, '
                        'so the system accumulates against the party across the financial year.'),
        ('payment_terms', 'Sets the due date on every document raised for the party.'),
        ('credit_limit', 'Warns when outstanding exceeds it.'),
        ('opening_balance', 'What was owed when the books began.'),
    ],
    widths=[1.5, 4.7], font=8.5,
)

doc.add_heading('5.2  How a party links to documents', level=2)
para('Fourteen tables carry a foreign key back to contacts. The relationship is enforced by the '
     'database, not by convention, so a document cannot exist without a party behind it and a '
     'party cannot be deleted out from under its history.')

table(
    ['Points at a party through', 'Tables'],
    [
        ('customer_id', 'invoices, estimates, sales_orders, delivery_challans, credit_notes, '
                        'retainer_invoices, recurring_invoices'),
        ('vendor_id', 'bills, expenses, purchase_orders, vendor_credits'),
        ('contact_id', 'payments, cheques, bank_rules'),
        ('billable_customer_id', 'expenses — an expense to be re-billed to a client'),
    ],
    widths=[1.7, 4.5], font=8.5,
)

para('journal_lines carries the party too, but without a foreign key. It is the one deliberate '
     'exception: the column is denormalised from the entry so that ledger and ageing queries need '
     'no join, and it is the reason section 5.3 works the way it does.')

doc.add_heading('5.3  The link that matters most: the journal line', level=2)

para('Every journal line that touches Accounts Receivable or Accounts Payable carries the party it '
     'belongs to, indexed by organisation, party and date. That single column is what turns the '
     'ledger into a subsidiary ledger per party, and it has three consequences.')

rich([('A party balance is a ledger fact, not a document sum. ', True),
      ('Summing the unpaid amounts on a party’s open documents tells you what they owe now. '
       'Summing their AR journal lines up to a date tells you what they owed on that date. Only '
       'the second one can answer a question about 31 March in September.')])

rich([('Ageing ties to the control account at every date. ', True),
      ('The ageing report takes each party’s balance from the journal, filtered to the '
       'as-of date, and then spreads it across their open documents oldest first. Because the '
       'amount comes from the ledger rather than from each document’s current payment status, '
       'the ageing total equals the AR or AP control account balance on any date — not merely '
       'today. This is verified as part of the test suite.')])

rich([('A party statement is one query. ', True),
      ('Every movement for a party, in date order, comes from the journal lines carrying that '
       'contact id — invoices, receipts, credit notes and adjustments together, with no union of '
       'six document tables and no risk of one of them being forgotten.')])

callout(
    'The bug this design avoids',
    'A common implementation filters documents by date but reads today’s payment status '
    'against them. Ask that system what a customer owed on 31 March and it returns a figure that '
    'belongs to neither date — the March invoices, less the payments made since. Deriving the '
    'balance from dated journal lines is what makes the answer correct.',
    'FFF0F0',
)

doc.add_heading('5.4  Payments and allocation', level=2)
para('A payment is recorded against a party first and allocated to documents second. The '
     'allocation table is polymorphic on purpose — one payment can settle an invoice, a bill, a '
     'credit note, a vendor credit or a retainer, and five nullable foreign keys would be worse '
     'than one typed pair. Anything unallocated stays on the party’s account as an advance '
     'and is offered against their next document.')

para('The direction is checked: a receipt cannot be allocated against a bill. Crossing the two '
     'would credit a customer for paying a supplier, and the resulting entry would balance — which '
     'is exactly what makes the mistake hard to find later.')

doc.add_heading('5.5  Creating a party from inside a document', level=2)
para('Pickers for customers, vendors and items carry a "New …" action that opens a dialog instead '
     'of navigating to the master form. The record is written through the same endpoint and the '
     'same validation the full form uses, and the document being filled in survives.')

bullet('The dialog asks for what the document needs — name, GST treatment, state, and for vendors '
       'the MSME and TDS questions that change what a bill does. Addresses, credit limits and '
       'opening balances stay on the master screen.')
bullet('Entering a GSTIN fills in the state from its first two characters, so the pair cannot '
       'disagree.')
bullet('The document’s own change handler runs on the result, so a new customer’s '
       'payment terms set the due date and its state sets the place of supply, exactly as if the '
       'party had been picked from the list.')
bullet('A registered party cannot be saved without a GSTIN. Someone with no GSTIN is unregistered, '
       'which is a different treatment rather than a missing field.')

doc.add_heading('5.6  What a party screen shows', level=2)
para('Opening a customer or vendor gives the full position in one place: receivable or payable '
     'outstanding, their documents with status and balance, payments and unapplied advances, '
     'ageing buckets, year-to-date taxable billing (which is what the TDS threshold is measured '
     'against), MSME status with the 45-day countdown where it applies, and the ledger movements '
     'behind all of it.')

# ═══════════════════════════════════════════════════════════════════════════
pagebreak()
doc.add_heading('6. Functional modules', level=1)
para(f'{FACTS["pages"]} screens across nine modules. Each is listed with what it does and the '
     'accounting behind it where that is not obvious.')

para('Eight of the nine are the same for a business anywhere. The ninth — the tax and '
     'compliance module — is the jurisdiction module made visible: its screens are named after '
     'the returns and documents the implemented jurisdiction requires, and a second '
     'jurisdiction would add its own alongside them rather than change any of the others.')

MODULES = [
    ('Sales', [
        ('Customers', 'Party master with GST treatment, credit limit, terms and full transaction '
                      'history.'),
        ('Items', 'Goods and services with HSN or SAC, unit, rates and both prices.'),
        ('Estimates', 'Quotes, convertible to a sales order or straight to an invoice.'),
        ('Sales Orders', 'Confirmed orders, tracked against what has been invoiced.'),
        ('Delivery Challans', 'Goods moved without an invoice — job work, approval, exhibition.'),
        ('Invoices', 'The tax invoice. Live GST resolution, discounts per line, TDS deducted by '
                     'the customer, e-invoice and e-way bill status.'),
        ('Retainer Invoices', 'Advances taken against future work. Held as unearned revenue and '
                              'applied to invoices later; a retainer can only be applied once the '
                              'money has actually arrived.'),
        ('Payments Received', 'Receipts with allocation across open invoices, advances left on '
                              'account, and TDS the customer withheld.'),
        ('Credit Notes', 'Returns and corrections, with the output tax reversed.'),
        ('Recurring Invoices', 'Profiles that generate on a schedule.'),
    ]),
    ('Purchases', [
        ('Vendors', 'Party master with MSME registration, TDS section and composition status.'),
        ('Purchase Orders', 'Orders placed, tracked against bills received.'),
        ('Bills', 'Supplier invoices with input credit eligibility per line, reverse charge, and '
                  'TDS computed against the annual threshold for that vendor.'),
        ('Expenses', 'Direct costs with no supplier bill, optionally re-billable to a client.'),
        ('Payments Made', 'Payment runs with allocation, and TDS withheld at source.'),
        ('Vendor Credits', 'Supplier credit notes, with the input credit given back.'),
        ('MSME 45-Day Tracker', 'Unpaid micro and small supplier bills with a countdown to the '
                                'Section 43B(h) deadline.'),
    ]),
    ('Banking', [
        ('Accounts', 'Bank, cash, card, wallet and clearing accounts, each tied to a ledger '
                     'account so a statement can be compared with the books.'),
        ('Reconcile', 'Two-pane workspace: statement lines against the books, with suggested '
                      'matches, split and create-inline, and a running difference that has to '
                      'reach zero.'),
        ('Imports', 'Statement import with duplicate detection across re-imports.'),
        ('Rules', 'Patterns that categorise the transactions that repeat every month.'),
        ('Transfers', 'Movements between own accounts, which are not income or expense.'),
        ('Cheques & PDCs', 'Cheques issued and received, with maturity dates. Nothing posts until '
                           'one clears.'),
    ]),
    ('Accountant', [
        ('Manual Journals', 'Direct entries for what no document explains — depreciation, '
                            'provisions, corrections.'),
        ('Chart of Accounts', 'The account tree, with system accounts protected.'),
        ('Opening Balances', 'What was carried forward when the books began.'),
        ('Budgets', 'Targets per account, per branch, per period, against actuals.'),
        ('Recurring Journals', 'Entries that repeat monthly, such as depreciation.'),
        ('Period Close', 'The checklist before a period is declared final.'),
        ('Transaction Locking', 'Per-module lock dates. Sales are usually finalised before '
                                'purchases, so one blunt lock for the whole book makes everyone '
                                'wait for the slowest module.'),
        ('Audit Trail', 'Every create, change, approval and void, with actor, time and address.'),
    ]),
    ('GST & Taxes', [
        ('E-Invoices', 'The IRN queue, ordered by urgency, with the 30-day reporting window '
                       'counted down per invoice.'),
        ('E-Way Bills', 'Consignments above ₹50,000, with validity of one day per 200 km.'),
        ('GSTR-1', 'Outward supplies section by section — B2B, B2C large and small, exports, '
                   'credit notes, HSN summary — with the portal JSON.'),
        ('GSTR-3B', 'The summary return, with the input credit set-off applied in the order '
                    'Section 49A prescribes: integrated credit first, and against integrated tax '
                    'before the others.'),
        ('ITC Reconciliation', 'Purchase register against GSTR-2B, in four buckets: matched, '
                               'mismatched, missing in 2B, and missing in the books.'),
        ('TDS & TCS', 'Deductions by section, measured against annual thresholds.'),
    ]),
    ('Inventory', [
        ('Stock on Hand', 'Derived from documents; never stored.'),
        ('Adjustments', 'Damage, theft, stocktake corrections — the movements no document '
                        'explains.'),
        ('Warehouses', 'Locations, optionally tied to a branch.'),
    ]),
    ('Reports', [
        (f'{FACTS["reports"]} reports',
         'Trial balance, profit and loss, balance sheet, cash flow, general ledger, day book, '
         'journal report, AR and AP ageing with detail, sales and purchase registers, party '
         'balances, business ratios, time-to-get-paid, and the document-level registers. Every '
         'figure is computed from the journal on request and every report is exportable.'),
    ]),
    ('Settings', [
        ('Organisation', 'Name, PAN, registration type, financial year.'),
        ('HSN & SAC Codes', 'The approved list. Invoice lines may pick from here and nowhere else, '
                            'because GSTR-1 Table 12 is validated against the official master and '
                            'a code that does not exist bounces the whole return rather than one '
                            'line.'),
        ('Numbering, custom fields, automation, integrations', 'Configuration and extension '
                                                               'points.'),
    ]),
    ('Other', [
        ('Dashboard', 'Cash, receivables, payables, profit, sales performance, and the two '
                      'deadlines that cost money — invoices without an IRN, and MSME bills nearing '
                      'day 45.'),
        ('AI Assistant', 'Questions answered against the ledger, and checks run over the books.'),
        ('Customer Portal', 'The customer-facing view of their own invoices and balance. Currently '
                            'a signed-in preview — see section 13.'),
    ]),
]

for module, screens in MODULES:
    doc.add_heading(module, level=2)
    table(['Screen', 'What it does'], screens, widths=[1.5, 4.7], font=8.5)

# ═══════════════════════════════════════════════════════════════════════════
pagebreak()
doc.add_heading('7. Trading internationally', level=1)

para('A business that sells beyond its own borders is taxed three different ways on the same '
     'goods: one rate at home, another into a neighbouring jurisdiction under the same tax system, '
     'and nothing at all on a genuine export. Getting that wrong is not a rounding error — it is '
     'either tax charged that should not have been, or tax not charged that will be demanded later '
     'with interest.')

doc.add_heading('7.1  What is working today', level=2)

para('Cross-border sales are handled end to end. The supply type is resolved from where the seller '
     'is registered, where the goods or services are supplied, and what kind of party the customer '
     'is — and everything downstream follows from that one answer.')

table(
    ['Situation', 'Treatment', 'Effect on the books'],
    [
        ('Customer in the same tax jurisdiction as the selling registration',
         'Domestic supply', 'Tax split between the two domestic components'),
        ('Customer in a different jurisdiction under the same tax system',
         'Interstate supply', 'A single combined tax at the full rate'),
        ('Overseas customer, exemption undertaking held',
         'Export, zero-rated', 'No tax charged; the supply is still reported'),
        ('Overseas customer, no undertaking',
         'Export with tax', 'Tax charged and reclaimable as a refund'),
        ('Special economic zone unit or developer',
         'Treated as an export', 'Zero-rated, reported separately'),
        ('Overseas supplier, reverse charge applies',
         'Buyer accounts for the tax', 'Liability and credit posted together'),
    ],
    widths=[2.3, 1.5, 2.4], font=8.5,
)

para('The party record carries the treatment, so it is applied consistently rather than being '
     'decided per invoice. An overseas customer never has domestic tax charged to it by accident, '
     'and a zero-rated export still appears in the return — omitting it is as much a filing error '
     'as charging the wrong rate.')

doc.add_heading('7.2  Multiple registrations', level=2)

para('A business trading in several jurisdictions usually holds a separate tax registration in '
     'each, and those registrations are not interchangeable: each files its own return and each '
     'numbers its own documents. The system models a registration rather than an office, which is '
     'what makes the numbering, the supply-type resolution and the per-registration return fall '
     'out naturally instead of needing special cases.')

bullet('Each registration keeps its own document series, restarting at one each financial year.')
bullet('A user may be granted access to one registration or several; a document can only be '
       'raised under one they hold.')
bullet('Returns, ageing and the statements can be read for one registration or for the business '
       'as a whole.')

doc.add_heading('7.3  Currency', level=2)

para('The organisation has a base currency, and the ledger is kept in it. Every amount in the '
     'database, on every report and in every total is that one currency, which is what allows the '
     'trial balance to be summed at all — a ledger holding mixed currencies without conversion '
     'does not balance in any of them.')

callout(
    'Multi-currency is on the roadmap, and is not built',
    'Invoicing a customer in a currency other than the base one requires an exchange rate on the '
    'document, a realised gain or loss when it is settled at a different rate, and a revaluation '
    'of open balances at period end. The base-currency field exists; none of that machinery does. '
    'A business exporting today invoices in its base currency, which is common practice but not '
    'universal. Section 17 places this first on the roadmap.',
    'FFF6E5',
)

doc.add_heading('7.4  Adding a jurisdiction', level=2)

para('The work of supporting a new country is contained. What has to be written is a tax module '
     'answering a fixed set of questions; what does not have to be touched is the ledger, the '
     'documents, the reports or the audit trail.')

table(
    ['A jurisdiction module supplies', 'Example from the implemented one'],
    [
        ('The taxes that exist and their components',
         'India: a central and a state component domestically, a single integrated tax across '
         'state lines'),
        ('How a supply is classified',
         'By the seller’s registration, the place of supply and the customer’s status'),
        ('The registration number format and its validation',
         'A 15-character identifier with an embedded jurisdiction code and a check digit'),
        ('The product classification scheme',
         'Tariff codes for goods and service codes for services, from an approved list'),
        ('Which input tax may be recovered, and which is blocked',
         'Blocked categories become part of the cost rather than an asset'),
        ('Withholding rules and their thresholds',
         'Section-based withholding measured against an annual limit per supplier'),
        ('The statutory returns and their formats',
         'Two monthly returns and a supplier-matching statement'),
        ('Statutory deadlines that carry a penalty',
         'A 30-day reporting window, and a 45-day payment obligation to small suppliers'),
    ],
    widths=[2.4, 3.8], font=8.5,
)

para('The candidates most often asked for are value added tax regimes — the Gulf states, the '
     'United Kingdom, the European Union — and sales tax in the United States. The first group '
     'maps closely onto what is already built, because the structure of the questions is the same. '
     'United States sales tax differs more, being levied by thousands of local authorities rather '
     'than nationally, and would need a rate service behind it.')

pagebreak()
doc.add_heading('8. Tax compliance by jurisdiction', level=1)

callout(
    'India is the implemented jurisdiction',
    'This section describes the tax module that exists today. It is deliberately specific, because '
    'a jurisdiction module is specific by nature — the value of reading it is seeing the depth a '
    'module goes to, which is the standard any further jurisdiction is held to.',
    'EAF2FF',
)

doc.add_heading('8.1  Supply resolution', level=2)
para('The engine answers one question first: what kind of supply is this? The seller’s '
     'registration, the place of supply and the customer’s tax status decide it, and everything '
     'else follows.')
table(
    ['Situation', 'Result'],
    [
        ('Registration state equals place of supply', 'Intra-state — CGST + SGST, half each'),
        ('Different states', 'Inter-state — a single IGST at the full rate'),
        ('Overseas customer, LUT held', 'Export — zero-rated, no tax charged'),
        ('Overseas customer, no LUT', 'Export with tax, refundable'),
        ('SEZ unit or developer', 'Treated as an export'),
        ('Unregistered vendor, notified supply', 'Reverse charge — the buyer pays the tax and '
                                                 'claims it back'),
        ('Composition dealer', 'No tax charged, and no input credit available to the buyer'),
    ],
    widths=[2.6, 3.6], font=8.5,
)
para('Registration numbers are validated on format and on the mod-36 check digit, not merely on '
     'length. The same engine is used by the invoice form, the API and the return preparation, so '
     'the figure on the screen and the figure in the return cannot disagree.')

doc.add_heading('8.2  Input tax credit', level=2)
para('Credit is tracked per line, not per bill. Section 17(5) blocks it on motor vehicles, food '
     'and beverages, club memberships, works contracts for immovable property and personal '
     'consumption — and where it is blocked the tax becomes part of the cost rather than an asset. '
     'Reverse-charge purchases post both sides: the liability to pay the tax, and the credit for '
     'having paid it.')

doc.add_heading('8.3  Returns', level=2)
bullet('GSTR-1 is prepared section by section, with the HSN summary that Table 12 requires, and '
       'exported as portal JSON.')
bullet('GSTR-3B applies the set-off order Section 49A prescribes: integrated credit is used '
       'first, and against integrated tax before central or state tax.')
bullet('GSTR-2B reconciliation compares the purchase register against what suppliers filed, in '
       'four buckets, because credit claimed on an invoice a supplier never filed is credit that '
       'will be reversed with interest.')

doc.add_heading('8.4  E-invoicing and e-way bills', level=2)
para('A B2B invoice above the turnover threshold is not legally valid without an IRN, and the '
     'reporting window is 30 days from the invoice date — after which the portal refuses it and '
     'the invoice must be cancelled and reissued. The queue is therefore ordered by urgency and '
     'the countdown is shown per invoice rather than buried.')
para('An e-way bill is required for a consignment of goods worth more than ₹50,000 that moves. '
     'Validity is one day per 200 km with a minimum of one day, counted from generation. Services '
     'never need one, because nothing travels.')

doc.add_heading('8.5  Withholding tax and the small-supplier rule', level=2)
para('TDS thresholds are annual, so the system accumulates taxable billing per vendor across the '
     'financial year and begins withholding when the threshold is crossed — at the rate the '
     'vendor’s PAN status earns, which is materially higher without one. Section 194C, for '
     'example, applies at ₹30,000 for a single payment or ₹1,00,000 across the year.')
para('Section 43B(h) disallows an expense entirely if a registered micro or small supplier is not '
     'paid within 45 days — the deduction returns only in the year the payment is actually made. '
     'The tracker counts those days from the bill date on every unpaid MSME bill and warns from '
     'day 38.')

# ═══════════════════════════════════════════════════════════════════════════
pagebreak()
doc.add_heading('9. Money and arithmetic', level=1)

para('Amounts are stored as DECIMAL(19,4) in MySQL and handled as integer paise everywhere else. '
     'Rates and quantities use DECIMAL(19,6). Conversion happens at exactly two points — reading '
     'from the database and writing to it — and between them the arithmetic is on integers and '
     'strings.')

para('Rounding is half-up at the minor unit. Where a jurisdiction requires the document total to '
     'be rounded to a whole major unit — as India does — the difference is posted to a rounding '
     'account rather than absorbed, because the printed invoice has to show it.')

para('Number formatting follows the locale rather than a fixed pattern. The same amount reads as '
     '₹12,34,567.00 under Indian grouping and 1,234,567.00 under the grouping used almost '
     'everywhere else; the stored value is identical, and only the presentation differs.')

callout(
    'Why this is not over-engineering',
    'A floating-point rupee is accurate to about fifteen significant digits, which sounds like '
    'plenty until a year of lines is summed and the trial balance is out by four paise. It will '
    'still balance to a human reading the report, and it will not balance to the constraint that '
    'refuses unbalanced entries — so the failure appears as a rejected save weeks later, with no '
    'obvious cause.',
    'EAF2FF',
)

# ═══════════════════════════════════════════════════════════════════════════
doc.add_heading('10. Security and audit', level=1)

doc.add_heading('10.1  Authentication', level=2)
bullet('Passwords are hashed with argon2id at the OWASP minimum — 19 MiB of memory, two '
       'iterations, one lane. The cost is encoded in the hash, so raising it later keeps old '
       'hashes verifying.')
bullet('Sessions are rows in a table, not self-contained tokens. When an administrator disables a '
       'user or somebody signs out, access stops immediately on every device — which a JWT cannot '
       'do without a revocation list, which is a sessions table with extra steps.')
bullet('The cookie carries a random 256-bit token; what is stored is its SHA-256, so a database '
       'leak does not hand over live sessions. The cookie is httpOnly, sameSite=lax and secure.')
bullet('An account locks for fifteen minutes after eight consecutive failures. A sign-in against '
       'an unknown email burns the same amount of time as a real one, so the form cannot be used '
       'to enumerate addresses.')

doc.add_heading('10.2  Roles', level=2)
table(
    ['Role', 'May do'],
    [
        ('Admin', 'Everything, including settings, period locks and user management'),
        ('Accountant', 'Sales, purchases, banking, journals and GST; reads settings'),
        ('Sales', 'Quotes and invoices; purchase costs and margins stay hidden'),
        ('Staff', 'Create in sales and purchases; no approval or void'),
        ('Viewer', 'Read-only across the book — for auditors'),
    ],
    widths=[1.1, 5.1], font=9,
)
para('One permission matrix is shared by the interface and the API. The interface uses it to '
     'decide what to render; the route handler uses it to decide whether to answer. Keeping one '
     'copy means the two cannot drift apart about what a role may do.')

doc.add_heading('10.3  The audit trail', level=2)
para('Every create, change, approval, void, sign-in, import and export is recorded with the actor, '
     'the time to the millisecond, the target, the IP address and the user agent. The module has '
     'an insert path and no update or delete path anywhere in the codebase, and there is no '
     'setting that turns it off — because Rule 11(g) does not permit one.')

# ═══════════════════════════════════════════════════════════════════════════
pagebreak()
doc.add_heading('11. Organisations and the demo book', level=1)

doc.add_heading('11.1  Sign-up', level=2)
para('Anyone can create an organisation from the public site. It is created together with its '
     'first GST registration and its owner inside a single transaction, and the owner is signed in '
     'immediately.')
para('A new book gets the standard chart of accounts, a Cash in Hand account so the first receipt '
     'can be recorded before any bank is connected, and numbering that starts at one for the '
     'current financial year. Nothing else — no sample customers, no demo invoices. A book that '
     'starts with somebody else’s data is not your book, and the first person to notice is '
     'the auditor.')
para('If a GSTIN is given it is checked against its own check digit and against the state chosen, '
     'because a mismatch between the two would put CGST+SGST where IGST belongs on every invoice '
     'that business ever raises. A business with no GSTIN is recorded as unregistered rather than '
     'being refused, since plenty trade below the registration threshold.')

doc.add_heading('11.2  The demo book', level=2)
para('The demo organisation is a real row carrying an is_demo flag, and that flag is the whole '
     'mechanism:')
bullet('The one-click door on the sign-in page can only ever open onto an organisation with it '
       'set. It takes no input that names an organisation, so it cannot be pointed at a customer '
       'ledger.')
bullet('The banner reading "Demo book · nothing here is filed with any portal" appears only where '
       'it is set. On a real book that space stays empty, because a permanent demo label over '
       'somebody’s actual ledger teaches them to distrust what the screen says.')
bullet('The seed script’s rebuild deletes only organisations with it set, scoped by org_id, '
       'so a customer ledger is never in range.')
para('Nothing that comes through the sign-up form can set the flag. It defaults to off, which is '
     'the safe direction for a default to fail in.')

# ═══════════════════════════════════════════════════════════════════════════
doc.add_heading('12. Brand and public site', level=1)

doc.add_heading('12.1  Identity', level=2)
para('One module holds the name, the tagline and the artwork, so they cannot drift apart between '
     'the sidebar, the sign-in screen, the landing page and the page metadata. Every image is '
     'derived from one master file by a script, including the dark-theme variants — which are made '
     'by repainting the navy rather than filtering the whole image, because a filter would take '
     'the teal and blue of the glyph with it.')
table(
    ['Element', 'Value'],
    [
        ('Name', 'REKONZA AI'),
        ('Tagline', 'Books. Made Smarter.'),
        ('Navy', '#002F6E'),
        ('Blue', '#0A7CFF'),
        ('Teal', '#00CFC0'),
        ('Typeface', 'IBM Plex Sans, with IBM Plex Mono for figures and codes'),
    ],
    widths=[1.4, 4.8], font=9,
)

doc.add_heading('12.2  The public site', level=2)
para('The landing page is a static server component with no session read, so it renders '
     'immediately for a visitor and for a crawler. It carries the product claims the code can '
     'stand behind, a real screenshot of the application in both themes, and a plain statement of '
     'what is not connected — an accounting product that oversells on its landing page has already '
     'told its first lie.')
para('Search visibility is complete: canonical URLs, an Open Graph card, a Twitter card, '
     'robots.txt excluding every authenticated route, a sitemap, a web app manifest, and JSON-LD '
     'describing the organisation, the site and the software. The sign-in and sign-up pages carry '
     'their own titles so no two indexed pages share one.')

# ═══════════════════════════════════════════════════════════════════════════
pagebreak()
doc.add_heading('13. Accounting-system integrations', level=1)

para('Very few businesses replace their accounting system in one step. Most run a new one '
     'alongside the incumbent for a year, and their accountant or auditor keeps working in '
     'whatever they already know. An integration that hands over a period cleanly is therefore '
     'not a convenience — it is what makes adoption possible at all.')

para('Each market has a different incumbent: Tally across India, QuickBooks and Xero across the '
     'English-speaking markets, DATEV in Germany, and others besides. They differ in their '
     'wire formats and in how they are reached, but the problem is the same one every time — '
     'map our parties, accounts and vouchers onto theirs, transfer a closed period, and prove '
     'the two ledgers agree afterwards. Tally is described here in full because it is the '
     'first to be built and because it is the hardest of them: it is desktop software, which '
     'the others are not. The rules in 13.4 are written to outlast it.')

callout(
    'Status: planned, not built',
    'No Tally code exists in the current build. This section records the design intent and the '
    'mapping so that the data model can be checked against it now, while changing the model is '
    'still cheap. Nothing in this section should be read as a description of working software.',
    'FFF6E5',
)

doc.add_heading('13.1  Why Tally comes first', level=2)
para('Tally is where most accountants and auditors in the Indian market already work, and India '
     'is the jurisdiction the product implements today. A business running REKONZA AI day to day '
     'will still be asked for a Tally company by its chartered accountant at year end, and '
     're-keying a year of vouchers is both expensive and a source of differences nobody can '
     'explain. The integration exists to make that hand-off a transfer rather than a '
     'transcription.')

doc.add_heading('13.2  Shape of the integration', level=2)
para('Tally Prime is desktop software. It exposes an XML request-response interface over HTTP on '
     'the local machine — port 9000 by default — which is reachable from the same network but not '
     'from a hosted application. The integration therefore needs a small local agent installed '
     'alongside Tally: it authenticates outward to REKONZA AI, pulls what is due to be sent, and '
     'posts it into Tally over that local interface. No inbound port is opened on the customer '
     'network.')

mono(
    'REKONZA AI (hosted)        Bridge agent (customer PC)        Tally Prime\n'
    '  export queue      ──▶      polls, authenticates      ──▶     XML on :9000\n'
    '  status per record ◀──      reports success/failure   ◀──     voucher GUID'
)

doc.add_heading('13.3  What maps to what', level=2)
para('The mapping is direct because both systems are double-entry underneath. The one real '
     'difference is that Tally models a party as a ledger account under a group, where this system '
     'holds the party in a master table and posts to a single control account with the party on '
     'the line. That is the translation the bridge performs, and it is why section 5 matters here.')

table(
    ['REKONZA AI', 'Tally', 'Notes'],
    [
        ('Organisation', 'Company', 'One company per organisation and financial year'),
        ('Tax registration', 'Godown or cost centre', 'Tally keeps one registration per company, '
                                                     'so several need one company each'),
        ('Contact, kind = customer', 'Ledger under Sundry Debtors',
         'GSTIN, state and registration type carried across'),
        ('Contact, kind = vendor', 'Ledger under Sundry Creditors',
         'A party that is both becomes two ledgers, which is Tally’s own convention'),
        ('Account (chart of accounts)', 'Ledger under the matching group',
         'Fixed mapping table; the standard chart maps one-to-one'),
        ('Item', 'Stock Item', 'With unit, HSN and GST rate'),
        ('HSN / SAC code', 'GST classification', 'Only approved codes are ever sent'),
        ('Invoice', 'Sales voucher', 'With GST analysis per line'),
        ('Bill', 'Purchase voucher', 'Input credit eligibility carried per line'),
        ('Credit note / vendor credit', 'Credit Note / Debit Note voucher', ''),
        ('Payment received', 'Receipt voucher', 'With bill-wise allocation'),
        ('Payment made', 'Payment voucher', 'With bill-wise allocation'),
        ('Manual journal', 'Journal voucher', ''),
        ('Bank transfer', 'Contra voucher', ''),
    ],
    widths=[1.7, 1.7, 2.8], font=8.5,
)

doc.add_heading('13.4  Rules the integration must hold to', level=2)

rich([('One direction at a time. ', True),
      ('The first release pushes from REKONZA AI into Tally and does not read back. Two systems '
       'both claiming to own the same voucher is how ledgers diverge, and a two-way sync needs a '
       'conflict rule that neither product can supply on its own.')])

rich([('Our document number is the idempotency key. ', True),
      ('Each voucher carries the source document number, and the bridge records the Tally GUID it '
       'received. A record already exported is never sent again, so a retry after a network '
       'failure cannot produce a duplicate voucher — the failure mode that makes people abandon '
       'these integrations.')])

rich([('Masters before vouchers. ', True),
      ('A voucher naming a ledger Tally does not have is rejected. Parties, accounts and stock '
       'items are exported and confirmed first, in dependency order.')])

rich([('Bill-wise details are not optional. ', True),
      ('A receipt exported without its allocation leaves the Tally party ledger correct in total '
       'and useless for ageing. Every payment carries its allocations across, against the '
       'reference of the document it settles.')])

rich([('Locked periods only. ', True),
      ('A period is exported once it is locked, so what reaches Tally is a closed period rather '
       'than a moving one. This also means the export can be an append rather than a merge.')])

rich([('The export is reconciled, not assumed. ', True),
      ('After a period is exported the bridge reads back the Tally trial balance and compares it '
       'with ours, account by account. An integration that reports success without proving the two '
       'ledgers agree is an integration that hides its own failures.')])

doc.add_heading('13.5  Delivery plan', level=2)
table(
    ['Phase', 'Scope'],
    [
        ('1', 'Export file — a Tally-compatible XML download per period, imported by hand. No '
              'agent, no network work; proves the mapping and the reconciliation.'),
        ('2', 'Bridge agent — polls, posts and reports status; masters and vouchers, one '
              'direction, with idempotency and the trial-balance check.'),
        ('3', 'Scheduled sync — automatic export as each period is locked, with a status screen '
              'and a per-record error log.'),
        ('4', 'Read-back — importing vouchers entered directly in Tally, once a conflict rule '
              'has been agreed with the customer.'),
    ],
    widths=[0.6, 5.6], font=9,
)

# ═══════════════════════════════════════════════════════════════════════════
pagebreak()
doc.add_heading('14. What is not connected yet', level=1)

para('Stated plainly, because the application itself says so where a user would go looking for '
     'these, rather than showing a green badge over nothing.')

table(
    ['Capability', 'Status', 'What it needs'],
    [
        ('Live IRN registration', 'Simulated',
         'A contract with a GST Suvidha Provider. The queue, the window countdown and the payload '
         'are built; only the call to the portal is not.'),
        ('Live e-way bill generation', 'Simulated', 'The same GSP contract'),
        ('Automatic bank feeds', 'Not connected',
         'An Account Aggregator licence, which accounting software does not hold. Statement import '
         'and reconciliation work fully.'),
        ('Outbound email', 'Not connected',
         'A mail transport. Invoices can be printed and downloaded but not sent from the app.'),
        ('Payment collection', 'Not connected',
         'A merchant account and gateway. The portal button explains this rather than failing.'),
        ('Receipt and bill OCR', 'Not built', 'A document extraction service'),
        ('Customer portal', 'Preview only',
         'Tokenised per-customer links, which need the mail transport above. Today it is a '
         'signed-in preview of what a customer would see, reading the real ledger.'),
        ('User and branch management UI', 'Not built',
         'The model, roles and permissions exist and are enforced; the administration screens are '
         'not written. Users are created by the sign-up flow or directly.'),
        ('Multi-currency invoicing', 'Not built',
         'Per-document exchange rates, realised gain and loss on settlement, and revaluation of '
         'open balances at period end. The base-currency field exists; the machinery does not.'),
        ('Tax jurisdictions beyond India', 'Not built',
         'One module per jurisdiction, against the interface set out in section 7.4. The layer '
         'they plug into is built and in use.'),
        ('Accounting-system integrations', 'Planned', 'See section 13'),
        ('Payroll, manufacturing, fixed-asset depreciation, multi-entity consolidation',
         'Out of scope', 'Deliberately excluded from this phase'),
    ],
    widths=[1.6, 1.0, 3.6], font=8.5,
)

# ═══════════════════════════════════════════════════════════════════════════
doc.add_heading('15. Running and deploying', level=1)

doc.add_heading('15.1  Environment', level=2)
table(
    ['Variable', 'Purpose'],
    [
        ('DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME', 'MySQL connection'),
        ('DB_CONNECTION_LIMIT, DB_QUEUE_LIMIT', 'Pool sizing'),
        ('SESSION_SECRET', '32+ random bytes; rotating it invalidates every active session'),
        ('SESSION_TTL_HOURS', 'Session lifetime; one week by default'),
        ('NEXT_PUBLIC_SITE_URL', 'Canonical origin for metadata, sitemap, robots and JSON-LD'),
        ('APP_ENV', 'Set to production to refuse destructive scripts'),
    ],
    widths=[2.4, 3.8], font=8.5,
)

doc.add_heading('15.2  Commands', level=2)
mono(
    'npm install\n'
    'cp .env.example .env.local        # then fill it in\n'
    'npm run db:migrate                # apply migrations, checksum-enforced\n'
    'npm run db:seed                   # build the demo organisation\n'
    'npm run dev                       # http://localhost:5000\n'
    'npm run build && npm start        # production\n'
    '\n'
    'npm run db:seed -- --fresh        # rebuild the demo book only\n'
    'npm run db:status                 # which migrations are applied\n'
    'npm run brand:assets              # regenerate every logo and icon'
)

doc.add_heading('15.3  Migrations', level=2)
para('Migrations are plain SQL files numbered by hand and applied in order. Each is checksummed '
     'when applied, and a file edited afterwards is refused rather than silently skipped — which '
     'is what stops two environments believing they are on the same schema when they are not.')

# ═══════════════════════════════════════════════════════════════════════════
doc.add_heading('16. Testing and verification', level=1)

table(
    ['Suite', 'Command', 'Covers'],
    [
        ('Unit', 'npm run test:unit',
         'Posting engine, money arithmetic, GST resolution, sales and purchase services — 86 tests'),
        ('API', 'npm run test:api',
         'Authentication, permissions, and the shape of what crosses the wire, against a live '
         'server — 29 tests'),
        ('Auth flow', 'node scripts/auth-flow.mjs',
         'Sign-in, lockout, cookie properties, session revocation — 13 checks'),
        ('UI flows', 'npm run flows',
         'End-to-end journeys through every module — 133 checks'),
        ('Smoke', 'npm run smoke',
         'Every route renders with no console errors — 86 routes'),
        ('Onboarding', 'node scripts/onboarding.mjs',
         'Landing page, sign-up, empty-book correctness, the demo door — 23 checks'),
        ('Quick create', 'node scripts/quick-create.mjs',
         'Creating parties and items from inside a document — 22 checks'),
    ],
    widths=[0.9, 1.6, 3.7], font=8.5,
)

doc.add_heading('The invariants that are checked every run', level=2)
bullet('The trial balance ties — debits equal credits to the paisa.')
bullet('The balance sheet balances — assets equal liabilities plus equity.')
bullet('Profit reconciles — the profit and loss net result equals current-year earnings on the '
       'balance sheet.')
bullet('Ageing ties to its control account — at every date tested, not only today.')
bullet('Every posted entry is individually balanced.')

# ═══════════════════════════════════════════════════════════════════════════
doc.add_heading('17. Roadmap', level=1)
para('Ordered by what unblocks the most, not by what is easiest. The first two items are what '
     'stand between the product and customers outside its first market.')

table(
    ['Priority', 'Item', 'Why it is next'],
    [
        ('1', 'Multi-currency',
         'Exchange rates per document, realised gain and loss, period-end revaluation. Until '
         'this exists an exporter must invoice in its own currency, which many customers will '
         'not accept.'),
        ('2', 'A second tax jurisdiction (value added tax)',
         'Proves the jurisdiction layer against a regime it was not written for, which is the '
         'only way to find out where the seam actually is'),
        ('3', 'Statutory-filing provider contract for the implemented jurisdiction',
         'The only compliance gap that touches a legal obligation today'),
        ('4', 'Accounting-system export (phase 1)',
         'Removes the year-end re-keying that every customer otherwise faces'),
        ('5', 'User and registration management screens',
         'The model and its enforcement exist; only the administration interface is missing'),
        ('6', 'Mail transport',
         'Unblocks sending invoices, payment reminders, and the tokenised customer portal'),
        ('7', 'Statutory print template per jurisdiction',
         'A printed invoice must carry every particular its jurisdiction requires'),
        ('8', 'Payment collection',
         'Turns the portal from a statement into a collection channel'),
        ('9', 'Bridge agent (phases 2–3)', 'Automates what phase 1 does by hand'),
    ],
    widths=[0.7, 2.1, 3.4], font=9,
)

# ═══════════════════════════════════════════════════════════════════════════
pagebreak()
doc.add_heading('Appendix A — API endpoints', level=1)
para(f'{FACTS["routes"]} route handlers. Every one authenticates the session and checks the '
     'role’s permission for its module before doing anything, except the four marked public.')

PUBLIC = {'/api/health', '/api/auth/login', '/api/auth/register', '/api/auth/demo'}
rows = [(r, 'Public' if r in PUBLIC else 'Authenticated') for r in API_ROUTES]
table(['Endpoint', 'Access'], rows, widths=[4.6, 1.6], font=8.5)

pagebreak()
doc.add_heading('Appendix B — Database tables', level=1)
para(f'{FACTS["tables"]} tables across {FACTS["migrations"]} migrations.')
table(['Table', 'Introduced in'], TABLES, widths=[3.4, 2.8], font=8.5)

pagebreak()
doc.add_heading('Appendix C — Reports', level=1)
para(f'{FACTS["reports"]} reports, every figure computed from the journal on request.')
PRETTY = {
    'ar-ageing': 'AR Ageing Summary', 'ap-ageing': 'AP Ageing Summary',
    'ar-ageing-details': 'AR Ageing Details', 'profit-and-loss': 'Profit and Loss',
    'gstr1': 'GSTR-1',
}
rows = [(PRETTY.get(r, r.replace('-', ' ').title()), f'/reports/{r}') for r in REPORTS]
table(['Report', 'Route'], rows, widths=[3.2, 3.0], font=8.5)

# ── Footer on every page ────────────────────────────────────────────────────
for section in doc.sections:
    p = section.footer.paragraphs[0]
    p.text = f'REKONZA AI — Project Documentation · {FACTS["date"]} · build {FACTS["commit"]}'
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for r in p.runs:
        r.font.size = Pt(8)
        r.font.color.rgb = MUTED

doc.save(OUT)
print(f'Wrote {OUT}')
print(f'  {FACTS["tables"]} tables · {FACTS["routes"]} routes · {FACTS["reports"]} reports '
      f'· {FACTS["pages"]} screens')
