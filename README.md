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

## Onboarding emails (Resend)

When a customer is onboarded, one or more customer service staff are chosen as their support
contacts. The customer is then emailed a welcome letter (`server/onboardingEmail.js`, from
Millwater's `millwater_onboarding.html` design), with the support contacts copied in and set
as reply-to. Staff can change support contacts and resend the email from the customer profile.

Customers are also assigned the bank account they pay into, chosen from the accounts an
administrator adds in Settings → Bank accounts; it appears on the email and invoices.

Set `RESEND_API_KEY` and `EMAIL_FROM` (a sender on a domain verified in Resend). The logo
images are served publicly from `/api/email-assets/`. The sign-off comes from Settings. Every send, and every failure with its reason, is recorded in the customer's
messages and in the audit log. Onboarding still completes if the email cannot be sent.

## Approval queues

Some changes are held in the approval queue (table `ApprovalRequest`, screen **Approvals**) and take effect only once someone other than the requester approves them. Administrators can stand in for any approver.

| Request | Raised by | Approved by |
| --- | --- | --- |
| Add, change, retire or reactivate a tariff | Admin, Billing | Finance |
| Payment exceptions: manual match, clearing a duplicate flag, reversal | Admin, Finance, Billing | Finance |
| Closing a billing cycle (creates the draft invoices) | Admin, Billing | Finance |
| Releasing draft invoices to customers | Admin, Billing | Finance |
| Meter-reading exceptions | Admin, Billing, Network Ops | Network Ops |

A reading is an exception if it changes a reading already recorded, if the opening reading does not match last cycle's closing reading, or if consumption is more than 50% above or below the customer's average over the last three invoices. Until it is decided, the account is left out of billing.

The API keeps the same endpoints. Requests that are queued return `202` with `pending: true`. When a request is approved, the change and the decision are saved in one transaction.

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
  - `SEED_DEMO_DATA` — `true` loads demonstration data on startup (see below); set it to `false` before entering real data.

### Demonstration data

With `SEED_DEMO_DATA=true` the server loads, on each start:

- the sample network (4 substations, 8 feeders, 24 transformers), 3 tariffs and 200 customers — records that already exist are left alone;
- three months of billing history — closed billing cycles with meter readings, about 600 issued invoices calculated with the Settings VAT, terms and prefix, varied payment behaviour (on time, late, partial, stopped), a few reconciliation exceptions and reminder messages — plus the current month's open cycle. This part runs only when the database has **no billing cycles at all**, so it never mixes with real billing data. If no administrator exists yet, it runs as soon as the first administrator is created.

Locally, `npm run db:seed` does the same.

The plans in `render.yaml` (`starter`, `basic-256mb`) are paid tiers; change them if you prefer the free tier.

After the first deploy, create the first administrator once with `POST /api/auth/bootstrap` (see `BACKEND_SETUP.md`). The AMI connection, VAT, payment terms, invoice prefix and company/bank details are then entered in the app under **Settings**.

More detail: `BACKEND_SETUP.md` (API reference) and `AMI_INTEGRATION.md`.
