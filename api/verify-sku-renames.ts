// api/verify-sku-renames.ts
// ─────────────────────────────────────────────────────────────
// Scans the Walmart catalogue and checks whether the 22 successfully
// renamed unpublished SKUs now appear as clean SKUs (no TIRE- prefix).
//
// Looks for both the old TIRE- form and new clean form of each SKU,
// reports which transition succeeded and which are still pending/failed.
//
// GET /api/verify-sku-renames
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// The 22 successfully submitted renames (16093NXK excluded — SKU conflict)
const RENAMES: { oldSku: string; newSku: string }[] = [
  { oldSku: 'TIRE-12817NXK',                newSku: '12817NXK' },
  { oldSku: 'TIRE-13321NXK',                newSku: '13321NXK' },
  { oldSku: 'TIRE-14376NXK',                newSku: '14376NXK' },
  { oldSku: 'TIRE-15395NXK',                newSku: '15395NXK' },
  { oldSku: 'TIRE-16095NXK',                newSku: '16095NXK' },
  { oldSku: 'TIRE-16096NXK',                newSku: '16096NXK' },
  { oldSku: 'TIRE-16099NXK',                newSku: '16099NXK' },
  { oldSku: 'TIRE-16100NXK',                newSku: '16100NXK' },
  { oldSku: 'TIRE-16107NXK',                newSku: '16107NXK' },
  { oldSku: 'TIRE-16188NXK',                newSku: '16188NXK' },
  { oldSku: 'TIRE-16409NXK',                newSku: '16409NXK' },
  { oldSku: 'TIRE-166284021',               newSku: '166284021' },
  { oldSku: 'TIRE-166424021',               newSku: '166424021' },
  { oldSku: 'TIRE-166425021',               newSku: '166425021' },
  { oldSku: 'TIRE-166426021',               newSku: '166426021' },
  { oldSku: 'TIRE-166427021',               newSku: '166427021' },
  { oldSku: 'TIRE-166430021',               newSku: '166430021' },
  { oldSku: 'TIRE-166435021',               newSku: '166435021' },
  { oldSku: 'TIRE-17136NXK',                newSku: '17136NXK' },
  { oldSku: 'TIRE-BBK90',                   newSku: 'BBK90' },
  { oldSku: 'TIRE-MIC-DLTXP-2657017-115T',  newSku: 'MIC-DLTXP-2657017-115T' },
  { oldSku: 'TIRE-NIT-RG2-2857017-117T',    newSku: 'NIT-RG2-2857017-117T' },
];

// Build lookup sets for fast matching during page scan
const oldSkus = new Set(RENAMES.map(r => r.oldSku));
const newSkus  = new Set(RENAMES.map(r => r.newSku));

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
  if (!res.ok) throw new Error(`Auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

// ─── Handler ──────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const token = await getToken();

    // Track what we find during the scan
    const foundOld = new Map<string, string>(); // oldSku -> publishedStatus (still exists)
    const foundNew = new Map<string, string>(); // newSku -> publishedStatus (rename succeeded)

    let cursor = '*';
    let page   = 0;

    while (page < 100) {
      const url = `${WALMART_BASE}/v3/items?limit=100&nextCursor=${encodeURIComponent(cursor)}`;
      const r   = await fetch(url, { headers: walmartHeaders(token) });
      if (r.status === 429) { await delay(2000); continue; }
      if (!r.ok) throw new Error(`GET /v3/items ${r.status}`);
      const data: any = await r.json();

      const pageItems: any[] = data?.ItemResponse ?? data?.items ?? [];
      for (const item of pageItems) {
        const sku: string = item?.sku ?? '';
        if (oldSkus.has(sku)) foundOld.set(sku, item?.publishedStatus ?? 'UNKNOWN');
        if (newSkus.has(sku))  foundNew.set(sku, item?.publishedStatus ?? 'UNKNOWN');
      }

      const nextCursor = data?.nextCursor || null;
      if (!nextCursor || pageItems.length === 0) break;
      cursor = nextCursor;
      page++;
      await delay(150);
    }

    // Build result for each rename
    const results = RENAMES.map(({ oldSku, newSku }) => {
      const oldFound = foundOld.has(oldSku);
      const newFound = foundNew.has(newSku);

      let status: string;
      if (newFound && !oldFound)  status = 'RENAMED';        // clean — old gone, new present
      if (newFound && oldFound)   status = 'BOTH_EXIST';     // partial — both still in catalogue
      if (!newFound && oldFound)  status = 'NOT_YET';        // old still there, new not visible yet
      if (!newFound && !oldFound) status = 'NEITHER_FOUND';  // unexpected — neither in catalogue
      status ??= 'UNKNOWN';

      return {
        oldSku,
        newSku,
        status,
        newSkuPublishedStatus: foundNew.get(newSku) ?? null,
        oldSkuStillPresent:    oldFound,
      };
    });

    const renamed      = results.filter(r => r.status === 'RENAMED').length;
    const notYet       = results.filter(r => r.status === 'NOT_YET').length;
    const bothExist    = results.filter(r => r.status === 'BOTH_EXIST').length;
    const neitherFound = results.filter(r => r.status === 'NEITHER_FOUND').length;

    return res.status(200).json({
      success: true,
      summary: { renamed, notYet, bothExist, neitherFound, total: RENAMES.length },
      pagesScanned: page + 1,
      results,
    });

  } catch (err: any) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
