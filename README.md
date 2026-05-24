# GCI Command Center

Unified operations dashboard for GCI Tires. Aggregates real-time data from Shopify, Google Analytics 4, and Xero into a single internal tool.

## Routes

| Path | Department |
|---|---|
| `/` | Dashboard — top-level KPIs |
| `/bi` | Business Intelligence |
| `/sales` | Sales — pipeline, orders, revenue |
| `/marketing` | Marketing — GA4 analytics & campaigns |
| `/it` | IT — infrastructure & integrations |
| `/finance` | Finance — Xero invoicing & reports |
| `/content` | Content — publishing schedule & assets |

## Stack

- **React 18** + **TypeScript** via **Vite**
- **React Router v6** (BrowserRouter)
- **Tailwind CSS**
- **Vercel** — static frontend + serverless API routes under `/api`

## Development

```bash
npm install
npm run dev        # starts Vite dev server on http://localhost:5173
```

API calls proxy to `http://localhost:3000` in dev (see `vite.config.ts`).

## Deployment

Deployed automatically to Vercel on push to `main`. The `vercel.json` catch-all rewrite ensures all client-side routes are served by `index.html`.

```json
{ "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
]}
```
