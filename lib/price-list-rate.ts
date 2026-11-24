// An item's rate on a price list, as the server works it out
// (lib/server/services/price-lists.ts pricesFor / bestDiscount): a percentage
// list moves the item's own price by its share; a per-item list names a rate
// and leaves other items at their own price. The best discount rule the
// quantity qualifies for comes with it. Used where a form offers Zoho's
// "Select Price List" (the recurring invoice form).

export interface PriceListShape {
  id: string;
  name: string;
  basis: 'percent' | 'per_item';
  percent: number;
  isActive: boolean;
  items: { itemId: string; ratePaise: number }[];
  discounts: { itemId: string | null; minQty: number; discountPct: number }[];
}

export function listRate(list: PriceListShape, itemId: string, ownPricePaise: number, qty: number): { ratePaise: number; discountPct: number } {
  const named = list.items.find((i) => i.itemId === itemId);
  const ratePaise = list.basis === 'percent'
    ? Math.round(ownPricePaise * (1 + list.percent / 100))
    : named ? named.ratePaise : ownPricePaise;
  const discountPct = list.discounts
    .filter((d) => (d.itemId === null || d.itemId === itemId) && qty >= d.minQty)
    .reduce((best, d) => Math.max(best, d.discountPct), 0);
  return { ratePaise, discountPct };
}
