import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

interface ShopifyOrder {
  id: number;
  name: string;
  email: string;
  total_price: string;
  financial_status: string;
  fulfillment_status: string | null;
  created_at: string;
  line_items: Array<{
    id: number;
    title: string;
    quantity: number;
    price: string;
  }>;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  variants: Array<{
    id: number;
    price: string;
    inventory_quantity: number;
    sku: string;
  }>;
}

export async function getOrders(limit = 50, status = 'any'): Promise<ShopifyOrder[]> {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?limit=${limit}&status=${status}`,
    {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN!,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) throw new Error(`Shopify orders fetch failed: ${res.status}`);
  const data = await res.json();
  return data.orders;
}

export async function getProducts(limit = 50): Promise<ShopifyProduct[]> {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/products.json?limit=${limit}`,
    {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN!,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
  const data = await res.json();
  return data.products;
}

export async function getTodayOrderCount(): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders/count.json?status=any&created_at_min=${todayStart.toISOString()}`,
    {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN!,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) throw new Error(`Shopify order count fetch failed: ${res.status}`);
  const data = await res.json();
  return data.count as number;
}

export async function getRevenueMetrics(since: string): Promise<{ total: number; count: number }> {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?limit=250&status=any&financial_status=paid&created_at_min=${since}`,
    {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN!,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) throw new Error(`Shopify revenue fetch failed: ${res.status}`);
  const data = await res.json();
  const orders: ShopifyOrder[] = data.orders;
  const total = orders.reduce((sum, o) => sum + parseFloat(o.total_price), 0);
  return { total, count: orders.length };
}

// Vercel serverless handler
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { resource, limit, status, since } = req.query;

    switch (resource) {
      case 'today-orders': {
        const count = await getTodayOrderCount();
        return res.status(200).json({ count });
      }
      case 'orders': {
        const orders = await getOrders(
          limit ? parseInt(limit as string) : 50,
          (status as string) || 'any'
        );
        return res.status(200).json({ orders });
      }
      case 'products': {
        const products = await getProducts(limit ? parseInt(limit as string) : 50);
        return res.status(200).json({ products });
      }
      case 'revenue': {
        const metrics = await getRevenueMetrics(
          (since as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        );
        return res.status(200).json(metrics);
      }
      default:
        return res.status(400).json({ error: 'Unknown resource. Use: today-orders | orders | products | revenue' });
    }
  } catch (err) {
    console.error('[shopify api]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
