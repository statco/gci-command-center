// src/pages/DiscountManager/walmart.ts
// ─────────────────────────────────────────────────────────────
// Walmart Canada Promotions API client (browser side).
//
// IMPORTANT: the browser NEVER talks to marketplace.walmartapis.com
// directly (CORS + credential exposure). This module only builds the
// PriceFeed payload and POSTs it to /api/discount-proxy, which performs
// the authenticated server-to-server call.
//
// Promotion rules:
//   - currentPriceType: "CLEARANCE" for the high group, else "REDUCED"
//   - effectiveDate  = now + 5h   (Walmart ≥4h rule + 1h buffer)
//   - expirationDate = effectiveDate + durationDays
//   - comparisonPrice = original "was" price (strikethrough)
// ─────────────────────────────────────────────────────────────

import type { CatalogueItem } from './catalogue';

export type GroupTier = 'low' | 'mid' | 'high';

export interface PromoDates {
  effectiveDate: string;  // ISO
  expirationDate: string; // ISO
}

export interface PromoFeedResponse {
  feedId?: string;
  feedStatus?: string;
  [key: string]: unknown;
}

const PROXY_BASE = '/api/discount-proxy';

// Walmart requires the promo to start ≥4h out; we add a 1h buffer = 5h.
const EFFECTIVE_LEAD_HOURS = 5;

/**
 * Compute the effective + expiration ISO timestamps for a promotion.
 */
export function buildPromoDates(durationDays: number): PromoDates {
  const effective = new Date(Date.now() + EFFECTIVE_LEAD_HOURS * 60 * 60 * 1000);
  const expiration = new Date(
    effective.getTime() + durationDays * 24 * 60 * 60 * 1000,
  );
  return {
    effectiveDate: effective.toISOString(),
    expirationDate: expiration.toISOString(),
  };
}

function discountedPrice(original: number, pct: number): number {
  return parseFloat((original * (1 - pct / 100)).toFixed(2));
}

async function postProxy(
  action: string,
  payload: unknown,
  opts: { dry?: boolean } = {},
): Promise<PromoFeedResponse> {
  const url = new URL(PROXY_BASE, window.location.origin);
  url.searchParams.set('action', action);
  if (opts.dry) url.searchParams.set('dry', 'true');

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `discount-proxy ${action} failed ${res.status}`);
  }
  return res.json();
}

/**
 * Submit a promotion PriceFeed for a group of items.
 */
export async function submitPromotions(
  items: CatalogueItem[],
  pct: number,
  groupTier: GroupTier,
  durationDays: number,
  opts: { dry?: boolean } = {},
): Promise<PromoFeedResponse> {
  const { effectiveDate, expirationDate } = buildPromoDates(durationDays);
  const currentPriceType = groupTier === 'high' ? 'CLEARANCE' : 'REDUCED';

  const payload = {
    PriceHeader: { version: '1.7' },
    Price: items.map(item => ({
      itemIdentifier: { sku: item.sku },
      pricingList: {
        pricing: [
          {
            currentPriceType,
            currentPrice: {
              currentPrice: {
                currency: 'CAD',
                amount: discountedPrice(item.price, pct),
              },
            },
            comparisonPrice: {
              currency: 'CAD',
              amount: item.price, // original "was" price (strikethrough)
            },
            priceDisplayCode: { submitDecisionCode: 'true' },
            effectiveDate,
            expirationDate,
          },
        ],
      },
    })),
  };

  return postProxy('submitPriceFeed', payload, opts);
}

/**
 * Revert promotions: resubmit the feed with currentPriceType=BASE and
 * replaceAll=true so the prior prices are fully restored.
 */
export async function revertPromotions(
  items: CatalogueItem[],
  opts: { dry?: boolean } = {},
): Promise<PromoFeedResponse> {
  const payload = {
    PriceHeader: { version: '1.7' },
    replaceAll: true,
    Price: items.map(item => ({
      itemIdentifier: { sku: item.sku },
      pricingList: {
        pricing: [
          {
            currentPriceType: 'BASE',
            currentPrice: {
              currentPrice: {
                currency: 'CAD',
                amount: item.price,
              },
            },
          },
        ],
      },
    })),
  };

  return postProxy('submitPriceFeed', payload, opts);
}
