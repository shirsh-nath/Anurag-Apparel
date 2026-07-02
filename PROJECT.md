# 📦 Anurag Apparel — Project Documentation

> **Last updated:** 2026-07-02
> **Status:** Production  
> **Live domain:** `anuragapparel.in`  
> **Location:** Hazaribagh, Jharkhand, India

---

## 📖 Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Environment Variables](#environment-variables)
5. [Database Schema (Supabase PostgreSQL)](#database-schema-supabase-postgresql)
   - [Extensions & Schemas](#extensions--schemas)
   - [Tables](#tables)
   - [RPC Functions](#rpc-functions)
   - [RLS Policies](#rls-policies)
   - [Triggers](#triggers)
   - [Storage Buckets](#storage-buckets)
   - [Seed Data](#seed-data)
   - [Scheduled Tasks](#scheduled-tasks)
6. [Frontend Pages](#frontend-pages)
   - [index.html — Public Storefront](#indexhtml--public-storefront)
   - [admin.html — Admin Portal](#adminhtml--admin-portal)
   - [analytics.html — Traffic Analytics Dashboard](#analyticshtml--traffic-analytics-dashboard)
   - [email_resend.html — Email Campaign Dashboard](#email_resendhtml--email-campaign-dashboard)
7. [Backend / API (Vercel Serverless)](#backend--api-vercel-serverless)
8. [Edge Functions](#edge-functions)
9. [Direct Apify Review Sync](#direct-apify-review-sync)
10. [Deployment Configuration](#deployment-configuration)
11. [Images & Assets](#images--assets)
12. [Design System](#design-system)
13. [Architecture Decisions & Patterns](#architecture-decisions--patterns)
14. [Changelog](#changelog)

---

## Overview

**Anurag Apparel** is a full-featured static storefront and admin portal for a premium clothing store. It functions as a product catalog (not a transactional e-commerce store) with:

- **Public storefront** — showcasing products, brands, announcements, and offers
- **Admin dashboard** — managing products, categories, brands, announcements, settings, and campaign images
- **Analytics dashboard** — anonymous traffic & engagement tracking
- **Email campaign tool** — sending branded marketing emails to customer groups via Resend
- **Google reviews section** - automatically syncs Google Maps reviews through a serverless Apify API route and displays admin-curated reviews on the homepage

---

## Tech Stack

| Layer               | Technology                                                        |
| ------------------- | ----------------------------------------------------------------- |
| **Frontend**        | HTML5, Tailwind CSS (CDN), Vanilla JavaScript (no framework)      |
| **Database / BaaS** | Supabase (PostgreSQL, Storage, Edge Functions, RPC)               |
| **Email Service**   | Resend (via Supabase Edge Function proxy)                         |
| **Edge Functions**  | Deno (Supabase Edge Functions)                                    |
| **Automation**      | Vercel Serverless API + Apify Google Maps Reviews Scraper         |
| **Deployment**      | Vercel (primary) + Netlify (secondary; `_redirects` file)         |
| **File Uploads**    | Supabase Storage (`product-images` bucket), tus-js-client (resumable) |

---

## Project Structure

```
d:\Stores\Anurag Apparel\
├── .env                              # Environment variables (gitignored)
├── .gitignore                        # Ignores .env, credential.txt, supabase-browser-config.js
├── credential.txt                    # Local Apify/Supabase handoff file (gitignored; never commit)
├── _redirects                        # Netlify URL rewrites
├── vercel.json                       # Vercel rewrites + cron job config
├── supabase-browser-config.js        # Browser-side Supabase credentials (gitignored)
├── supabase-schema.sql               # Complete DB schema (~600 lines, ~35KB)
├── index.html                        # Public storefront (~3206 lines, ~110KB)
├── admin.html                        # Admin portal (~2888 lines, ~117KB)
├── analytics.html                    # Traffic analytics dashboard (~881 lines, ~36KB)
├── email_resend.html                 # Email campaign dashboard (~1498 lines, ~63KB)
├── README.md                         # Original project README
├── PROJECT.md                        # ⬅ THIS FILE — living project documentation
├── api/
│   ├── config.js                     # Vercel serverless: serves Supabase config from env vars
│   ├── purge-analytics.js            # Vercel cron: purges analytics events > 90 days
│   └── sync-google-reviews.js        # Vercel serverless / cron: invokes Supabase review sync
│
├── supabase/
│   └── functions/
│       ├── sync-google-reviews/
│       │   └── index.ts              # Deno Edge Function: Apify scraper + Supabase review replacement
│       └── send-email/
│           └── index.ts              # Deno Edge Function: email sender via Resend (~336 lines)
│
└── Images/
    ├── Admin Background.jpg          # Auth screen background
    ├── Anurag Apparel Logo.png       # Original logo
    ├── Background.jpeg               # Hero section background
    ├── Levis.jpeg                    # Levi's banner
    ├── New Logo.png                  # Updated logo
    ├── Rear_View.jpeg                # Store rear view photo
    ├── With Background.png           # Logo with background
    ├── With Background New.png       # Updated logo with background
    ├── Brand Logos/                   # Brand logo PNGs (AA, Jack&Jones, Jockey, Lee, Levis, etc.)
    ├── QRs/                          # QR codes (Google Maps, Website URL)
    └── References/
        └── References.txt            # Unsplash background image attributions
```

---

## Environment Variables

### `.env` file (gitignored)

| Variable              | Purpose                            |
| --------------------- | ---------------------------------- |
| `SUPABASE_URL`        | Supabase project URL               |
| `SUPABASE_ANON_KEY`   | Supabase anonymous (public) key    |
| `RESEND_API_KEY`      | Resend email service API key       |
| `RESEND_FROM_EMAIL`   | Sender email address               |

### `credential.txt` file (gitignored)

Local handoff file for local credentials configuration. It contains the Apify API token plus the Supabase URL/anon key. Do not commit this file or paste its secret values into documentation.

### Additional Vercel env vars

| Variable                    | Used By                                  | Purpose                                          |
| --------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `SUPABASE_URL`              | `config.js`, API routes                  | Supabase project URL                             |
| `SUPABASE_ANON_KEY`         | `config.js`, `sync-google-reviews.js`    | Public key used to invoke Supabase Edge Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | `purge-analytics.js`                     | Service role key for analytics purge fallback    |
| `CRON_SECRET`               | `purge-analytics.js`, `sync-google-reviews.js` | Vercel cron auth (Bearer token)             |
| `MAX_VIDEO_MB`              | `config.js`                              | Max upload size (default: 50MB)                  |

### Supabase Edge Function secrets

| Secret                       | Used By                                  | Purpose                                                            |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `APIFY_API_KEY`              | `sync-google-reviews/index.ts`           | Apify API key used to trigger the review scraper                   |
| `CRON_SECRET`                | `sync-google-reviews/index.ts`           | Optional second check for Vercel-triggered review sync             |
| `RESEND_API_KEY`             | `send-email/index.ts`                    | Resend email service API key                                       |
| `RESEND_FROM_EMAIL`          | `send-email/index.ts`                    | Sender email address                                               |
| `RESEND_CAMPAIGN_TO`         | `send-email/index.ts`                    | Legacy; filtered from recipients if set                            |

The review sync actor, Google Maps URL, and max review count are hardcoded in `supabase/functions/sync-google-reviews/index.ts`.

Supabase automatically provides `SUPABASE_URL` and service credentials (`SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEYS`) to Edge Functions, which the review sync uses to write to `public.google_reviews`.

### Browser config (`supabase-browser-config.js`, gitignored)

Exposes to `window`:
- `window.ANURAG_SUPABASE_URL`
- `window.ANURAG_SUPABASE_ANON_KEY`
- `window.ANURAG_MAX_VIDEO_MB` (default: 50)

---

## Database Schema (Supabase PostgreSQL)

> **Source of truth:** `supabase-schema.sql` (~600 lines). All statements are idempotent (safe to re-run).

### Extensions & Schemas

- **`extensions` schema** with `pgcrypto` — for bcrypt password hashing
- **`private` schema** — stores admin credentials, hidden from public API access

### Tables

#### 1. `public.product_subcategories`

| Column        | Type      | Notes                    |
| ------------- | --------- | ------------------------ |
| `id`          | uuid (PK) | Auto-generated           |
| `name`        | text      | Not null                 |
| `slug`        | text      | Unique, not null         |
| `description` | text      | Nullable                 |
| `sort_order`  | integer   | Default: 0               |
| `is_active`   | boolean   | Default: true            |
| `created_at`  | timestamptz | Auto                   |
| `updated_at`  | timestamptz | Auto via trigger       |

#### 2. `public.products`

| Column           | Type      | Notes                                           |
| ---------------- | --------- | ----------------------------------------------- |
| `id`             | uuid (PK) | Auto-generated                                  |
| `title`          | text      | Not null                                        |
| `description`    | text      | Nullable                                        |
| `price`          | numeric   | **Nullable** — null means "Price on Request"    |
| `subcategory_id` | uuid (FK) | References `product_subcategories(id)`          |
| `gallery_images` | text[]    | Array of Supabase Storage URLs (images + videos)|
| `is_active`      | boolean   | Default: true                                   |
| `created_at`     | timestamptz | Auto                                          |
| `updated_at`     | timestamptz | Auto                                          |

#### 3. `public.brands`

| Column      | Type      | Notes            |
| ----------- | --------- | ---------------- |
| `id`        | uuid (PK) | Auto-generated   |
| `name`      | text      | Not null         |
| `logo_url`  | text      | Nullable         |
| `sort_order`| integer   | Default: 0       |
| `is_active` | boolean   | Default: true    |
| `created_at`| timestamptz | Auto           |
| `updated_at`| timestamptz | Auto           |

#### 4. `public.site_announcements`

| Column         | Type      | Notes                             |
| -------------- | --------- | --------------------------------- |
| `id`           | text (PK) | Default: `'homepage'`             |
| `eyebrow`      | text      | Small text above title            |
| `title`        | text      | Announcement title                |
| `message`      | text      | Announcement body                 |
| `offer_text`   | text      | Offer/discount text               |
| `cta_label`    | text      | CTA button label                  |
| `cta_url`      | text      | CTA button URL                    |
| `offer_images` | text[]    | Array of offer image URLs         |
| `is_active`    | boolean   | Default: true                     |
| `created_at`   | timestamptz | Auto                            |
| `updated_at`   | timestamptz | Auto via trigger                |

#### 5. `public.site_settings`

| Column         | Type      | Notes                                    |
| -------------- | --------- | ---------------------------------------- |
| `id`           | text (PK) | Default: `'storefront'`                  |
| `phone_number` | text      | Validated: 7-15 digits                   |
| `email_address`| text      | Optional email address for contact button |
| `instagram_url`| text      | Optional `http(s)` URL for follow button |
| `facebook_url` | text      | Optional `http(s)` URL for follow button |
| `reviews_section_enabled` | boolean | Toggle homepage reviews section |
| `review_sort_mode` | text | One of `latest`, `highest_rated`, `featured`, `longest` |
| `review_display_limit` | integer | Number of reviews to show, constrained 1-12 |
| `created_at`   | timestamptz | Auto                                   |
| `updated_at`   | timestamptz | Auto via trigger                       |

#### 6. `public.email_contacts`

| Column        | Type      | Notes                                         |
| ------------- | --------- | --------------------------------------------- |
| `id`          | uuid (PK) | Auto-generated                                |
| `email`       | text      | **Unique**, not null                          |
| `name`        | text      | Nullable                                      |
| `group_name`  | text      | Auto-assigned group (batches of 100)          |
| `group_index` | integer   | Auto-assigned index within group              |
| `is_active`   | boolean   | Default: true                                 |
| `created_at`  | timestamptz | Auto                                        |
| `updated_at`  | timestamptz | Auto via trigger                            |

#### 7. `public.email_campaign_images`

| Column         | Type      | Notes                                     |
| -------------- | --------- | ----------------------------------------- |
| `id`           | uuid (PK) | Auto-generated                            |
| `name`         | text      | Not null                                  |
| `image_url`    | text      | Not null                                  |
| `storage_path` | text      | **Unique**, must match `campaigns/*`      |
| `created_at`   | timestamptz | Auto                                    |

#### 8. `public.website_analytics_events`

| Column             | Type      | Notes                          |
| ------------------ | --------- | ------------------------------ |
| `id`               | uuid (PK) | Auto-generated                 |
| `event_name`       | text      | Not null                       |
| `page_path`        | text      | Nullable                       |
| `page_title`       | text      | Nullable                       |
| `visitor_id`       | text      | Not null (localStorage ID)     |
| `session_id`       | text      | Not null (sessionStorage ID)   |
| `referrer`         | text      | Nullable                       |
| `user_agent`       | text      | Nullable                       |
| `language`         | text      | Nullable                       |
| `timezone`         | text      | Nullable                       |
| `screen_width`     | integer   | Nullable                       |
| `screen_height`    | integer   | Nullable                       |
| `viewport_width`   | integer   | Nullable                       |
| `viewport_height`  | integer   | Nullable                       |
| `metadata`         | jsonb     | Nullable, extra event data     |
| `created_at`       | timestamptz | Auto                         |

#### 9. `public.google_reviews`

| Column                    | Type      | Notes                                      |
| ------------------------- | --------- | ------------------------------------------ |
| `id`                      | uuid (PK) | Auto-generated                             |
| `google_review_id`        | text      | Unique review id from Google/Apify         |
| `author_name`             | text      | Reviewer display name                      |
| `author_photo_url`        | text      | Optional reviewer avatar URL               |
| `rating`                  | integer   | Google star rating, constrained 1-5        |
| `review_text`             | text      | Review body                                |
| `review_url`              | text      | Optional Google review URL                 |
| `language`                | text      | Optional source language                   |
| `relative_time_description` | text    | Google relative date label                 |
| `reviewed_at`             | timestamptz | Parsed review date when available        |
| `scraped_at`              | timestamptz | Last scrape/import time                   |
| `is_active`               | boolean   | Admin visibility toggle                    |
| `is_featured`             | boolean   | Admin curation toggle                      |
| `raw`                     | jsonb     | Original normalized review payload         |
| `created_at`              | timestamptz | Auto                                     |
| `updated_at`              | timestamptz | Auto via trigger                         |

#### 10. `private.admin_credentials`

| Column          | Type      | Notes                                   |
| --------------- | --------- | --------------------------------------- |
| `id`            | text (PK) | Default: `'dashboard'`                  |
| `username`      | text      | Not null                                |
| `password_hash` | text      | Not null (bcrypt)                       |
| `created_at`    | timestamptz | Auto                                  |
| `updated_at`    | timestamptz | Auto                                  |

### RPC Functions

| Function                                     | Schema    | Purpose                                                      |
| -------------------------------------------- | --------- | ------------------------------------------------------------ |
| `private.verify_admin_login(username, pw)`   | private   | Bcrypt comparison — `security definer`                       |
| `private.change_admin_password(user, old, new)` | private | Min 8 chars enforcement — `security definer`                 |
| `public.verify_admin_login()`                | public    | Public wrapper callable by anon key                          |
| `public.change_admin_password()`             | public    | Public wrapper callable by anon key                          |
| `public.purge_old_analytics_events()`        | public    | Deletes events older than 90 days — `security definer`       |
| `public.purge_old_analytics_events_rpc()`    | public    | Public wrapper for Vercel cron                               |

### RLS Policies

- **All public tables** have RLS enabled
- Most tables grant **full CRUD to `anon` role** (intentional for static admin pattern)
- `private.admin_credentials` → **denies all direct access** (`using (false)`)
- `site_settings` → insert/update restricted to `id = 'storefront'` + phone validation
- `google_reviews` → select is open; insert/update/delete are available to the static admin/serverless sync path with field constraints and unique upsert by `google_review_id`
- `email_campaign_images` → insert/update/delete restricted to `storage_path LIKE 'campaigns/%'`
- `website_analytics_events` → insert requires non-blank `event_name`/`visitor_id`/`session_id`; select open; delete requires non-blank `visitor_id`

### Triggers

| Trigger Name                               | Table                    | Action                     |
| ------------------------------------------ | ------------------------ | -------------------------- |
| `site_announcements_updated_at`            | `site_announcements`     | Auto-set `updated_at`      |
| `site_settings_updated_at`                 | `site_settings`          | Auto-set `updated_at`      |
| `trg_email_contacts_updated_at`            | `email_contacts`         | Auto-set `updated_at`      |
| `trg_email_campaign_images_updated_at`     | `email_campaign_images`  | Auto-set `updated_at`      |
| `trg_google_reviews_updated_at`            | `google_reviews`         | Auto-set `updated_at`      |

### Storage Buckets

| Bucket            | Visibility | Usage                                                   |
| ----------------- | ---------- | ------------------------------------------------------- |
| `product-images`  | **Public** | Product gallery media, brand logos (`brands/`), campaign images (`campaigns/`) |

- Anon role can **upload, update, delete** objects in this bucket

### Seed Data

- **Admin:** username `anurag`, password `Anurag@2026` (bcrypt-hashed)
- **Announcement:** Default homepage announcement
- **Site settings:** Default `storefront` row with empty phone
- **Subcategories (6):** Shirts (10), T-Shirts (20), Jeans (30), Trousers (40), Kurtas (50), Jackets (60)

### Scheduled Tasks

| Method          | Schedule                  | What it does                                                    |
| --------------- | ------------------------- | --------------------------------------------------------------- |
| **pg_cron**     | `30 20 * * *` (02:00 IST) | Calls `purge_old_analytics_events()` (database cleanup)         |
| **Vercel Cron** | `30 20 * * *` (02:00 IST) | Calls `/api/purge-analytics` (analytics fallback)               |
| **Vercel Cron** | `45 21 * * *` (03:15 IST) | Calls `/api/sync-google-reviews` (syncs Google Reviews)         |

- **Analytics Purge:** Deletes `website_analytics_events` older than **90 days**.
- **Reviews Sync:** Scrapes and imports latest Google Reviews into the database daily.

---

## Frontend Pages

### `index.html` — Public Storefront

> ~3206 lines, ~110KB | **Route:** `/` (root)

**Sections:**
- **Header** — Brand logo, nav links (Home, Shop, About), contact buttons (Call Us from phone_number, Mail Us from email_address), "Shop" CTA
- **Social follow & contact buttons** — Instagram, Facebook, and Mail Us links in the header/footer, loaded from `site_settings`
- **Hero** — Background image with overlay, tagline, CTA buttons
- **Announcement/Offers Board** — Dynamic from `site_announcements`; offer images carousel, CTA button
- **Brands Strip** — Horizontal scrolling brand logos from `brands` table
- **Subcategory Slider** — Horizontal category chips for filtering products
- **Product Grid** — Responsive grid of product cards with gallery images/videos, price or "Price on Request"
- **Google Reviews Carousel** — Admin-controlled cards wrapped in a frosted glass card, with sideways navigation controls
- **Product Modal** — Full-screen modal with media gallery, description, subcategory badge, price

**Key JS Functions (50+):**
- **Init:** `init()`, `createSupabaseClient()`, `loadSupabaseConfig()` — 3-tier config fallback
- **Data:** `loadProducts()`, `loadSubcategories()`, `loadBrands()`, `loadSiteSettings()`, `loadAnnouncementBoard()`, `loadReviews()`
- **Render:** `renderProducts()`, `renderBrands()`, `renderCategorySlider()`, `renderAnnouncementBoard()`, `renderReviews()`, `renderCallButton()`, `renderMailButton()`
- **Reviews:** `sortReviews()`, `createReviewCard()`, `renderReviewStars()`, `scrollReviews()`
- **Modal:** `openProductModal()`, `closeProductModal()`, `renderModal()`
- **Media:** `createMediaElement()`, `isVideoUrl()`, `getGalleryImages()`
- **Analytics:** `initAnalyticsTracking()`, `trackAnalyticsEvent()`, `getVisitorId()`, `getSessionId()`
- **Utils:** `formatCurrency()` (₹ Indian Rupee), `handleTrackedOutboundClick()`

**Analytics Tracked Events:** page views, product clicks, call button clicks, direction clicks, filter usage

---

### `admin.html` — Admin Portal

> ~2888 lines, ~117KB | **Route:** `/admin`

**Auth:** Password-protected via `verify_admin_login` RPC. Session in `sessionStorage`.

**Admin Menu Panels:**
| Panel               | Features                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| **Products**        | CRUD for products (title, description, price, subcategory, gallery upload via tus-js-client) |
| **Subcategories**   | Create, edit, archive, delete, reorder subcategories                        |
| **Brands**          | Upload/manage brand logos (transparent PNG)                                 |
| **Announcement Board** | Edit homepage announcement (eyebrow, title, message, offer text, CTA, offer images) |
| **Contact Settings**| Edit store phone number                                                     |
| **Social Links**    | Edit Instagram and Facebook redirect URLs for header/footer follow buttons  |
| **Campaign Images** | Manage reusable email campaign images (upload, rename, remove)              |
| **Security**        | Change admin password                                                       |
| **Traffic Analytics**| Link to `analytics.html`                                                   |
| **Email Campaigns** | Link to `email_resend.html`                                                 |
| **Purge Analytics** | Manual trigger for deleting old analytics events                            |

**Key JS Functions (80+):**
- **Auth:** `createSupabaseClient()`, `verifyAdminLogin()`, `unlockDashboard()`, `lockDashboard()`
- **Products:** `loadProducts()`, `saveProduct()`, `deleteProduct()`, `uploadGalleryMedia()`, `removeMediaItem()`
- **Subcategories:** `loadSubcategories()`, `saveSubcategory()`, `deleteSubcategory()`, `archiveSubcategory()`
- **Brands:** `loadBrands()`, `saveBrand()`, `deleteBrand()`
- **Announcements:** `loadAnnouncementBoard()`, `saveAnnouncementBoard()` + offer image management
- **Settings:** `loadSiteSettings()`, `saveSiteSettings()`
- **Campaigns:** `loadCampaignImages()`, `renameCampaignImage()`, `removeCampaignImage()`
- **Security:** `changeAdminPassword()`
- **Analytics Purge:** `purgeAdminAnalytics()`

---

### `analytics.html` — Traffic Analytics Dashboard

> ~881 lines, ~36KB | **Route:** `/analytics`

**Auth:** Same admin login as `admin.html`

**Features:**
- **Period Selector** — Last 7 days, 30 days (default), 90 days, All time
- **Metric Cards** — Website Visits, Unique Visitors, Repeat Visitors, Engagements, Product Views, Call Clicks, Direction Clicks, Filter Usage
- **Daily Bar Chart** — Visual bar chart showing page views per day
- **Breakdown Panels** — Top Pages, Top Referrers, Browsers, Devices, Actions
- **Recent Sessions Table** — Latest sessions with visitor IDs, timestamps, actions
- **Auto-refresh** — Periodically refreshes data
- **Lock button** — Re-locks the dashboard

**Key JS Functions (37):**
- **Data:** `loadAnalytics()` — fetches all events for selected period
- **Render:** `renderAnalytics()`, `renderDailyBars()`, `renderList()`, `renderRecentSessions()`
- **Analysis:** `actionRows()`, `rankedRows()`, `countBy()`, `browserFromUserAgent()`, `deviceFromUserAgent()`, `readableReferrer()`
- **Utils:** `formatNumber()`, `formatDateTime()`, `shortId()`, `periodLabel()`, `unique()`

---

### `email_resend.html` — Email Campaign Dashboard

> ~1498 lines, ~63KB | **Route:** `/email`

**Auth:** Same admin login

**Features:**
- **Tabbed Views** — "Contacts" (individual list) and "Groups" (grouped view)
- **Contact Management** — Add/edit/delete email contacts with name, email, group assignment
- **Auto-grouping** — Contacts auto-assigned to groups of 100 (Resend free-tier limit)
- **Send Email Modal:**
  - Brand Logo picker (from `brands` table)
  - Campaign Image picker (from `email_campaign_images` + upload new)
  - Subject & message body fields
  - Group selector for targeted sending
  - Recipient preview showing count
- **Campaign Image Management** — Upload, rename, remove within send form

**Key JS Functions (50+):**
- **Contacts:** `loadContacts()`, `saveContactHandler()`, `toggleContactActive()`, `deleteContact()`, `nextGroupSlot()`
- **Brands/Images:** `loadBrands()`, `loadCampaignImages()`, `populateBrandSelect()`, `populateCampaignImageSelect()`, `savePendingCampaignImage()`, `renameSelectedCampaignImage()`
- **Sending:** `sendEmailHandler()` — orchestrates Edge Function call to `{SUPABASE_URL}/functions/v1/send-email`
- **UI:** `switchView()`, `openContactModal()`, `closeSendModal()`, `renderContactsList()`, `renderGroupsView()`

---

## Backend / API (Vercel Serverless)

### `api/config.js`

- Serves Supabase config to the browser from env vars
- Returns: `{ supabaseUrl, supabaseAnonKey, maxVideoMb }`
- No-cache headers to prevent stale config

### `api/purge-analytics.js`

- **Schedule:** Daily at `30 20 * * *` (02:00 IST) via Vercel Cron
- Accepts **GET** (cron) and **POST** (manual admin trigger)
- Protected by `CRON_SECRET` env var (Bearer token auth)
- Calls Supabase RPC `purge_old_analytics_events_rpc()` to delete events > 90 days
- Uses `SUPABASE_SERVICE_ROLE_KEY` (preferred) or `SUPABASE_ANON_KEY` as fallback

### `api/sync-google-reviews.js`

- **Schedule:** Daily at `45 21 * * *` (03:15 IST) via Vercel Cron
- Accepts **GET** (cron) and **POST** (manual trigger)
- Cron **GET** requests are protected by `CRON_SECRET` Bearer token auth
- Manual admin **POST** requests are proxied server-side without requiring a browser-visible secret
- Proxies the request to `{SUPABASE_URL}/functions/v1/sync-google-reviews`
- Uses only `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and optional `CRON_SECRET`; Apify credentials stay in Supabase secrets

---

## Edge Functions

### `supabase/functions/sync-google-reviews/index.ts`

**Purpose:** Server-side Google Reviews sync. Apify and Supabase write credentials stay in Supabase Edge Function secrets.

**Endpoint:** `POST {SUPABASE_URL}/functions/v1/sync-google-reviews`

- Reads `APIFY_API_KEY` from Supabase secrets
- Calls the Apify Run Sync Dataset API (`https://api.apify.com`) to run the `compass~google-maps-reviews-scraper` actor on demand
- Fetches, normalizes, and filters up to 100 latest Google Maps reviews for the store
- Upserts reviews in chunks of 25 to the Supabase `public.google_reviews` table on conflict of `google_review_id`
- Deletes stale rows from `public.google_reviews` after the fresh batch is successfully saved
- Uses Supabase-provided `SUPABASE_URL` and service credentials inside the Edge Function

**Required Supabase Secrets:** `APIFY_API_KEY`

**Recommended Supabase Secret:** `CRON_SECRET`

**Hardcoded Review Sync Config:** `GOOGLE_MAPS_REVIEWS_URL=https://maps.app.goo.gl/6uggTtXDuTrEZQDY8`, `REVIEW_SYNC_MAX_REVIEWS=100`, `APIFY_GOOGLE_REVIEWS_ACTOR=compass~google-maps-reviews-scraper`

### `supabase/functions/send-email/index.ts`

> **File:** `supabase/functions/send-email/index.ts` (~336 lines)

**Purpose:** Server-side Resend proxy — the Resend API key never enters the browser.

**Endpoint:** `POST {SUPABASE_URL}/functions/v1/send-email`

**Request Payload:**
```json
{
  "to": ["email1@example.com", "email2@example.com"],
  "subject": "Campaign Subject",
  "message": "Campaign body text",
  "brandLogoUrl": "https://...",        // optional
  "campaignImageUrl": "https://...",    // optional
  "storeName": "Anurag Apparel",       // optional
  "storeLocation": "Hazaribagh"        // optional
}
```

**Validation:**
- At least 1 recipient, max 100 recipients
- Subject & message required
- Deduplicates recipients; filters out sender address and `RESEND_CAMPAIGN_TO`

**Email HTML Features:**
- Brand logo or text fallback header
- Optional campaign image
- Message body (auto-paragraphs from newlines)
- Footer with store name and location
- Dark mode override CSS (forces light theme)
- `[data-ogsc]` selectors for Outlook dark mode override

**Response:** `{ id, ids[], count }`

**Required Secrets:** `RESEND_API_KEY`, `RESEND_FROM_EMAIL`

---

## Direct Apify Review Sync

Google Reviews are synced by a Supabase Edge Function (`supabase/functions/sync-google-reviews/index.ts`) using the Apify API. The Vercel API route (`api/sync-google-reviews.js`) remains as the cron/admin trigger so existing URLs continue to work.

### Flow Architecture

1. **Trigger:** The review sync is run daily via a Vercel Cron Job calling `/api/sync-google-reviews` or triggered manually from the admin UI.
2. **Vercel Proxy:** `api/sync-google-reviews.js` validates the optional `CRON_SECRET` for cron `GET` requests, accepts manual admin `POST` requests, then calls `{SUPABASE_URL}/functions/v1/sync-google-reviews` with the public Supabase anon key and server-side `x-cron-secret`.
3. **Supabase Secrets:** The Edge Function reads `APIFY_API_KEY` and optional `CRON_SECRET` from Supabase Edge Function secrets. The Google Maps URL, max review count, and Apify actor are hardcoded in the function.
4. **Apify API Execution:** The Edge Function makes a POST request to Apify's run sync dataset endpoint:
   `https://api.apify.com/v2/acts/compass~google-maps-reviews-scraper/run-sync-get-dataset-items`
   - Passes the hardcoded Google Maps URL as the start URL.
   - Restricts extraction using the hardcoded `REVIEW_SYNC_MAX_REVIEWS=100` value to limit cost/run duration.
   - The table only stores the latest review batch requested by the store.
   - Orders by newest reviews.
5. **Payload Normalization:** Raw JSON objects returned from Apify's dataset items are parsed and mapped to the database schema:
   - Maps varying field names (e.g. `textTranslated`/`text`/`comment` -> `review_text`).
   - Normalizes rating stars (1-5).
   - Extracts or hashes stable review IDs to prevent duplicates.
6. **Idempotent Database Upsert:** Normalized reviews are capped at 100 usable records and upserted into the `public.google_reviews` table in chunks of 25:
   - REST endpoint: `{SUPABASE_URL}/rest/v1/google_reviews?on_conflict=google_review_id`
   - Uses `Prefer: resolution=merge-duplicates,return=representation,missing=default` header.
   - New rows use the table defaults for visibility and featured state.
7. **Fresh Batch Replacement:** Each successful run stamps the incoming reviews with a shared `scraped_at` value, then deletes rows whose `scraped_at` does not match that fresh batch. If Apify returns no usable reviews, the API leaves the existing Supabase reviews untouched.

### Production Secret Setup

Set the review sync secrets in Supabase, not Vercel:

```bash
supabase secrets set APIFY_API_KEY=your_apify_key
supabase secrets set CRON_SECRET=your_cron_secret
```

Then deploy the Edge Function:

```bash
supabase functions deploy sync-google-reviews
```

Vercel still needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and the same `CRON_SECRET` so its cron route can invoke the Supabase function.

---

## Deployment Configuration

### Vercel (`vercel.json`)

**Rewrites:**
| Source Pattern              | Destination          |
| -------------------------- | -------------------- |
| `/admin`, `/admin/*`       | `admin.html`         |
| `/analytics`, `/analytics/*` | `analytics.html`   |
| `/email`, `/email/*`       | `email_resend.html`  |

**Cron:**
```json
[
  { "path": "/api/purge-analytics", "schedule": "30 20 * * *" },
  { "path": "/api/sync-google-reviews", "schedule": "45 21 * * *" }
]
```

### Netlify (`_redirects`)

Same rewrites as Vercel with `200` status (rewrite, not redirect).

### `.gitignore`

- `.env` and `.env*.local` excluded
- `supabase-browser-config.js` excluded (contains credentials)
- `credential.txt` excluded (contains local API credentials)

---

## Images & Assets

| Path                            | Contents                                                  |
| ------------------------------- | --------------------------------------------------------- |
| `Images/Anurag Apparel Logo.png`| Original brand logo                                      |
| `Images/New Logo.png`           | Updated brand logo                                       |
| `Images/With Background.png`    | Logo on background                                       |
| `Images/With Background New.png`| Updated logo on background                               |
| `Images/Background.jpeg`        | Hero section background (Unsplash)                       |
| `Images/Admin Background.jpg`   | Admin auth screen background                             |
| `Images/Rear_View.jpeg`         | Store rear view photo                                    |
| `Images/Levis.jpeg`             | Levi's banner                                            |
| `Images/Brand Logos/`           | Brand logo PNGs: AA, Jack&Jones, Jockey, Lee, Levis, Peter England, Wrangler, All_Red |
| `Images/QRs/`                   | QR codes for Google Maps location & website URL          |
| `Images/References/`            | `References.txt` — Unsplash background image attributions |

---

## Design System

| Token   | Hex       | Usage                          |
| ------- | --------- | ------------------------------ |
| `ink`   | `#171717` | Primary text, dark backgrounds |
| `paper` | `#fbfaf7` | Page background                |
| `linen` | `#f3eee5` | Subtle section backgrounds     |
| `brass` | `#b7872d` | Accent, CTAs, highlights       |
| `leaf`  | `#2d6a4f` | Success, secondary accent      |
| `wine`  | `#7f1d1d` | Error, danger                  |
| `clay`  | `#a85f3d` | Warm secondary accent          |

**Typography:** System fonts via Tailwind defaults  
**Currency:** Indian Rupees (₹) via `formatCurrency()`  
**Localization:** IST timezone, Indian phone validation, Google Maps (Hazaribagh)

---

## Architecture Decisions & Patterns

1. **No Build Step** — Pure static HTML + CDN-loaded Tailwind & Supabase JS. No npm, no bundler. Each HTML file is self-contained with inline JS.

2. **3-Tier Config Fallback** — Browser pages load config in order: (1) `window.*` globals from `supabase-browser-config.js` → (2) Vercel serverless `/api/config` → (3) direct `.env` file fetch + parse. Graceful fallback with sample product preview if unconfigured.

3. **Admin Auth Without Supabase Auth** — Uses custom bcrypt-hashed credentials in `private` schema with `security definer` RPC functions. Session stored in `sessionStorage`. ⚠️ Not production-grade; Supabase Auth + stricter RLS recommended for scaling.

4. **Open RLS for Static Admin Pattern** — Most tables grant full CRUD to `anon` role. Intentional trade-off for a no-server admin pattern.

5. **Edge Function as API Proxy** — Resend API key never enters the browser. Email sending goes through the `send-email` Edge Function.

6. **Dual Cleanup Strategy** — Analytics purge via both pg_cron (database-level) and Vercel Cron (application-level fallback).

7. **Resumable Uploads** — Admin uses `tus-js-client` for resumable file uploads up to 50MB (important for video files).

8. **Resend Free-Tier Aware** — Email contacts auto-grouped in batches of 100 (Resend's free-tier limit per batch).

9. **Privacy-Focused Analytics** — Anonymous tracking with `localStorage` visitor IDs and `sessionStorage` session IDs. No cookies, no PII.

10. **Multi-Platform Deploy** — Supports both Vercel and Netlify with equivalent rewrite configurations.

11. **Dark Mode Defense in Emails** — Email HTML includes `@media (prefers-color-scheme: dark)` and `[data-ogsc]` selectors to force light-mode in Outlook and other dark-mode clients.

---

## Changelog

| Date       | Change Description                                 |
| ---------- | -------------------------------------------------- |
| 2026-07-02 | ⭐ Added a "Leave us a review" button redirecting to Google reviews; optimized with hardware-accelerating compositing layers for buttery-smooth transitions and centered button layout. Removed store review sync subtext. |
| 2026-07-02 | 🪔 Redesigned the customer reviews section with a premium frosted glass card wrap and sideways arrow navigation controls. |
| 2026-07-02 | ✨ Added a "Mail Us" button in the header nav with desktop-only popup display (preventing client redirect) and mobile mailto functionality. |
| 2026-07-02 | 🛡️ Resolved responsive overlapping issues on mobile by preventing brand logo shrink and collapsing nav buttons into icon-only squares below 1024px. |
| 2026-07-02 | 🛠️ Upgraded the admin "Call Button" menu to "Call and Mail Buttons", allowing email editing, validation, and database upserts. |
| 2026-07-01 | Moved Google Reviews scraping into a Supabase Edge Function so Apify credentials can live in Supabase production secrets; Vercel route now proxies cron/manual triggers. |
| 2026-07-01 | Updated Apify review sync to cap latest reviews at 100, upsert the fresh batch, and delete stale Supabase review rows after a successful sync. |
| 2026-07-01 | Updated `PROJECT.md` to document the direct Apify Google Reviews sync API handler (`api/sync-google-reviews.js`) and environment variables. |
| 2026-07-01 | ✨ Added Instagram and Facebook follow buttons to the storefront header/footer, plus admin-managed social URLs stored in `site_settings`. |
| 2026-06-28 | 🐛 Fixed email send endpoint in `email_resend.html` on deployed sites by calling dynamic config (`state.supabaseConfig`) instead of global script window variables (which are undefined in production). |
| 2026-06-28 | ✨ Tinted the outer `visit-glass-card` with a warm yellow/cream overlay in all views (light, dark, and iOS `@supports` compatibility blocks) to match the surrounding gold/paper theme. |
| 2026-06-28 | 🗑️ Removed "Video" and "X views" badges from product cards in `index.html`. Modal thumbnails still show Video badges. |
| 2026-06-28 | ✨ Enhanced Visit Us address card glassmorphism — warm-tinted frosted glass, brass left accent border, shimmer reflection `::before`, hover lift animation, pin icon with warm tint + interactive glow |
| 2026-06-28 | ✨ Redesigned Offer Board header in `index.html` with glassmorphism — frosted `backdrop-blur`, translucent white fills, subtle shadows, green Live dot. Removed heavy color gradients. |
| 2026-06-28 | 🐛 Fixed local dev Supabase connection in `index.html` — added missing `<script src="supabase-browser-config.js">` tag (already present in admin, analytics, email pages). File is gitignored so credentials stay local only. |
| 2026-06-28 | 🐛 Fixed iOS video previews in `index.html` — added `webkit-playsinline` attr, changed `preload` to `auto` for card thumbnails, added `loadedmetadata` seek-to-first-frame trick, and explicit `play()` call on `loadeddata` |
| 2026-06-28 | 📄 Initial `PROJECT.md` created — full project documentation |

---

> **Note:** This file is a living document. It is updated after every change to the project.
