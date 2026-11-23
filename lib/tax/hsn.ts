// ─────────────────────────────────────────────────────────────────────────────
// HSN and SAC codes as Zoho Books checks them.
//
// Zoho asks one question (Settings → Items: "Number of digits for HSN code or
// SAC") and accepts any properly formed code of at least that many digits. The
// law behind it (notification 78/2020-Central Tax): four digits are the least a
// business with aggregate turnover up to ₹5 crore may print, six above it; eight
// may always be given. A SAC begins 99 and describes a service; an HSN for goods
// never does.
//
// Zoho's "Validate HSN/SAC" asks the GST portal. Without it, the next best check
// is the tariff's own structure: the two-digit chapter of an HSN and the
// four-digit heading of a SAC must exist, which catches the usual typo, and
// naming the chapter tells the person at once whether the code is the kind of
// thing they sell.
// ─────────────────────────────────────────────────────────────────────────────

export type HsnDigits = 4 | 6 | 8;
export const HSN_DIGIT_CHOICES: HsnDigits[] = [4, 6, 8];
export const isHsnDigits = (v: unknown): v is HsnDigits => v === 4 || v === 6 || v === 8;

/** Chapters of the Harmonized System as India's customs tariff numbers them (77 is reserved). */
const CHAPTERS: Record<string, string> = {
  '01': 'Live animals', '02': 'Meat and edible meat offal', '03': 'Fish, crustaceans and molluscs',
  '04': 'Dairy produce; eggs; honey', '05': 'Products of animal origin, not elsewhere specified',
  '06': 'Live trees and plants; cut flowers', '07': 'Edible vegetables', '08': 'Edible fruit and nuts',
  '09': 'Coffee, tea, mate and spices', '10': 'Cereals', '11': 'Products of the milling industry; malt; starches',
  '12': 'Oil seeds and oleaginous fruits', '13': 'Lac; gums, resins and other vegetable saps',
  '14': 'Vegetable plaiting materials', '15': 'Animal or vegetable fats and oils', '16': 'Preparations of meat or fish',
  '17': 'Sugars and sugar confectionery', '18': 'Cocoa and cocoa preparations',
  '19': 'Preparations of cereals, flour, starch or milk', '20': 'Preparations of vegetables, fruit or nuts',
  '21': 'Miscellaneous edible preparations', '22': 'Beverages, spirits and vinegar',
  '23': 'Residues from the food industries; animal fodder', '24': 'Tobacco and manufactured tobacco substitutes',
  '25': 'Salt; sulphur; earths and stone; lime and cement', '26': 'Ores, slag and ash',
  '27': 'Mineral fuels, mineral oils and their products', '28': 'Inorganic chemicals', '29': 'Organic chemicals',
  '30': 'Pharmaceutical products', '31': 'Fertilisers', '32': 'Tanning or dyeing extracts; paints, varnishes and inks',
  '33': 'Essential oils; perfumery and cosmetic preparations', '34': 'Soap, washing and lubricating preparations, waxes',
  '35': 'Albuminoidal substances; glues; enzymes', '36': 'Explosives; matches; pyrotechnic products',
  '37': 'Photographic or cinematographic goods', '38': 'Miscellaneous chemical products', '39': 'Plastics and articles thereof',
  '40': 'Rubber and articles thereof', '41': 'Raw hides and skins and leather', '42': 'Articles of leather; travel goods and handbags',
  '43': 'Furskins and artificial fur', '44': 'Wood and articles of wood; wood charcoal', '45': 'Cork and articles of cork',
  '46': 'Manufactures of straw; basketware', '47': 'Pulp of wood; recovered paper', '48': 'Paper and paperboard; articles of paper',
  '49': 'Printed books, newspapers, pictures', '50': 'Silk', '51': 'Wool and fine or coarse animal hair', '52': 'Cotton',
  '53': 'Other vegetable textile fibres; paper yarn', '54': 'Man-made filaments', '55': 'Man-made staple fibres',
  '56': 'Wadding, felt and nonwovens; twine and cordage', '57': 'Carpets and other textile floor coverings',
  '58': 'Special woven fabrics; lace; embroidery', '59': 'Impregnated, coated or laminated textile fabrics',
  '60': 'Knitted or crocheted fabrics', '61': 'Apparel, knitted or crocheted', '62': 'Apparel, not knitted or crocheted',
  '63': 'Other made up textile articles; worn clothing', '64': 'Footwear and gaiters', '65': 'Headgear',
  '66': 'Umbrellas and walking sticks', '67': 'Prepared feathers; artificial flowers; articles of human hair',
  '68': 'Articles of stone, plaster, cement, asbestos or mica', '69': 'Ceramic products', '70': 'Glass and glassware',
  '71': 'Pearls, precious stones and metals; jewellery; coin', '72': 'Iron and steel', '73': 'Articles of iron or steel',
  '74': 'Copper and articles thereof', '75': 'Nickel and articles thereof', '76': 'Aluminium and articles thereof',
  '78': 'Lead and articles thereof', '79': 'Zinc and articles thereof', '80': 'Tin and articles thereof',
  '81': 'Other base metals; cermets', '82': 'Tools, implements and cutlery of base metal',
  '83': 'Miscellaneous articles of base metal', '84': 'Machinery, mechanical appliances, boilers and parts',
  '85': 'Electrical machinery and equipment and parts', '86': 'Railway or tramway locomotives and rolling stock',
  '87': 'Vehicles other than railway; parts and accessories', '88': 'Aircraft, spacecraft and parts',
  '89': 'Ships, boats and floating structures', '90': 'Optical, measuring, medical and surgical instruments',
  '91': 'Clocks and watches', '92': 'Musical instruments', '93': 'Arms and ammunition',
  '94': 'Furniture; bedding; lamps; prefabricated buildings', '95': 'Toys, games and sports requisites',
  '96': 'Miscellaneous manufactured articles', '97': 'Works of art, collectors\' pieces and antiques',
  '98': 'Project imports and special classifications',
};

/** The service headings of the GST scheme of classification (SAC). */
const SAC_HEADINGS: Record<string, string> = {
  '9954': 'Construction services', '9961': 'Wholesale trade services', '9962': 'Retail trade services',
  '9963': 'Accommodation, food and beverage services', '9964': 'Passenger transport services',
  '9965': 'Goods transport services', '9966': 'Rental of transport vehicles with operators',
  '9967': 'Supporting services in transport', '9968': 'Postal and courier services',
  '9969': 'Electricity, gas, water and other distribution services', '9971': 'Financial and related services',
  '9972': 'Real estate services', '9973': 'Leasing or rental services without operator',
  '9981': 'Research and development services', '9982': 'Legal and accounting services',
  '9983': 'Other professional, technical and business services',
  '9984': 'Telecommunications, broadcasting and information supply services', '9985': 'Support services',
  '9986': 'Support services to agriculture, forestry, fishing and mining',
  '9987': 'Maintenance, repair and installation (except construction) services',
  '9988': 'Manufacturing services on physical inputs owned by others',
  '9989': 'Other manufacturing services; publishing, printing and reproduction',
  '9991': 'Public administration and other services to the community', '9992': 'Education services',
  '9993': 'Human health and social care services', '9994': 'Sewage and waste collection, treatment and disposal',
  '9995': 'Services of membership organisations', '9996': 'Recreational, cultural and sporting services',
  '9997': 'Other services', '9998': 'Domestic services', '9999': 'Services by extraterritorial organisations',
};

export interface HsnCheck {
  ok: boolean;
  /** 'sac' for a service code (99…), 'hsn' for goods; null when the code is not a code at all. */
  kind: 'hsn' | 'sac' | null;
  /** What is wrong, in a sentence; null when it is fine. */
  problem: string | null;
  /** The chapter (HSN) or heading (SAC) the code falls under, when it exists. */
  heading: string | null;
}

/**
 * Whether a code is a properly formed HSN or SAC for this business: digits only,
 * a length the tariff uses, at least the digits the business prints, and of the
 * kind the item is (goods take an HSN, services a SAC).
 */
export function checkHsnCode(code: string, opts: { digits: HsnDigits; kind?: 'goods' | 'service' | null }): HsnCheck {
  const c = code.trim();
  if (!/^\d+$/.test(c)) return { ok: false, kind: null, problem: `${c || 'The code'} is not an HSN or SAC: it is digits only.`, heading: null };
  const sac = c.startsWith('99');
  const kind = sac ? 'sac' : 'hsn';
  if (sac) {
    const heading = SAC_HEADINGS[c.slice(0, 4)] ?? null;
    if (c.length !== 4 && c.length !== 6) return { ok: false, kind, problem: `${c} is not a SAC: a SAC has six digits (such as 998311), or four for its heading.`, heading };
    if (c.length < Math.min(opts.digits, 6)) return { ok: false, kind, problem: `${c} has ${c.length} digits; your settings print SAC with 6 (Settings → Items).`, heading };
    if (!heading) return { ok: false, kind, problem: `${c} is not a SAC heading: services are classified 9954 and 9961 to 9999.`, heading: null };
    if (opts.kind === 'goods') return { ok: false, kind, problem: `${c} is a SAC, which describes a service, but this item is goods. Goods take an HSN.`, heading };
    return { ok: true, kind, problem: null, heading };
  }
  const heading = CHAPTERS[c.slice(0, 2)] ?? null;
  if (![4, 6, 8].includes(c.length)) return { ok: false, kind, problem: `${c} is not an HSN: an HSN has 4, 6 or 8 digits.`, heading };
  if (c.length < opts.digits) return { ok: false, kind, problem: `${c} has ${c.length} digits; your settings ask for at least ${opts.digits} (Settings → Items).`, heading };
  if (!heading) return { ok: false, kind, problem: `${c} is not an HSN: there is no chapter ${c.slice(0, 2)} in the tariff.`, heading: null };
  if (opts.kind === 'service') return { ok: false, kind, problem: `${c} is an HSN, which describes goods, but this item is a service. Services take a SAC (99…).`, heading };
  return { ok: true, kind, problem: null, heading };
}

/** "Chapter 72 · Iron and steel" or "SAC 9983 · Other professional, technical and business services". */
export function hsnHeadingLabel(code: string): string | null {
  const c = code.trim();
  if (!/^\d{4,8}$/.test(c)) return null;
  if (c.startsWith('99')) {
    const h = SAC_HEADINGS[c.slice(0, 4)];
    return h ? `SAC heading ${c.slice(0, 4)} · ${h}` : null;
  }
  const ch = CHAPTERS[c.slice(0, 2)];
  return ch ? `Chapter ${c.slice(0, 2)} · ${ch}` : null;
}

/** The least digits the law asks of a business at its turnover: 6 above ₹5 crore, 4 up to it. */
export const legalMinimumDigits = (above5Cr: boolean): HsnDigits => (above5Cr ? 6 : 4);
