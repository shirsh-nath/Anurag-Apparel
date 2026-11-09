# Database scripts

All SQL lives here. Application Edge Functions remain in `supabase/functions/`.
SQL files are excluded from website deployment and the local asset server.

| File | Purpose | Connected Supabase status, checked 9 November 2026 |
| --- | --- | --- |
| `supabase-schema.sql` | Historical base schema for fresh installations | Existing database already provisioned; do not rerun the whole historical script to add commerce |
| `commerce-schema.sql` | Additive commerce tables, inventory, settings, order operations and admin sessions | Applied, including verified rules and email snapshots |
| `commerce-maintenance.sql` | Order maintenance, daily analytics cleanup and daily review refresh | Applied; all three jobs active; maintenance worker HTTP 200 |
| `commerce-security.sql` | Activate staff permissions and optional password-change boundary | Applied; existing administrator credential retained |
| `tests/customer-profiles.sql` | Customer-profile isolation checks | Rollback-only validation script |
| `tests/commerce.sql` | Checkout, stock, slots, delivery codes, outbox and retention checks | Passed with fixtures rolled back |
| `tests/commerce-security.sql` | Staff-session and permission checks | Passed with activation and fixtures rolled back |

Ordering remains off while inventory and delivery settings are prepared. The
frontend and updated legacy Edge Functions are deployed through `main`, and
security activation is complete. The existing admin password is unchanged.
Future installs must coordinate the secure frontend and schema activation;
optional password changes revoke existing sessions.

Moving these files does not change or rerun anything in Supabase. See the
[rollout guide](../docs/online-orders.md#installation-and-coordinated-rollout) and
[verification record](../docs/commerce-verification.md).
