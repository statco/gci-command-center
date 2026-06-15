// api/audit-walmart-skus.ts
// ─────────────────────────────────────────────────────────────
// One-shot diagnostic endpoint. Fetches ALL items from the Walmart
// CA Marketplace catalogue (paginated via nextCursor) and returns:
//   - totalItems: full catalogue count
//   - tirePrefixCount: how many have TIRE- prefix
//   - tirePrefixItems: full list of { oldSku, newSku, title, status, price }
//   - cleanItems: count of items with no TIRE- prefix
//
// Call once from the dashboard button, read the JSON, done.
// Safe to delete this file after the remediation is complete.
//
// GET /api/audit-walmart-skus
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Walmart auth ─────────────────────────────────────────────
let _token: string | null = null;
let _tokenExp = 0;

function basicCredentials(): string {
  const id     = process.env.WALMART_CLIENT_ID     ?? '';
  const secret = process.env.WALMART_CLIENT_SECRET ?? '';
  if (!id || !secret) throw new Error('Walmart credentials not set.');
  return Buffer.from(`${id}:${secret}`).toString('base64');
}

async function getWalmartToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;
  const res = await fetch(`${WALMART_BASE}/v3/token`, {
    method: 'POST',
    headers: {
      Authorization:           `Basic ${basicCredentials()}`,
      'Content-Type':          'application/x-www-form-urlencoded',
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
      'WM_MARKET':             'ca',
      Accept:                  'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Walmart auth failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  _token    = data.access_token as string;
  _tokenExp = Date.now() + ((data.expires_in ?? 900) * 1000);
  return _token!;
}

function walmartHeaders(token: string): Record<string, string> {
  return {
    'WM_SEC.ACCESS_TOKEN':   token,
    'WM_GLOBAL_VERSION':     '3.1',
    'WM_MARKET':             'ca',
    'WM_SVC.NAME':           'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    Accept:                  'application/json',
  };
}

// ─── Fetch one page of items ──────────────────────────────────
async function fetchItemPage(
  token: string,
  nextCursor: string,
  limit = 100,
): Promise<{ items: any[]; nextCursor: string | null; totalCount: number }> {
  const url = `${WALMART_BASE}/v3/items?limit=${limit}&nextCursor=${encodeURIComponent(nextCursor)}`;
  const res = await fetch(url, { headers: walmartHeaders(token) });

  if (res.status === 429) {
    await delay(3000);
    return fetchItemPage(token, nextCursor, limit);
  }
  if (!res.ok) {
    throw new Error(`GET /v3/items failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data: any = await res.json();

  // Response shape: { ItemResponse: [...], totalItems: N, nextCursor: '...' }
  const items: any[]     = data?.ItemResponse ?? data?.items ?? [];
  const total: number    = data?.totalItems   ?? data?.totalCount ?? 0;
  const cursor: string | null = data?.nextCursor || null;

  return { items, nextCursor: cursor, totalCount: total };
}

// ─── Handler ──────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const startMs = Date.now();

  try {
    const token = await getWalmartToken();

    const allItems: any[]  = [];
    let cursor: string     = '*';   // Walmart: first page always starts with '*'
    let totalCount         = 0;
    let page               = 0;
    const MAX_PAGES        = 100;   // safety ceiling — 100 pages × 100 items = 10,000 items

    console.log('[audit-walmart-skus] Starting full catalogue fetch…');

    while (page < MAX_PAGES) {
      const result = await fetchItemPage(token, cursor, 100);

      if (page === 0) {
        totalCount = result.totalCount;
        console.log(`[audit-walmart-skus] Total items reported by Walmart: ${totalCount}`);
      }

      allItems.push(...result.items);
      console.log(`[audit-walmart-skus] Page ${page + 1}: got ${result.items.length} items (${allItems.length} total so far)`);

      if (!result.nextCursor || result.items.length === 0) break;
      cursor = result.nextCursor;
      page++;
      await delay(200); // gentle pacing
    }

    console.log(`[audit-walmart-skus] Fetch complete: ${allItems.length} items across ${page + 1} pages`);

    // ── Classify items ────────────────────────────────────────
    const tirePrefixItems: {
      oldSku: string;
      newSku: string;
      title: string;
      publishedStatus: string;
      price: number | null;
    }[] = [];

    const cleanItems: { sku: string; title: string; publishedStatus: string }[] = [];

    for (const item of allItems) {
      // Walmart item response uses different field names depending on API version
      const sku: string =
        item?.sku           ??
        item?.Sku           ??
        item?.offerId       ??
        item?.martId        ??
        '';

      const title: string =
        item?.productName   ??
        item?.itemName      ??
        item?.title         ??
        '';

      const status: string =
        item?.publishedStatus ??
        item?.status          ??
        '';

      const price: number | null =
        item?.price?.amount ??
        item?.sellerPrice   ??
        null;

      if (!sku) continue;

      if (sku.startsWith('TIRE-')) {
        tirePrefixItems.push({
          oldSku: sku,
          newSku: sku.replace(/^TIRE-/, ''),
          title,
          publishedStatus: status,
          price,
        });
      } else {
        cleanItems.push({ sku, title, publishedStatus: status });
      }
    }

    // Sort TIRE- items: PUBLISHED first, then alphabetical
    tirePrefixItems.sort((a, b) => {
      if (a.publishedStatus === b.publishedStatus) return a.oldSku.localeCompare(b.oldSku);
      return a.publishedStatus === 'PUBLISHED' ? -1 : 1;
    });

    const durationMs = Date.now() - startMs;

    console.log(
      `[audit-walmart-skus] Done: ${allItems.length} total, ` +
      `${tirePrefixItems.length} TIRE- prefix, ${cleanItems.length} clean` +
      ` in ${(durationMs / 1000).toFixed(1)}s`,
    );

    return res.status(200).json({
      success:         true,
      totalItems:      allItems.length,
      reportedTotal:   totalCount,
      tirePrefixCount: tirePrefixItems.length,
      cleanCount:      cleanItems.length,
      tirePrefixItems,          // full rename list
      durationMs,
      pages:           page + 1,
    });

  } catch (err: any) {
    console.error('[audit-walmart-skus] error:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : JSON.stringify(err),
    });
  }
}
