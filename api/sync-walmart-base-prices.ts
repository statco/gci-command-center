// api/sync-walmart-base-prices.ts
// ─────────────────────────────────────────────────────────────
// One-shot (and nightly-cron-safe) endpoint that pushes the current
// Shopify price as the Walmart BASE price for every active SKU in the
// KV catalogue.
//
// Why this exists:
//   Walmart maintains its own base price independently of Shopify. When
//   CT/supplier prices change overnight and the nightly cron updates
//   Shopify, Walmart's base price stays stale. This causes Walmart to
//   display the wrong regular price both when no promo is running AND
//   as the strikethrough "was" price when a promo is active.
//
//   PUT /v3/price with currentPriceType: "BASE" overwrites Walmart's
//   stored base price with the value we pass. After this call:
//     - Walmart shows the correct regular price at all times
//     - The REDUCED/CLEARANCE comparisonPrice in activate-sale.ts is
//       now redundant (Walmart already knows the base) but left in for
//       belt-and-suspenders explicitness
//
// Called by:
//   - Dashboard "Sync Walmart Prices" button (manual, immediate fix)
//   - refresh-catalogue.ts at the end of every nightly cron run
//
// Response:
//   { updated, failed, skipped, total, failures[], durationMs }
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

// ─── Config ───────────────────────────────────────────────────
const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

const KV_URL   = process.env.KV_REST_API_URL   || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN  || '';

const WALMART_RATE_DELAY_MS = 150;

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Types (mirrors refresh-catalogue / activate-sale) ────────
type GroupId = 'low' | 'mid' | 'high';

interface CatalogueItem {
  sku: string;
  price: number;
  group: GroupId;
  [key: string]: unknown;
}

interface StoredCatalogue {
  groups: Record<GroupId, CatalogueItem[]>;
  pendingApprovals?: CatalogueItem[];
  generatedAt?: string;
  [key: string]: unknown;
}

// ─── Walmart auth (module-scoped token cache) ─────────────────
let _token: string | null = null;
let _tokenExp = 0;

function basicCredentials(): string {
  const id     = process.env.WALMART_CLIENT_ID     ?? '';
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
      Authorization:            `Basic ${basicCredentials()}`,
      'Content-Type':           'application/x-www-form-urlencoded',
      'WM_SVC.NAME':            'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID':  crypto.randomUUID(),
      'WM_MARKET':              'ca',
      Accept:                   'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Walmart auth failed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data: any = await res.json();
  _token    = data.access_token as string;
  _tokenExp = Date.now() + (((data.expires_in as number) ?? 900) * 1000);
  return _token!;
}

function walmartHeaders(token: string): Record<string, string> {
  return {
    'WM_SEC.ACCESS_TOKEN':    token,
    'WM_GLOBAL_VERSION':      '3.1',
    'WM_MARKET':              'ca',
    'WM_SVC.NAME':            'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID':  crypto.randomUUID(),
    'Content-Type':           'application/json',
    Accept:                   'application/json',
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
    console.error('[sync-walmart-base-prices] kvGet failed:', err);
    return null;
  }
}

// ─── Core: push BASE price for a single SKU ───────────────────
async function putBasePrice(
  token: string,
  sku: string,
  price: number,
  attempt = 0,
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(`${WALMART_BASE}/v3/price`, {
    method: 'PUT',
    headers: walmartHeaders(token),
    body: JSON.stringify({
      sku,
      pricing: [{
        currentPriceType: 'BASE',
        currentPrice: { currency: 'CAD', amount: price },
      }],
    }),
  });
  if (res.status === 429 && attempt < 3) {
    await delay(2000);
    return putBasePrice(token, sku, price, attempt + 1);
  }
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

// ─── Handler ──────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startMs = Date.now();

  try {
    const catalogue = await kvGet<StoredCatalogue>('discount_catalogue');
    if (!catalogue?.groups) {
      return res.status(400).json({
        error: 'No catalogue found in KV. Run a catalogue refresh first.',
      });
    }

    const allItems: CatalogueItem[] = [
      ...(catalogue.groups.low  || []),
      ...(catalogue.groups.mid  || []),
      ...(catalogue.groups.high || []),
    ];

    if (allItems.length === 0) {
      return res.status(200).json({
        updated: 0, failed: 0, skipped: 0,
        total: 0, failures: [], durationMs: 0,
        message: 'No items in catalogue groups — nothing to sync.',
      });
    }

    console.log(`[sync-walmart-base-prices] Starting BASE price sync for ${allItems.length} SKUs`);

    const token = await getWalmartToken();

    let updated  = 0;
    let failed   = 0;
    let skipped  = 0;
    const failures: { sku: string; status: number; error: string }[] = [];

    for (const item of allItems) {
      if (!item.sku || !item.price || item.price <= 0) {
        skipped++;
        continue;
      }

      const r = await putBasePrice(token, item.sku, item.price);
      if (r.ok) {
        updated++;
        console.log(`[sync-walmart-base-prices] ✓ ${item.sku} BASE=$${item.price}`);
      } else {
        failed++;
        failures.push({ sku: item.sku, status: r.status, error: r.text.slice(0, 200) });
        console.error(`[sync-walmart-base-prices] ✗ ${item.sku} ${r.status}: ${r.text.slice(0, 200)}`);
      }

      await delay(WALMART_RATE_DELAY_MS);
    }

    const durationMs = Date.now() - startMs;
    console.log(
      `[sync-walmart-base-prices] Done: ${updated} updated, ${failed} failed, ${skipped} skipped` +
      ` in ${(durationMs / 1000).toFixed(1)}s`,
    );

    return res.status(200).json({
      success: true,
      updated,
      failed,
      skipped,
      total: allItems.length,
      failures,
      durationMs,
      catalogueGeneratedAt: catalogue.generatedAt ?? null,
    });

  } catch (err: any) {
    console.error('[sync-walmart-base-prices] error:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : JSON.stringify(err),
      code: 500,
    });
  }
}
