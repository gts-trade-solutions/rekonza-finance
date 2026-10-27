// A real call to a real e-invoice portal, from the command line.
//   npm run einvoice:sandbox            login only
//   npm run einvoice:sandbox -- --irn   login, register one invoice, cancel it
//
// The first real call is where a specification meets the system that wrote it,
// so this exists to make that moment cheap: no database, no browser, no app —
// the connector, the credentials from the environment, and a printed answer.
// Run it the day the keys arrive, and again against every GSP considered.
//
// What it needs, all from .env.local:
//
//   NIC_EINV_BASE_URL        the address the portal gave you
//   NIC_EINV_ENV             sandbox or production (only NIC's own sandbox host
//                            is recognised without this)
//   NIC_EINV_CLIENT_ID       issued at registration
//   NIC_EINV_CLIENT_SECRET   issued at registration
//   NIC_EINV_PUBLIC_KEY      the portal's public key: PEM, base64, or a path
//   EINV_TEST_GSTIN          the registration to act for
//   EINV_TEST_USERNAME       the API user created on the portal for that GSTIN
//   EINV_TEST_PASSWORD       its password
//   EINV_TEST_BUYER_GSTIN    a buyer to invoice; defaults to the seller
//
// Nothing secret is printed: credentials are reported as set or missing, and
// only the portal's own reference numbers are shown.

import {
  NicEinvoiceProvider, NIC_SANDBOX_URL, nicConfigFromEnv, type NicConfig,
} from '../lib/server/integrations/gst/nic-einvoice';
import { buildEinvoicePayload, type EinvoiceSource } from '../lib/server/integrations/gst/einvoice-payload';
import {
  PortalAuthFailed, PortalDuplicate, PortalRejection, PortalUnavailable, type ProviderContext,
} from '../lib/server/integrations/gst/provider';

/**
 * Addresses to try when the configured one is not there.
 *
 * NIC has published these under two shapes — /eivital/v1.04/auth in the
 * version pages and <URL>/v1.04/auth or <URL>/api/auth in the current ones —
 * and a GSP mounts the same API somewhere else again. Rather than guess, the
 * script asks the portal: the one that does not answer 404 is the one to put
 * in .env.local.
 */
const CANDIDATES = {
  authPath: ['/eivital/v1.04/auth', '/v1.04/auth', '/api/auth', '/eivital/v1.03/auth', '/auth'],
  invoicePath: ['/eicore/v1.03/Invoice', '/api/Invoice', '/v1.03/Invoice', '/Invoice'],
  cancelPath: ['/eicore/v1.03/Invoice/Cancel', '/api/Cancel', '/v1.03/Invoice/Cancel', '/Cancel'],
} as const;

const args = new Set(process.argv.slice(2));
const withIrn = args.has('--irn');
const say = (line: string) => console.log(line);
const set = (v: string | undefined | null) => (v && v.trim() ? 'set' : 'MISSING');

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`\n${name} is not set. See the comment at the top of this script for the full list.`);
    process.exit(2);
  }
  return v;
}

/** One invoice, valid on its own terms: intra-state, one line, tax that adds up. */
function testInvoice(sellerGstin: string, buyerGstin: string): EinvoiceSource {
  const state = sellerGstin.slice(0, 2);
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const intra = buyerGstin.slice(0, 2) === state;
  const taxable = 10_000_00;
  const half = 900_00;
  return {
    docType: 'INV',
    // Unique per run: the portal refuses a document number it already holds.
    number: `SBX/${Date.now().toString().slice(-8)}`,
    date: today,
    supplyType: intra ? 'intra' : 'inter',
    supplyKind: 'goods',
    placeOfSupply: buyerGstin.slice(0, 2),
    seller: {
      gstin: sellerGstin,
      legalName: 'Sandbox Test Seller',
      address1: '1 Test Street',
      city: 'Test City',
      pincode: '600001',
      stateCode: state,
    },
    buyer: {
      gstin: buyerGstin,
      legalName: 'Sandbox Test Buyer',
      address1: '2 Test Road',
      city: 'Test City',
      pincode: '600002',
      stateCode: buyerGstin.slice(0, 2),
    },
    lines: [
      {
        lineNo: 1,
        description: 'Test item',
        hsnSac: '998877',
        qty: 1,
        uqc: 'NOS',
        ratePaise: taxable,
        discountPaise: 0,
        taxablePaise: taxable,
        gstRatePct: 18,
        cgstPaise: intra ? half : 0,
        sgstPaise: intra ? half : 0,
        igstPaise: intra ? 0 : half * 2,
        cessPaise: 0,
        lineTotalPaise: taxable + half * 2,
      },
    ],
    docDiscountPaise: 0,
    shippingChargePaise: 0,
    adjustmentPaise: 0,
    roundOffPaise: 0,
    totalPaise: taxable + half * 2,
  };
}

/** Try each candidate address until one is not a 404, and say which answered. */
async function findPath(
  which: keyof typeof CANDIDATES,
  config: NicConfig,
  ctx: ProviderContext,
  attempt: (provider: NicEinvoiceProvider) => Promise<unknown>,
): Promise<string> {
  const tried: string[] = [];
  for (const path of [config[which], ...CANDIDATES[which].filter((p) => p !== config[which])]) {
    const provider = new NicEinvoiceProvider({ ...config, [which]: path });
    try {
      await attempt(provider);
      return path;
    } catch (err) {
      const missing = err instanceof PortalRejection && err.code === 'http_404';
      tried.push(`${path} → ${missing ? 'not found' : (err as Error).name}`);
      // Anything but "no such address" means the address was right and the
      // call itself is what failed. Report that, not the next guess.
      if (!missing) {
        say(`  tried: ${tried.join(', ')}`);
        throw err;
      }
    }
  }
  throw new Error(`None of these addresses exist on this host:\n  ${tried.join('\n  ')}`);
}

async function main() {
  const config = nicConfigFromEnv();
  const gstin = need('EINV_TEST_GSTIN');
  const username = need('EINV_TEST_USERNAME');
  const password = need('EINV_TEST_PASSWORD');
  const buyerGstin = process.env.EINV_TEST_BUYER_GSTIN?.trim() || gstin;

  const provider = new NicEinvoiceProvider(config);
  say('e-invoice portal check');
  say(`  address        ${config.baseUrl}${config.baseUrl === NIC_SANDBOX_URL ? "  (NIC's own sandbox)" : ''}`);
  say(`  environment    ${provider.environment}${provider.live ? '  — FILES FOR REAL' : '  — nothing is filed'}`);
  say(`  client id      ${set(config.clientId)}`);
  say(`  client secret  ${set(config.clientSecret)}`);
  say(`  public key     ${config.publicKey ? 'loaded' : `MISSING${config.publicKeyError ? ` — ${config.publicKeyError}` : ''}`}`);
  say(`  acting for     ${gstin} as "${username}"`);

  const missing = provider.missingConfiguration();
  if (missing.length) {
    console.error(`\nNot ready to call:\n  ${missing.join('\n  ')}`);
    process.exit(2);
  }

  // No session store: every call logs in afresh, which is what a first check
  // should do — a cached token would hide a broken login.
  const ctx: ProviderContext = { orgId: 0, connectionId: null, gstin, credentials: { username, password } };

  say('\n1. logging in');
  const authPath = await findPath('authPath', config, ctx, (p) => p.verify(ctx));
  const session = await new NicEinvoiceProvider({ ...config, authPath }).verify(ctx);
  say(`   ok · ${authPath} · token expires ${session.expiresAt ?? 'at a time the portal did not say'}`);

  if (!withIrn) {
    say('\nLogin works. Run again with --irn to register a test invoice and cancel it.');
    return;
  }

  const source = testInvoice(gstin, buyerGstin);
  const payload = buildEinvoicePayload(source);
  say(`\n2. registering ${source.number} (${source.supplyType}-state, buyer ${buyerGstin}, ₹${(source.totalPaise / 100).toFixed(2)})`);

  let irn: string;
  let invoicePath = config.invoicePath;
  try {
    invoicePath = await findPath('invoicePath', { ...config, authPath }, ctx, async (p) => {
      const r = await p.generateIrn(payload, ctx);
      irn = r.irn;
      say(`   ok · IRN ${r.irn.slice(0, 24)}… · ack ${r.ackNo} on ${r.ackDate}`);
      say(`   signed invoice ${r.signedInvoice ? 'returned' : 'not returned'} · QR ${r.signedQr ? 'returned' : 'not returned'}`);
      if (r.ewbNo) say(`   e-way bill ${r.ewbNo} valid to ${r.ewbValidUntil}`);
    });
  } catch (err) {
    if (err instanceof PortalDuplicate) {
      irn = err.irn;
      say(`   the portal already holds this document · IRN ${err.irn.slice(0, 24)}…`);
    } else throw err;
  }

  say(`\n3. cancelling it (reason 1, duplicate)`);
  const cancelPath = await findPath('cancelPath', { ...config, authPath, invoicePath }, ctx, (p) =>
    p.cancelIrn(irn!, '1', 'Sandbox connectivity check', ctx),
  );
  say(`   ok · ${cancelPath}`);

  say('\nPut these in .env.local so the app uses the same addresses:');
  say(`  NIC_EINV_AUTH_PATH=${authPath}`);
  say(`  NIC_EINV_INVOICE_PATH=${invoicePath}`);
  say(`  NIC_EINV_CANCEL_PATH=${cancelPath}`);
}

main().catch((err) => {
  // Each kind of failure has its own remedy, so each is named rather than
  // dumped as a stack trace.
  if (err instanceof PortalAuthFailed) {
    console.error(`\nThe portal refused the login.\n  ${err.message}`);
  } else if (err instanceof PortalRejection) {
    console.error(`\nThe portal refused the request. [${err.code}] ${err.message}`);
  } else if (err instanceof PortalUnavailable) {
    console.error(`\nThe portal could not be reached. ${err.message}`);
  } else {
    console.error(`\n${(err as Error).message}`);
  }
  process.exit(1);
});
