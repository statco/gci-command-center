import type { VercelRequest, VercelResponse } from '@vercel/node';

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_API_KEY = process.env.GA4_API_KEY;

interface GA4ReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

interface GA4ReportResponse {
  rows?: GA4ReportRow[];
  rowCount?: number;
}

async function runReport(
  dimensions: string[],
  metrics: string[],
  startDate: string,
  endDate: string
): Promise<{ dimensions: string[]; metrics: string[]; rows: Array<Record<string, string>>; rowCount: number }> {
  if (!GA4_PROPERTY_ID) throw new Error('GA4_PROPERTY_ID not set');
  if (!GA4_API_KEY) throw new Error('GA4_API_KEY not set');

  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport?key=${GA4_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dimensions: dimensions.map(name => ({ name })),
      metrics: metrics.map(name => ({ name })),
      dateRanges: [{ startDate, endDate }],
    }),
  });

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
          start,
          end
        );
        const totalSessions = data.rows.reduce(
          (sum, row) => sum + parseInt(row.sessions || '0', 10),
          0
        );
        return res.status(200).json({ ...data, totalSessions });
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
