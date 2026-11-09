# Online orders

The online-ordering implementation is on `feature/online-order-commerce`. A branch
push does not merge into `main` or deploy its frontend to the production domain.
The customer Google sign-in configuration is described in
[customer-accounts.md](customer-accounts.md).

As checked on 9 November 2026, the additive commerce schema and new `commerce`
Edge Function are installed on the connected project. Server keys and the
five-minute maintenance job are configured; a maintenance request returned HTTP
200. The coordinated legacy security activation is **not** applied, and the
production frontend is unchanged. `sealed`, `admin_password_ready` and effective
`allow_orders` remain false. See [the verification record](commerce-verification.md)
for what was tested and which browser checks still block launch.

## What the feature provides

- A cart, product choices, server-priced checkout and cash on delivery. Checkout
  requires a Google account, completed contact profile, recipient phone, full
  address, six-digit PIN code and map coordinates. GPS is optional; a customer can
  choose the point on the map or enter coordinates.
- My orders with active/past filters, status history, delivery slot and an explicit
  customer-only action to reveal a required delivery code.
- `/orders` (`orders.html`), linked from the admin menu, with Orders, Customers,
  Delivery, Stock & options, and Settings tabs. The customer list includes Google
  registrations which have not yet completed a contact profile.
- Cancellation with a reason, safe stock restoration, staff slot changes and a
  delivery desk showing customer pins and submitted addresses. Staff location is
  requested only on demand and is not saved in an order.
- Personal booking, delivery and cancellation emails via Resend, with editable
  plain-text subjects/messages and sample previews. Account creation does not
  subscribe a customer to marketing.

Ordering starts **off**. Every existing product starts with zero available stock
until stock is entered. The catalogue remains usable, and disabled ordering shows
Visit Store. Turning ordering off stops new quotes/bookings; staff can still
manage existing orders. Public settings are refreshed periodically, and the server
checks the current rules on every booking.

## Data and authorization

`sql/commerce-schema.sql` is the additive commerce schema. It adds inventory
columns to products, a settings row, orders, line items and status events. An order
keeps a snapshot of its prices, contact/address details, delivery slot and whether
its delivery code is required. Later catalogue edits do not rewrite past orders.
Available product stock is shared across its listed size and colour choices; this
is not a separate stock ledger for every variant.

Customers can select only their own visible orders, items and events through RLS.
They cannot create or mutate these rows directly. The `commerce` Edge Function
validates the customer's bearer token with Supabase Auth and derives the customer
UUID from that identity. Browser-supplied customer IDs, prices and status values
do not confer authority. Quotes and bookings check the stored product prices,
options, availability, address/area rules, capacity and limits in PostgreSQL.
Booking reserves stock atomically. Repeating the same checkout request with its
idempotency key returns the original order instead of booking a second one.

Staff use the store admin login to obtain an opaque eight-hour session. Only its
digest is stored in the private schema. The branch's admin clients send the token
in `x-admin-session`; a browser boolean and customer-editable Google metadata do
not grant staff permissions. Five failed admin logins trigger a 15-minute lock.
Changing the administrator password revokes existing sessions. Catalogue/media,
campaign and analytics protections are activated by the separate
`sql/commerce-security.sql` rollout.

### Delivery acceptance code

The setting is copied to each new order. Changing it never disables verification
for an existing protected order. The customer reveals their four-digit code from
My orders and supplies it to staff at delivery. Staff must mark the order out for
delivery, confirm cash collection and submit the correct code to finish it. A
generic status update cannot mark an order delivered. Five wrong code attempts
lock verification for 15 minutes. Protected code records are removed when delivery
finishes or the order is cancelled.

The database stores authenticated ciphertext and a keyed verification digest,
never the plaintext code. The server-only `COMMERCE_CODE_KEY` is a 32-byte
base64url master key. HKDF derives separate AES-GCM and HMAC keys bound to the order
and customer identifiers. Do not store this key in PostgreSQL, Vault, browser
configuration, emails or logs. The code reveal route requires the owning customer;
the staff API has no reveal action. Templates cannot insert codes.

A project owner who controls server code and keys can change these controls or
recover ciphertext. The protection is against normal database inspection and
admin use; it is not a guarantee against the owner of the infrastructure. Keep a
secure backup of the key. Replacing or losing it while protected orders are active
makes their existing codes unusable; key migration requires a deliberate server
change, not an ordinary settings edit.

## Order settings

The Settings tab controls ordering, limits, delivery fee and minimum order value,
delivery area, schedule, code requirement, retention and all three email templates.
Settings are checked on the server before saving.

| Setting | Initial value / meaning |
| --- | --- |
| Allow online orders | Off, also blocked until the security rollout and administrator password review are complete |
| Maximum new orders/day | 50, counted by booking date in the configured business time zone |
| Maximum items/order | 20 cart lines |
| Maximum quantity/product choice | 10 for the same product, size and colour, including repeated cart lines |
| Time zone | `Asia/Kolkata` |
| Delivery times | `11:00`, `17:00`; the list determines daily frequency |
| Default upcoming slot | 2: skip the first upcoming scheduled slot, then use the first slot with capacity |
| Slot duration | 120 minutes |
| Slot capacity | 25 non-cancelled bookings per slot, including ones already delivered |
| Delivery fee / minimum order | ₹0 / ₹0 |
| Delivery radius | 0 disables this restriction; check store coordinates before enabling a radius |
| Serviceable PIN codes | Empty: no PIN restriction; if configured, both PIN and radius rules must pass |
| Delivery code | Required for new orders |
| Automatic history retention | Off |
| Customer / admin history | 180 / 365 days after delivery or cancellation, when retention is on |

Cancellation does not reopen that day's booking limit; it restores reserved
stock and frees the delivery slot. A manually deleted terminal order no longer
contributes to booking counts. Schedule edits do not move existing orders. Staff
can select another valid future configured slot on an active order; capacity is
checked again. Slot search covers the next 60 days. Customer names, phone numbers
and map positions are supplied by customers; the phone and map point are not
independently verified.

### History and permanent deletion

The customer and admin periods start at `terminal_at`, when the order is delivered
or cancelled. With automatic retention enabled, each audience loses access when
its own period expires. The canonical shared order remains until **both** periods
have expired, then maintenance physically deletes its rows from the application
database. `0` means no expiry for that audience and prevents automatic permanent
deletion indefinitely. Disabling automatic retention disables both expiry rules.
Active orders are never automatically purged.

Changing the periods applies to existing terminal orders; shortening or enabling
retention can immediately hide old history and make it eligible for deletion at
the next maintenance run. Until permanent deletion, increasing a period may make
previously hidden records visible again. Once purged, that record cannot be
restored through the application.

Staff can manually permanently delete only delivered/cancelled orders after a
confirmation. This removes the shared order for both audiences and cascades to
line items, events, encrypted code records and email-outbox rows. It does not
delete the customer's Google identity or contact profile. Supabase backups and
provider logs have separate retention; neither this action nor the scheduled purge
recalls emails already delivered to Resend or a recipient's inbox.

### Transactional email

The outbox records one booking, delivery or cancellation notification for an order
and snapshots that event's template, order details, time zone and store contacts.
Later slot, contact and template edits do not change an already queued message,
so retries reuse the same content and event identity. Messages are personalized
with these fields:

```text
{{customer_name}} {{order_number}} {{order_total}} {{order_url}}
{{delivery_slot}} {{address}} {{order_items}} {{cancel_reason}}
{{store_name}} {{store_email}} {{store_phone}}
```

Subjects are single-line, messages are plain text and email HTML is escaped. The
order URL opens My orders and requires the correct customer sign-in. Delivery
codes have no template field and never enter order emails. Store contact fields
come from site settings. The verified email recorded at booking is the recipient.

The Edge Function attempts pending messages after order events. Maintenance
retries queued failures with leases and backoff. Resend requests reuse an event
idempotency key. Automatic attempts stop after five attempts or 23 hours, before
Resend's 24-hour deduplication window ends. A failed event may be retried from the
admin order screen only within that window. A provider accepting a message is not
a guarantee that the recipient read or received it; inspect Resend delivery logs
when investigating mail problems. Booking is not rolled back because mail fails.

## Installation and coordinated rollout

Do not run the entire historical base schema against an existing live database
just to add orders. Preserve existing records and take a database backup before a
production rollout.

1. For a fresh project, install `sql/supabase-schema.sql` and the customer-profile
   section described in the account guide. The base schema no longer creates a
   published/default administrator credential. Bootstrap `private.admin_credentials`
   privately using id `dashboard`, your chosen username and a unique bcrypt hash
   generated with `extensions.crypt`/`extensions.gen_salt('bf')`. Never put the
   plaintext password in tracked SQL or documentation. Existing installations keep
   their current credential; the historically published seed is rejected by the
   commerce login and must be changed privately before using it.
2. Apply `sql/commerce-schema.sql`. This is additive and idempotent. Effective
   ordering remains sealed/off, so it can coexist with the current production
   catalogue. Do not set private readiness flags by hand to bypass activation.
3. Enable `pg_cron`, `pg_net` and Vault for maintenance. Save `SUPABASE_URL` and
   your setup-only `SUPABASE_ACCESS_TOKEN` in the ignored local `.env`. Save
   `RESEND_API_KEY` and a verified `RESEND_FROM_EMAIL` sender there if they are not
   already configured on the project. From the repository root, run:

   ```sh
   node scripts/configure-commerce.mjs --secrets --schedule-config
   ```

   The helper generates independent random 32-byte base64url `COMMERCE_CODE_KEY`
   and `COMMERCE_MAINTENANCE_KEY` values only if absent, saves new values in the
   ignored `.env`, and verifies their remote digests without printing secrets.
   It refuses to overwrite a different existing remote key or replace a remote
   key missing locally: recover the original private backup instead. It adds
   Resend secrets only when absent. The script does not deploy functions or
   activate ordering. Supabase supplies its project URL and service credentials
   to the Edge Function. Optional `COMMERCE_ALLOWED_ORIGINS` is a comma-separated
   list of exact preview origins; production apex/www and local port 5500 are
   already allowed. Do not expose secrets through `/api/config`.
4. Deploy the new `commerce` Edge Function with JWT gateway verification disabled
   **because its handler performs explicit customer, admin or maintenance
   authentication per action**. Only public settings are intentionally anonymous.
   Include both `index.ts` and `domain.mjs`.
5. Apply `sql/commerce-maintenance.sql`. The helper's `--schedule-config`
   step stores `commerce_maintenance_key` and `commerce_project_url` in Vault;
   the SQL schedules named job `anurag-commerce-maintenance` at `*/5 * * * *`.
   It uses `net.http_post` with JSON `{"action":"maintenance"}` and the scoped
   maintenance header. Do not store the code encryption key in Vault. Check both
   `cron.job_run_details` and `net._http_response`: a successful cron SQL statement
   only means a request was queued, while the HTTP result confirms the handler
   ran. Avoid selecting/logging request authorization headers.
6. Coordinate deployment of this branch's frontend/API routes and updated legacy
   `send-email` and `sync-google-reviews` Edge Functions with applying
   `sql/commerce-security.sql`. That SQL removes the legacy anonymous write
   boundary and public purge/password-verifier access, and authorizes the new
   opaque staff session on every request. Old admin clients cease working after
   activation. The new Vercel analytics purge needs `SUPABASE_SERVICE_ROLE_KEY`
   and `CRON_SECRET`; review cron needs the matching `CRON_SECRET` in Vercel and
   Supabase. No automatic production merge is required for branch review.
7. Sign in with the new admin UI, change the password through the Security menu
   to a unique password of at least 12 characters and at most 72 UTF-8 bytes, then
   sign in again. The byte limit prevents bcrypt from silently ignoring a suffix;
   multibyte characters consume more than one byte. This marks the administrator
   password review complete and revokes the old session.
8. Configure stock, size/colour choices, store coordinates, delivery area, slots,
   fees, limits and email copy. Confirm the store can deliver to every enabled
   area. Keep automatic deletion off until the chosen periods are understood.
9. Complete the checks below. Enable Allow online orders only after the security
   readiness notice clears and real-account checkout/delivery checks succeed.

Keep the setup access token local and ignored. It is an administration credential,
not an application dependency. `.env.example` lists names without values. Use
`npm run dev` rather than serving the repository root with a generic static server.

## Verification

```sh
npm run check
npm test
```

Run `sql/tests/commerce.sql` in Supabase to exercise stock, quote/booking, idempotency,
slot/capacity, transitions, code attempts, owner isolation and retention rules.
Its synthetic fixtures are wrapped in a transaction and rolled back. Run
`sql/tests/commerce-security.sql` after activation, or together with the security SQL
inside one rollback-only validation transaction. Never remove the fixture rollback
to test against live customer records.

Before launch, verify in a browser using two real test accounts: Google consent
and profile completion; cart choices and COD checkout; price/slot change recovery;
reload/retry without duplicate booking; private order history and code reveal;
customer A unable to access B's order; staff cancellation/stock restoration;
rescheduling; map location permission denied/manual fallback; incorrect-code lock;
correct-code delivery and cash confirmation; all three emails; ordering-off
fallback; mobile and keyboard navigation; and cleared private screens on logout.
Check maintenance delivery and retention on disposable fixtures rather than
shortening production customer history for a test.

The branch's automated tests use mocks/rolled-back database fixtures. A passing
test suite does not substitute for real Google consent, live mail delivery or
visual/browser verification. Recorded results and outstanding launch checks are
in [commerce-verification.md](commerce-verification.md).
