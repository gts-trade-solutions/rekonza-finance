// The user manual: how to do the everyday things, screen by screen. Kept with
// the code so a change to a screen and a change to its help travel together.

export interface HelpTopic {
  id: string;
  area: string;
  title: string;
  summary: string;
  steps: string[];
  links: { label: string; href: string }[];
}

export const HELP: HelpTopic[] = [
  {
    id: 'setup', area: 'Getting started', title: 'Setting up your books',
    summary: 'Your business details, GST registration and opening balances, before the first invoice.',
    steps: [
      'Settings → Organisation: the legal name, PAN, address and each branch with its GSTIN and state. A branch is a GST registration; invoices are raised from one.',
      'Settings → Statutory: regular or composition registration, whether e-invoicing applies to you and from when, and monthly or quarterly (QRMP) filing.',
      'Accountant → Opening Balances: what each account held on the day you start, and the invoices and bills still unpaid then.',
      'Settings → Numbering: the prefix of each document series. GST allows sixteen characters for an invoice number.',
    ],
    links: [{ label: 'Settings', href: '/settings' }, { label: 'Opening balances', href: '/accountant/opening-balances' }],
  },
  {
    id: 'users', area: 'Getting started', title: 'Users, roles and two-step sign-in',
    summary: 'Who can sign in, what each may do, and the extra code that protects an account.',
    steps: [
      'Settings → Users & roles → Add user. A temporary password is shown once; pass it on privately. They change it in Settings → Sign-ins.',
      'Choose a standard role, or one of your own: New role sets, part by part, what it may view, create, edit, approve or void — including which groups of reports.',
      'Settings → Sign-ins → Two-step sign-in: scan the code with an authenticator app and keep the ten recovery codes.',
      'Settings → Policies → Require two-step sign-in, for admins or everyone. Turn it on for yourself first.',
      'Lost phone: an admin clears the user\'s two-step sign-in from Users & roles; they set it up again at the next sign-in.',
    ],
    links: [{ label: 'Users & roles', href: '/settings' }],
  },
  {
    id: 'parties', area: 'Sales & purchases', title: 'Customers and suppliers',
    summary: 'The GSTIN and state decide the tax; MSME status and bank details matter for paying them.',
    steps: [
      'Sales → Customers or Purchases → Vendors → New. The GSTIN fills the state; an unregistered party needs the state of supply.',
      'For a supplier registered under MSMED: the Udyam number, category and agreed payment days (at most 45). Late payment is flagged on MSME Payments.',
      'Bank account and IFSC are needed to pay a supplier through a payment batch.',
      'A customer can carry a price list and a currency other than rupees.',
    ],
    links: [{ label: 'Customers', href: '/sales/customers' }, { label: 'Vendors', href: '/purchases/vendors' }],
  },
  {
    id: 'invoice', area: 'Sales & purchases', title: 'Raising an invoice',
    summary: 'GST, the number in the series, the ledger entry and the e-invoice all follow from saving it.',
    steps: [
      'Sales → Invoices → New invoice. Pick the customer; the place of supply decides IGST against CGST and SGST.',
      'Add lines from items, or type them with their HSN/SAC and rate. Batches are picked first-to-expire for batch-tracked items.',
      'A voucher type numbers the invoice in its own series (for example exports); an invoice in another currency is booked in rupees at the rate.',
      'Save: the entry is posted. Where e-invoicing applies, the IRN is requested from the portal; an e-way bill can be made from the invoice.',
      'A mistake is corrected by a credit note, or by voiding with a reason — never by editing a posted invoice.',
    ],
    links: [{ label: 'Invoices', href: '/sales/invoices' }],
  },
  {
    id: 'receipts', area: 'Sales & purchases', title: 'Money received',
    summary: 'Record the receipt and say which invoices it settles; TDS the customer withheld is recorded with it.',
    steps: [
      'Sales → Payments Received → New. The amount is what the customer parted with; TDS they withheld is entered separately and claimed against Form 16A.',
      'Allocate to invoices; what is left stays on account and can be applied later.',
      'An advance for services carries GST on the unapplied amount.',
    ],
    links: [{ label: 'Payments received', href: '/sales/payments' }],
  },
  {
    id: 'bills', area: 'Sales & purchases', title: 'Recording a supplier\'s bill',
    summary: 'Enter it, or have it read from the PDF or photo, then check and save.',
    steps: [
      'Purchases → Bills → New. Read a bill reads the supplier, number, dates and lines from the file (it needs the AI assistant on, and uses credits); check them before saving. The file is attached to the bill.',
      'Each line says whether its input tax credit is eligible, ineligible (blocked under section 17(5)) or on capital goods.',
      'Reverse charge for an unregistered supplier\'s services; TDS by the supplier\'s section, counted against the year so far.',
      'Unpaid after 180 days, the credit is reversed under Rule 37 (GST & Taxes → ITC Reversals).',
    ],
    links: [{ label: 'Bills', href: '/purchases/bills' }, { label: 'New bill', href: '/purchases/bills/new' }],
  },
  {
    id: 'pay', area: 'Sales & purchases', title: 'Paying suppliers, one by one or in a batch',
    summary: 'A payment batch makes one bank upload for the week\'s bills, with a second person where a rule asks.',
    steps: [
      'Purchases → Payment Batches → New batch: the bank account, the day, and the bills due by a date. MSME suppliers are marked.',
      'Release: with no approval rule it is released at once; with one (Approvals → Rules → Payment batches) a second person releases it.',
      'Download the bank file (CSV or Excel), one transfer per supplier — RTGS from ₹2 lakh, NEFT below — and upload it to the bank.',
      'When the bank has paid: Mark paid, with the UTRs. A transfer the bank returned is ticked, and its bills stay unpaid.',
    ],
    links: [{ label: 'Payment batches', href: '/purchases/payment-batches' }],
  },
  {
    id: 'banking', area: 'Banking', title: 'Bank accounts and reconciliation',
    summary: 'Import the statement, match each line, and the bank balance agrees with the books.',
    steps: [
      'Banking: add each bank, cash and card account.',
      'Import the statement (CSV or Excel). Lines are matched to receipts and payments; rules categorise the regular ones.',
      'Cheques: issued, deposited, cleared or bounced — a bounce reopens the invoice it paid.',
      'Reports → Cash & Bank Book shows any account with its running balance; count the cash there.',
    ],
    links: [{ label: 'Banking', href: '/banking' }],
  },
  {
    id: 'journals', area: 'Accounting', title: 'Journals: accruals, optional and post-dated entries',
    summary: 'For what no document covers. Debits must equal credits exactly.',
    steps: [
      'Accountant → Manual Journals → New journal. A line on Receivables or Payables can settle a particular invoice or bill.',
      'Reverse automatically on: an accrual dated the 31st that undoes itself on the 1st.',
      'Save as Optional voucher: kept out of the books until someone posts it. Post-dated: posts itself on its date.',
      'A journal approval rule holds big entries for a second person (Approvals).',
      'Recurring Journals: depreciation and the like; switch on Automatic and the scheduler posts each on its day.',
    ],
    links: [{ label: 'Manual journals', href: '/accountant/journals' }, { label: 'Recurring journals', href: '/accountant/recurring-journals' }],
  },
  {
    id: 'approvals', area: 'Accounting', title: 'Approvals',
    summary: 'Rules by amount and role; whoever submits cannot approve.',
    steps: [
      'Approvals → Rules: invoices, bills, journals or payment batches from an amount need a role\'s approval.',
      'Waiting items appear in Approvals for those who may approve them; approving posts (or releases) at once, sending back asks for a reason.',
    ],
    links: [{ label: 'Approvals', href: '/approvals' }],
  },
  {
    id: 'gst', area: 'GST & taxes', title: 'GST returns',
    summary: 'GSTR-1 and 3B from the books, credit checked against GSTR-2B, and the due dates.',
    steps: [
      'GST & Taxes → GSTR-1 and GSTR-3B: prepared from the invoices and bills of the period. GSTR-1 downloads as the JSON the portal takes.',
      'ITC Reconciliation: your bills against GSTR-2B, so credit is claimed only on what suppliers have filed.',
      'ITC Reversals: Rule 37 (unpaid after 180 days) and Rules 42/43 (credit used for exempt supplies).',
      'Composition dealers file CMP-08 and GSTR-4 instead (GST & Taxes → Composition).',
      'The Compliance Calendar lists what is due and when, for your registration.',
    ],
    links: [{ label: 'Compliance calendar', href: '/gst/compliance-calendar' }],
  },
  {
    id: 'tds', area: 'GST & taxes', title: 'TDS and TCS',
    summary: 'Deducted on bills by section, paid, returned quarterly, certified.',
    steps: [
      'Set the supplier\'s TDS section; deduction follows the yearly threshold and the PAN (20% without one).',
      'A lower-deduction certificate (section 197) is entered against the supplier.',
      'Quarterly returns (26Q, and 24Q for salaries) are prepared from the deductions.',
      'TDS your customers deduct from you: record the certificates they send (Form 16A) against their receipts.',
    ],
    links: [{ label: 'TDS & TCS', href: '/gst/tds-tcs' }],
  },
  {
    id: 'payroll', area: 'Payroll', title: 'Running payroll',
    summary: 'Employees and their salary, then a month at a time: prepare, post, pay.',
    steps: [
      'Payroll → Employees: salary structure from a date, PF, ESI, PT and the tax regime.',
      'Payroll → Runs → a month: unpaid days and extras per person, then Post. PF, ESI, PT, LWF and TDS are worked out.',
      'Download the bank transfer file, the PF ECR and the ESI contribution file; record the payment once the bank has made it.',
      'Payslips print from the run.',
    ],
    links: [{ label: 'Payroll runs', href: '/payroll/runs' }],
  },
  {
    id: 'stock', area: 'Inventory', title: 'Stock, transfers and production',
    summary: 'Stock moves with the documents; valued at weighted average or FIFO.',
    steps: [
      'Inventory → Transfers between branches (in transit until received). Not between GSTINs: that is a sale.',
      'Inventory → Production: a bill of materials turns components into finished goods at cost.',
      'Job work: goods sent out and back, with the ITC-04 return (GST & Taxes → Job Work).',
      'Settings → Policies: weighted average or FIFO, and whether stock may go below zero.',
    ],
    links: [{ label: 'Inventory', href: '/inventory/transfers' }],
  },
  {
    id: 'reports', area: 'Reports', title: 'Reports: drilling down, comparing, scheduling',
    summary: 'Every figure comes from the journal on the spot, and opens to the entries behind it.',
    steps: [
      'Click an account on the profit and loss, balance sheet or trial balance to open its ledger; click a line there to open the document.',
      'Compare with: the previous period or the same period last year, side by side.',
      'Export to Excel or CSV from any report.',
      'Reports → Scheduled Reports: made on their day and announced under the bell; Cash-flow Forecast for the next thirteen weeks.',
    ],
    links: [{ label: 'Reports', href: '/reports' }, { label: 'Scheduled reports', href: '/reports/scheduled' }],
  },
  {
    id: 'close', area: 'Accounting', title: 'Closing a month and a year',
    summary: 'Checks before a period is locked, and the year-end pack.',
    steps: [
      'Accountant → Period Close: the checks (unreconciled bank, drafts, IRNs, suspense) before locking.',
      'Transaction Locking: no entry can be dated into a locked period, so filed returns and the books keep agreeing.',
      'Year end: close the year and download the Excel year pack for your auditor.',
    ],
    links: [{ label: 'Period close', href: '/accountant/period-close' }],
  },
  {
    id: 'tally', area: 'Connecting', title: 'Tally',
    summary: 'Bring a Tally company in, or send these books to Tally.',
    steps: [
      'Tally → import masters and vouchers from a Tally export, or pair the connector on the PC that runs Tally.',
      'Export ledgers and vouchers for Tally, named as your Tally company names them.',
    ],
    links: [{ label: 'Tally', href: '/tally' }],
  },
  {
    id: 'api', area: 'Connecting', title: 'API keys and webhooks',
    summary: 'For your website or other software to read and write these books.',
    steps: [
      'Settings → Developer → Make key. It acts with the role you choose, in your name; keep it secret and revoke it when no longer needed.',
      'Webhooks: an address told when invoices, payments and other records are created or voided. Check each delivery\'s signature.',
    ],
    links: [{ label: 'Developer settings', href: '/settings' }],
  },
  {
    id: 'privacy', area: 'Security', title: 'Personal data and privacy',
    summary: 'What the DPDP Act asks of the books, and where it is done.',
    steps: [
      'Settings → Privacy: the grievance officer, how long records are kept, and how soon requests are answered.',
      'Log a request from a person to see, correct or erase their data; download their data, or erase it as far as the tax laws allow.',
      'Record any breach, and when the Data Protection Board and the people affected were told.',
    ],
    links: [{ label: 'Privacy settings', href: '/settings' }],
  },
  {
    id: 'offline', area: 'Security', title: 'Installing the app, and working offline',
    summary: 'Add it to a phone or desktop; read what you have seen when the connection drops.',
    steps: [
      'In Chrome or Edge, Install app from the address bar menu; on a phone, Add to Home screen.',
      'Offline, pages and figures already opened on that device can still be read, and new invoices, bills, expenses, payments, journals and expense claims are kept on the device. They are sent, in order, when the connection is back, and numbered then, so two devices never take the same number. Each carries a key of its own, so one sent twice is made once. One the server refuses (a closed period, a customer since archived) waits in the corner with the reason until it is discarded.',
      'Signing out clears what was kept for offline reading.',
    ],
    links: [],
  },
];
