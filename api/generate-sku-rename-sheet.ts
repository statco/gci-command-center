// api/generate-sku-rename-sheet.ts
// ─────────────────────────────────────────────────────────────
// Fetches full item details for all UNPUBLISHED TIRE- prefix SKUs
// from Walmart CA using the same GET /v3/items pagination that
// the audit endpoint uses (WM_MARKET:ca, OAuth token).
//
// The per-SKU /v3/ca/items/{sku} endpoint returns 404 — it requires
// legacy Consumer ID auth. This endpoint instead paginates through
// the full catalogue (same as audit-walmart-skus.ts), finds the 23
// unpublished TIRE- SKUs, captures ALL raw fields from each item
// object, and returns them for inspection + XLSX generation.
//
// GET /api/generate-sku-rename-sheet
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// The 23 unpublished TIRE- SKUs to target
const TARGET_SKUS = new Set([
  'TIRE-12817NXK','TIRE-13321NXK','TIRE-14376NXK','TIRE-15395NXK',
  'TIRE-16093NXK','TIRE-16095NXK','TIRE-16096NXK','TIRE-16099NXK',
  'TIRE-16100NXK','TIRE-16107NXK','TIRE-16188NXK','TIRE-16409NXK',
  'TIRE-166284021','TIRE-166424021','TIRE-166425021','TIRE-166426021',
  'TIRE-166427021','TIRE-166430021','TIRE-166435021','TIRE-17136NXK',
  'TIRE-BBK90','TIRE-MIC-DLTXP-2657017-115T','TIRE-NIT-RG2-2857017-117T',
]);

// ─── Auth (identical to audit-walmart-skus.ts) ────────────────
let _token: string | null = null;
let _tokenExp = 0;

async function getToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;
  const id     = process.env.WALMART_CLIENT_ID     ?? '';
  const secret = process.env.WALMART_CLIENT_SECRET ?? '';
  if (!id || !secret) throw new Error('Walmart credentials not set.');
  const res = await fetch(`${WALMART_BASE}/v3/token`, {
    method: 'POST',
    headers: {
      Authorization:           `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type':          'application/x-www-form-urlencoded',
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
      'WM_MARKET':             'ca',
      Accept:                  'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Walmart auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d: any = await res.json();
  _token    = d.access_token;
  _tokenExp = Date.now() + ((d.expires_in ?? 900) * 1000);
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

// ─── Paginated fetch (identical pattern to audit-walmart-skus) ─
async function fetchPage(
  token: string,
  cursor: string,
  limit = 100,
): Promise<{ items: any[]; nextCursor: string | null; totalCount: number }> {
  const url = `${WALMART_BASE}/v3/items?limit=${limit}&nextCursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(url, { headers: walmartHeaders(token) });
  if (res.status === 429) { await delay(2000); return fetchPage(token, cursor, limit); }
  if (!res.ok) throw new Error(`GET /v3/items ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return {
    items:      data?.ItemResponse ?? data?.items ?? [],
    nextCursor: data?.nextCursor   || null,
    totalCount: data?.totalItems   ?? data?.totalCount ?? 0,
  };
}

// ─── Handler ──────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const token = await getToken();
    const found = new Map<string, any>(); // oldSku -> raw item object
    let cursor  = '*';
    let page    = 0;

    console.log(`[generate-sku-rename-sheet] Scanning catalogue for ${TARGET_SKUS.size} unpublished SKUs...`);

    while (page < 100 && found.size < TARGET_SKUS.size) {
      const result = await fetchPage(token, cursor, 100);
      for (const item of result.items) {
        const sku: string = item?.sku ?? item?.Sku ?? item?.offerId ?? '';
        if (TARGET_SKUS.has(sku)) {
          found.set(sku, item);
          console.log(`[generate-sku-rename-sheet] Found ${sku} (${found.size}/${TARGET_SKUS.size})`);
        }
      }
      if (!result.nextCursor || result.items.length === 0) break;
      cursor = result.nextCursor;
      page++;
      await delay(200);
    }

    console.log(`[generate-sku-rename-sheet] Scan complete: ${found.size} of ${TARGET_SKUS.size} found after ${page + 1} pages`);

    // Build response: for each target SKU, return raw item + extracted fields
    const items = Array.from(TARGET_SKUS).map(oldSku => {
      const newSku = oldSku.replace(/^TIRE-/, '');
      const raw    = found.get(oldSku);

      if (!raw) return { oldSku, newSku, error: 'not_found_in_catalogue' };

      // Extract GTIN — dump ALL keys so we can see what's available
      return {
        oldSku,
        newSku,
        // The fields we need for the XLSX
        productName:     raw.productName  ?? raw.itemName   ?? '',
        brand:           raw.brand        ?? raw.brandName  ?? '',
        price:           raw.price?.amount ?? raw.sellerPrice ?? 0,
        publishedStatus: raw.publishedStatus ?? raw.status ?? '',
        mainImageUrl:    raw.images?.[0]?.thumbnailUrl ?? raw.imageUrl ?? '',
        // GTIN candidates — whichever is populated tells us the field name
        gtin_candidates: {
          upc:           raw.upc          ?? null,
          gtin:          raw.gtin         ?? null,
          productId:     raw.productId    ?? null,
          wpid:          raw.wpid         ?? null,
          isbn:          raw.isbn         ?? null,
          ean:           raw.ean          ?? null,
          productIdentifiers: raw.productIdentifiers ?? null,
        },
        // Full raw key list so we know exactly what Walmart returns
        rawKeys: Object.keys(raw),
      };
    });

    const foundCount   = items.filter(i => !i.error).length;
    const missingCount = items.filter(i =>  i.error).length;

    return res.status(200).json({
      success:      true,
      count:        items.length,
      foundInApi:   foundCount,
      notFound:     missingCount,
      pagesScanned: page + 1,
      items,
    });

  } catch (err: any) {
    console.error('[generate-sku-rename-sheet] error:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
