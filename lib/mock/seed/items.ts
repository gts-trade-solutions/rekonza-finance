// Seeded items — auto-parts catalogue with genuine HSN codes and one service
// item (SAC). Prices in paise.

import type { Item } from '../../types';
import { ACC } from './accounts';

const goods = (
  id: string,
  name: string,
  sku: string,
  hsn: string,
  salePrice: number, // rupees
  purchasePrice: number,
  gstRatePct: number,
  o: Partial<Item> = {},
): Item => ({
  id,
  kind: 'goods',
  name,
  sku,
  hsnSac: hsn,
  uqc: 'NOS',
  salePricePaise: salePrice * 100,
  purchasePricePaise: purchasePrice * 100,
  gstRatePct,
  taxPref: 'taxable',
  saleAccountId: ACC.SALES,
  purchaseAccountId: ACC.PURCHASES,
  isArchived: false,
  trackInventory: true,
  openingStockQty: 40,
  reorderLevel: 10,
  ...o,
});

export const SEED_ITEMS: Item[] = [
  goods('i_brakepad', 'Brake Pad Set – Swift/Baleno', 'BP-SW-101', '8708', 1450, 980, 28),
  goods('i_clutch', 'Clutch Plate Assembly – i20', 'CL-I20-202', '8708', 3200, 2250, 28),
  goods('i_airfilter', 'Air Filter – Creta 1.5', 'AF-CR-303', '8421', 520, 340, 18),
  goods('i_oilfilter', 'Oil Filter – Universal M20', 'OF-UN-404', '8421', 260, 155, 18),
  goods('i_sparkplug', 'Spark Plug Iridium (4-pack)', 'SP-IR-505', '8511', 1840, 1290, 28),
  goods('i_headlamp', 'Headlamp Assembly LH – Nexon', 'HL-NX-606', '8512', 4650, 3400, 28),
  goods('i_wiper', 'Wiper Blade Pair 24"/16"', 'WB-2416', '8512', 640, 410, 28),
  goods('i_battery', 'Battery 35Ah – Amaron', 'BT-AM-35', '8507', 4900, 3950, 28),
  goods('i_tyre', 'Tyre 185/65 R15 – MRF ZVTV', 'TY-MRF-185', '4011', 5750, 4600, 28),
  goods('i_shocker', 'Shock Absorber Rear – WagonR', 'SA-WR-707', '8708', 2100, 1500, 28),
  goods('i_radiator', 'Radiator Assembly – Innova', 'RD-IN-808', '8708', 7800, 5900, 28),
  goods('i_alternator', 'Alternator 90A – Verna', 'AL-VR-909', '8511', 8900, 6800, 28),
  goods('i_coolant', 'Coolant Premix 1L', 'CO-1L', '3820', 320, 205, 18),
  goods('i_engineoil', 'Engine Oil 5W-30 Synthetic 3.5L', 'EO-5W30', '2710', 1980, 1520, 18),
  goods('i_greasekit', 'Chassis Grease Kit 500g', 'GK-500', '2710', 240, 150, 18),
  goods('i_beltkit', 'Timing Belt Kit – City', 'TB-CT-111', '4010', 3450, 2500, 28),
  goods('i_hornset', 'Horn Set 12V Twin', 'HN-12V', '8512', 780, 520, 28),
  goods('i_mirrror', 'Side Mirror Electric RH – Baleno', 'SM-BL-112', '7009', 2350, 1700, 28),
  goods('i_cabinfilter', 'Cabin AC Filter – Universal', 'CF-UN-113', '8421', 450, 280, 18),
  {
    id: 'i_fitment',
    kind: 'service',
    name: 'Fitment & Labour Charges',
    sku: 'SRV-FIT',
    hsnSac: '998729',
    uqc: 'NOS',
    salePricePaise: 500 * 100,
    purchasePricePaise: 0,
    gstRatePct: 18,
    taxPref: 'taxable',
    saleAccountId: ACC.SERVICE_INCOME,
    purchaseAccountId: ACC.PURCHASES,
    isArchived: false,
    trackInventory: false,
  },
];
