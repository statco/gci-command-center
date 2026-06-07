import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

// Trim + strip any non-digit chars (e.g. a stray newline pasted into the env
// var, or an accidental "properties/" prefix). The Data API needs the bare
// numeric property id.
const GA4_PROPERTY_ID = (process.env.GA4_PROPERTY_ID || '').replace(/\D/g, '');
// Service-account JSON key (the full file contents, or base64 of it).
// Preferred over OAuth: no refresh tokens, never expires. The service account's
// client_email must be added as a Viewer on the GA4 property.
const GA4_SERVICE_ACCOUNT_KEY = process.env.GA4_SERVICE_ACCOUNT_KEY;

const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

interface GA4ReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

interface GA4ReportResponse {
  rows?: GA4ReportRow[];
  rowCount?: number;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

class GA4ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GA4ConfigError';
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function loadServiceAccount(): ServiceAccountKey {
  if (!GA4_SERVICE_ACCOUNT_KEY) {
    throw new GA4ConfigError('GA4_SERVICE_ACCOUNT_KEY not set');
  }
  let raw = GA4_SERVICE_ACCOUNT_KEY.trim();
  // Accept either raw JSON or base64-encoded JSON.
  if (!raw.startsWith('{')) {
    try {
      raw = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      throw new GA4ConfigError('GA4_SERVICE_ACCOUNT_KEY is neither JSON nor valid base64');
    }
  }
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(raw);
  } catch {
    throw new GA4ConfigError('GA4_SERVICE_ACCOUNT_KEY is not valid JSON');
  }
  if (!key.client_email || !key.private_key) {
    throw new GA4ConfigError('GA4_SERVICE_ACCOUNT_KEY missing client_email or private_key');
  }
  // Env vars often store the private key with literal "\n" — normalise to real newlines.
  key.private_key = key.private_key.replace(/\\n/g, '\n');
  return key;
}

// In-memory access-token cache (per warm lambda).
let _token: string | null = null;
let _tokenExp = 0;

async function getAccessToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;

  const sa = loadServiceAccount();
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: GA4_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = base64url(
    crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key),
  );
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GA4 service-account token exchange failed ${res.status}: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  _token = data.access_token as string;
  _tokenExp = Date.now() + ((data.expires_in as number ?? 3600) * 1000);
  return _token!;
}

async function runReport(
  dimensions: string[],
  metrics: string[],
  startDate: string,
  endDate: string
): Promise<{ dimensions: string[]; metrics: string[]; rows: Array<Record<string, string>>; rowCount: number }> {
  if (!GA4_PROPERTY_ID) throw new Error('GA4_PROPERTY_ID not set');

  const accessToken = await getAccessToken();

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dimensions: dimensions.map(name => ({ name })),
        metrics: metrics.map(name => ({ name })),
        dateRanges: [{ startDate, endDate }],
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GA4 runReport failed ${res.status} (property ${GA4_PROPERTY_ID}): ${JSON.stringify(err)}`);
  }

  const data: GA4ReportResponse = await res.json();

  const rows = (data.rows || []).map(row => {
    const record: Record<string, string> = {};
    dimensions.forEach((dim, i) => {
      record[dim] = row.dimensionValues?.[i]?.value ?? '';
    });
    metrics.forEach((met, i) => {
      record[met] = row.metricValues?.[i]?.value ?? '';
    });
    return record;
  });

  return { dimensions, metrics, rows, rowCount: data.rowCount ?? rows.length };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { report, startDate, endDate } = req.query;

  const start = (startDate as string) || '7daysAgo';
  const end = (endDate as string) || 'today';

  try {
    switch (report) {
      case 'overview': {
        const data = await runReport(
          ['date'],
          ['sessions', 'activeUsers', 'newUsers', 'bounceRate', 'averageSessionDuration'],
          start, end
        );
        const totalSessions = data.rows.reduce(
          (sum, row) => sum + parseInt(row.sessions || '0', 10), 0
        );
        return res.status(200).json({ ...data, totalSessions });
      }
      case 'top-pages':
        return res.status(200).json(await runReport(
          ['pagePath', 'pageTitle'],
          ['screenPageViews', 'averageSessionDuration', 'bounceRate'],
          start, end
        ));
      case 'traffic-sources':
        return res.status(200).json(await runReport(
          ['sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium'],
          ['sessions', 'activeUsers', 'conversions'],
          start, end
        ));
      case 'conversions':
        return res.status(200).json(await runReport(
          ['eventName', 'date'],
          ['eventCount', 'conversions', 'totalRevenue'],
          start, end
        ));
      default:
        return res.status(400).json({
          error: 'Unknown report. Use: overview | top-pages | traffic-sources | conversions',
        });
    }
  } catch (err: any) {
    console.error('[ga4 api]', err);
    if (err instanceof GA4ConfigError) {
      return res.status(500).json({
        error: err.message,
        code: 'GA4_CONFIG_ERROR',
        hint: 'Set GA4_SERVICE_ACCOUNT_KEY (service-account JSON) and add the service account email as a Viewer on the GA4 property.',
      });
    }
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
}
