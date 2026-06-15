// api/generate-sku-rename-sheet.ts
// ─────────────────────────────────────────────────────────────
// Fetches full item details for all UNPUBLISHED TIRE- prefix SKUs
// from Walmart CA, then returns a JSON payload ready to be turned
// into the Walmart bulk upload XLSX for SKU rename.
//
// Why JSON not XLSX: Vercel serverless functions can't write binary
// files to disk. The XLSX is built locally by running:
//   node scripts/build-sku-rename-xlsx.mjs
// which reads this endpoint's response.
//
// GET /api/generate-sku-rename-sheet
// Returns: { items: [{ oldSku, newSku, productId, productIdType,
//             productName, brand, price, mainImageUrl, tireSize }] }
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── The 23 unpublished TIRE- SKUs from the audit ────────────
const UNPUBLISHED_TIRE_SKUS = [
  'TIRE-12817NXK','TIRE-13321NXK','TIRE-14376NXK','TIRE-15395NXK',
  'TIRE-16093NXK','TIRE-16095NXK','TIRE-16096NXK','TIRE-16099NXK',
  'TIRE-16100NXK','TIRE-16107NXK','TIRE-16188NXK','TIRE-16409NXK',
  'TIRE-166284021','TIRE-166424021','TIRE-166425021','TIRE-166426021',
  'TIRE-166427021','TIRE-166430021','TIRE-166435021','TIRE-17136NXK',
  'TIRE-BBK90','TIRE-MIC-DLTXP-2657017-115T','TIRE-NIT-RG2-2857017-117T',
];

// ─── Auth ─────────────────────────────────────────────────────
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
  if (!res.ok) throw new Error(`Walmart auth ${res.status}: ${(await res.text()).slice(0,200)}`);
  const d: any = await res.json();
  _token    = d.access_token;
  _tokenExp = Date.now() + ((d.expires_in ?? 900) * 1000);
  return _token!;
}

function headers(token: string) {
  return {
    'WM_SEC.ACCESS_TOKEN':   token,
    'WM_GLOBAL_VERSION':     '3.1',
    'WM_MARKET':             'ca',
    'WM_SVC.NAME':           'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    Accept:                  'application/json',
  };
}

// ─── Fetch single item detail ─────────────────────────────────
async function fetchItem(token: string, sku: string): Promise<any | null> {
  // Try CA-specific endpoint first, fall back to global
  const url = `${WALMART_BASE}/v3/ca/items/${encodeURIComponent(sku)}`;
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) return null;
  if (res.status === 429) { await delay(3000); return fetchItem(token, sku); }
  if (!res.ok) {
    console.error(`[generate-sku-rename-sheet] ${sku} → ${res.status}`);
    return null;
  }
  return res.json();
}

// ─── Handler ──────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const token = await getToken();
    const results: any[] = [];

    for (const oldSku of UNPUBLISHED_TIRE_SKUS) {
      const newSku = oldSku.replace(/^TIRE-/, '');
      console.log(`[generate-sku-rename-sheet] Fetching: ${oldSku}`);

      const data = await fetchItem(token, oldSku);
      await delay(200);

      if (!data) {
        console.warn(`[generate-sku-rename-sheet] No data for ${oldSku} — using minimal fallback`);
        results.push({ oldSku, newSku, error: 'not_found' });
        continue;
      }

      // Walmart CA item response can nest under different keys
      const item = data?.ItemResponse?.[0] ?? data?.item ?? data;

      // Extract GTIN — Walmart returns it in various places
      const productId: string =
        item?.upc ??
        item?.gtin ??
        item?.productId ??
        item?.wpid ??
        item?.productIdentifiers?.find?.((p: any) => p.productIdType === 'UPC')?.productId ??
        item?.productIdentifiers?.find?.((p: any) => p.productIdType === 'GTIN')?.productId ??
        item?.productIdentifiers?.[0]?.productId ??
        '';

      const productIdType: string =
        item?.productIdentifiers?.find?.((p: any) => p.productId === productId)?.productIdType ??
        (productId.length === 12 ? 'UPC' : productId.length === 14 ? 'GTIN' : 'UPC');

      results.push({
        oldSku,
        newSku,
        productId,
        productIdType,
        productName: item?.productName ?? item?.itemName ?? '',
        brand:       item?.brand ?? item?.brandName ?? '',
        price:       item?.price?.amount ?? item?.sellerPrice ?? item?.offerPrice ?? 0,
        mainImageUrl: item?.images?.[0]?.thumbnailUrl ?? item?.imageUrl ?? '',
        tireSize:    item?.tireSize ?? '',
        publishedStatus: item?.publishedStatus ?? 'UNPUBLISHED',
        rawKeys: Object.keys(item ?? {}),  // debug: shows what fields are available
      });
    }

    console.log(`[generate-sku-rename-sheet] Done: ${results.length} items`);
    return res.status(200).json({ success: true, count: results.length, items: results });

  } catch (err: any) {
    console.error('[generate-sku-rename-sheet] error:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
