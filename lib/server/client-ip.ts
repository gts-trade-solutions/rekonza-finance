// The address a request really came from, for the sign-in allowlist, attempt
// counting and the audit trail.
//
// X-Forwarded-For is a list anyone can start: a client sends its own, and each
// proxy appends the address it was reached from. Only the entries our own
// proxies add can be believed, and they are at the end. So the address is the
// one TRUSTED_PROXY_HOPS from the end (1: one nginx or load balancer in front,
// the usual case). On Vercel, the platform sets x-real-ip itself. With no
// proxy at all (TRUSTED_PROXY_HOPS=0) nothing in the headers can be trusted,
// and the address is unknown — an allowlist then refuses, as it should.

export function clientIp(req: Request): string | null {
  const h = req.headers;
  if (process.env.VERCEL) return h.get('x-real-ip')?.trim() || h.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || null;
  const hops = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1) || 0);
  if (hops === 0) return null;
  const list = (h.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return h.get('x-real-ip')?.trim() || null;
  return list[Math.max(list.length - hops, 0)] ?? null;
}

/**
 * The address for the audit trail: the trusted one above where there is one.
 * With TRUSTED_PROXY_HOPS=0 (the app reached directly, no proxy in front)
 * clientIp gives nothing, because nothing in the headers can be trusted for a
 * sign-in allowlist. The audit trail still needs an address to show the
 * auditor, so it takes the one the app's own server put in X-Forwarded-For
 * from the connection (Next.js sets it from the socket when the request
 * carries none). It is a record, never a gate: nothing is allowed or refused
 * on it, so a client that sent its own header can only mislabel its own row.
 */
export function auditIp(req: Request): string | null {
  const trusted = clientIp(req);
  if (trusted) return trusted;
  const h = req.headers;
  const list = (h.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = list[list.length - 1] || h.get('x-real-ip')?.trim() || null;
  // "::ffff:127.0.0.1" is IPv4 seen through an IPv6 socket.
  return ip ? ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1').slice(0, 64) : null;
}
