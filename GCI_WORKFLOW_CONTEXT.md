# GCI Tires — Cross-Repo Workflow Context

> **Read this first**, before starting any new work in any GCI Tires repo — whether
> you're a human or an AI assistant picking up a session. This file is duplicated
> identically across all 6 repos below so it's available no matter which one you
> land in first. If you update it, update all 6 copies.
>
> Last written: 2026-07-01, last updated: 2026-07-02, following a full
> cross-repo audit and remediation pass. Status markers:
> ✅ verified working · 🟡 built but not fully live-verified · ⛔ known broken/blocked ·
> 🔲 not yet built.

---

## 1. What this system is

GCI Tires runs an tire e-commerce + wholesale operation (gcitires.ca /
gcitirescanada.com) across **Shopify** (storefront) and **Walmart Canada
Marketplace**, sourced from supplier **Canada Tire (CT)**, with a small network
of independent **installers** dispatched via Airtable. The intent is a largely
autonomous system spanning Operations, Sales & Marketing, Finance, and
Reporting/Monitoring — six repos, one Vercel team (`GCI_Tires projects`), plus
Shopify, Walmart, Airtable, Xero, and Google Analytics 4 as external systems.

**This is not one app.** It's six independently-deployed repos that talk to
each other over HTTP (webhooks + REST calls) and shared external services, not
shared code or a shared database. Before changing anything, know which repo
owns which piece — see the map below — and don't assume a name matches its
actual current purpose (some don't; see §4).

---

## 2. Repo map

| Repo | Role | Deploys to | Status |
|---|---|---|---|
| **gci-brain** | Shopify catalog/SEO/marketing engine. Owns: CT→Shopify catalog sync (`shopifySync.ts`), GMC/Microsoft Merchant feeds, SEO backfill, social media scheduler, blog publisher, installer booking UI (AI Match), `/api/airtable` + `/api/send-email` proxies used by other repos. | `gci-brain.vercel.app`, custom domain `match.gcitires.com` | ✅ core catalog/SEO pipeline working. ⛔ GMC account suspended (business action needed, not code). See §5. |
| **gci-order-hub** | Order automation for GCI's own Shopify store: Shopify `orders/paid` webhook → routes to CT (TIRE- SKUs) → installer dispatch → Walmart price/inventory cron sync (`/api/walmart-sync`, `/api/walmart-sync-cursor`, `/api/walmart-ship`, etc. — more routes live than the README documents, check the actual `api/` folder). CJ Dropshipping (NUPROZ- SKU) routing removed 2026-07 — see §3/§4. | `gci-order-hub.vercel.app` | ✅ core routing working. 🟡 CT auto-PO switch built, dormant (§6). |
| **gci-command-center** | Internal ops dashboard — Sales/Marketing/Finance/IT/Content, one React app. Pulls Shopify + GA4 + Xero into one place. Also runs the Walmart discount-rotation system (`/promotions`). | **Two Vercel projects deploy the same repo** — `gci-command-center-ofzf` (custom domain `ops.gcitires.com`) is the real one; `gci-command-center` (plain `.vercel.app` URL) is a leftover duplicate slated for retirement. Don't be confused by there being two. | ✅ discount rotation working. ⛔ Xero integration token-expired, ⛔ GA4 integration permission-denied — both need manual re-auth, not code (§5). |
| **gcitires-chatbot** | Customer-facing AI chat widget embedded on the storefront. Memory/conversation history migrated 2026-07 from Airtable to Supabase (`chatbot_customers`/`chatbot_conversations` tables in the shared `gci-walmart-sync` Supabase project) — fixes the `/api/memory` timeout problem below. | `gcitires-chatbot.vercel.app` | 🟡 Code merged/PR open (gcitires-chatbot#27). Requires `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env vars set + historical Airtable data migration script run before fully live — see §5. |
| **gci-walmart-sync** | **Standalone commercial Shopify app** (Remix, Shopify App Store template) for Walmart CA Marketplace sync — listings, price, inventory, orders, returns. Built first for GCI, intended to be **published commercially** once ready. **Not activated for GCI's own operations yet** — pre-launch. | `app.gcitires.ca` (+ `gci-walmart-sync.vercel.app`) | 🟡 CC-1 through CC-12 built and compiling, feature-complete on paper, genuinely NOT live-tested with a real merchant yet (including GCI itself). See its own `docs/SESSION-CONTEXT.md` for full build history. |
| **gci-price-monitor** | Daily competitor tire-price scraper (Python/Playwright), **runs via GitHub Actions, not Vercel** — despite having a `vercel.json`, that file is an unused stub. Reports via Telegram. Persistence migrated 2026-07 from local SQLite to Supabase (`price_monitor_snapshots` table, same shared project) — real day-over-day trend data now possible for the first time. | GitHub Actions cron (`.github/workflows/price_monitor.yml`, daily 8AM EST) | 🟡 Migration PR open (gci-price-monitor#4), verified working end-to-end via a real `workflow_dispatch` test run against the branch (real scrape, real Supabase insert, confirmed via direct SQL query) before merge. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` secrets already set on the repo. |

**Explicitly not part of this system**, despite living in the same Vercel team:
`nuprozone`, `gci-finance-website`, `gci-corporate-website` — unrelated projects,
don't touch without separately confirming scope.

---

## 3. External systems and where their credentials live

| System | Used by | Auth pattern | Notes |
|---|---|---|---|
| **Shopify** (`gcitires-ca.myshopify.com`, plan: Basic) | All 6 repos, in different ways | Admin API token (`SHOPIFY_ADMIN_API_TOKEN` — watch for the older `SHOPIFY_ADMIN_TOKEN` name still lurking in some scripts, see gci-brain's project file) | **Basic plan** — no checkout extensibility / arbitrary custom-priced cart lines. Anything needing dynamic pricing (e.g. installation fees) has to use fixed-price product tiers, not true custom amounts. |
| **Canada Tire (CT)** | gci-brain (catalog read), gci-order-hub (PO submission, dormant) | OAuth 1.0a (NetSuite RESTlet pattern) — Consumer Key/Secret, Token ID/Secret, Realm `8031691` | **Currently READ-ONLY** (`customscript_item_search_rl` — catalog/price search only). No order-creation endpoint exists yet. Credit line + API access reportedly coming — ask before assuming it's ready. |
| **Walmart Canada Marketplace** | gci-order-hub (live), gci-command-center (live, discount rotation), gci-walmart-sync (built, not activated) | OAuth2 client_credentials, `WM_MARKET: ca` header, `WM_SEC.ACCESS_TOKEN` (not Bearer) | Multiple independent Walmart clients exist across repos — `gci-order-hub/api/lib/walmart-client.ts` is the oldest/most battle-tested; port patterns from there, don't reinvent. |
| **Airtable** (`GCI Installer Portal` base) | gci-brain (owns `/api/nearby-installers` + `/api/submit-installer-application`, both narrow/safe; `/api/airtable` itself is now server-to-server only), gci-order-hub (calls `/api/airtable` with the shared secret). **gcitires-chatbot no longer uses Airtable at all as of 2026-07** — migrated to Supabase, see §2. | Server-side API key, held by gci-brain only | ✅ Fixed 2026-07 (gci-brain#129, gci-order-hub#44, merged). `/api/airtable` now requires `X-Internal-Secret` (env var `INTERNAL_API_SECRET`, must match across gci-brain + gci-order-hub) and is unreachable from any browser. The two browser-facing use cases (installer search, application submission) moved to purpose-built endpoints that never expose PII fields. |
| **Xero** | gci-command-center (Finance page) | OAuth2, refresh token | ⛔ Refresh token expired/revoked as of audit date — needs manual re-auth via `/api/xero?resource=auth-url`. |
| **GA4** | gci-command-center (Marketing page) | Service account | ⛔ 403 permission-denied on property `526079137` — service account needs to be re-added to the GA4 property access list in Google Analytics console. |
| **Telegram + Resend** | gci-order-hub, gci-command-center, gci-price-monitor (Telegram only) | Bot token / API key per repo | Straightforward, no known issues. |
| **Supabase** (project `gci-walmart-sync`, ref `enhbckomwdelktdhnuzq`, region `ca-central-1`) | gci-walmart-sync (original owner — `shops`/`products`/`walmart_orders`/`sync_logs`/`sessions`/`walmart_sync_cursor` tables), gcitires-chatbot (`chatbot_customers`/`chatbot_conversations`, added 2026-07), gci-price-monitor (`price_monitor_snapshots`, added 2026-07) | Service role key, held server-side only per repo | Reused deliberately across all three rather than provisioning separate paid projects. RLS enabled on every table, no permissive policies for anon/authenticated — service_role-only access pattern, consistent across all tenants of this project. If you add a new table here for a new use case, follow the same pattern. |
| **CJ Dropshipping** | none — removed 2026-07 | — | **Was dead code (`NUPROZ-` SKU path in gci-order-hub), now fully removed** (gci-order-hub#45). nuprozone.com was discontinued due to brand conflicts; confirmed permanent, not paused. |

---

## 4. Things that look like one thing but are another (read before assuming)

- **`gci-order-hub` vs `gci-walmart-sync`**: both touch Walmart, but they are not
  duplicates. `gci-order-hub` is GCI's live production Walmart price/inventory
  cron. `gci-walmart-sync` is a separate, not-yet-activated commercial Shopify
  app being built for eventual Shopify App Store publication. Don't consolidate
  them without explicit instruction — they serve different purposes and have
  different audiences (GCI-only vs. multi-tenant).
- **Two `gci-command-center` Vercel projects**: same GitHub repo, two Vercel
  deployments. `-ofzf` (custom domain `ops.gcitires.com`) is real/live. The
  plain one is a leftover duplicate. Documented for retirement, not yet deleted
  as of this writing — confirm current status before assuming either way.
- **`gci-price-monitor`'s `vercel.json`**: present but unused. The real
  execution engine is GitHub Actions. Don't spend time debugging Vercel
  deployments for this repo — there's nothing meaningfully deployed there.
- **The AI Match checkout** (gci-brain, `CheckoutModal.tsx`): as of 2026-06-30
  this **did not create real Shopify orders or collect payment at all** — it
  simulated success locally. Fixed 2026-07-01 (PRs gci-brain#125, #126,
  gci-order-hub#42) to use Shopify's real Cart API + a post-payment webhook
  for installer dispatch. A second, separate bug surfaced immediately after
  via a real manual test: the redirect to real checkout used
  `window.location.href`, which only navigates the iframe AI Match actually
  runs inside on the real storefront (`templates/page.gci-ai-match-landing.liquid`
  on the Dawn theme) — Shopify's checkout refuses to load inside any iframe
  whose top-level page isn't a Shopify domain, so it silently failed. Fixed
  2026-07-02 (gci-brain#128, `window.top!.location.href`), verified working
  via a real completed checkout page (screenshot). If you're reading an old
  summary/memory of this system, distrust anything about checkout that
  predates 2026-07-02, not just 2026-07-01.

- **TIRE- SKU prefix**: legacy. Most live Shopify products use native/mixed
  SKU formats now, not the `TIRE-` prefix. Filter by `status:ACTIVE AND
  productType:Tire`, not by SKU prefix, when querying the live catalog (see
  gci-command-center's CONTEXT.md §2 for the full reasoning — this was a
  hard-won lesson from real bugs).

---

## 5. Known issues open as of 2026-07-01 (business/config, not code)

These need a human action outside any repo's code — don't try to "fix" them
with a code change:

1. **GMC (Google Merchant Center) account suspended** — reinstatement blocked
   on a commercial-name update requirement. See gci-brain's project file.
2. **Xero refresh token expired** — re-auth via gci-command-center's
   `/api/xero?resource=auth-url`.
3. **GA4 service account lost property access** — re-add it in Google
   Analytics console for property `526079137`.
4. **CT order-creation API** — doesn't exist yet; GCI's rep is working with CT
   on credit line + API access. The auto-PO switch (gci-order-hub) is built
   and dormant, ready to activate once CT delivers their side — see
   `api/lib/ct-client.ts` for exactly what's needed.

## 6. Known issues (code) — status as of 2026-07-02

**Fixed and merged:**
1. **`gci-brain`'s `/api/airtable` proxy** — was unauthenticated + open CORS, exposing installer PII (bank info) to any customer's browser during normal AI Match use. Fixed (gci-brain#129, gci-order-hub#44, both merged) — see §3 credential map.
2. **`gcitires-chatbot`'s `/api/memory` timeouts** — migrated Airtable → Supabase. Code merged in gcitires-chatbot#27 (PR, not yet confirmed fully live — needs `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env vars set on that Vercel project, and the historical-data migration script run — see below).
3. **`gci-price-monitor`'s SQLite persistence** — migrated to Supabase, verified working end-to-end via a real `workflow_dispatch` test run (real scrape + real DB write, confirmed via direct SQL query) before merge. PR: gci-price-monitor#4.
4. **Deprecated Claude model references** — were hardcoded in 3 files in
   `gci-brain` (`blog-publisher.ts`, `social-scheduler.ts`,
   `generateSeoDescriptions.ts`), causing silent failures for ~1 week+.
   Fixed as part of the audit — if you see `claude-sonnet-4-20250514`
   anywhere else in this system, it's stale and needs updating (check what
   model string is currently valid before hardcoding a new one — don't just
   copy whatever was here).
5. **27 Walmart listings still carry a stale `TIRE-` SKU prefix** in Seller
   Center, causing silent no-ops on price sync for those specific listings.
   Confirmed 2026-07: **zero currently-ACTIVE Shopify products have a
   `TIRE-` SKU anymore** (all archived/draft) — these are orphaned
   Walmart-side listings referencing SKUs that no longer exist in the live
   catalog at all. Can't be enumerated from Shopify data; needs a direct
   Walmart Seller Center lookup (no Walmart connector was available to
   pull this automatically). Fix: rename/relist in Seller Center, no code
   change needed.
6. **Installer application form was silently dropping submissions
   entirely** — `submitInstallerApplication()` posted to a table
   ('Installer Applications') that doesn't exist in the Airtable base and
   wasn't in the old proxy's allowlist. Every real application failed
   outright since the form was built. Fixed as part of gci-brain#129 —
   now writes to the real `Installers` table (`Status: Pending Review`),
   confirmed against the live schema.
7. **`gci-order-hub`'s dead NUPROZ- (nuprozone.com) routing code** —
   removed (gci-order-hub#45). Confirmed permanently discontinued.

**Still open:**
8. **Duplicate `gci-command-center` Vercel project** — identified as safe
   to delete (§4), not yet deleted. No delete-project tool was available
   to do this automatically; needs a manual delete in the Vercel
   dashboard (Settings → Delete Project on the plain `.vercel.app` one,
   NOT `-ofzf`).
9. **Chatbot Supabase migration needs two manual steps before it's fully
   live**: (a) set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in
   gcitires-chatbot's Vercel project env vars, (b) run
   `scripts/migrate-airtable-to-supabase.ts` once with real
   `AIRTABLE_API_KEY` + Supabase credentials to bring over ~19,272
   existing customer records — the new tables start empty otherwise (new
   conversations still work fine either way, this only affects returning-
   customer memory for pre-migration customers).

---

## 7. Working conventions across these repos

- **Port from confirmed-working implementations, don't reconstruct from
  memory or docs.** Several of these integrations (Walmart auth headers, CT
  OAuth signing) were hard-won through real debugging. If you need a Walmart
  or CT client and one already exists in another repo, copy its exact
  headers/URLs/error-handling rather than re-deriving them.
- **Feature branches + PRs, not direct pushes to `main`**, for anything
  beyond a trivial fix. Branch naming varies slightly by repo (`claude/*` is
  most common) — check each repo's existing branches before naming a new one.
- **Run `npx tsc --noEmit` (and `npm run build` / `vite build` where
  applicable) before merging, in a real environment with `node_modules`
  installed.** Don't trust a sandbox that couldn't install dependencies —
  verify for real. (This audit caught a real bug this way that a
  dependency-less sandbox review missed.)
- **Don't dispatch anything (installer, supplier PO, customer email) before
  payment is confirmed.** The 2026-07-01 checkout fix exists specifically
  because this rule was violated — client-side code created real-world
  side effects (installer jobs, emails) before any payment had happened.
  Anything with a real-world consequence belongs in a webhook handler that
  fires after Shopify (or Walmart) confirms the transaction, not before.
- **When in doubt about a repo's actual current state, read its code, not
  just its README/docs.** Several docs across this system were found
  meaningfully out of date during the audit that produced this file —
  including, ironically, this file will eventually become outdated too.
  Trust `git log` and the actual source over prose descriptions when they
  conflict.

---

## 8. Where to go for more detail

Each repo has its own deeper docs — read the relevant one(s) before starting
work in that repo specifically:

- `gci-brain`: `GCI_Tires_Project_File.md`, `CLAUDE.md`
- `gci-order-hub`: `README.md` (partially stale — check actual `api/` folder
  contents against it)
- `gci-command-center`: `CONTEXT.md` (detailed, mostly current as of
  2026-06-15)
- `gci-walmart-sync`: `docs/SESSION-CONTEXT.md` (detailed build history,
  written for exactly this "prime a new session" purpose)
- `gcitires-chatbot`, `gci-price-monitor`: `README.md`, `SETUP_GUIDE.md`,
  `WORKFLOW.md` (price-monitor)
