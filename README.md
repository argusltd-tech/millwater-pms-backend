# Millwater PMS — API

Express + Prisma (PostgreSQL) API for Millwater PMS. The web app lives in the separate `millwater-pms-frontend` repository and reaches this API through a Vercel rewrite of `/api/*`, so the browser only ever talks to one origin.

## Run locally

Requires Node 20+ and PostgreSQL.

```powershell
copy .env.example .env      # set DATABASE_URL, MILLWATER_BOOTSTRAP_KEY, SETTINGS_ENCRYPTION_KEY
npm install                 # also generates the Prisma client
npm run db:migrate
npm run db:seed             # optional sample network, customers and tariffs
npm run db:test-users       # optional: one login per role (prints passwords once)
npm run dev                 # http://localhost:4000
```

`npm test` runs the unit tests.

## Deploy on Render

Use the Blueprint in `render.yaml` (**New → Blueprint**), which creates the API and a PostgreSQL database, or create a Web Service by hand:

- Build command: `npm ci`
- Start command: `npx prisma migrate deploy && npm start` (migrations run on every start)
- Health check path: `/api/health`
- Environment variables:
  - `DATABASE_URL` — PostgreSQL connection string
  - `NODE_ENV=production` — makes the session cookie HTTPS-only
  - `TRUST_PROXY=2` — Vercel rewrite + Render load balancer, so rate limits and audit logs see the real client IP
  - `ALLOWED_ORIGINS` — the frontend's Vercel URL(s), comma-separated
  - `MILLWATER_BOOTSTRAP_KEY` — random secret (32+ characters) for creating the first administrator
  - `SETTINGS_ENCRYPTION_KEY` — random secret (32+ characters) that encrypts secrets entered in Settings (e.g. the AMI token). Never change it once set.

The plans in `render.yaml` (`starter`, `basic-256mb`) are paid tiers; change them if you prefer the free tier.

After the first deploy, create the first administrator once with `POST /api/auth/bootstrap` (see `BACKEND_SETUP.md`). The AMI connection, VAT, payment terms, invoice prefix and company/bank details are then entered in the app under **Settings**.

More detail: `BACKEND_SETUP.md` (API reference) and `AMI_INTEGRATION.md`.
