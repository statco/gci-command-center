import type { VercelRequest, VercelResponse } from '@vercel/node';

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_SERVICE_ACCOUNT_KEY = process.env.GA4_SERVICE_ACCOUNT_KEY; // JSON string of service account

interface GA4DimensionValue {
  value: string;
}

interface GA4MetricValue {
  value: string;
}

interface GA4Row {
  dimensionValues: GA4DimensionValue[];
  metricValues: GA4MetricValue[];
}

interface GA4RunReportResponse {
  rows?: GA4Row[];
  dimensionHeaders: Array<{ name: string }>;
  metricHeaders: Array<{ name: string; type: string }>;
  rowCount?: number;
}

interface ReportResult {
  dimensions: string[];
  metrics: string[];
  rows: Array<Record<string, string>>;
  rowCount: number;
}

async function getServiceAccountToken(): Promise<string> {
  if (!GA4_SERVICE_ACCOUNT_KEY) throw new Error('GA4_SERVICE_ACCOUNT_KEY not set');
  const serviceAccount = JSON.parse(GA4_SERVICE_ACCOUNT_KEY);

  // Build JWT for Google OAuth2
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })
  ).toString('base64url');

  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) throw new Error(`GA4 token fetch failed: ${tokenRes.status}`);
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

async function runReport(
  dimensions: string[],
  metrics: string[],
  startDate: string,
  endDate: string
): Promise<ReportResult> {
  const token = await getServiceAccountToken();
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dimensions: dimensions.map(name => ({ name })),
        metrics: metrics.map(name => ({ name })),
        dateRanges: [{ startDate, endDate }],
      }),
    }
  );

  if (!res.ok) throw new Error(`GA4 runReport failed: ${res.status}`);
  const data: GA4RunReportResponse = await res.json();

  const rows = (data.rows || []).map(row => {
    const record: Record<string, string> = {};
    dimensions.forEach((dim, i) => {
      record[dim] = row.dimensionValues[i]?.value ?? '';
    });
    metrics.forEach((met, i) => {
      record[met] = row.metricValues[i]?.value ?? '';
    });
    return record;
  });

  return { dimensions, metrics, rows, rowCount: data.rowCount ?? rows.length };
}

// Vercel serverless handler
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { report, startDate, endDate } = req.query;
  const start = (startDate as string) || '30daysAgo';
  const end = (endDate as string) || 'today';

  try {
    switch (report) {
      case 'overview': {
        const data = await runReport(
          ['date'],
          ['sessions', 'activeUsers', 'newUsers', 'bounceRate', 'averageSessionDuration'],
          start,
          end
        );
        return res.status(200).json(data);
      }
      case 'top-pages': {
        const data = await runReport(
          ['pagePath', 'pageTitle'],
          ['screenPageViews', 'averageSessionDuration', 'bounceRate'],
          start,
          end
        );
        return res.status(200).json(data);
      }
      case 'traffic-sources': {
        const data = await runReport(
          ['sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium'],
          ['sessions', 'activeUsers', 'conversions'],
          start,
          end
        );
        return res.status(200).json(data);
      }
      case 'conversions': {
        const data = await runReport(
          ['eventName', 'date'],
          ['eventCount', 'conversions', 'totalRevenue'],
          start,
          end
        );
        return res.status(200).json(data);
      }
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
