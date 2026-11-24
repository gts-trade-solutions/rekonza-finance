import { route, ApiError } from '@/lib/server/http';
import { inboundSecretOk, readInboundRequest, receiveInboundStatement } from '@/lib/server/services/inbound-statements';

// The inbound-mail service posts each email sent to a bank account's own
// address here (services/inbound-statements.ts): Mailgun Routes, SendGrid
// Inbound Parse or Postmark Inbound, pointed at
//   https://<this site>/api/inbound/statements?secret=<INBOUND_WEBHOOK_SECRET>
// (or with the secret in an x-inbound-secret header). A wrong secret is
// refused; a refused or failed statement is still answered 200, with why, so
// the service does not keep sending the same mail.
export const POST = route(
  async ({ req }) => {
    const given = req.headers.get('x-inbound-secret') ?? new URL(req.url).searchParams.get('secret');
    if (!inboundSecretOk(given)) throw new ApiError(401, 'That inbound secret is not right.', 'unauthorized');
    const email = await readInboundRequest(req);
    return receiveInboundStatement(email);
  },
  { public: true },
);
