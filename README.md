# Anurag Apparel

Static storefront and admin portal for Anurag Apparel, built with HTML5, Tailwind CSS CDN, Vanilla JavaScript, and the Supabase JS SDK.

Product media is stored as public Supabase Storage URLs in the existing `products.gallery_images` array. The column name is kept for compatibility, but the UI supports both images and videos.

## Setup

1. Run `supabase-schema.sql` in the Supabase SQL editor.
2. Create or confirm the public Supabase Storage bucket named `product-images`.
3. Add your browser credentials to `supabase-browser-config.js`:

```js
window.ANURAG_SUPABASE_URL = "https://your-project.supabase.co";
window.ANURAG_SUPABASE_ANON_KEY = "your-anon-key";
```

4. You can keep the same values in `.env` for local reference:

```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
```

The browser pages load `supabase-browser-config.js` first and then fall back to `/.env`. On hosts that block dotfiles, the browser config file is the reliable option.

```html
<script>
  window.ANURAG_SUPABASE_URL = "https://your-project.supabase.co";
  window.ANURAG_SUPABASE_ANON_KEY = "your-anon-key";
</script>
```

## Admin Route

Netlify uses `_redirects`, and Vercel uses `vercel.json`, so `/admin` will serve `admin.html` on either platform. On other static hosts, add an equivalent rewrite from `/admin` and `/admin/*` to `/admin.html`.

## Security Note

The requested hardcoded admin username/password hides the dashboard UI only. A production admin portal should use Supabase Auth, stricter RLS policies, and server-side write authorization.
