# Anurag Apparel

Static storefront and admin portal for Anurag Apparel, built with HTML5, Tailwind CSS CDN, Vanilla JavaScript, and the Supabase JS SDK.

Product media is stored as public Supabase Storage URLs in the existing `products.gallery_images` array. The column name is kept for compatibility, but the UI supports both images and videos.

Product subcategories are powered by `public.product_subcategories`; products can reference them through `products.subcategory_id`. The storefront shows active subcategories as a horizontal slider above the product cards, and `admin.html` can create, archive, delete, and assign them.

The homepage announcement/offers board is powered by `public.site_announcements` and can be edited from `admin.html`.
The storefront call button is powered by `public.site_settings.phone_number` and can be edited from `admin.html`.
The available brands strip is powered by `public.brands`; transparent logo images are uploaded from `admin.html` and stored in the `product-images` bucket under `brands/`.
The email campaign dashboard is `email_resend.html`. Brand logos are selected from `public.brands`, reusable campaign images are stored in `public.email_campaign_images`, and new campaign image files are uploaded to the public `product-images` bucket under `campaigns/`. Sending calls the Supabase Edge Function at `supabase/functions/send-email` to deliver branded Resend emails.

Traffic monitoring is available at `analytics.html` and from the Admin Menu. Storefront visits and engagement events are stored in `public.website_analytics_events`; run the latest `supabase-schema.sql` before expecting live analytics data.

The admin password is verified through Supabase RPC functions created by `supabase-schema.sql`; use the Security panel in `admin.html` to change it.

## Setup

1. Run `supabase-schema.sql` in the Supabase SQL editor.
2. Create or confirm the public Supabase Storage bucket named `product-images`.
3. Add your browser credentials to `supabase-browser-config.js`:

```js
window.ANURAG_SUPABASE_URL = "https://your-project.supabase.co";
window.ANURAG_SUPABASE_ANON_KEY = "your-anon-key";
window.ANURAG_MAX_VIDEO_MB = 50;
```

4. You can keep the same values in `.env` for local reference:

```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
RESEND_API_KEY=your_resend_api_key
RESEND_FROM_EMAIL=hello@your-domain.com
```

The browser pages load `supabase-browser-config.js` first and then fall back to `/.env`. On hosts that block dotfiles, the browser config file is the reliable option.

Supabase Free projects cannot upload files larger than 50 MB. If you upgrade and raise the Storage file-size limit, update `window.ANURAG_MAX_VIDEO_MB` to match.

```html
<script>
  window.ANURAG_SUPABASE_URL = "https://your-project.supabase.co";
  window.ANURAG_SUPABASE_ANON_KEY = "your-anon-key";
  window.ANURAG_MAX_VIDEO_MB = 50;
</script>
```

## Email Campaigns

Campaign sending uses Supabase Edge Functions as a server-side Resend proxy so the Resend API key never enters the browser. The send form supports:

- Brand Logo: selected from existing brand logos in `public.brands`.
- Campaign Image: selected from saved `public.email_campaign_images`, with upload, rename, and remove controls in the send form.
- Subject and message body: converted into a professional HTML email by the Edge Function.

Required Supabase Edge Function secrets:

```env
RESEND_API_KEY=your_resend_api_key
RESEND_FROM_EMAIL=hello@your-domain.com
```

Optional legacy secret:

```env
RESEND_CAMPAIGN_TO=hello@your-domain.com
```

Campaign emails are sent through Resend's batch endpoint, so every customer receives an individual email addressed only to them. `RESEND_CAMPAIGN_TO` is no longer used as the visible recipient; if it exists, that address is filtered out along with `RESEND_FROM_EMAIL` so store/admin inboxes do not receive customer campaigns by accident.

Set production secrets from the local `.env` file:

```bash
supabase secrets set --env-file .env
```

Deploy the function after editing it:

```bash
supabase functions deploy send-email
```

For local testing, serve the function with the same secrets:

```bash
supabase functions serve send-email --env-file .env
```

## Admin Route

Netlify uses `_redirects`, and Vercel uses `vercel.json`, so `/admin` will serve `admin.html` on either platform. On other static hosts, add an equivalent rewrite from `/admin` and `/admin/*` to `/admin.html`.

## Security Note

The admin password is no longer hardcoded in the browser, but this is still a static admin portal using the anon key for product writes. A production admin portal should use Supabase Auth, stricter RLS policies, and server-side write authorization.
