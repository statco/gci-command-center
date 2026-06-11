// api/refresh-catalogue.ts
// ─────────────────────────────────────────────────────────────
// Rebuilds the Discount Manager sale groups from LIVE Shopify data.
// Shopify is the source of truth — only ACTIVE products with TIRE-
// prefixed SKUs are included. Each item carries a pre-resolved
// shopifyVariantId so activate-sale.ts can skip per-SKU lookups.
//
//   - Fetch all Shopify variants (paginated GraphQL), filter TIRE- + ACTIVE
//   - Price breaks: LOW ≤ $260 | MID $261–$349 | HIGH ≥ $350
//   - Sample 100 per group
//   - New-item detection vs stored KV catalogue
//   - Auto-add to active group if below ceiling; else pendingApprovals
//   - Persist to KV key "discount_catalogue"
//   - 24h cooldown unless ?force=true
//   - ?dry=true returns result without writing KV / Telegram / Walmart
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

// ─── Config ──────────────────────────────────────────────────
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'gcitires-ca.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || '';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_PAGE_DELAY_MS = 250;

// Walmart auth — still needed for auto-adding items to active Walmart promos.
const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || '';

const KV_KEY = 'discount_catalogue';
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const GROUP_SAMPLE = 100;
const DEFAULT_CEILING = 500;
const DEFAULT_GROUP_CAP = 120;

type GroupId = 'low' | 'mid' | 'high';

interface CatalogueItem {
  id: string;
  sku: string;
  offerId: string;
  gtin: string;
  price: number;
  title: string;
  group: GroupId;
  shopifyProductId?: string;
  shopifyVariantId?: number;
  addedAt?: string;
  autoAdded?: boolean;
}

interface StoredCatalogue {
  groups: Record<GroupId, CatalogueItem[]>;
  pendingApprovals: CatalogueItem[];
  generatedAt: string;
  totalItems: number;
  source: string;
  activeSales?: Partial<Record<GroupId, { effectiveAt: string; pct: number }>>;
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Walmart auth (module-scoped token cache) ────────────────
// Kept for submitItemToActivePromo — when a new tire auto-joins a
// group that already has a live sale, we push the promo to Walmart.
let _wmToken: string | null = null;
let _wmTokenExp = 0;

function basicCredentials(): string {
  const id = process.env.WALMART_CLIENT_ID ?? '';
  const secret = process.env.WALMART_CLIENT_SECRET ?? '';
  if (!id || !secret) {
    throw new Error('Walmart credentials not set (WALMART_CLIENT_ID / WALMART_CLIENT_SECRET).');
  }
  return Buffer.from(`${id}:${secret}`).toString('base64');
}

async function getWalmartToken(): Promise<string> {
  if (_wmToken && Date.now() < _wmTokenExp - 60_000) return _wmToken;
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
    const body = await res.text();
    throw new Error(`Walmart auth failed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data: any = await res.json();
  _wmToken = data.access_token as string;
  _wmTokenExp = Date.now() + (((data.expires_in as number) ?? 900) * 1000);
  return _wmToken!;
}

function walmartHeaders(token: string): Record<string, string> {
  return {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_GLOBAL_VERSION': '3.1',
    'WM_MARKET': 'ca',
    'WM_SVC.NAME': 'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// ─── Vercel KV (REST, Upstash-compatible) ────────────────────
async function kvGet<T>(key: string): Promise<T | null> {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data?.result == null) return null;
    return JSON.parse(data.result) as T;
  } catch (err) {
    console.error('[refresh-catalogue] kvGet failed:', err);
    return null;
  }
}

async function kvSet(key: string, value: unknown): Promise<boolean> {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(value),
    });
    return res.ok;
  } catch (err) {
    console.error('[refresh-catalogue] kvSet failed:', err);
    return false;
  }
}

// ─── Telegram ────────────────────────────────────────────────
async function sendTelegram(text: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`[refresh-catalogue] Telegram failed ${res.status}:`, (await res.text()).slice(0, 200));
    }
  } catch (err) {
    console.error('[refresh-catalogue] Telegram error:', err);
  }
}

// ─── Shopify GraphQL (with THROTTLED retry) ──────────────────
async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  attempt = 0,
): Promise<T> {
  const MAX_ATTEMPTS = 6;
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (res.status === 429) {
    if (attempt >= MAX_ATTEMPTS) throw new Error('Shopify GraphQL 429 after retries');
    await delay(2000);
    return shopifyGraphQL<T>(query, variables, attempt + 1);
  }
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();
  if (json.errors) {
    const throttled = Array.isArray(json.errors) && json.errors.some(
      (e: any) => e?.extensions?.code === 'THROTTLED' || /throttl/i.test(e?.message || ''),
    );
    if (throttled && attempt < MAX_ATTEMPTS) {
      await delay(2000);
      return shopifyGraphQL<T>(query, variables, attempt + 1);
    }
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors).slice(0, 200)}`);
  }
  return json.data as T;
}

// ─── Helpers ─────────────────────────────────────────────────
function gidToId(gid: string): number {
  const m = String(gid).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : NaN;
}

function classify(price: number): GroupId {
  if (price <= 260) return 'low';
  if (price <= 349) return 'mid';
  return 'high';
}

// ─── Fetch all TIRE- variants from Shopify ───────────────────
async function fetchAllShopifyTireVariants(): Promise<CatalogueItem[]> {
  if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_ADMIN_API_TOKEN not set');

  const items: CatalogueItem[] = [];
  let cursor: string | null = null;
  let page = 0;
  const MAX_PAGES = 200; // 200 × 250 = 50k variants safety cap

  while (page < MAX_PAGES) {
    const data: any = await shopifyGraphQL<any>(
      `query TireVariants($cursor: String) {
         productVariants(first: 250, after: $cursor) {
           edges {
             node {
               id
               sku
               price
               product { id title status }
             }
           }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { cursor },
    );

    const conn = data?.productVariants;
    for (const edge of conn?.edges || []) {
      const node = edge?.node;
      if (!node) continue;
      const sku = (node.sku || '').trim();
      if (!sku.toUpperCase().startsWith('TIRE-')) continue;
      if (node.product?.status && node.product.status !== 'ACTIVE') continue;

      const price = parseFloat(node.price) || 0;
      items.push({
        id: sku,
        sku,
        offerId: sku,
        gtin: '',
        price,
        title: node.product?.title || sku,
        group: classify(price),
        shopifyProductId: node.product?.id || undefined,
        shopifyVariantId: gidToId(node.id) || undefined,
      });
    }

    page++;
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    await delay(SHOPIFY_PAGE_DELAY_MS);
  }

  console.log(`[refresh-catalogue] Shopify fetch: ${items.length} TIRE- variants across ${page} page(s)`);
  return items;
}

// ─── Build groups (sorted asc, 100 per group) ───────────────
function buildGroups(items: CatalogueItem[]): Record<GroupId, CatalogueItem[]> {
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const groups: Record<GroupId, CatalogueItem[]> = { low: [], mid: [], high: [] };
  for (const item of sorted) groups[item.group].push(item);
  return {
    low: groups.low.slice(0, GROUP_SAMPLE),
    mid: groups.mid.slice(0, GROUP_SAMPLE),
    high: groups.high.slice(0, GROUP_SAMPLE),
  };
}

// ─── Auto-add a single item to an active Walmart promo ──────
// Uses PUT /v3/price (Global Marketplace), the same endpoint as
// activate-sale.ts. NOT /v3/ca/feeds which requires the channel-type header.
async function submitItemToActivePromo(
  item: CatalogueItem,
  pct: number,
): Promise<void> {
  const token = await getWalmartToken();
  const salePrice = parseFloat((item.price * (1 - pct / 100)).toFixed(2));
  const currentPriceType = item.group === 'high' ? 'CLEARANCE' : 'REDUCED';

  const res = await fetch(`${WALMART_BASE}/v3/price`, {
    method: 'PUT',
    headers: walmartHeaders(token),
    body: JSON.stringify({
      sku: item.sku,
      pricing: [{
        currentPriceType,
        currentPrice: { currency: 'CAD', amount: salePrice },
        comparisonPrice: { currency: 'CAD', amount: item.price },
        comparisonPriceType: 'BASE',
      }],
    }),
  });
  if (!res.ok) {
    console.error(`[refresh-catalogue] auto-add Walmart price PUT failed for ${item.sku}: ${res.status}`);
  }
}

// ─── Handler ─────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const force = req.query.force === 'true';
  const dry = req.query.dry === 'true';

  try {
    // ── Cooldown check ──────────────────────────────────────
    const prev = await kvGet<StoredCatalogue>(KV_KEY);
    if (!force && prev?.generatedAt) {
      const age = Date.now() - new Date(prev.generatedAt).getTime();
      if (age < COOLDOWN_MS) {
        return res.status(200).json({
          skipped: true,
          reason: `last refresh ${Math.round(age / 3600_000)}h ago (<24h). Use ?force=true to override.`,
          groups: prev.groups,
          pendingApprovals: prev.pendingApprovals,
          generatedAt: prev.generatedAt,
          totalItems: prev.totalItems,
          source: prev.source || 'unknown',
          newItems: [],
        });
      }
    }

    // ── Pull live catalogue from Shopify ─────────────────────
    const allItems = await fetchAllShopifyTireVariants();
    const groups = buildGroups(allItems);
    const totalItems = allItems.length;

    const ceiling = DEFAULT_CEILING;
    const cap = DEFAULT_GROUP_CAP;

    // ── New-item detection vs stored catalogue ──────────────
    const newItems: CatalogueItem[] = [];
    const pendingApprovals: CatalogueItem[] = [...(prev?.pendingApprovals || [])];
    const autoAddedByGroup: Record<GroupId, string[]> = { low: [], mid: [], high: [] };
    const pendingFlagged: string[] = [];

    if (prev?.groups) {
      const knownSkus = new Set<string>();
      (['low', 'mid', 'high'] as GroupId[]).forEach(g =>
        (prev.groups[g] || []).forEach(i => knownSkus.add(i.sku.toUpperCase())),
      );
      (prev.pendingApprovals || []).forEach(i => knownSkus.add(i.sku.toUpperCase()));

      for (const item of allItems) {
        if (knownSkus.has(item.sku.toUpperCase())) continue;
        const tagged: CatalogueItem = { ...item, addedAt: new Date().toISOString() };

        if (item.price <= ceiling) {
          const g = item.group;
          if (groups[g].length < cap && !groups[g].some(i => i.sku === item.sku)) {
            tagged.autoAdded = true;
            groups[g].push(tagged);
            autoAddedByGroup[g].push(item.sku);
            newItems.push(tagged);

            const sale = prev.activeSales?.[g];
            if (sale && !dry) {
              await submitItemToActivePromo(tagged, sale.pct ?? 0);
            }
          }
        } else {
          pendingApprovals.push(tagged);
          pendingFlagged.push(item.sku);
          newItems.push(tagged);
        }
      }
    }

    const generatedAt = new Date().toISOString();
    const stored: StoredCatalogue = {
      groups,
      pendingApprovals,
      generatedAt,
      totalItems,
      source: 'shopify',
      activeSales: prev?.activeSales,
    };

    // ── Persist + notify (skipped on dry) ───────────────────
    if (!dry) {
      await kvSet(KV_KEY, stored);

      for (const g of ['low', 'mid', 'high'] as GroupId[]) {
        const skus = autoAddedByGroup[g];
        if (skus.length > 0) {
          await sendTelegram(
            `✅ Auto-added ${skus.length} new tire(s) to active Group ${g.toUpperCase()} sale.\n` +
            `SKUs: ${skus.join(', ')}. Shopify + Walmart promo submitted.`,
          );
        }
      }
      if (pendingFlagged.length > 0) {
        await sendTelegram(
          `⚠️ ${pendingFlagged.length} new tire(s) flagged for manual approval (price >$${ceiling}).\n` +
          `Review in GCI Command Center → Promotions.`,
        );
      }
    }

    return res.status(200).json({
      groups,
      pendingApprovals,
      generatedAt,
      totalItems,
      source: 'shopify',
      newItems,
      skipped: false,
      dry,
    });
  } catch (err: any) {
    console.error('[refresh-catalogue] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error', code: 500 });
  }
}
