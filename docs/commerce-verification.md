# Commerce verification record

Checkpoint: 9 November 2026, production cutover from `feature/online-order-commerce`
to `main`. Runtime code was published in commit `23e875f`.

## Completed

- All 82 automated tests passed, with no failures or skipped tests. Syntax checks
  passed for 34 scripts. Tests cover accounts, customer isolation, cart/checkout,
  delivery-code cryptography, endpoint authorization, settings and session races.
- The commerce schema and security activation are applied on the connected
  Supabase project. Both SQL suites passed against the activated database with
  synthetic fixtures and password edits rolled back.
- `sealed` and `admin_password_ready` are true. Activation accepts the configured
  administrator credential; its stored password was not changed or reset.
  Ordering remains explicitly off (`allow_orders=false`).
- `main` was pushed through the existing Git/Vercel integration. Production
  `orders.html`, `orders-admin.js`, `admin-session.js` and `index.html` matched
  repository code. Both apex and www `/orders` routes returned the admin console.
  `/api/config` returned only allowlisted public configuration.
- The local orders-page configuration error was fixed by loading the same ignored
  public browser configuration used by the other pages, before the admin module.
  Its public URL/key match the saved local project configuration.
- Live admin login using the existing credential succeeded. Admin orders,
  customers, inventory and settings endpoints succeeded. Anonymous contact reads
  were empty, and the old public password-verification RPC was denied.
- Signed media authorization, a disposable PNG upload and its removal succeeded.
  The temporary verification session was revoked, and no product was modified.
- `commerce` version 2, `send-email` version 13 and `sync-google-reviews` version 4
  are deployed. Campaign authentication rejected missing sessions and accepted a
  valid session through input validation; no campaign or order email was sent.
- All three Supabase jobs are active: order maintenance every five minutes,
  analytics cleanup at `20:30` UTC daily, and review refresh at `21:45` UTC daily.
  Vercel cron entries were removed to avoid duplicate schedules. A maintenance
  worker returned HTTP 200; scheduled review provider execution has not yet been
  observed after this cutover.
- Live `.env`, credential, SQL and Edge Function source paths returned 404.
  Local secrets remain ignored. The encryption key is in Edge secrets/local
  private backup only; Vault contains the separate scoped maintenance key.
- Outbox tests passed for leases, stale acknowledgments, bounded retries, retry
  expiry and immutable event snapshots. Admin email-status metadata is excluded
  from customer responses. No real orders were placed by verification.

## Advisor interpretation

Private commerce tables intentionally use deny-all RLS without public policies.
The public admin login/logout/session/password-change functions are intentional
security-definer entry points with credential/token checks. Privileged order RPCs
remain service-only, and public analytics-purge permission is revoked. See the
[security-definer advisor](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).
The existing [Auth leaked-password warning](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
remains; customer authentication uses Google OAuth rather than customer passwords.

## Before enabling customer bookings

Configure real inventory, delivery area, slots, fees, limits and email copy in
Settings. Automatic order deletion remains separately controlled by retention
settings. No forced admin password change is required.

The browser automation host/native pipe was unavailable. Visual/mobile QA, a
live Google consent-to-checkout flow and real transactional-email delivery remain
manual checks. Use the [launch checklist](online-orders.md#verification) with two
customer test accounts before enabling Allow online orders. Passing API, SQL and
mock tests does not replace those checks.
