// api/discount-proxy.ts
// ─────────────────────────────────────────────────────────────
// Vercel serverless proxy for all Walmart Canada API calls made from
// the Discount Manager browser UI. Avoids CORS and keeps the Walmart
// credentials server-side.
//
// Pattern follows gci-order-hub/api/lib/walmart-client.ts:
//   - OAuth2 client_credentials → Basic base64(clientId:secret)
//   - token cached in module scope, refreshed when expired
//   - WM_SEC.ACCESS_TOKEN header on all API calls
//
// Routes by ?action=:
//   submitPriceFeed → POST /v3/ca/feeds?feedType=price
//   getFeedStatus   → GET  /v3/ca/feeds/{feedId}
//   getItems        → GET  /v3/ca/items (paginated)
//
// ?dry=true logs the payload but does NOT submit to Walmart.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

const WALMART_BASE = (
  process.env.WALMART_BASE_URL ?? 'https://marketplace.walmartapis.com'
).replace(/\/$/, '');

const PROXY_SECRET = process.env.PROXY_SECRET || '';

// ─── OAuth token cache (module scope) ─────────────────────────
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
  const expiresIn = (data.expires_in as number) ?? 900;
  _tokenExp = Date.now() + expiresIn * 1000;
  return _token!;
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

// ─── Origin / secret validation ───────────────────────────────
function isAuthorized(req: VercelRequest): boolean {
  // A shared PROXY_SECRET takes precedence when configured.
  if (PROXY_SECRET) {
    const provided = (req.headers['x-proxy-secret'] as string) || '';
    return provided === PROXY_SECRET;
  }
  // Otherwise require a same-origin Referer/Origin.
  const host = req.headers.host || '';
  const referer = (req.headers.referer as string) || (req.headers.origin as string) || '';
  if (!host) return false;
  if (!referer) return true; // same-origin fetch may omit Referer; allow.
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAuthorized(req)) {
    return res.status(403).json({ error: 'Forbidden — invalid origin', code: 403 });
  }

  const action = (req.query.action as string) || '';
  const dry = req.query.dry === 'true';

  try {
    switch (action) {
      // ── Submit a price/promotion feed ──────────────────────
      case 'submitPriceFeed': {
        if (req.method !== 'POST') {
          return res.status(405).json({ error: 'Method not allowed', code: 405 });
        }
        if (dry) {
          console.log('[discount-proxy] DRY submitPriceFeed payload:', JSON.stringify(req.body).slice(0, 2000));
          return res.status(200).json({
            dry: true,
            feedId: `DRY-${Date.now()}`,
            feedStatus: 'DRY_RUN',
            itemCount: (req.body?.Price?.length ?? 0),
          });
        }
        const token = await getWalmartToken();
        const wm = await fetch(`${WALMART_BASE}/v3/ca/feeds?feedType=price`, {
          method: 'POST',
          headers: walmartHeaders(token),
          body: JSON.stringify(req.body),
        });
        const text = await wm.text();
        if (!wm.ok) {
          console.error(`[discount-proxy] submitPriceFeed ${wm.status}:`, text.slice(0, 300));
          return res.status(502).json({ error: `Walmart feed ${wm.status}: ${text.slice(0, 200)}`, code: 502 });
        }
        return res.status(200).json(text ? JSON.parse(text) : {});
      }

      // ── Poll feed status ──────────────────────────────────
      case 'getFeedStatus': {
        const feedId = req.query.feedId as string;
        if (!feedId) return res.status(400).json({ error: 'feedId required', code: 400 });
        const token = await getWalmartToken();
        const wm = await fetch(
          `${WALMART_BASE}/v3/ca/feeds/${encodeURIComponent(feedId)}?includeDetails=true`,
          { headers: walmartHeaders(token) },
        );
        const text = await wm.text();
        if (!wm.ok) {
          console.error(`[discount-proxy] getFeedStatus ${wm.status}:`, text.slice(0, 300));
          return res.status(502).json({ error: `Walmart feed status ${wm.status}`, code: 502 });
        }
        return res.status(200).json(text ? JSON.parse(text) : {});
      }

      // ── List items (paginated by the caller via nextCursor) ─
      case 'getItems': {
        const limit = (req.query.limit as string) || '200';
        const cursor = (req.query.nextCursor as string) || '';
        const qs = cursor
          ? `?limit=${limit}&nextCursor=${encodeURIComponent(cursor)}`
          : `?limit=${limit}`;
        const token = await getWalmartToken();
        const wm = await fetch(`${WALMART_BASE}/v3/ca/items${qs}`, {
          headers: walmartHeaders(token),
        });
        const text = await wm.text();
        if (!wm.ok) {
          console.error(`[discount-proxy] getItems ${wm.status}:`, text.slice(0, 300));
          return res.status(502).json({ error: `Walmart items ${wm.status}`, code: 502 });
        }
        return res.status(200).json(text ? JSON.parse(text) : {});
      }

      default:
        return res.status(400).json({
          error: 'Unknown action. Use: submitPriceFeed | getFeedStatus | getItems',
          code: 400,
        });
    }
  } catch (err: any) {
    console.error('[discount-proxy] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error', code: 500 });
  }
}
