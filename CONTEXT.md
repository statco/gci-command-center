# GCI Tires — Discount Manager System Context

> **Last updated:** 2026-06-15
> **Status:** Production — Group B Mid reverted, Walmart BASE price sync live (PR #17)
> **Repo:** `statco/gci-command-center` (React 18 + TypeScript + Vite + Tailwind + React Router v6)
> **Reference repo:** `statco/gci-order-hub` (read-only, proven integration patterns)
> **Live URL:** `ops.gcitires.com/promotions`
> **Shopify store:** `gcitires-ca.myshopify.com`

---

## 1. What This System Does

A dual-channel sales discount rotation system for GCI Tires (Canada). It manages pricing promotions across **Shopify** and **Walmart Canada Marketplace** from a single dashboard.

**Core flow:**
1. Nightly cron pulls all active tires from Shopify → builds 3 price-tier groups (LOW/MID/HIGH, 100 items each) → immediately syncs all group SKU prices to Walmart as BASE prices
2. Operator activates a group from the dashboard
3. Shopify: sets `compare_at_price` for strikethrough display
4. Walmart CA: sends reduced pricing via `PUT /v3/price` for "Reduced price" badge
5. Operator can revert prices when the rotation ends

---

## 2. Architecture Decisions (Do Not Revisit)

These were resolved through extensive debugging. They are correct and should not be changed.

### Source of Truth: Shopify (NOT Walmart)
- Original approach pulled from Walmart Items API — 80% of SKUs didn't exist on Shopify
- **Decision:** Query Shopify GraphQL `products(query: "status:ACTIVE AND product_type:Tire")` as the single source
- Shopify variant IDs are pre-resolved during catalogue refresh, stored in each item
- No per-SKU lookup needed at activation time

### SKU Format: Mixed (NOT TIRE- prefix)
- `TIRE-` prefix only exists on 583 draft/archived Shopify imports from an old bulk upload
- Active products use mixed formats: `166204004`, `AP27540020...`, `MB4016U`, `MV951`, `200E1015`, etc.
- **Filter:** `status:ACTIVE AND productType contains 'Tire'` — NOT SKU prefix
- SKUs match exactly between Shopify and Walmart for non-prefixed listings (native SKU format)
- **27 Walmart listings still carry the TIRE- prefix** — see Section 8 backlog item #1 for the mandatory fix

### Walmart API: Global Marketplace (NOT CA-specific feeds)
- `PUT /v3/price` with header `WM_MARKET: ca` — matches proven pattern in `gci-order-hub` and `gci-walmart-sync`
- **NOT** `/v3/ca/feeds` which requires a `WM_CONSUMER.CHANNEL.TYPE` GUID we don't have
- Auth: client_credentials OAuth → `WM_SVC.NAME` headers

### Walmart Pricing: Two-Layer Model
Walmart separates BASE price from promotional overlays. Both must be managed:
- **BASE price** — the item's regular listed price on walmart.ca. Set via `PUT /v3/price` with `currentPriceType: "BASE"`. Synced nightly from Shopify.
- **REDUCED / CLEARANCE** — a promotional overlay with a strikethrough "was" price. Set during activation via `activate-sale.ts`. Cleared on revert.
- If BASE is never set, Walmart shows whatever price was set when the listing was originally created — which drifts from Shopify over time.

### Price Tiers: Data-Driven Boundaries
- **LOW:** ≤$260 (~100 items, Ovation/Minerva/Cooper budget lines, $149.99–$259.99)
- **MID:** $261–$349 (~100 items, Cooper/Nexen/Vredestein mid-range, $260.99–$283.99 base + auto-added up to $349)
- **HIGH:** ≥$350 (~100 items, premium/performance/LT, $349.99+)
- Equal thirds was rejected — ~50% of catalogue clusters at $284.99, natural breaks are more meaningful

### Compounding Protection
- If `compare_at_price` is already set on a variant, use it as the original price
- Prevents double-discounting when CDA/CT supplier clearance overwrites MSRP (e.g., $255 → $69.97)

### Staged Auto-Add
- Items ≤$500: auto-add to matching price group (capped at 120 per group)
- Items >$500: queue to `pendingApprovals` for manual review
- Telegram notifications on both events

---

## 3. File Map

```
src/pages/DiscountManager/
  index.tsx              — Main dashboard UI (groups, steppers, activation, revert, activity log, settings,
                           ⇅ Sync Walmart Prices button)
  shopify.ts             — Shopify compare_at helpers (client-side, used for display/state only)
  walmart.ts             — Walmart pricing client (client-side reference)
  catalogue.ts           — Static fallback + CatalogueItem interface
  useDiscountStore.ts    — localStorage state (key: gci_discount_manager_v2)

api/
  activate-sale.ts         — Serverless: Shopify GraphQL variant mutation + Walmart PUT /v3/price (REDUCED/CLEARANCE)
  sync-walmart-base-prices.ts — Serverless: pushes currentPriceType BASE for all group SKUs to Walmart
  refresh-catalogue.ts     — Serverless: pulls active tires from Shopify GraphQL, builds groups, stores in
                             Upstash KV, then calls syncWalmartBasePrices for all group SKUs
  discount-proxy.ts        — Serverless: CORS proxy for Walmart calls from browser
  clean-pending.ts         — Serverless: removes TIRE- prefix items from pendingApprovals in KV

src/App.tsx              — Route: /promotions → DiscountManager
vercel.json              — Cron: refresh-catalogue at "0 10 * * *" (5AM EST / 10AM UTC)
```

---

## 4. Environment Variables

All must be set on **both** Vercel projects (see Section 5).

```
SHOPIFY_STORE_DOMAIN=gcitires-ca.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=shpat_...           # Shopify Admin API access token
WALMART_CLIENT_ID=                           # Walmart Marketplace API
WALMART_CLIENT_SECRET=                       # Walmart Marketplace API
KV_REST_API_URL=                             # Upstash Redis REST URL
KV_REST_API_TOKEN=                           # Upstash Redis REST token
TELEGRAM_BOT_TOKEN=                          # Ops notification bot
TELEGRAM_CHAT_ID=                            # Ops notification channel
```

---

## 5. Deployment — Two Vercel Projects (Critical)

The same repo deploys to **two** Vercel projects. Env vars must exist on both.

| Project | Domain | Role |
|---|---|---|
| `gci-command-center` | `gci-command-center.vercel.app` | Secondary (can be retired) |
| `gci-command-center-ofzf` | `ops.gcitires.com` | **Primary — this is the live one** |

**TODO:** Consolidate to single project. Retire `gci-command-center`, keep only `gci-command-center-ofzf`.

---

## 6. API Patterns

### Shopify GraphQL — Variant Price Update
```graphql
mutation productVariantUpdate($input: ProductVariantInput!) {
  productVariantUpdate(input: $input) {
    productVariant { id price compareAtPrice }
    userErrors { field message }
  }
}
```
- Input: `{ id: "gid://shopify/ProductVariant/{variantId}", compareAtPrice: "{originalPrice}" }`
- Rate limiting: 250ms delay between calls
- Variant IDs are pre-resolved in catalogue — no lookup needed

### Walmart CA — BASE Price (nightly sync + on-demand)
```
PUT https://marketplace.walmartapis.com/v3/price
Headers:
  WM_MARKET: ca
  WM_SVC.NAME: Walmart Marketplace
  WM_SEC.ACCESS_TOKEN: {oauth_token}
  WM_GLOBAL_VERSION: 3.1
  Content-Type: application/json

Body: { sku, pricing: [{ currentPriceType: "BASE", currentPrice: { currency: "CAD", amount } }] }
```

### Walmart CA — Promotional Price (activation)
```
PUT https://marketplace.walmartapis.com/v3/price

Body: { sku, pricing: [{ currentPriceType: "REDUCED"|"CLEARANCE",
        currentPrice: { currency: "CAD", amount: salePrice },
        comparisonPrice: { currency: "CAD", amount: originalPrice },
        comparisonPriceType: "BASE" }] }
```
- Auth for both: POST to `https://marketplace.walmartapis.com/v3/token` with client_credentials
- **NEVER include `WM_CONSUMER.CHANNEL.TYPE` header** — causes 400 errors on every call
- 150ms delay between per-SKU calls; 429 → wait 2s and retry

### Upstash KV
- REST API at `KV_REST_API_URL` with Bearer `KV_REST_API_TOKEN`
- Catalogue stored as JSON under key `discount_catalogue`
- Active sale snapshots stored under `active_sale:{group}` — used by revert
- Read/write from serverless functions only (not browser)

---

## 7. Current State (as of 2026-06-15)

### What's Working ✅
- Catalogue: 1,963 active tires from Shopify, all with pre-resolved variant IDs
- Nightly cron refresh at 5AM EST: rebuilds groups → syncs all BASE prices to Walmart automatically
- Walmart BASE price sync: dashboard button (⇅ Sync Walmart Prices) for on-demand correction
- Compounding protection: correctly uses existing `compare_at_price` as original
- Staged auto-add with $500 threshold
- Telegram notifications
- Stale TIRE- prefix pendingApprovals cleared (84 removed)
- 248 legitimate >$500 items in pendingApprovals awaiting manual review
- Group B Mid reverted (prices restored on Shopify and Walmart)

### Walmart SKU Coverage After PR #17
- **73/100** Walmart listings have native SKUs matching Shopify exactly — fully synced by BASE price system
- **27/100** Walmart listings still carry TIRE- prefix — price API calls targeting the clean SKU are a **silent no-op** for these; they are NOT updated by activate-sale or sync-walmart-base-prices until the prefix is removed in Seller Center (see backlog item #1)
  - 21 of these 27 are PUBLISHED on walmart.ca
  - 6 are UNPUBLISHED

### Previous Successful Activations
- Group A Low (early build): 99/100 Shopify, 24/24 Walmart — before source migration
- Group B Mid: 120/120 Shopify, 120/120 Walmart — activated and subsequently reverted

### PR History
| PR | Description | Status |
|---|---|---|
| #3 | Initial Discount Manager feature | Merged |
| #7 | GA4 integration (property 526079137) | Merged |
| #8 | Shopify GraphQL variant lookup + Walmart header fix | Merged |
| #9 | Walmart endpoint switch to PUT /v3/price | Merged |
| #12 | Shopify source-of-truth rewrite | Merged |
| #13 | Filter by ACTIVE+Tire instead of TIRE- prefix | Merged |
| #14 | Clean stale TIRE- prefix pendingApprovals endpoint | Merged |
| #17 | Walmart BASE price sync — nightly cron + dashboard button | Merged |

---

## 8. Known Issues & Backlog

### Priority
1. **TIRE- prefix on 27 Walmart listings** — Walmart's `PUT /v3/price` matches by the exact listing SKU. Our system sends clean SKUs (e.g. `16191NXK`) but these 27 listings are registered as `TIRE-16191NXK` in Seller Center. Every price call — BASE sync, promo activation, revert — is a **silent no-op** for these listings. **Fix: rename all 27 SKUs in Walmart Seller Center** (remove the `TIRE-` prefix). No code change needed. Breakdown:
   - 11 are Nexen NXK variants (e.g. `TIRE-16191NXK` → `16191NXK`)
   - 16 are Cooper/numeric supplier codes (e.g. `TIRE-170128006` → `170128006`)
   - Once renamed, they are automatically covered by the nightly BASE sync and all future activations

2. **Revert bug** — Currently only reverts variants with `compare_at_price` still set. The KV snapshot (`active_sale:{group}`) is already persisted at activation time — revert should read from it for reliability. Fix: update `handleRevert` in `activate-sale.ts` to always use the KV snapshot as the authoritative source rather than checking `compare_at_price` on each variant.

3. **GA4 403 PERMISSION_DENIED** — Property ID 526079137. Service account email needs to be verified and added to GA4 property access list. Not a code issue — access configuration in Google Analytics console.

### Low Priority
4. **Consolidate dual Vercel projects** — Retire `gci-command-center`, keep only `gci-command-center-ofzf` (ops.gcitires.com)
5. **`url.parse()` deprecation warning** — Cosmetic. Switch to WHATWG URL API in `activate-sale.ts`
6. **Walmart revert efficiency** — Only send BASE prices for actually-discounted SKUs, not all items in group
7. **`[object Object]` error display** — Some catch blocks still need `err instanceof Error ? err.message : JSON.stringify(err)`

---

## 9. Key Learnings (Avoid These Mistakes)

1. **Never assume Walmart CA and Walmart US share the same API values.** Channel type headers, endpoint paths, and market headers differ. Always verify against `gci-order-hub` reference patterns.

2. **Never include `WM_CONSUMER.CHANNEL.TYPE` in Walmart headers.** Its presence causes 400 errors on every call, regardless of the value. Omit it entirely.

3. **Walmart has two independent price layers: BASE and promotional.** `PUT /v3/price` with `REDUCED`/`CLEARANCE` applies a promo overlay — it does NOT update the item's regular listed price. BASE must be set separately and explicitly. If BASE is never synced from Shopify, Walmart displays a stale price both when no promo is running and as the strikethrough "was" price during a promo.

4. **Walmart `PUT /v3/price` matches by exact listing SKU.** If the Walmart listing was created with SKU `TIRE-16191NXK` and you send a price update for `16191NXK`, Walmart silently ignores it — no error, no confirmation, no effect. Always verify listing SKUs in Seller Center match what the system sends.

5. **Shopify REST `variants.json?sku=` does NOT support SKU filtering.** Use GraphQL `productVariants(query:"sku:{sku}")` instead.

6. **Pre-resolve variant IDs in catalogue, not at activation time.** Per-SKU GraphQL lookups during activation are slow and error-prone. The nightly refresh resolves all variant IDs upfront.

7. **Run diagnostics before code changes when multiple failure modes exist.** Confirm environment variables, endpoint routing, and header values before modifying code. Several bugs were compounded by fixing the wrong thing first.

8. **Natural price breaks > equal thirds** for tier segmentation. Data-driven boundaries reflect actual inventory distribution.

9. **TIRE- prefix is legacy.** Active Shopify products use mixed SKU formats. Filter by `productType:Tire` + `status:ACTIVE`, never by SKU prefix. The goal is a unified SKU system: CT → Shopify → Walmart all on the same raw identifier. 27 Walmart listings still need manual remediation (see backlog item #1).

---

## 10. Workflow for New Sessions

### To resume work:
1. Read this document first
2. Check the repo at `https://github.com/statco/gci-command-center`
3. Reference `gci-order-hub` for proven Walmart/Shopify patterns (read-only)
4. All serverless functions deploy via Vercel — push to main triggers deploy on both projects
5. Use Claude Code for implementation on feature branches with PRs

### To activate a new sale group:
1. Ensure catalogue is fresh: `GET /api/refresh-catalogue?dry=true&force=true`
2. If stale, run real refresh: `GET /api/refresh-catalogue?force=true`
3. Hard refresh dashboard, select group, click Activate Sale
4. Verify on `gcitires.ca` (strikethrough) and `walmart.ca` (Reduced badge)
5. Note: the 27 TIRE- prefixed Walmart listings will NOT receive the promo until their SKUs are corrected in Seller Center

### To sync Walmart base prices (after CT price update or on demand):
1. From the dashboard, click **⇅ Sync Walmart Prices**
2. Activity log will confirm count of updated/failed SKUs and duration (~45s for ~300 SKUs)
3. This also runs automatically at the end of every nightly catalogue refresh
4. Only covers the 73 non-prefixed listings — TIRE- prefixed listings are unaffected until fixed in Seller Center

### To revert a sale:
1. Click Revert on the active group in dashboard
2. **Known limitation:** reliability depends on `compare_at_price` still being set — KV-snapshot-based revert fix is pending (backlog item #2)

### To debug activation failures:
1. Check Vercel runtime logs on `gci-command-center-ofzf` project
2. Verify env vars are set (especially `SHOPIFY_ADMIN_API_TOKEN`, `WALMART_CLIENT_ID`, `WALMART_CLIENT_SECRET`)
3. Look for `undefined` env vars or 401/403 errors in logs
4. Confirm the catalogue in KV has `shopifyVariantId` populated on all items
5. If Walmart updates appear to succeed (200 OK) but prices don't change on walmart.ca — check if the affected SKUs have the TIRE- prefix in Seller Center
