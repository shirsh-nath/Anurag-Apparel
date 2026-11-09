# Anurag Apparel implementation map

Updated 9 November 2026. Deployment state and completed checks are recorded in
[docs/commerce-verification.md](docs/commerce-verification.md).

## Architecture

The storefront is HTML with vanilla JavaScript modules and Tailwind CDN. Supabase
provides Google Auth, PostgreSQL, public catalogue media and Deno Edge Functions.
Vercel serves the static pages/API routes; `_redirects` provides equivalent clean
page routes for Netlify. Leaflet and OpenStreetMap tiles display checkout/delivery
maps. Resend delivers transactional order updates and separately managed marketing
campaigns. Apify refreshes Google reviews through a server function.

| Files | Responsibility |
| --- | --- |
| `index.html` | Catalogue, product modal, store information and shared entry points |
| `customer-account.js/css` | Google sign-in, profile completion, account editing and customer session |
| `storefront-commerce.js/css` | Product purchase controls, cart, checkout address/map, order history and owner code reveal |
| `commerce-client.js` | JSON commerce requests using customer JWT or opaque staff session |
| `admin-session.js` | Staff login/session validation, logout and signed media operations |
| `admin.html` | Catalogue/media, categories, brands, homepage settings, reviews, password and admin menu |
| `orders.html`, `orders-admin.js/css`, `orders-admin-logic.js` | Orders, customers, delivery, inventory and flexible commerce settings |
| `analytics.html`, `email_resend.html` | Private staff analytics and marketing tools |
| `privacy.html`, `terms.html`, `legal.css` | Public account/order information and footer policy links |
| `public-config.js`, `api/config.js` | Load only the Supabase URL/public key and public media limit |
| `scripts/dev-server.mjs` | Local allowlisted asset server and public configuration endpoint |

## Database

`sql/supabase-schema.sql` contains the historical catalogue/account schema. It creates
products, categories, brands, announcements, store settings, reviews, marketing
contacts/images, analytics, customer profiles and a private administrator-credential
table. A fresh project needs a privately provisioned strong administrator
credential; there is no published default password.

The commerce extension is split deliberately:

1. `sql/commerce-schema.sql` adds product inventory/options, singleton
   settings, orders, line-item snapshots, status events, private encrypted code
   records, email outbox, admin sessions and login throttling. Ordering stays off
   until security and password readiness flags are satisfied. Customers have
   owner-only visible-order reads. Privileged commerce RPCs are service-only.
2. `sql/commerce-security.sql` activates the new staff boundary alongside the
   branch deployment. It removes the old public verifier/write/purge permissions,
   applies session-checked catalogue policies, protects campaign/analytics data,
   and routes Storage mutations through signed capabilities. Old admin clients
   cannot continue writing after activation.

Booking locks settings and products, validates server prices and stock, assigns a
future slot and reserves available quantity. A customer-bound idempotency key
prevents duplicate retries. Cancellation restores stock once. Generic status
updates cannot finish delivery; the dedicated action verifies cash collection
and, when the order snapshot requires it, the customer's four-digit code.

Order retention is audience-specific visibility followed by one canonical purge
after both periods expire. Active orders do not expire. Manual terminal-order
deletion cascades through related order records. Provider backups and already-sent
emails are outside the application's delete operation. Details and defaults are
in [the order guide](docs/online-orders.md).

## Server boundary

`supabase/functions/commerce/index.ts` validates customer tokens with Supabase Auth,
staff tokens through a private session digest and maintenance calls through a
separate server secret. Public settings are the only intentionally anonymous
commerce action. CORS allows the production apex/www domains and local port 5500;
exact preview origins can be added using `COMMERCE_ALLOWED_ORIGINS`.

`domain.mjs` validates inputs and plain-text email templates, escapes rendered HTML,
and derives separate AES-GCM/HMAC keys from the server-only code master key.
Plaintext delivery codes are absent from PostgreSQL, staff responses and emails.
Only the customer who owns an active protected order can request decryption. An
infrastructure owner with code/key control can override these protections.

Order email events use a private durable outbox with leases, bounded retries and
Resend idempotency. Maintenance purges eligible orders/expired staff sessions and
retries pending notifications. The encryption master key must never be stored in
the database; a different maintenance secret is stored in Vault for cron.
`scripts/configure-commerce.mjs --secrets --schedule-config` provisions/checks keys
from the ignored local environment and prepares the scoped Vault configuration.
`sql/commerce-maintenance.sql` installs the five-minute order-maintenance job,
daily analytics cleanup and daily review refresh.

The updated `send-email` and `sync-google-reviews` Edge Functions require validated
staff sessions for manual actions. Scheduled reviews use the scoped maintenance
secret from Vault.
`api/purge-analytics.js` requires a valid cron secret and server-only service-role
key. These legacy function changes must roll out with the secure admin frontend.

## Configuration and verification

[.env.example](.env.example) lists local/server variable names without credentials.
The ignored `.env`, `credential.txt`, browser-local config and `.account-work`
directory are excluded from deployment. Only public configuration may be returned
by `/api/config`. Google OAuth client secrets belong in the Supabase provider
configuration, not browser code.

Run `npm run dev`, `npm run check` and `npm test`. SQL tests in `sql/tests/` use
synthetic fixtures with transaction rollback. Account/order runtime mocks do not
replace real-account Google consent, browser/mobile visual checks or live mail
delivery verification. Follow the coordinated rollout and launch checklist in
[docs/online-orders.md](docs/online-orders.md); use
[docs/customer-accounts.md](docs/customer-accounts.md) for the exact OAuth callback
and return URLs. [docs/commerce-verification.md](docs/commerce-verification.md)
records the completed database/endpoint tests and the outstanding browser, Google
consent and real-mail launch checks. Ordering is controlled separately from schema
activation and deployment, and remains off until enabled by the administrator.
