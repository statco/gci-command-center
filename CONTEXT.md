# GCI Tires — Discount Manager System Context

> **Last updated:** 2026-06-11
> **Status:** Production — Group B Mid activated, system fully operational
> **Repo:** `statco/gci-command-center` (React 18 + TypeScript + Vite + Tailwind + React Router v6)
> **Reference repo:** `statco/gci-order-hub` (read-only, proven integration patterns)
> **Live URL:** `ops.gcitires.com/promotions`
> **Shopify store:** `gcitires-ca.myshopify.com`

---

## 1. What This System Does

A dual-channel sales discount rotation system for GCI Tires (Canada). It manages pricing promotions across **Shopify** and **Walmart Canada Marketplace** from a single dashboard.

**Core flow:**
1. Nightly cron pulls all active tires from Shopify → builds 3 price-tier groups (LOW/MID/HIGH, 100 items each)
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
- SKUs match exactly between Shopify and Walmart (99.8% overlap)

### Walmart API: Global Marketplace (NOT CA-specific feeds)
- `PUT /v3/price` with header `WM_MARKET: ca` — matches proven pattern in `gci-order-hub` and `gci-walmart-sync`
- **NOT** `/v3/ca/feeds` which requires a `WM_CONSUMER.CHANNEL.TYPE` GUID we don't have
- Auth: client_credentials OAuth → `WM_SVC.NAME` headers
- Price type `REDUCED` with `comparisonPrice` for badge display

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
  index.tsx              — Main dashboard UI (groups, steppers, activation, revert, activity log, settings)
  shopify.ts             — Shopify compare_at helpers (client-side, used for display/state only)
  walmart.ts             — Walmart pricing client (client-side reference)
  catalogue.ts           — Static fallback + CatalogueItem interface
  useDiscountStore.ts    — localStorage state (key: gci_discount_manager_v2)

api/
  activate-sale.ts       — Serverless: Shopify GraphQL variant mutation + Walmart PUT /v3/price
  discount-proxy.ts      — Serverless: CORS proxy for Walmart calls from browser
  refresh-catalogue.ts   — Serverless: pulls active tires from Shopify GraphQL, builds groups, stores in Upstash KV
  clean-pending.ts       — Serverless: removes TIRE- prefix items from pendingApprovals in KV

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

### Walmart CA — Price Update
```
PUT https://marketplace.walmartapis.com/v3/price
Headers:
  WM_MARKET: ca
  WM_SVC.NAME: Walmart Marketplace
  WM_SEC.ACCESS_TOKEN: {oauth_token}
  WM_GLOBAL_VERSION: 3.1
  Content-Type: application/json
```
- Body: `{ pricing: [{ sku, pricing: [{ currentPriceType: "REDUCED", currentPrice: { amount }, comparisonPrice: { amount } }] }] }`
- Auth: POST to `https://marketplace.walmartapis.com/v3/token` with client_credentials
- Up to 120 items per batch

### Upstash KV
- REST API at `KV_REST_API_URL` with Bearer `KV_REST_API_TOKEN`
- Catalogue stored as JSON under a single key
- Read/write from serverless functions only (not browser)

---

## 7. Current State (as of 2026-06-11)

### What's Working ✅
- Catalogue: 1,963 active tires from Shopify, all with pre-resolved variant IDs
- Group B Mid activated: 120/120 Shopify + 120/120 Walmart
- Compounding protection: correctly uses existing compare_at_price as original
- Nightly cron refresh: 5AM EST via Vercel cron
- Staged auto-add with $500 threshold
- Telegram notifications
- Stale TIRE- prefix pendingApprovals cleared (84 removed)
- 248 legitimate >$500 items in pendingApprovals awaiting manual review

### Previous Successful Activations
- Group A Low (early build): 99/100 Shopify, 24/24 Walmart — before source migration
- Group B Mid (current): 120/120 Shopify, 120/120 Walmart — after Shopify source migration

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

---

## 8. Known Issues & Backlog

### Priority
1. **Revert bug** — Currently only reverts variants with `compare_at_price` set. Should store activated SKU list in KV during activation and use it for reliable revert.
2. **GA4 403 PERMISSION_DENIED** — Property ID 526079137. Service account email needs to be verified and added to GA4 property access list. Not a code issue — it's an access configuration issue in Google Analytics.

### Low Priority
3. **Consolidate dual Vercel projects** — Retire `gci-command-center`, keep only `gci-command-center-ofzf` (ops.gcitires.com)
4. **`url.parse()` deprecation warning** — Cosmetic. Switch to WHATWG URL API in activate-sale.ts
5. **Walmart revert efficiency** — Only send BASE prices for actually-discounted SKUs, not all items in group
6. **`[object Object]` error display** — Catch blocks need `err instanceof Error ? err.message : JSON.stringify(err)`

---

## 9. Key Learnings (Avoid These Mistakes)

1. **Never assume Walmart CA and Walmart US share the same API values.** Channel type headers, endpoint paths, and market headers differ. Always verify against `gci-order-hub` reference patterns.

2. **Shopify REST `variants.json?sku=` does NOT support SKU filtering.** Use GraphQL `productVariants(query:"sku:{sku}")` instead.

3. **Pre-resolve variant IDs in catalogue, not at activation time.** Per-SKU GraphQL lookups during activation are slow and error-prone. The nightly refresh resolves all variant IDs upfront.

4. **Run diagnostics before code changes when multiple failure modes exist.** Confirm environment variables, endpoint routing, and header values before modifying code. Several bugs were compounded by fixing the wrong thing first.

5. **Natural price breaks > equal thirds** for tier segmentation. Data-driven boundaries reflect actual inventory distribution.

6. **TIRE- prefix is legacy.** Active products use mixed SKU formats. Filter by `productType:Tire` + `status:ACTIVE`, never by SKU prefix.

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

### To revert a sale:
1. Click Revert on the active group in dashboard
2. **Known limitation:** only reverts variants with current `compare_at_price` — fix pending (backlog item #1)

### To debug activation failures:
1. Check Vercel runtime logs on `gci-command-center-ofzf` project
2. Verify env vars are set (especially `SHOPIFY_ADMIN_API_TOKEN`, `WALMART_CLIENT_ID`, `WALMART_CLIENT_SECRET`)
3. Look for `undefined` env vars or 401/403 errors in logs
4. Confirm the catalogue in KV has `shopifyVariantId` populated on all items
