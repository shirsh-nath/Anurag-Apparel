# Commerce verification record

Checkpoint: 9 November 2026, `feature/online-order-commerce`.

## Completed

- `npm test`: 79 tests passed, none failed/skipped. Coverage includes customer
  account behavior, cart/request validation, checkout retries, cryptography,
  endpoint authentication, templates/settings, admin sessions and delayed-response
  isolation after logout. These runtime tests use mocks, not real purchases.
- `npm run check`: syntax verified for 34 scripts.
- The additive commerce schema was applied on the connected Supabase project.
  Live PostgreSQL commerce tests passed with synthetic fixtures rolled back.
  Security activation and its tests also passed inside one rollback-only
  transaction; the activation changes were not left applied.
- Outbox tests cover leases, stale acknowledgments, bounded retries, retry-window
  expiry and event snapshots that stay identical after later slot/contact edits.
  Email status and retry availability appear only in admin order responses.
- The new `commerce` Edge Function was deployed (version 2). Live endpoint checks passed for
  public settings, customer/admin authentication rejection and allowed/disallowed
  CORS behavior. Server-only keys were configured without exposing their values.
- Vault contains the scoped maintenance key and project URL, never the delivery
  encryption key. Named cron job `anurag-commerce-maintenance` is active every
  five minutes. A `pg_net` maintenance request completed with HTTP 200.
- Public privacy/terms contents anchors and footer routes were checked.

## Activation state

The branch has not been merged into `main`, and its frontend has not replaced the
production storefront. `sql/commerce-security.sql` and the coordinated legacy Edge
Function/frontend cutover remain unapplied. The security state is unsealed,
administrator password readiness is false and ordering is effectively off. Do not
enable ordering by changing private flags directly.

The production cutover must deploy the branch's secure staff clients and updated
`send-email`/`sync-google-reviews` functions, apply the security SQL, then change the
administrator password and sign in again. Use at least 12 characters and no more
than 72 UTF-8 bytes. Configure real stock, area, slots, fees and notifications
before allowing bookings. Follow [the rollout guide](online-orders.md#installation-and-coordinated-rollout).

## Advisor interpretation

Private commerce tables intentionally have RLS enabled with no public policies;
deny-all/no-policy advisor notices reflect that design. The small public admin
login/logout/session functions are intentional security-definer entry points;
privileged order RPCs remain service-only. Existing legacy public analytics-purge
permissions are held until the coordinated security activation removes them; the
additive install is not the completed security cutover. The Auth leaked-password
warning also remains; customer authentication uses Google OAuth rather than
customer passwords. Re-run advisors after activation to assess the final state.

## Still required before launch

The browser automation host/native pipe was unavailable during this run. No
visual/browser QA, live Google consent-to-checkout flow or real transactional-email
delivery test was completed. Passing mocks and SQL tests do not establish that
those experiences are ready for customers.

Use the [browser launch checklist](online-orders.md#verification) to test two
customer accounts, mobile/keyboard dialogs, manual/GPS map selection, checkout and
retry recovery, cross-account privacy, staff cancellation/rescheduling, code lock
and successful delivery, emails, ordering off, and private-screen cleanup on
logout. Inspect the actual Resend delivery result. Use disposable fixtures for
retention checks; do not shorten real history merely to test deletion.
