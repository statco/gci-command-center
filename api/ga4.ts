import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_SERVICE_ACCOUNT_KEY = process.env.GA4_SERVICE_ACCOUNT_KEY;

function makeClient(): BetaAnalyticsDataClient {
  if (!GA4_SERVICE_ACCOUNT_KEY) throw new Error('GA4_SERVICE_ACCOUNT_KEY not set');
  if (!GA4_PROPERTY_ID) throw new Error('GA4_PROPERTY_ID not set');
  const credentials = JSON.parse(GA4_SERVICE_ACCOUNT_KEY);
  return new BetaAnalyticsDataClient({ credentials });
}

async function runReport(
  client: BetaAnalyticsDataClient,
  dimensions: string[],
  metrics: string[],
  startDate: string,
  endDate: string
): Promise<{ dimensions: string[]; metrics: string[]; rows: Array<Record<string, string>>; rowCount: number }> {
  const [response] = await client.runReport({
    property: `properties/${GA4_PROPERTY_ID}`,
    dimensions: dimensions.map(name => ({ name })),
    metrics: metrics.map(name => ({ name })),
    dateRanges: [{ startDate, endDate }],
  });

  const rows = (response.rows || []).map(row => {
    const record: Record<string, string> = {};
    dimensions.forEach((dim, i) => {
      record[dim] = row.dimensionValues?.[i]?.value ?? '';
    });
    metrics.forEach((met, i) => {
      record[met] = row.metricValues?.[i]?.value ?? '';
    });
    return record;
  });

  return { dimensions, metrics, rows, rowCount: response.rowCount ?? rows.length };
}

// Vercel serverless handler
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { report, startDate, endDate } = req.query;
  const start = (startDate as string) || '7daysAgo';
  const end = (endDate as string) || 'today';

  try {
    const client = makeClient();

    switch (report) {
      case 'overview': {
        const data = await runReport(
          client,
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
          client,
          ['pagePath', 'pageTitle'],
          ['screenPageViews', 'averageSessionDuration', 'bounceRate'],
          start,
          end
        );
        return res.status(200).json(data);
      }
      case 'traffic-sources': {
        const data = await runReport(
          client,
          ['sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium'],
          ['sessions', 'activeUsers', 'conversions'],
          start,
          end
        );
        return res.status(200).json(data);
      }
      case 'conversions': {
        const data = await runReport(
          client,
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
