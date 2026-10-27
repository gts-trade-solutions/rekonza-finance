// Address rules for signing in: an address, a range in CIDR form, or a
// wildcard. Kept apart from the rules that read the book's policies, which
// themselves check addresses with these when a list is saved.

const v4 = (ip: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((x) => x > 255) ? null : parts.reduce((t, x) => t * 256 + x, 0);
};

/** A wildcard's parts, filled out to four: a trailing * stands for the rest, so 10.1.* is 10.1.*.*. */
const wildParts = (rule: string) => {
  const parts = rule.split('.');
  while (parts.length < 4 && parts[parts.length - 1] === '*') parts.push('*');
  return parts;
};

/** An address, a range such as 203.0.113.0/24, or a wildcard such as 192.168.1.* or 10.1.*. */
export function isAddressRule(rule: string): boolean {
  const r = rule.trim();
  if (/^[0-9a-f:]+$/i.test(r) && r.includes(':')) return true;
  if (/\*/.test(r)) return v4(wildParts(r).map((p) => (p === '*' ? '0' : p)).join('.')) !== null;
  const [base, bits] = r.split('/');
  if (v4(base) === null) return false;
  return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
}

/** Whether an address is one the rules allow. No rules, no limit. */
export function ipAllowed(ip: string | null, rules: string[]): boolean {
  if (!rules.length) return true;
  if (!ip) return false;
  const addr = ip.replace(/^::ffff:/, '');
  return rules.some((raw) => {
    const rule = raw.trim();
    if (!rule) return false;
    if (rule.includes('*')) {
      const re = new RegExp(`^${wildParts(rule).map((p) => (p === '*' ? '\\d{1,3}' : p)).join('\\.')}$`);
      return re.test(addr);
    }
    const [base, bits] = rule.split('/');
    if (bits === undefined) return base.toLowerCase() === addr.toLowerCase();
    const a = v4(addr);
    const b = v4(base);
    if (a === null || b === null) return false;
    const n = Number(bits);
    const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  });
}
