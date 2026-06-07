// src/pages/DiscountManager/index.tsx
// ─────────────────────────────────────────────────────────────
// GCI Discount Manager — promotion rotation dashboard.
// Three sale groups (Low / Mid / High), Shopify compare_at pricing,
// Walmart Canada Promotions API (via /api/discount-proxy), nightly
// auto-refresh of the catalogue from Vercel KV, staged auto-add with
// pending-approval review for high-value items.
// ─────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../../components/PageHeader';
import { AUTO_CATALOGUE, type CatalogueItem } from './catalogue';
import {
  useDiscountStore,
  type GroupId,
  type ActiveSale,
} from './useDiscountStore';
import { buildPromoDates } from './walmart';

// Server-side activation: Shopify variant lookup + compare_at writes happen in
// api/activate-sale.ts (the browser cannot reach the Shopify Admin API directly).
async function callActivateSale(
  action: 'activate' | 'revert',
  payload: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`/api/activate-sale?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || `activate-sale ${action} failed ${res.status}`);
  }
  return data;
}

// ─── Group presentation metadata ──────────────────────────────
const GROUP_META: Record<
  GroupId,
  { letter: string; label: string; range: string; dot: string; text: string; ring: string; btn: string; soft: string }
> = {
  low: {
    letter: 'A', label: 'Low', range: '≤ $260',
    dot: 'bg-green-500', text: 'text-green-600', ring: 'border-green-200',
    btn: 'bg-green-600 hover:bg-green-700', soft: 'bg-green-50',
  },
  mid: {
    letter: 'B', label: 'Mid', range: '$261 – $349',
    dot: 'bg-yellow-500', text: 'text-yellow-600', ring: 'border-yellow-200',
    btn: 'bg-yellow-600 hover:bg-yellow-700', soft: 'bg-yellow-50',
  },
  high: {
    letter: 'C', label: 'High', range: '≥ $350',
    dot: 'bg-red-500', text: 'text-red-600', ring: 'border-red-200',
    btn: 'bg-red-600 hover:bg-red-700', soft: 'bg-red-50',
  },
};

const GROUP_ORDER: GroupId[] = ['low', 'mid', 'high'];
const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

// ─── Time helpers ─────────────────────────────────────────────
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function relHoursFromNow(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const h = Math.round(diff / 3600_000);
  if (h <= 0) return 'now';
  return `in ${h}h`;
}
function relHoursAgo(iso: string): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600_000);
  if (h < 1) return `${Math.max(1, Math.floor(diff / 60_000))} min ago`;
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

const DiscountManager: React.FC = () => {
  const { state, setState, addLog } = useDiscountStore();
  const [busy, setBusy] = useState<GroupId | 'refresh' | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const liveGroups = useMemo(
    () => GROUP_ORDER.filter(g => !!state.activeSales[g]),
    [state.activeSales],
  );

  // ── Hydrate from KV on mount ────────────────────────────────
  useEffect(() => {
    void hydrateFromKv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function hydrateFromKv(force = false) {
    setBusy('refresh');
    try {
      const url = `/api/refresh-catalogue${force ? '?force=true' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`refresh-catalogue ${res.status}`);
      const data = await res.json();

      if (data?.groups) {
        setState({
          groups: {
            low: data.groups.low ?? AUTO_CATALOGUE.low,
            mid: data.groups.mid ?? AUTO_CATALOGUE.mid,
            high: data.groups.high ?? AUTO_CATALOGUE.high,
          },
          pendingApprovals: data.pendingApprovals ?? state.pendingApprovals,
          catalogueLastUpdated: data.generatedAt ?? new Date().toISOString(),
        });
        addLog(
          data.skipped
            ? `Catalogue loaded from KV (${data.totalItems ?? '?'} items, cached).`
            : `Catalogue refreshed from Walmart (${data.totalItems ?? '?'} items).`,
          'success',
        );

        // If the cached data is older than 24h, trigger a fresh pull once.
        const age = data.generatedAt ? Date.now() - new Date(data.generatedAt).getTime() : Infinity;
        if (!force && (!data.generatedAt || age > TWENTY_FOUR_H)) {
          addLog('Catalogue >24h old — triggering fresh pull…', 'info');
          await hydrateFromKv(true);
        }
      } else {
        throw new Error('no groups in response');
      }
    } catch (err: any) {
      console.error('[DiscountManager] hydrate failed:', err);
      addLog(`Refresh failed (${err?.message}). Using static catalogue fallback.`, 'warn');
      // Fall back to the pre-seeded static catalogue.
      if (!state.catalogueLastUpdated) {
        setState({
          groups: { low: AUTO_CATALOGUE.low, mid: AUTO_CATALOGUE.mid, high: AUTO_CATALOGUE.high },
        });
      }
    } finally {
      setBusy(null);
    }
  }

  // ── Discount % stepper ──────────────────────────────────────
  function stepPct(group: GroupId, delta: number) {
    setState(prev => {
      const next = Math.min(75, Math.max(1, prev.discountPct[group] + delta));
      return { discountPct: { ...prev.discountPct, [group]: next } };
    });
  }

  // ── Activate a sale ─────────────────────────────────────────
  async function activate(group: GroupId) {
    const items = state.groups[group];
    if (items.length === 0 || state.activeSales[group]) return;
    setBusy(group);
    const pct = state.discountPct[group];
    const meta = GROUP_META[group];
    const promotionType = group === 'high' ? 'CLEARANCE' : 'REDUCED';

    try {
      // Overlap OFF → revert any currently-live group first.
      if (!state.allowOverlap) {
        for (const live of liveGroups) {
          if (live !== group) {
            addLog(`Overlap OFF — auto-reverting Group ${GROUP_META[live].letter} before activating ${meta.letter}.`, 'info');
            await revert(live, true);
          }
        }
      }

      // Server-side: Shopify compare_at lookup/write, then Walmart feed.
      const data = await callActivateSale('activate', {
        group,
        pct,
        durationDays: state.promotionDuration,
        items: items.map(i => ({ sku: i.sku, price: i.price, group })),
      });

      const s = data.shopify || {};
      addLog(
        `Shopify: compare_at applied to ${s.updated ?? 0}/${s.total ?? items.length} variants (Group ${meta.letter}).`,
        (s.updated ?? 0) > 0 ? 'success' : 'warn',
      );
      if (s.failed?.length) {
        addLog(`Shopify: ${s.failed.length} variant(s) failed (e.g. ${s.failed[0]?.sku}: ${s.failed[0]?.error}).`, 'warn');
      }

      const w = data.walmart || {};
      if (w.submitted) {
        addLog(`Walmart: feed submitted successfully (feed ${w.feedId}) · live ~${fmtTime(w.effectiveDate)}.`, 'success');
      } else {
        addLog(`Walmart: feed not submitted${w.error ? ` — ${w.error}` : w.reason ? ` — ${w.reason}` : ''}.`, w.error ? 'error' : 'warn');
      }

      // Only mark the group live if Shopify actually updated ≥1 variant.
      if ((s.updated ?? 0) > 0) {
        const fallback = buildPromoDates(state.promotionDuration);
        const sale: ActiveSale = {
          startedAt: new Date().toISOString(),
          effectiveAt: w.effectiveDate || fallback.effectiveDate,
          expiresAt: w.expirationDate || fallback.expirationDate,
          pct,
          feedId: w.feedId ?? 'pending',
          promotionType,
        };
        setState(prev => ({ activeSales: { ...prev.activeSales, [group]: sale } }));
        addLog(`Group ${meta.letter} (${meta.label}) sale activated at ${pct}% — ${promotionType}.`, 'success');
      } else {
        addLog(`Group ${meta.letter} not activated — no Shopify variants matched.`, 'error');
      }
    } catch (err: any) {
      console.error('[DiscountManager] activate failed:', err);
      addLog(`Activate Group ${meta.letter} failed: ${err?.message}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  // ── Revert a sale ───────────────────────────────────────────
  async function revert(group: GroupId, silentBusy = false) {
    if (!state.activeSales[group]) return;
    if (!silentBusy) setBusy(group);
    const items = state.groups[group];
    const meta = GROUP_META[group];
    try {
      const data = await callActivateSale('revert', {
        group,
        items: items.map(i => ({ sku: i.sku, price: i.price, group })),
      });
      const s = data.shopify || {};
      const w = data.walmart || {};
      setState(prev => {
        const next = { ...prev.activeSales };
        delete next[group];
        return { activeSales: next };
      });
      addLog(
        `Group ${meta.letter} reverted — Shopify (${s.reverted ?? 0}/${s.total ?? items.length}) + ` +
        `Walmart ${w.submitted ? 'BASE feed resubmitted' : 'feed skipped'}.`,
        'success',
      );
    } catch (err: any) {
      console.error('[DiscountManager] revert failed:', err);
      addLog(`Revert Group ${meta.letter} failed: ${err?.message}`, 'error');
    } finally {
      if (!silentBusy) setBusy(null);
    }
  }

  // ── Pending approvals ───────────────────────────────────────
  async function approveItem(item: CatalogueItem) {
    const group = item.group;
    setState(prev => ({
      pendingApprovals: prev.pendingApprovals.filter(i => i.sku !== item.sku),
      groups: {
        ...prev.groups,
        [group]: [...prev.groups[group], { ...item, autoAdded: true, addedAt: new Date().toISOString() }],
      },
    }));
    addLog(`Approved ${item.sku} → Group ${GROUP_META[group].letter}.`, 'success');

    // If the target group is live, apply Shopify compare_at + submit to
    // Walmart for this single item now (server-side).
    const sale = state.activeSales[group];
    if (sale) {
      try {
        const data = await callActivateSale('activate', {
          group,
          pct: sale.pct,
          durationDays: state.promotionDuration,
          items: [{ sku: item.sku, price: item.price, group }],
        });
        addLog(
          `${item.sku} added to active Group ${GROUP_META[group].letter} ` +
          `(Shopify ${data.shopify?.updated ?? 0}/1, Walmart ${data.walmart?.submitted ? 'ok' : 'skipped'}).`,
          'success',
        );
      } catch (err: any) {
        addLog(`Failed to submit ${item.sku}: ${err?.message}`, 'error');
      }
    }
  }

  function dismissItem(item: CatalogueItem) {
    setState(prev => ({ pendingApprovals: prev.pendingApprovals.filter(i => i.sku !== item.sku) }));
    addLog(`Dismissed pending item ${item.sku}.`, 'info');
  }

  const pendingByGroup = (g: GroupId) => state.pendingApprovals.filter(i => i.group === g);

  // ── Render ──────────────────────────────────────────────────
  return (
    <div className="p-6">
      <PageHeader
        title="Promotions"
        description="Rotate Shopify + Walmart Canada sale pricing across Low / Mid / High tiers."
        actions={
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">
              Last refreshed: {relHoursAgo(state.catalogueLastUpdated)}
            </span>
            <button
              onClick={() => hydrateFromKv(true)}
              disabled={busy === 'refresh'}
              className="px-3 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy === 'refresh' ? 'Refreshing…' : '↻ Refresh Catalogue'}
            </button>
            <button
              onClick={() => setShowSettings(s => !s)}
              className="px-3 py-2 text-sm font-medium rounded-lg bg-gray-200 text-gray-800 hover:bg-gray-300"
            >
              ⚙ Settings
            </button>
          </div>
        }
      />

      {/* Overlap toggle */}
      <div className="flex items-center gap-3 mb-6">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={state.allowOverlap}
            onChange={e => setState({ allowOverlap: e.target.checked })}
            className="h-4 w-4 rounded border-gray-300"
          />
          Allow overlapping sales
          <span className="text-xs text-gray-400">
            ({state.allowOverlap ? 'multiple groups can be live' : 'one group at a time — activating reverts the live group'})
          </span>
        </label>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
          <h2 className="text-sm font-bold text-gray-900 mb-4">Settings</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingsInput label="Shopify Admin Token" type="password"
              value={state.credentials.shopifyToken}
              onChange={v => setState(p => ({ credentials: { ...p.credentials, shopifyToken: v } }))} />
            <SettingsInput label="Shopify Domain"
              value={state.credentials.shopifyDomain}
              onChange={v => setState(p => ({ credentials: { ...p.credentials, shopifyDomain: v } }))} />
            <SettingsInput label="Walmart Client ID" type="password"
              value={state.credentials.walmartClientId}
              onChange={v => setState(p => ({ credentials: { ...p.credentials, walmartClientId: v } }))} />
            <SettingsInput label="Walmart Client Secret" type="password"
              value={state.credentials.walmartClientSecret}
              onChange={v => setState(p => ({ credentials: { ...p.credentials, walmartClientSecret: v } }))} />
            <SettingsNumber label="Promotion duration (days)"
              value={state.promotionDuration}
              onChange={v => setState({ promotionDuration: v })} />
            <SettingsNumber label="Auto-add price ceiling ($)"
              value={state.autoAddCeiling}
              onChange={v => setState({ autoAddCeiling: v })} />
            <SettingsNumber label="Group cap (max items)"
              value={state.groupCap}
              onChange={v => setState({ groupCap: v })} />
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Credentials are stored locally and used as a fallback; server-side calls use Vercel env vars.
          </p>
        </div>
      )}

      {/* Group cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
        {GROUP_ORDER.map(group => {
          const meta = GROUP_META[group];
          const items = state.groups[group];
          const sale = state.activeSales[group];
          const pct = state.discountPct[group];
          const pending = pendingByGroup(group);
          const overCap = items.length >= state.groupCap;

          return (
            <div key={group} className={`bg-white rounded-xl shadow-sm border ${meta.ring} p-5 flex flex-col`}>
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center h-8 w-8 rounded-lg text-white font-bold ${meta.dot}`}>
                    {meta.letter}
                  </span>
                  <div>
                    <p className="font-bold text-gray-900">{meta.label}</p>
                    <p className="text-xs text-gray-400">{meta.range}</p>
                  </div>
                </div>
                {sale && (
                  <span className="flex items-center gap-1 text-xs font-medium text-green-600">
                    <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                    LIVE
                  </span>
                )}
              </div>

              {/* Badges */}
              <div className="flex items-center gap-2 mb-4">
                <span className={`text-xs font-medium px-2 py-1 rounded-full ${overCap ? 'bg-red-100 text-red-700' : meta.soft + ' ' + meta.text}`}>
                  {items.length} / {state.groupCap} items
                </span>
                {pending.length > 0 && (
                  <span className="text-xs font-medium px-2 py-1 rounded-full bg-orange-100 text-orange-600">
                    {pending.length} pending
                  </span>
                )}
              </div>

              {/* Discount stepper */}
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm text-gray-500">Discount</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => stepPct(group, -1)}
                    disabled={!!sale || pct <= 1}
                    className="h-7 w-7 rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-40"
                  >−</button>
                  <span className={`w-12 text-center font-bold ${meta.text}`}>{pct}%</span>
                  <button
                    onClick={() => stepPct(group, +1)}
                    disabled={!!sale || pct >= 75}
                    className="h-7 w-7 rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-40"
                  >+</button>
                </div>
              </div>

              {/* Rotation controls */}
              <div className="flex gap-2 mb-3">
                <button
                  onClick={() => activate(group)}
                  disabled={!!sale || items.length === 0 || busy === group}
                  className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-40 ${meta.btn}`}
                >
                  {busy === group && !sale ? 'Activating…' : 'Activate Sale'}
                </button>
                <button
                  onClick={() => revert(group)}
                  disabled={!sale || busy === group}
                  className="flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:opacity-40"
                >
                  {busy === group && sale ? 'Reverting…' : 'Revert Prices'}
                </button>
              </div>

              {/* Scheduled / channel status */}
              {sale ? (
                <div className="mt-1 border-t border-gray-100 pt-3 space-y-1.5 text-xs">
                  <p className="text-green-600">✓ Shopify: compare_at_price applied</p>
                  <p className="text-gray-500 italic flex items-center gap-1">
                    🕒 Walmart CA: feed submitted · live ~{fmtTime(sale.effectiveAt)}
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <span className={`px-2 py-0.5 rounded-full font-medium ${sale.promotionType === 'CLEARANCE' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                      {sale.promotionType}
                    </span>
                    <span className="text-gray-400">Expires {fmtDate(sale.expiresAt)}</span>
                  </div>
                </div>
              ) : (
                items.length > 0 && (
                  <p className="mt-1 text-xs text-gray-400 italic flex items-center gap-1">
                    🕒 Will go live at {fmtTime(buildPromoDates(state.promotionDuration).effectiveDate)} ({relHoursFromNow(buildPromoDates(state.promotionDuration).effectiveDate)}) — Walmart rule
                  </p>
                )
              )}
            </div>
          );
        })}
      </div>

      {/* Pending approvals */}
      {state.pendingApprovals.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-orange-200 p-5 mb-6">
          <h2 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
            Pending Approvals
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-600">
              {state.pendingApprovals.length}
            </span>
          </h2>
          <p className="text-xs text-gray-400 mb-3">New TIRE- items flagged by the nightly cron (price &gt; ${state.autoAddCeiling}). Approve to add to a group.</p>
          <div className="space-y-2">
            {state.pendingApprovals.map(item => (
              <div key={item.sku} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                <div className="text-sm">
                  <span className="font-mono text-gray-700">{item.sku}</span>
                  <span className="text-gray-500"> · {item.title}</span>
                  <span className="font-medium text-gray-900"> · ${item.price.toFixed(2)}</span>
                  <span className={`ml-2 text-xs ${GROUP_META[item.group].text}`}>Group {GROUP_META[item.group].letter}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => approveItem(item)}
                    className="px-3 py-1 text-xs font-medium rounded-md bg-green-600 text-white hover:bg-green-700"
                  >Approve &amp; Add</button>
                  <button
                    onClick={() => dismissItem(item)}
                    className="px-3 py-1 text-xs font-medium rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300"
                  >Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Activity log */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h2 className="text-sm font-bold text-gray-900 mb-3">Activity Log</h2>
        {state.log.length === 0 ? (
          <p className="text-xs text-gray-400">No activity yet.</p>
        ) : (
          <div className="space-y-1 max-h-72 overflow-auto">
            {state.log.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="text-gray-400 whitespace-nowrap">{fmtTime(entry.ts)}</span>
                <span className={
                  entry.type === 'error' ? 'text-red-600'
                    : entry.type === 'warn' ? 'text-orange-600'
                    : entry.type === 'success' ? 'text-green-600'
                    : 'text-gray-600'
                }>{entry.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Small settings inputs ────────────────────────────────────
const SettingsInput: React.FC<{
  label: string; value: string; type?: string; onChange: (v: string) => void;
}> = ({ label, value, type = 'text', onChange }) => (
  <label className="block">
    <span className="text-xs font-medium text-gray-500">{label}</span>
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
    />
  </label>
);

const SettingsNumber: React.FC<{
  label: string; value: number; onChange: (v: number) => void;
}> = ({ label, value, onChange }) => (
  <label className="block">
    <span className="text-xs font-medium text-gray-500">{label}</span>
    <input
      type="number"
      value={value}
      onChange={e => onChange(parseInt(e.target.value, 10) || 0)}
      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
    />
  </label>
);

export default DiscountManager;
