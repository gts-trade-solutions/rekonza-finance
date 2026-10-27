// ─────────────────────────────────────────────────────────────────────────────
// The organisation's approved HSN / SAC list.
//
// GST law makes the code on each line the organisation's responsibility, and
// GSTR-1 Table 12 is validated against the official master — a code that does
// not exist, or exists but does not match the rate charged, fails at the portal
// and the whole return bounces. Letting a sales user free-type it is therefore
// the single most common way an otherwise clean return gets rejected.
//
// So the admin curates a short list here — usually ten to fifteen codes cover a
// trading business entirely — and invoice lines may only choose from it. These
// are the real codes for an automotive spares dealer.
// ─────────────────────────────────────────────────────────────────────────────

import type { HsnCode } from '../../types';

const hsn = (
  code: string,
  description: string,
  gstRatePct: number,
  uqc = 'NOS',
): HsnCode => ({ id: `hsn_${code}`, code, kind: 'hsn', description, gstRatePct, uqc, isActive: true });

const sac = (code: string, description: string, gstRatePct: number): HsnCode => ({
  id: `sac_${code}`, code, kind: 'sac', description, gstRatePct, isActive: true,
});

export const SEED_HSN_CODES: HsnCode[] = [
  // Goods — every code below is used by at least one seeded item.
  hsn('2710', 'Petroleum oils — lubricants, engine oil, grease', 18, 'LTR'),
  hsn('3820', 'Anti-freezing preparations and prepared de-icing fluids', 18, 'LTR'),
  hsn('4010', 'Conveyor or transmission belts of vulcanised rubber', 28),
  hsn('4011', 'New pneumatic tyres of rubber', 28),
  hsn('7009', 'Glass mirrors, including rear-view mirrors for vehicles', 28),
  hsn('8421', 'Filtering or purifying machinery — air and oil filters', 18),
  hsn('8507', 'Electric accumulators — lead-acid automotive batteries', 28),
  hsn('8511', 'Ignition equipment — spark plugs, alternators, starters', 28),
  hsn('8512', 'Lighting and signalling equipment — lamps, horns, wipers', 28),
  hsn('8708', 'Parts and accessories of motor vehicles', 28),
  hsn('8409', 'Parts for spark-ignition and diesel engines', 28),
  hsn('8413', 'Pumps for liquids — fuel, oil and water pumps', 18),

  // Services — SAC codes always begin 99.
  sac('998729', 'Maintenance and repair of other goods — fitment and labour', 18),
  sac('998714', 'Maintenance and repair of motor vehicles', 18),
  sac('996511', 'Road transport of goods — freight and delivery', 5),
  sac('998311', 'Management consulting and advisory services', 18),
];
