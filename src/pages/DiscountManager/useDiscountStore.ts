// src/pages/DiscountManager/useDiscountStore.ts
// ─────────────────────────────────────────────────────────────
// localStorage-backed state for the Discount Manager dashboard.
// Single source of truth for groups, discount %, active sales,
// pending approvals and the activity log. Persists on every change.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { AUTO_CATALOGUE, type CatalogueItem } from './catalogue';

const STORAGE_KEY = 'gci_discount_manager_v2';

export type GroupId = 'low' | 'mid' | 'high';
export type PromotionType = 'CLEARANCE' | 'REDUCED';
export type LogType = 'info' | 'success' | 'warn' | 'error';

export interface ActiveSale {
  startedAt: string;   // ISO
  effectiveAt: string; // ISO — when Walmart goes live
  expiresAt: string;   // ISO
  pct: number;
  feedId: string;      // Walmart feed ID
  promotionType: PromotionType;
}

export interface LogEntry {
  ts: string;
  msg: string;
  type: LogType;
}

export interface DiscountState {
  credentials: {
    shopifyToken: string;
    shopifyDomain: string;
    walmartClientId: string;
    walmartClientSecret: string;
  };
  groups: Record<GroupId, CatalogueItem[]>;
  discountPct: Record<GroupId, number>;
  promotionDuration: number; // days
  autoAddCeiling: number;    // max price for auto-add
  groupCap: number;          // max items per group
  activeSales: Partial<Record<GroupId, ActiveSale>>;
  pendingApprovals: CatalogueItem[];
  allowOverlap: boolean;
  catalogueLastUpdated: string; // ISO
  log: LogEntry[];
}

const MAX_LOG = 100;

function defaultState(): DiscountState {
  return {
    credentials: {
      shopifyToken: '',
      shopifyDomain: 'gcitires-ca.myshopify.com',
      walmartClientId: '',
      walmartClientSecret: '',
    },
    groups: {
      low: AUTO_CATALOGUE.low,
      mid: AUTO_CATALOGUE.mid,
      high: AUTO_CATALOGUE.high,
    },
    discountPct: { low: 15, mid: 20, high: 25 },
    promotionDuration: 30,
    autoAddCeiling: 500,
    groupCap: 120,
    activeSales: {},
    pendingApprovals: [],
    allowOverlap: false,
    catalogueLastUpdated: '',
    log: [],
  };
}

function loadState(): DiscountState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<DiscountState>;
    // Shallow-merge over defaults so newly added fields are populated.
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      credentials: { ...base.credentials, ...(parsed.credentials || {}) },
      groups: { ...base.groups, ...(parsed.groups || {}) },
      discountPct: { ...base.discountPct, ...(parsed.discountPct || {}) },
      activeSales: parsed.activeSales || {},
      pendingApprovals: parsed.pendingApprovals || [],
      log: parsed.log || [],
    };
  } catch (err) {
    console.error('[useDiscountStore] failed to load state, using defaults:', err);
    return defaultState();
  }
}

export function useDiscountStore() {
  const [state, setStateRaw] = useState<DiscountState>(() => loadState());

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error('[useDiscountStore] failed to persist state:', err);
    }
  }, [state]);

  const setState = useCallback(
    (patch: Partial<DiscountState> | ((prev: DiscountState) => Partial<DiscountState>)) => {
      setStateRaw(prev => {
        const next = typeof patch === 'function' ? patch(prev) : patch;
        return { ...prev, ...next };
      });
    },
    [],
  );

  const getState = useCallback(() => state, [state]);

  const addLog = useCallback((msg: string, type: LogType = 'info') => {
    setStateRaw(prev => ({
      ...prev,
      log: [{ ts: new Date().toISOString(), msg, type }, ...prev.log].slice(0, MAX_LOG),
    }));
  }, []);

  return { state, getState, setState, addLog };
}
