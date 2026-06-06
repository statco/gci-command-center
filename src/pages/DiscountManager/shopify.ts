// src/pages/DiscountManager/shopify.ts
// ─────────────────────────────────────────────────────────────
// Shopify Admin API helpers for the Discount Manager.
// Patterns mirror gci-order-hub/api/shopify.ts exactly:
//   - Domain from process.env.SHOPIFY_STORE_DOMAIN
//   - X-Shopify-Access-Token header
//   - API version 2024-01
//
// All functions only operate on SKUs starting with "TIRE-".
// A 250ms delay is enforced between variant writes to stay within
// Shopify's Basic plan rate limit (2 req/s).
// ─────────────────────────────────────────────────────────────

const SHOPIFY_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || 'gcitires-ca.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || '';
const API_VERSION = '2024-01';

const TIRE_PREFIX = 'TIRE-';

export interface ShopifyVariant {
  id: number;
  sku: string;
  price: string;
  compare_at_price: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTireSku(sku: string): boolean {
  return typeof sku === 'string' && sku.toUpperCase().startsWith(TIRE_PREFIX);
}

function baseUrl(): string {
  return `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}`;
}

function headers(): Record<string, string> {
  return {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json',
  };
}

/**
 * Look up a variant by SKU. Returns the variant with its current price and
 * compare_at_price, or null when no TIRE- variant matches.
 */
export async function getVariantBySku(sku: string): Promise<ShopifyVariant | null> {
  if (!isTireSku(sku)) {
    console.warn(`[shopify] getVariantBySku: skipping non-TIRE sku ${sku}`);
    return null;
  }

  const res = await fetch(
    `${baseUrl()}/variants.json?sku=${encodeURIComponent(sku)}&limit=1`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`Shopify getVariantBySku failed ${res.status}`);

  const data = await res.json();
  const variant = (data.variants || [])[0];
  return variant ?? null;
}

/**
 * Apply a sale price: set price = discounted, compare_at_price = original
 * (the strikethrough "was" price). Only writes TIRE- variants.
 */
export async function applyCompareAtDiscount(
  variantId: number | string,
  originalPrice: number,
  discountedPrice: number,
): Promise<ShopifyVariant> {
  const res = await fetch(`${baseUrl()}/variants/${variantId}.json`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({
      variant: {
        id: variantId,
        price: discountedPrice.toFixed(2),
        compare_at_price: originalPrice.toFixed(2),
      },
    }),
  });
  if (!res.ok) throw new Error(`Shopify applyCompareAtDiscount failed ${res.status}`);

  await delay(250); // Shopify Basic rate limit
  const data = await res.json();
  return data.variant;
}

/**
 * Revert a sale: set price back to original, clear compare_at_price.
 */
export async function revertCompareAt(
  variantId: number | string,
  originalPrice: number,
): Promise<ShopifyVariant> {
  const res = await fetch(`${baseUrl()}/variants/${variantId}.json`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({
      variant: {
        id: variantId,
        price: originalPrice.toFixed(2),
        compare_at_price: null,
      },
    }),
  });
  if (!res.ok) throw new Error(`Shopify revertCompareAt failed ${res.status}`);

  await delay(250); // Shopify Basic rate limit
  const data = await res.json();
  return data.variant;
}
