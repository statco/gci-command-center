const BASE = '';

async function apiFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `API error ${res.status}`);
  }
  return res.json();
}

// Shopify
export const shopify = {
  orders: (params?: { limit?: string; status?: string }) =>
    apiFetch('/api/shopify', { resource: 'orders', ...params }),
  products: (params?: { limit?: string }) =>
    apiFetch('/api/shopify', { resource: 'products', ...params }),
  revenue: (since?: string) =>
    apiFetch('/api/shopify', { resource: 'revenue', ...(since ? { since } : {}) }),
};

// Xero
export const xero = {
  invoices: (status?: string) =>
    apiFetch('/api/xero', { resource: 'invoices', ...(status ? { status } : {}) }),
  balanceSheet: () =>
    apiFetch('/api/xero', { resource: 'balance-sheet' }),
  profitLoss: (fromDate?: string, toDate?: string) =>
    apiFetch('/api/xero', {
      resource: 'profit-loss',
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {}),
    }),
  accounts: () =>
    apiFetch('/api/xero', { resource: 'accounts' }),
};

// GA4
export const ga4 = {
  overview: (startDate?: string, endDate?: string) =>
    apiFetch('/api/ga4', {
      report: 'overview',
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
    }),
  topPages: (startDate?: string, endDate?: string) =>
    apiFetch('/api/ga4', {
      report: 'top-pages',
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
    }),
  trafficSources: (startDate?: string, endDate?: string) =>
    apiFetch('/api/ga4', {
      report: 'traffic-sources',
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
    }),
  conversions: (startDate?: string, endDate?: string) =>
    apiFetch('/api/ga4', {
      report: 'conversions',
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
    }),
};
