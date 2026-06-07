import type { VercelRequest, VercelResponse } from '@vercel/node';

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_CLIENT_ID = process.env.GA4_CLIENT_ID;
const GA4_CLIENT_SECRET = process.env.GA4_CLIENT_SECRET;
const GA4_REFRESH_TOKEN = process.env.GA4_REFRESH_TOKEN;
// Must match an Authorized Redirect URI in Google Cloud Console → OAuth 2.0 credentials.
const GA4_REDIRECT_URI = process.env.GA4_REDIRECT_URI || 'https://ops.gcitires.com/api/ga4?action=callback';

interface GA4ReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

interface GA4ReportResponse {
  rows?: GA4ReportRow[];
  rowCount?: number;
}

class TokenExpiredError extends Error {
  constructor(service: string, reauth: string) {
    super(`${service} refresh token expired or revoked. Re-authenticate at: ${reauth}`);
    this.name = 'TokenExpiredError';
  }
}

function ga4AuthUrl(): string {
  if (!GA4_CLIENT_ID) throw new Error('GA4_CLIENT_ID not set');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: GA4_CLIENT_ID,
    redirect_uri: GA4_REDIRECT_URI,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    access_type: 'offline',
    prompt: 'consent', // forces refresh_token to be returned even if previously authorized
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGa4Code(code: string): Promise<{ refresh_token: string }> {
  if (!GA4_CLIENT_ID) throw new Error('GA4_CLIENT_ID not set');
  if (!GA4_CLIENT_SECRET) throw new Error('GA4_CLIENT_SECRET not set');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: GA4_CLIENT_ID,
      client_secret: GA4_CLIENT_SECRET,
      redirect_uri: GA4_REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GA4 code exchange failed ${res.status}: ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  if (!data.refresh_token) throw new Error('No refresh_token returned — ensure prompt=consent was set in the auth URL');
  return { refresh_token: data.refresh_token as string };
}

async function getAccessToken(): Promise<string> {
  if (!GA4_CLIENT_ID) throw new Error('GA4_CLIENT_ID not set');
  if (!GA4_CLIENT_SECRET) throw new Error('GA4_CLIENT_SECRET not set');
  if (!GA4_REFRESH_TOKEN) throw new TokenExpiredError('GA4', ga4AuthUrl());

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GA4_CLIENT_ID,
      client_secret: GA4_CLIENT_SECRET,
      refresh_token: GA4_REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // invalid_grant = token revoked/expired; surface a 401 with the reauth URL
    if ((err as any)?.error === 'invalid_grant') {
      throw new TokenExpiredError('GA4', ga4AuthUrl());
    }
    throw new Error(`OAuth2 token exchange failed ${res.status}: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  return data.access_token as string;
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
    throw new Error(`GA4 runReport failed ${res.status}: ${JSON.stringify(err)}`);
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

  const { action, code, report, startDate, endDate } = req.query;

  // ── OAuth re-authentication endpoints ───────────────────────
  if (action === 'auth-url') {
    try {
      return res.status(200).json({
        message: 'Open this URL in a browser to re-authenticate GA4',
        url: ga4AuthUrl(),
        next: 'After authorizing, copy the GA4_REFRESH_TOKEN from the callback response into Vercel env vars',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (action === 'callback') {
    if (!code) return res.status(400).json({ error: 'Missing code parameter' });
    try {
      const result = await exchangeGa4Code(code as string);
      return res.status(200).json({
        message: 'Copy this value into your Vercel environment variables, then redeploy',
        GA4_REFRESH_TOKEN: result.refresh_token,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

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
    if (err instanceof TokenExpiredError) {
      return res.status(401).json({
        error: 'GA4_REFRESH_TOKEN expired or revoked',
        code: 'TOKEN_EXPIRED',
        reauth: 'GET /api/ga4?action=auth-url',
      });
    }
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
}
