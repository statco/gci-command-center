import type { VercelRequest, VercelResponse } from '@vercel/node';

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_CLIENT_ID = process.env.GA4_CLIENT_ID;
const GA4_CLIENT_SECRET = process.env.GA4_CLIENT_SECRET;
const GA4_REFRESH_TOKEN = process.env.GA4_REFRESH_TOKEN;

interface GA4ReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

interface GA4ReportResponse {
  rows?: GA4ReportRow[];
  rowCount?: number;
}

async function getAccessToken(): Promise<string> {
  if (!GA4_CLIENT_ID) throw new Error('GA4_CLIENT_ID not set');
  if (!GA4_CLIENT_SECRET) throw new Error('GA4_CLIENT_SECRET not set');
  if (!GA4_REFRESH_TOKEN) throw new Error('GA4_REFRESH_TOKEN not set');

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
  } catch (err) {
    console.error('[ga4 api]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
