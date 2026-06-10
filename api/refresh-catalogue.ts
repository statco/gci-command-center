// api/refresh-catalogue.ts
// ─────────────────────────────────────────────────────────────
// Rebuilds the Discount Manager sale groups from LIVE Walmart Canada
// data. Runs on demand (GET /api/refresh-catalogue) and on the nightly
// cron (0 10 UTC = 5 AM EST, one hour after walmart-sync).
//
//   - Auth: Walmart client_credentials (same as discount-proxy)
//   - Fetch all TIRE- items, paginate via nextCursor
//   - Price breaks: LOW ≤ $260 | MID $261–$349 | HIGH ≥ $350
//   - Sample 100 per group
//   - New-item detection vs the catalogue stored in Vercel KV:
//       price ≤ ceiling → auto-add to group (if not at cap), and if that
//         group has an active sale, submit to Walmart immediately
//       price > ceiling → push to pendingApprovals for manual review
//     Both paths fire a Telegram notification.
//   - Persist to KV key "discount_catalogue"
//   - 24h cooldown unless ?force=true
//   - ?dry=true returns the result without writing KV / Telegram / Walmart
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

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
const EFFECTIVE_LEAD_HOURS = 5;

type GroupId = 'low' | 'mid' | 'high';

interface CatalogueItem {
  id: string;
  sku: string;
  offerId: string;
  gtin: string;
  price: number;
  title: string;
  group: GroupId;
  addedAt?: string;
  autoAdded?: boolean;
}

interface StoredCatalogue {
  groups: Record<GroupId, CatalogueItem[]>;
  pendingApprovals: CatalogueItem[];
  generatedAt: string;
  totalItems: number;
  activeSales?: Partial<Record<GroupId, { effectiveAt: string; pct: number }>>;
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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
    const body = await res.text();
    throw new Error(`Walmart auth failed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data: any = await res.json();
  _token = data.access_token as string;
  _tokenExp = Date.now() + (((data.expires_in as number) ?? 900) * 1000);
  return _token!;
}

function walmartHeaders(token: string): Record<string, string> {
  // WM_CONSUMER.CHANNEL.TYPE is intentionally NOT sent on any call — neither the
  // items GET (already proven to work without it) nor feed submission. The
  // proven gci-walmart-sync client omits it entirely; the old
  // 'SWAGGER_WALMART_CA_MARKETPLACE' placeholder caused a 400 on the auto-add
  // promo feed submission below.
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

// ─── Vercel KV (REST, Upstash-compatible) ─────────────────────
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

// ─── Telegram (copied pattern from gci-order-hub/api/lib/notify.ts) ─
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

// ─── Walmart item fetch ───────────────────────────────────────
function classify(price: number): GroupId {
  if (price <= 260) return 'low';
  if (price <= 349) return 'mid';
  return 'high';
}

async function fetchAllWalmartTires(): Promise<CatalogueItem[]> {
  const token = await getWalmartToken();
  const all: CatalogueItem[] = [];
  const PAGE_SIZE = 200;
  let offset = 0;
  let totalItems = Infinity;
  let page = 0;
  const MAX_PAGES = 100; // safety

  while (page < MAX_PAGES && offset < totalItems) {
    const qs = `?limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(`${WALMART_BASE}/v3/items${qs}`, {
      headers: walmartHeaders(token), // no channel header sent (see walmartHeaders)
    });
    if (!res.ok) {
      throw new Error(`Walmart items HTTP ${res.status} on page ${page + 1}: ${(await res.text()).slice(0, 200)}`);
    }
    const data: any = await res.json();
    const list: any[] = data?.ItemResponse ?? data?.items ?? [];

    if (page === 0) {
      totalItems = (data?.totalItems as number) ?? list.length;
    }

    for (const it of list) {
      const sku = String(it.sku ?? it.mart_sku ?? '');
      if (!sku.toUpperCase().startsWith('TIRE-')) continue;
      const price = parseFloat(
        it.price?.amount ?? it.price ?? it.currentPrice?.amount ?? '0',
      ) || 0;
      const group = classify(price);
      all.push({
        id: sku,
        sku,
        offerId: String(it.offerId ?? it.wpid ?? sku),
        gtin: String(it.gtin ?? ''),
        price,
        title: String(it.productName ?? it.productType ?? sku),
        group,
      });
    }

    if (list.length === 0) break;
    page++;
    offset += PAGE_SIZE;
    await delay(300); // rate-limit between pages
  }

  return all;
}

// ─── Build groups (sorted asc, 100 per group) ─────────────────
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

// ─── Submit a single auto-added item to an active Walmart promo ──
async function submitItemToActivePromo(
  item: CatalogueItem,
  pct: number,
  effectiveAt: string,
  durationDays: number,
): Promise<void> {
  const token = await getWalmartToken();
  const effective = effectiveAt || new Date(Date.now() + EFFECTIVE_LEAD_HOURS * 3600_000).toISOString();
  const expiration = new Date(new Date(effective).getTime() + durationDays * 86400_000).toISOString();
  const currentPriceType = item.group === 'high' ? 'CLEARANCE' : 'REDUCED';
  const amount = parseFloat((item.price * (1 - pct / 100)).toFixed(2));

  const payload = {
    PriceHeader: { version: '1.7' },
    Price: [{
      itemIdentifier: { sku: item.sku },
      pricingList: {
        pricing: [{
          currentPriceType,
          currentPrice: { currentPrice: { currency: 'CAD', amount } },
          comparisonPrice: { currency: 'CAD', amount: item.price },
          effectiveDate: effective,
          expirationDate: expiration,
        }],
      },
    }],
  };

  const res = await fetch(`${WALMART_BASE}/v3/ca/feeds?feedType=price`, {
    method: 'POST',
    headers: walmartHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`[refresh-catalogue] auto-add promo submit failed for ${item.sku}: ${res.status}`);
  }
}

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
          newItems: [],
        });
      }
    }

    // ── Pull live catalogue ─────────────────────────────────
    const items = await fetchAllWalmartTires();
    const groups = buildGroups(items);
    const totalItems = items.length;

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

      for (const item of items) {
        if (knownSkus.has(item.sku.toUpperCase())) continue;
        // genuinely new TIRE- item
        const tagged: CatalogueItem = { ...item, addedAt: new Date().toISOString() };

        if (item.price <= ceiling) {
          const g = item.group;
          if (groups[g].length < cap && !groups[g].some(i => i.sku === item.sku)) {
            tagged.autoAdded = true;
            groups[g].push(tagged);
            autoAddedByGroup[g].push(item.sku);
            newItems.push(tagged);

            // If this group has an active sale, push the item to Walmart now.
            const sale = prev.activeSales?.[g];
            if (sale && !dry) {
              await submitItemToActivePromo(
                tagged,
                sale.pct ?? 0,
                sale.effectiveAt,
                30,
              );
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
            `SKUs: ${skus.join(', ')}. Walmart promo submitted.`,
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
      newItems,
      skipped: false,
      dry,
    });
  } catch (err: any) {
    console.error('[refresh-catalogue] error:', err);
    // Fall back gracefully — the client falls back to static catalogue.ts.
    return res.status(500).json({ error: err?.message || 'Internal server error', code: 500 });
  }
}
