import type { VercelRequest, VercelResponse } from '@vercel/node';

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_TENANT_ID = process.env.XERO_TENANT_ID;
const XERO_REFRESH_TOKEN = process.env.XERO_REFRESH_TOKEN;

const REDIRECT_URI = 'https://ops.gcitires.com/api/xero?resource=callback';
const XERO_SCOPES = 'accounting.transactions.read accounting.reports.read accounting.settings.read offline_access';

interface XeroTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
}

interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Type: string;
  Status: string;
  Contact: { Name: string };
  DateString: string;
  DueDateString: string;
  Total: number;
  AmountDue: number;
  AmountPaid: number;
}

interface XeroAccount {
  AccountID: string;
  Code: string;
  Name: string;
  Type: string;
  Status: string;
  Balance?: number;
}

async function getAccessToken(): Promise<string> {
  const credentials = Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: XERO_REFRESH_TOKEN!,
    }),
  });
  if (!res.ok) throw new Error(`Xero token refresh failed: ${res.status}`);
  const data: XeroTokenResponse = await res.json();
  return data.access_token;
}

async function xeroGet<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'xero-tenant-id': XERO_TENANT_ID!,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Xero API error: ${res.status} on ${path}`);
  return res.json();
}

export async function getInvoices(status?: string): Promise<XeroInvoice[]> {
  const query = status ? `?Statuses=${status}` : '';
  const data = await xeroGet<{ Invoices: XeroInvoice[] }>(`Invoices${query}`);
  return data.Invoices;
}

export async function getBalanceSheet(): Promise<unknown> {
  const today = new Date().toISOString().split('T')[0];
  return xeroGet(`Reports/BalanceSheet?date=${today}`);
}

export async function getProfitAndLoss(fromDate: string, toDate: string): Promise<unknown> {
  return xeroGet(`Reports/ProfitAndLoss?fromDate=${fromDate}&toDate=${toDate}`);
}

export async function getAccounts(): Promise<XeroAccount[]> {
  const data = await xeroGet<{ Accounts: XeroAccount[] }>('Accounts');
  return data.Accounts;
}

function getAuthUrl(): string {
  if (!XERO_CLIENT_ID) throw new Error('XERO_CLIENT_ID not set');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: XERO_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: XERO_SCOPES,
  });
  return `https://login.xero.com/identity/connect/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string): Promise<{ refresh_token: string; tenant_id: string }> {
  if (!XERO_CLIENT_ID) throw new Error('XERO_CLIENT_ID not set');
  if (!XERO_CLIENT_SECRET) throw new Error('XERO_CLIENT_SECRET not set');

  const credentials = Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64');

  const tokenRes = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    throw new Error(`Token exchange failed ${tokenRes.status}: ${JSON.stringify(err)}`);
  }

  const tokens: XeroTokenResponse = await tokenRes.json();

  const connectionsRes = await fetch('https://api.xero.com/connections', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!connectionsRes.ok) {
    throw new Error(`Xero connections fetch failed: ${connectionsRes.status}`);
  }

  const connections: Array<{ tenantId: string; tenantName: string }> = await connectionsRes.json();
  if (!connections.length) throw new Error('No Xero tenants found for this authorisation');

  return {
    refresh_token: tokens.refresh_token,
    tenant_id: connections[0].tenantId,
  };
}

// Vercel serverless handler
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { resource, status, fromDate, toDate, code } = req.query;

    switch (resource) {
      case 'auth-url': {
        const url = getAuthUrl();
        return res.status(200).json({ url });
      }
      case 'callback': {
        if (!code) return res.status(400).json({ error: 'Missing code parameter' });
        const result = await exchangeCodeForTokens(code as string);
        return res.status(200).json({
          message: 'Copy these values into your Vercel environment variables',
          XERO_REFRESH_TOKEN: result.refresh_token,
          XERO_TENANT_ID: result.tenant_id,
        });
      }
      case 'invoices': {
        const invoices = await getInvoices(status as string | undefined);
        return res.status(200).json({ invoices });
      }
      case 'balance-sheet': {
        const report = await getBalanceSheet();
        return res.status(200).json(report);
      }
      case 'profit-loss': {
        const from = (fromDate as string) || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
        const to = (toDate as string) || new Date().toISOString().split('T')[0];
        const report = await getProfitAndLoss(from, to);
        return res.status(200).json(report);
      }
      case 'accounts': {
        const accounts = await getAccounts();
        return res.status(200).json({ accounts });
      }
      default:
        return res.status(400).json({
          error: 'Unknown resource. Use: auth-url | callback | invoices | balance-sheet | profit-loss | accounts',
        });
    }
  } catch (err) {
    console.error('[xero api]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
