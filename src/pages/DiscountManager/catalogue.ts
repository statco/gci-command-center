// src/pages/DiscountManager/catalogue.ts
// ─────────────────────────────────────────────────────────────
// Pre-seeded STATIC catalogue used as a fallback when the live
// Walmart refresh (GET /api/refresh-catalogue) is unavailable.
//
// 100 placeholder items per sale group, all using the TIRE- SKU
// prefix. Price ranges mirror the analysis of GCI_Full_catalogue.xlsx:
//
//   LOW  group: avg $215, range $149.99–$259.99   (≤ $260)
//   MID  group: avg $289, range $261.99–$344.99   ($261–$349)
//   HIGH group: avg $471, range $350.99–$757.99   (≥ $350)
//
// Items are generated deterministically so the fallback is stable
// across reloads (same SKUs / prices every time).
// ─────────────────────────────────────────────────────────────

export interface CatalogueItem {
  id: string;
  sku: string;          // TIRE-XXXXXX
  offerId: string;      // Walmart offerId
  gtin: string;
  price: number;        // current Walmart price (CAD)
  title: string;
  group: 'low' | 'mid' | 'high';
  addedAt?: string;     // ISO — set when auto-added by cron
  autoAdded?: boolean;  // true if added by nightly refresh
}

// ─── Deterministic pseudo-random (mulberry32) ────────────────────
// Keeps the static catalogue identical between page loads.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BRANDS = [
  'Cooper', 'Nexen', 'Vredestein', 'Maxtrek', 'Minerva',
  'Ovation', 'Starfire', 'Kenda', 'Sailun', 'Goodyear',
];
const SEASONS = ['All-Season', 'Winter', 'Summer', 'All-Weather'];
const SIZES = [
  '205/55R16', '225/45R17', '235/65R18', '215/60R16', '245/40R18',
  '265/70R17', '195/65R15', '255/35R19', '275/55R20', '225/65R17',
];

function priceEndingIn99(rng: () => number, min: number, max: number): number {
  const whole = Math.floor(min + rng() * (max - min));
  return parseFloat(`${whole}.99`);
}

function buildGroup(
  group: 'low' | 'mid' | 'high',
  count: number,
  seed: number,
  minPrice: number,
  maxPrice: number,
): CatalogueItem[] {
  const rng = seeded(seed);
  const items: CatalogueItem[] = [];
  for (let i = 0; i < count; i++) {
    const brand = BRANDS[Math.floor(rng() * BRANDS.length)];
    const season = SEASONS[Math.floor(rng() * SEASONS.length)];
    const size = SIZES[Math.floor(rng() * SIZES.length)];
    // 6-digit SKU suffix, namespaced per group so they never collide.
    const suffix = String(seed + i).padStart(6, '0').slice(-6);
    const sku = `TIRE-${suffix}`;
    items.push({
      id: `${group}-${i}`,
      sku,
      offerId: `WMOFFER-${suffix}`,
      gtin: `0062${suffix}${String((seed + i) % 10000).padStart(4, '0')}`.slice(0, 14),
      price: priceEndingIn99(rng, minPrice, maxPrice),
      title: `${brand} ${season} ${size}`,
      group,
    });
  }
  return items;
}

export const AUTO_CATALOGUE: Record<'low' | 'mid' | 'high', CatalogueItem[]> = {
  low: buildGroup('low', 100, 100000, 150, 260),
  mid: buildGroup('mid', 100, 261000, 262, 345),
  high: buildGroup('high', 100, 350000, 351, 758),
};
