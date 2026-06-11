// api/clean-pending.ts
// ─────────────────────────────────────────────────────────────
// One-shot maintenance endpoint: removes stale TIRE--prefixed items
// from the catalogue's pendingApprovals list in Vercel KV.
//
// These are leftovers from the old Walmart-sourced catalogue. They
// have no shopifyVariantId and would fail activation, so they must
// be purged from the pending-approval queue.
//
// Usage:
//   GET /api/clean-pending           → applies the cleanup
//   GET /api/clean-pending?dry=true  → reports what would be removed
//
// Safe to run multiple times (idempotent).
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';

const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const KV_KEY = 'discount_catalogue';

interface CatalogueItem {
  id: string;
  sku: string;
  shopifyVariantId?: number;
  [key: string]: unknown;
}

async function kvGet<T>(key: string): Promise<T | null> {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) throw new Error(`KV get failed ${res.status}`);
  const data: any = await res.json();
  if (data?.result == null) return null;
  return JSON.parse(data.result) as T;
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV set failed ${res.status}`);
}

function isStaleTireItem(item: CatalogueItem): boolean {
  const id = (item?.id || '').toString().toUpperCase();
  const sku = (item?.sku || '').toString().toUpperCase();
  return id.startsWith('TIRE-') || sku.startsWith('TIRE-');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const dry = req.query.dry === 'true';

  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({ error: 'KV_REST_API_URL / KV_REST_API_TOKEN not set', code: 500 });
  }

  try {
    const catalogue = await kvGet<any>(KV_KEY);
    if (!catalogue) {
      return res.status(404).json({ error: `KV key "${KV_KEY}" is empty`, code: 404 });
    }

    const before: CatalogueItem[] = Array.isArray(catalogue.pendingApprovals)
      ? catalogue.pendingApprovals
      : [];

    const removed = before.filter(isStaleTireItem);
    const kept = before.filter(item => !isStaleTireItem(item));

    console.log(`[clean-pending] pendingApprovals: ${before.length} total, ` +
      `${removed.length} stale TIRE- items${dry ? ' (dry run — not written)' : ' removed'}, ${kept.length} kept`);

    if (!dry && removed.length > 0) {
      catalogue.pendingApprovals = kept;
      await kvSet(KV_KEY, catalogue);
    }

    return res.status(200).json({
      success: true,
      dry,
      pendingBefore: before.length,
      removed: removed.length,
      pendingAfter: kept.length,
      removedItems: removed.map(i => ({ id: i.id, sku: i.sku })),
      written: !dry && removed.length > 0,
    });
  } catch (err: any) {
    console.error('[clean-pending] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error', code: 500 });
  }
}
