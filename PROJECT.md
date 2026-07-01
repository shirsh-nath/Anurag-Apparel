# 📦 Anurag Apparel — Project Documentation

> **Last updated:** 2026-07-01
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
   - [Scheduled Cleanup](#scheduled-cleanup)
6. [Frontend Pages](#frontend-pages)
   - [index.html — Public Storefront](#indexhtml--public-storefront)
   - [admin.html — Admin Portal](#adminhtml--admin-portal)
   - [analytics.html — Traffic Analytics Dashboard](#analyticshtml--traffic-analytics-dashboard)
   - [email_resend.html — Email Campaign Dashboard](#email_resendhtml--email-campaign-dashboard)
7. [Backend / API (Vercel Serverless)](#backend--api-vercel-serverless)
8. [Edge Function: send-email](#edge-function-send-email)
9. [Deployment Configuration](#deployment-configuration)
10. [Images & Assets](#images--assets)
11. [Design System](#design-system)
12. [Architecture Decisions & Patterns](#architecture-decisions--patterns)
13. [Changelog](#changelog)

---

## Overview

**Anurag Apparel** is a full-featured static storefront and admin portal for a premium clothing store. It functions as a product catalog (not a transactional e-commerce store) with:

- **Public storefront** — showcasing products, brands, announcements, and offers
- **Admin dashboard** — managing products, categories, brands, announcements, settings, and campaign images
- **Analytics dashboard** — anonymous traffic & engagement tracking
- **Email campaign tool** — sending branded marketing emails to customer groups via Resend

---

## Tech Stack

| Layer               | Technology                                                        |
| ------------------- | ----------------------------------------------------------------- |
| **Frontend**        | HTML5, Tailwind CSS (CDN), Vanilla JavaScript (no framework)      |
| **Database / BaaS** | Supabase (PostgreSQL, Storage, Edge Functions, RPC)               |
| **Email Service**   | Resend (via Supabase Edge Function proxy)                         |
| **Edge Functions**  | Deno (Supabase Edge Functions)                                    |
| **Deployment**      | Vercel (primary) + Netlify (secondary; `_redirects` file)         |
| **File Uploads**    | Supabase Storage (`product-images` bucket), tus-js-client (resumable) |

---

## Project Structure

```
d:\Stores\Anurag Apparel\
├── .env                              # Environment variables (gitignored)
├── .gitignore                        # Ignores .env, supabase-browser-config.js
├── _redirects                        # Netlify URL rewrites
├── vercel.json                       # Vercel rewrites + cron job config
├── supabase-browser-config.js        # Browser-side Supabase credentials (gitignored)
├── supabase-schema.sql               # Complete DB schema (~540 lines, ~28KB)
├── index.html                        # Public storefront (~3072 lines, ~110KB)
├── admin.html                        # Admin portal (~3000 lines, ~117KB)
├── analytics.html                    # Traffic analytics dashboard (~881 lines, ~36KB)
├── email_resend.html                 # Email campaign dashboard (~1498 lines, ~63KB)
├── README.md                         # Original project README
├── PROJECT.md                        # ⬅ THIS FILE — living project documentation
│
├── api/
│   ├── config.js                     # Vercel serverless: serves Supabase config from env vars
│   └── purge-analytics.js            # Vercel cron: purges analytics events > 90 days
│
├── supabase/
│   └── functions/
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

### Additional env vars (referenced in code, set in Vercel/Supabase)

| Variable                   | Used By               | Purpose                                      |
| -------------------------- | --------------------- | -------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`| `purge-analytics.js`  | Service role key (fallback to anon key)       |
| `CRON_SECRET`              | `purge-analytics.js`  | Vercel cron auth (Bearer token)               |
| `MAX_VIDEO_MB`             | `config.js`           | Max upload size (default: 50MB)               |
| `RESEND_CAMPAIGN_TO`       | `send-email/index.ts` | Legacy; filtered from recipients if set       |

### Browser config (`supabase-browser-config.js`, gitignored)

Exposes to `window`:
- `window.ANURAG_SUPABASE_URL`
- `window.ANURAG_SUPABASE_ANON_KEY`
- `window.ANURAG_MAX_VIDEO_MB` (default: 50)

---

## Database Schema (Supabase PostgreSQL)

> **Source of truth:** `supabase-schema.sql` (~540 lines). All statements are idempotent (safe to re-run).

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
| `instagram_url`| text      | Optional `http(s)` URL for follow button |
| `facebook_url` | text      | Optional `http(s)` URL for follow button |
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

#### 9. `private.admin_credentials`

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
- `email_campaign_images` → insert/update/delete restricted to `storage_path LIKE 'campaigns/%'`
- `website_analytics_events` → insert requires non-blank `event_name`/`visitor_id`/`session_id`; select open; delete requires non-blank `visitor_id`

### Triggers

| Trigger Name                               | Table                    | Action                     |
| ------------------------------------------ | ------------------------ | -------------------------- |
| `site_announcements_updated_at`            | `site_announcements`     | Auto-set `updated_at`      |
| `site_settings_updated_at`                 | `site_settings`          | Auto-set `updated_at`      |
| `trg_email_contacts_updated_at`            | `email_contacts`         | Auto-set `updated_at`      |
| `trg_email_campaign_images_updated_at`     | `email_campaign_images`  | Auto-set `updated_at`      |

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

### Scheduled Cleanup

| Method       | Schedule           | What it does                         |
| ------------ | ------------------ | ------------------------------------ |
| **pg_cron**  | `30 20 * * *` (02:00 IST) | Calls `purge_old_analytics_events()` |
| **Vercel Cron** | `30 20 * * *` (02:00 IST) | Calls `/api/purge-analytics` (fallback) |

Both delete `website_analytics_events` older than **90 days**.

---

## Frontend Pages

### `index.html` — Public Storefront

> ~3072 lines, ~110KB | **Route:** `/` (root)

**Sections:**
- **Header** — Brand logo, nav links (Home, Shop, About), call button (from `site_settings.phone_number`), "Shop" CTA
- **Social follow buttons** — Instagram and Facebook logo links in the header and footer, loaded from `site_settings`
- **Hero** — Background image with overlay, tagline, CTA buttons
- **Announcement/Offers Board** — Dynamic from `site_announcements`; offer images carousel, CTA button
- **Brands Strip** — Horizontal scrolling brand logos from `brands` table
- **Subcategory Slider** — Horizontal category chips for filtering products
- **Product Grid** — Responsive grid of product cards with gallery images/videos, price or "Price on Request"
- **Product Modal** — Full-screen modal with media gallery, description, subcategory badge, price

**Key JS Functions (50+):**
- **Init:** `init()`, `createSupabaseClient()`, `loadSupabaseConfig()` — 3-tier config fallback
- **Data:** `loadProducts()`, `loadSubcategories()`, `loadBrands()`, `loadSiteSettings()`, `loadAnnouncementBoard()`
- **Render:** `renderProducts()`, `renderBrands()`, `renderCategorySlider()`, `renderAnnouncementBoard()`, `renderCallButton()`
- **Modal:** `openProductModal()`, `closeProductModal()`, `renderModal()`
- **Media:** `createMediaElement()`, `isVideoUrl()`, `getGalleryImages()`
- **Analytics:** `initAnalyticsTracking()`, `trackAnalyticsEvent()`, `getVisitorId()`, `getSessionId()`
- **Utils:** `formatCurrency()` (₹ Indian Rupee), `handleTrackedOutboundClick()`

**Analytics Tracked Events:** page views, product clicks, call button clicks, direction clicks, filter usage

---

### `admin.html` — Admin Portal

> ~3000 lines, ~117KB | **Route:** `/admin`

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

---

## Edge Function: send-email

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
{ "path": "/api/purge-analytics", "schedule": "30 20 * * *" }
```

### Netlify (`_redirects`)

Same rewrites as Vercel with `200` status (rewrite, not redirect).

### `.gitignore`

- `.env` and `.env*.local` excluded
- `supabase-browser-config.js` excluded (contains credentials)

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
