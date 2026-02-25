import type { VercelRequest, VercelResponse } from '@vercel/node';

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_TENANT_ID = process.env.XERO_TENANT_ID;
const XERO_REFRESH_TOKEN = process.env.XERO_REFRESH_TOKEN;

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

// Vercel serverless handler
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { resource, status, fromDate, toDate } = req.query;

    switch (resource) {
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
          error: 'Unknown resource. Use: invoices | balance-sheet | profit-loss | accounts',
        });
    }
  } catch (err) {
    console.error('[xero api]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
