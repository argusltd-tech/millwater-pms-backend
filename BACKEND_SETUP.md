# Millwater PMS backend setup

Millwater PMS now owns its billing database and API. It does not depend on Verge PMS. The AMI proxy remains a separate, read-only Millwater PMS integration.

## Local setup

1. Create a PostgreSQL database for Millwater PMS.
2. Copy `.env.example` to `.env`, set `DATABASE_URL`, and set `MILLWATER_BOOTSTRAP_KEY` to a random secret of at least 32 characters.
3. From `millwater-pms/backend`, install dependencies and apply the committed migrations:

   ```powershell
   npm install          # also generates the Prisma client
   npm run db:migrate
   ```
4. Start the API with `npm run dev` (port 4000). In a second terminal, start the frontend from `millwater-pms/frontend` with `npm install` then `npm run dev` (port 3000); it forwards `/api` to the backend.
5. Create the first administrator once using the bootstrap key. For example:

   ```powershell
   $env:MILLWATER_BOOTSTRAP_KEY = "<the same value configured in .env>"
   $body = @{
     fullName = "Millwater PMS Administrator"
     username = "millwater.admin"
     email = "admin@example.com"
     password = "replace-with-a-unique-password-of-at-least-12-characters"
   } | ConvertTo-Json

   Invoke-RestMethod -Method Post `
     -Uri "http://localhost:4000/api/auth/bootstrap" `
     -Headers @{ "x-millwater-bootstrap-key" = $env:MILLWATER_BOOTSTRAP_KEY } `
     -ContentType "application/json" -Body $body
   ```

   Bootstrap is disabled after the first account is created. Sign in through the Millwater PMS login screen using that account.
6. To load the bundled sample network, customers and tariffs into a development database, run `npm run db:seed` (data in `prisma/seed-data.json`). Seeding is explicit and does not create operator accounts.

## Billing API

- `POST /api/billing/cycles` creates a monthly cycle with a `periodKey` such as `2026-10`.
- `POST /api/billing/cycles/:id/readings` records opening and closing cumulative meter readings. Readings are entered in Millwater PMS; AMI data is not automatically mapped to billing.
- `GET /api/billing/cycles/:id/readiness` reports missing or non-increasing readings.
- After the month ends and all active accounts are ready, `POST /api/billing/cycles/:id/close` closes it; `POST /api/billing/cycles/:id/generate-invoices` creates idempotent draft invoices.
- `GET /api/billing/cycles/:id/readings` lists the readings recorded for a cycle.
- `POST /api/billing/invoices/:id/issue` changes a draft to issued and records an "invoice issued" customer message as `queued`. Nothing is sent because no notification provider is configured.
- `PATCH /api/tariffs/:id` changes rates or retires a tariff. New rates apply only to invoices generated afterwards; a tariff with active customers cannot be retired.

Issued and partly paid invoices past their due date are marked `overdue` automatically when invoices, customers or receivables are read.

## Payments and reconciliation API

- `POST /api/payments` records a payment from a bank confirmation. A payment with the same bank reference at the same bank, or the same payer and amount within 3 days, is saved as `duplicate` and cannot be allocated until released.
- `POST /api/payments/:id/allocate` takes `{ invoiceId }` (one invoice) or `{ customerId }` (oldest due invoice first).
- `POST /api/payments/auto-reconcile` allocates every unmatched or partial payment it can identify: by an invoice number or account number in the bank reference, by the customer recorded on the payment, or by an exact payer-name match. Payments it cannot identify are left for manual review.
- `POST /api/payments/:id/reverse` (`{ reason }`) removes the payment's allocations and restores invoice balances.
- `POST /api/payments/:id/release-duplicate` (`{ note }`) clears a duplicate flag.

## Customers, receivables, messaging and audit API

- `PATCH /api/customers/:id` updates a customer. Customer service can change contact details only; tariff, credit limit, risk, network and active status need a billing specialist or administrator.
- `GET /api/customers/:id/history` returns the account's readings, invoices, payments, messages and audit entries.
- `GET /api/receivables` returns totals, aging buckets, per-customer aging, overdue invoices and six months of billed-vs-collected figures.
- `GET /api/messages` and `POST /api/messages` (`{ customerIds }` or `{ feederId }`, plus `channel`, `templateType`, `subject`, `body`) keep the communication history. Messages are stored as `queued` until a delivery provider is added.
- `GET /api/audit-logs?entity=&entityId=` (administrators) returns entries with the acting user and, for updates, before/after values.

Money is stored using PostgreSQL decimal columns and calculated in whole kobo on the server. Passwords are scrypt-hashed, and browser sessions use random opaque tokens stored only as hashes in the database and carried in `HttpOnly`, `SameSite=Strict` cookies.

## Users and network API

- `PATCH /api/users/:id` (administrators) updates name, username, email, phone, department, role, status, or resets the password. A reset or suspension ends that user's other sessions. You cannot demote or suspend yourself, and the last active administrator cannot be demoted, suspended or deleted.
- `DELETE /api/users/:id` archives the account: access is removed, it disappears from the directory, the username and email are freed, and audit history keeps the operator's name.
- `GET /api/network` (administrators and network operations) returns substation → feeder → transformer → customer with customer counts and meter communication totals. Balances and arrears are included only for roles that can see financial data; `GET /api/customers` follows the same rule.
- `npm run db:test-users` creates one development login per role and prints the passwords once.
- `GET /api/settings` returns company/bank details, VAT rate, payment terms and invoice prefix to every signed-in user; administrators also get the AMI connection status (never the token). `PATCH /api/settings` (administrators) saves changes; `POST /api/settings/ami/test` checks the AMI connection. Secrets are encrypted with `SETTINGS_ENCRYPTION_KEY`.
- `GET /api/dashboard` returns the overview for the signed-in role: only the sections that role may see (network, billing, receivables, payments, messages, customer follow-ups, users, recent activity) plus a ranked "needs attention" list, each item pointing at the screen that resolves it.

## What the screens use

Billing, payments, receivables, customers, messaging, user management, the audit log and the network map's structure all use these APIs. The network map's communication and revenue lenses use live records; its health and loss lenses, and the feeder/meter monitoring and energy-loss screens, still use demonstration telemetry because AMI reading ingestion and the loss calculation are not built yet. Actions on those screens (thresholds, relay, breaker test, loss audit) change the display only and say so.
