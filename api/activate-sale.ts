// api/activate-sale.ts
// ─────────────────────────────────────────────────────────────
// Server-side activation / revert for a Discount Manager sale group.
//
// Why this exists:
//   The browser cannot talk to the Shopify Admin API directly — the token
//   would be exposed and the request is CORS-blocked, so the old browser
//   flow updated 0/N variants. This function runs server-side where
//   SHOPIFY_ADMIN_API_TOKEN is available.
//
// Flow (action=activate):
//   1. For each SKU look up the Shopify variant (id + current price = the
//      "original" price).
//   2. Apply compare_at_price: price = original*(1-pct/100),
//      compare_at_price = original. 250ms between writes (Shopify Basic).
//   3. Only AFTER Shopify succeeds on ≥1 variant, submit the Walmart CA
//      promotion feed, using the original prices collected in step 1 as the
//      comparisonPrice values.
//   4. Return { shopify: {updated, skipped, failed}, walmart: {...} }.
//
// Flow (action=revert): same SKU→variant lookup, restore the original price
//   (from compare_at_price), clear compare_at_price, then resubmit a Walmart
//   BASE feed with replaceAll=true.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

// ─── Config ───────────────────────────────────────────────────
const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'gcitires-ca.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || '';
const SHOPIFY_API_VERSION = '2024-01';

const PROXY_SECRET = process.env.PROXY_SECRET || '';
const SHOPIFY_RATE_DELAY_MS = 250; // Shopify Basic ≈ 2 req/s
const EFFECTIVE_LEAD_HOURS = 5;     // Walmart ≥4h rule + 1h buffer

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Types ────────────────────────────────────────────────────
type GroupTier = 'low' | 'mid' | 'high';

interface IncomingItem {
  sku: string;
  price?: number; // catalogue price (fallback only; Shopify price wins)
  group?: GroupTier;
}

interface CollectedItem {
  sku: string;
  variantId: number | string;
  originalPrice: number;
}

interface ShopifyVariant {
  id: number;
  sku: string;
  price: string;
  compare_at_price: string | null;
}

// ─── Walmart auth (module-scoped token cache) ─────────────────
let _token: string | null = null;
let _tokenExp = 0;

function basicCredentials(): string {
  const id = process.env.WALMART_CLIENT_ID ?? '';
  const secret = process.env.WALMART_CLIENT_SECRET ?? '';
  if (!id || !secret) {
    throw new Error('Walmart credentials not set (WALMART_CLIENT_ID / WALMART_CLIENT_SECRET).');
  }
  return Buffer.from(`${id}:${secret}`).toString('base64');
}

async function getWalmartToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;
  const res = await fetch(`${WALMART_BASE}/v3/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicCredentials()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
      'WM_MARKET': 'ca',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`Walmart auth failed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data: any = await res.json();
  _token = data.access_token as string;
  _tokenExp = Date.now() + (((data.expires_in as number) ?? 900) * 1000);
  return _token!;
}

function walmartHeaders(token: string): Record<string, string> {
  return {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_GLOBAL_VERSION': '3.1',
    'WM_MARKET': 'ca',
    'WM_SVC.NAME': 'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    // Walmart CANADA marketplace channel type — required on feed submissions.
    'WM_CONSUMER.CHANNEL.TYPE': 'SWAGGER_WALMART_CA_MARKETPLACE',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// ─── Shopify helpers ──────────────────────────────────────────
function shopifyBase(): string {
  return `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
}

function shopifyHeaders(): Record<string, string> {
  return {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function isTireSku(sku: string): boolean {
  return typeof sku === 'string' && sku.toUpperCase().startsWith('TIRE-');
}

async function getVariantBySku(sku: string): Promise<ShopifyVariant | null> {
  const res = await fetch(
    `${shopifyBase()}/variants.json?sku=${encodeURIComponent(sku)}&limit=1`,
    { headers: shopifyHeaders() },
  );
  if (res.status === 429) {
    await delay(2000);
    return getVariantBySku(sku);
  }
  if (!res.ok) throw new Error(`Shopify variant lookup ${res.status}`);
  const data: any = await res.json();
  return (data.variants || [])[0] ?? null;
}

async function putVariant(
  variantId: number | string,
  body: { price: string; compare_at_price: string | null },
): Promise<void> {
  const res = await fetch(`${shopifyBase()}/variants/${variantId}.json`, {
    method: 'PUT',
    headers: shopifyHeaders(),
    body: JSON.stringify({ variant: { id: variantId, ...body } }),
  });
  if (res.status === 429) {
    await delay(2000);
    return putVariant(variantId, body);
  }
  if (!res.ok) throw new Error(`Shopify variant update ${res.status}`);
}

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

// ─── Walmart feed builders ────────────────────────────────────
function buildPromoDates(durationDays: number) {
  const effective = new Date(Date.now() + EFFECTIVE_LEAD_HOURS * 3600_000);
  const expiration = new Date(effective.getTime() + durationDays * 86400_000);
  return { effectiveDate: effective.toISOString(), expirationDate: expiration.toISOString() };
}

async function submitWalmartPromo(
  items: CollectedItem[],
  pct: number,
  groupTier: GroupTier,
  durationDays: number,
): Promise<{ feedId?: string; feedStatus?: string; raw?: any }> {
  const token = await getWalmartToken();
  const { effectiveDate, expirationDate } = buildPromoDates(durationDays);
  const currentPriceType = groupTier === 'high' ? 'CLEARANCE' : 'REDUCED';

  const payload = {
    PriceHeader: { version: '1.7' },
    Price: items.map(it => ({
      itemIdentifier: { sku: it.sku },
      pricingList: {
        pricing: [{
          currentPriceType,
          currentPrice: { currentPrice: { currency: 'CAD', amount: round2(it.originalPrice * (1 - pct / 100)) } },
          comparisonPrice: { currency: 'CAD', amount: it.originalPrice },
          priceDisplayCode: { submitDecisionCode: 'true' },
          effectiveDate,
          expirationDate,
        }],
      },
    })),
  };

  const res = await fetch(`${WALMART_BASE}/v3/ca/feeds?feedType=price`, {
    method: 'POST',
    headers: walmartHeaders(token),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Walmart feed ${res.status}: ${text.slice(0, 200)}`);
  const json = text ? JSON.parse(text) : {};
  return { feedId: json.feedId, feedStatus: json.feedStatus, raw: json };
}

async function submitWalmartRevert(items: CollectedItem[]): Promise<{ feedId?: string; raw?: any }> {
  const token = await getWalmartToken();
  const payload = {
    PriceHeader: { version: '1.7' },
    replaceAll: true,
    Price: items.map(it => ({
      itemIdentifier: { sku: it.sku },
      pricingList: {
        pricing: [{
          currentPriceType: 'BASE',
          currentPrice: { currentPrice: { currency: 'CAD', amount: it.originalPrice } },
        }],
      },
    })),
  };
  const res = await fetch(`${WALMART_BASE}/v3/ca/feeds?feedType=price`, {
    method: 'POST',
    headers: walmartHeaders(token),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Walmart revert feed ${res.status}: ${text.slice(0, 200)}`);
  const json = text ? JSON.parse(text) : {};
  return { feedId: json.feedId, raw: json };
}

// ─── Origin / secret validation (mirrors discount-proxy) ──────
function isAuthorized(req: VercelRequest): boolean {
  if (PROXY_SECRET) {
    return ((req.headers['x-proxy-secret'] as string) || '') === PROXY_SECRET;
  }
  const host = req.headers.host || '';
  const referer = (req.headers.referer as string) || (req.headers.origin as string) || '';
  if (!host) return false;
  if (!referer) return true;
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

// ─── Handler ──────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAuthorized(req)) {
    return res.status(403).json({ error: 'Forbidden — invalid origin', code: 403 });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 405 });
  }
  if (!SHOPIFY_TOKEN) {
    return res.status(500).json({ error: 'SHOPIFY_ADMIN_API_TOKEN not set', code: 500 });
  }

  const action = (req.query.action as string) || (req.body?.action as string) || 'activate';
  const dry = req.query.dry === 'true';

  const body = req.body || {};
  const rawItems: IncomingItem[] = Array.isArray(body.items)
    ? body.items
    : Array.isArray(body.skus)
      ? body.skus.map((s: string) => ({ sku: s }))
      : [];
  const items = rawItems.filter(i => i && isTireSku(i.sku));

  if (items.length === 0) {
    return res.status(400).json({ error: 'No TIRE- SKUs provided', code: 400 });
  }

  try {
    if (action === 'revert') {
      return await handleRevert(req, res, items, dry);
    }
    return await handleActivate(req, res, body, items, dry);
  } catch (err: any) {
    console.error('[activate-sale] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error', code: 500 });
  }
}

async function handleActivate(
  _req: VercelRequest,
  res: VercelResponse,
  body: any,
  items: IncomingItem[],
  dry: boolean,
) {
  const group: GroupTier = (body.group as GroupTier) || items[0].group || 'low';
  const pct = Number(body.pct) || 0;
  const durationDays = Number(body.durationDays) || 30;

  // Step 1 + 2: Shopify lookup + compare_at write.
  const collected: CollectedItem[] = [];
  const failed: { sku: string; error: string }[] = [];
  let skipped = 0;

  for (const item of items) {
    try {
      const variant = await getVariantBySku(item.sku);
      if (!variant) { skipped++; continue; }
      const originalPrice = parseFloat(variant.price) || item.price || 0;
      if (!dry) {
        await putVariant(variant.id, {
          price: round2(originalPrice * (1 - pct / 100)).toFixed(2),
          compare_at_price: originalPrice.toFixed(2),
        });
        await delay(SHOPIFY_RATE_DELAY_MS);
      }
      collected.push({ sku: item.sku, variantId: variant.id, originalPrice });
    } catch (e: any) {
      failed.push({ sku: item.sku, error: e?.message || String(e) });
    }
  }

  const shopify = { updated: collected.length, skipped, total: items.length, failed };

  // Step 4: only submit to Walmart if Shopify succeeded on ≥1 variant.
  let walmart: any = { submitted: false, reason: 'no Shopify variants updated' };
  if (collected.length > 0) {
    if (dry) {
      walmart = { submitted: false, dry: true, wouldSubmit: collected.length };
    } else {
      try {
        const feed = await submitWalmartPromo(collected, pct, group, durationDays);
        const { effectiveDate, expirationDate } = buildPromoDates(durationDays);
        walmart = {
          submitted: true,
          feedId: feed.feedId ?? 'pending',
          feedStatus: feed.feedStatus ?? 'RECEIVED',
          effectiveDate,
          expirationDate,
          promotionType: group === 'high' ? 'CLEARANCE' : 'REDUCED',
        };
      } catch (e: any) {
        walmart = { submitted: false, error: e?.message || String(e) };
      }
    }
  }

  return res.status(200).json({ success: true, action: 'activate', group, pct, dry, shopify, walmart });
}

async function handleRevert(
  _req: VercelRequest,
  res: VercelResponse,
  items: IncomingItem[],
  dry: boolean,
) {
  const collected: CollectedItem[] = [];
  const failed: { sku: string; error: string }[] = [];
  let skipped = 0;

  for (const item of items) {
    try {
      const variant = await getVariantBySku(item.sku);
      if (!variant) { skipped++; continue; }
      // The original price is whatever we previously stashed in compare_at_price.
      const originalPrice =
        parseFloat(variant.compare_at_price || '') || parseFloat(variant.price) || item.price || 0;
      if (!dry) {
        await putVariant(variant.id, {
          price: originalPrice.toFixed(2),
          compare_at_price: null,
        });
        await delay(SHOPIFY_RATE_DELAY_MS);
      }
      collected.push({ sku: item.sku, variantId: variant.id, originalPrice });
    } catch (e: any) {
      failed.push({ sku: item.sku, error: e?.message || String(e) });
    }
  }

  const shopify = { reverted: collected.length, skipped, total: items.length, failed };

  let walmart: any = { submitted: false, reason: 'no Shopify variants reverted' };
  if (collected.length > 0) {
    if (dry) {
      walmart = { submitted: false, dry: true, wouldSubmit: collected.length };
    } else {
      try {
        const feed = await submitWalmartRevert(collected);
        walmart = { submitted: true, feedId: feed.feedId ?? 'pending' };
      } catch (e: any) {
        walmart = { submitted: false, error: e?.message || String(e) };
      }
    }
  }

  return res.status(200).json({ success: true, action: 'revert', dry, shopify, walmart });
}
