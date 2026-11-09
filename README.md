# Anurag Apparel

Static storefront and staff portal using HTML, vanilla JavaScript, Tailwind CDN,
Supabase Auth/PostgreSQL/Storage/Edge Functions, and Resend. The catalogue supports
product images/videos, categories, brands, announcements, reviews and store contact
settings. Google sign-in identifies customers and stores their private contact
profiles.

`feature/online-order-commerce` adds a cart, cash-on-delivery checkout, customer
order history and an admin Orders & Customers console. Ordering starts off and
remains blocked until the coordinated security activation and administrator
password review are complete. A branch push does not merge or publish the frontend
to `main`. Read [the order setup and rollout guide](docs/online-orders.md) before
enabling orders on a shared production database.

## Local development

```sh
npm run dev
npm run check
npm test
```

Open `http://localhost:5500`. The development server reads ignored `.env` values
privately and exposes only the public Supabase URL/key at `/api/config`. Copy
`.env.example` for variable names. Do not serve the repository root with a generic
static server while local secrets exist.

Public browser configuration comes from `public-config.js`, `/api/config`, or an
ignored `supabase-browser-config.js`. Only the project URL, public anon/publishable
key and media limit belong in the browser. Google client secrets, Supabase service
credentials, access tokens, Resend/Apify keys and commerce keys stay on the server.

## Pages

| URL | Purpose |
| --- | --- |
| `/` | Catalogue, Google account, cart, checkout and My orders |
| `/admin` | Catalogue/media, store settings, reviews, password and admin menu |
| `/orders` | Staff orders, customers, delivery map, stock and commerce settings |
| `/analytics` | Staff traffic monitoring |
| `/email` | Staff marketing campaigns |
| `/privacy`, `/terms` | Public customer information, also linked beside Google sign-in |

Clean URLs are mapped by `vercel.json`, `_redirects` and the local development
server. Product media uses public URLs from the `product-images` bucket; the
existing `products.gallery_images` column supports both images and videos.

## Database and server functions

All SQL is grouped in [`sql/`](sql/README.md), with rollback-only validation
scripts in `sql/tests/`. That folder also records which scripts are already
applied on the connected Supabase project.

- `sql/supabase-schema.sql`: original catalogue, staff credential, marketing,
  analytics, reviews and customer-profile schema. Existing live installations
  should apply only the relevant additions, not rerun the historical permissions.
  No shared administrator password is seeded for a new project.
- `sql/commerce-schema.sql`: additive order/inventory schema and private
  business operations; customer reads use owner RLS and mutations use the server.
- `sql/commerce-security.sql`: coordinated activation of opaque staff
  sessions, restricted catalogue writes, signed media uploads and private customer,
  campaign and analytics data. It deliberately replaces the legacy admin boundary.
- `supabase/functions/commerce`: authenticated quotes, bookings, order operations,
  encrypted delivery-code reveal/verification, transactional email outbox and
  maintenance.
- `supabase/functions/send-email`: staff-authorized Resend marketing campaigns.
  Registration never adds a customer to marketing automatically.
- `supabase/functions/sync-google-reviews`: staff/cron-authorized Apify review
  refresh. The Vercel API route forwards staff sessions or the verified cron secret.
- `api/purge-analytics.js`: authorized daily analytics cleanup, requiring both
  `CRON_SECRET` and a server-side `SUPABASE_SERVICE_ROLE_KEY` in Vercel.

See [PROJECT.md](PROJECT.md) for the implementation map,
[customer-accounts.md](docs/customer-accounts.md) for Google OAuth configuration,
and [online-orders.md](docs/online-orders.md) for secrets, scheduling, settings,
retention, delivery-code limits and launch verification. The setup helper is
`node scripts/configure-commerce.mjs --secrets --schedule-config`; the guide
explains its prerequisites and refusal to replace existing keys. Recorded results
and outstanding browser checks are in [commerce-verification.md](docs/commerce-verification.md).
SQL test fixtures in `tests/` are transactional and roll back.
