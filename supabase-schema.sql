-- ============================================================
-- Anurag Apparel – Complete Supabase Schema
-- ============================================================
-- This is the single source-of-truth for the entire database.
-- It is safe to run on a fresh project (all statements are
-- idempotent).  Migrations are tracked separately in the
-- supabase_migrations table by the Supabase CLI / MCP.
-- ============================================================

-- ── 0. Extensions & private schema ──────────────────────────
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

-- ── 1. product_subcategories ─────────────────────────────────
create table if not exists public.product_subcategories (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  slug        text        not null unique,
  description text        not null default '',
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  constraint product_subcategories_name_not_blank check (length(trim(name)) > 0),
  constraint product_subcategories_slug_not_blank check (length(trim(slug)) > 0)
);

create index if not exists product_subcategories_sort_order_created_at_idx
  on public.product_subcategories (sort_order asc, created_at desc);

create index if not exists product_subcategories_is_active_idx
  on public.product_subcategories (is_active);

-- ── 2. products ──────────────────────────────────────────────
create table if not exists public.products (
  id             uuid          primary key default gen_random_uuid(),
  title          text          not null,
  description    text          not null default '',
  price          numeric(10,2) check (price >= 0),   -- nullable (price on request)
  subcategory_id uuid          references public.product_subcategories(id) on delete set null,
  gallery_images text[]        not null default '{}',
  is_active      boolean       not null default true,
  created_at     timestamptz   not null default now()
);

-- Idempotent column additions (no-op on re-run)
alter table public.products
  add column if not exists subcategory_id uuid references public.product_subcategories(id) on delete set null;
alter table public.products
  alter column price drop not null;

create index if not exists products_created_at_idx      on public.products (created_at desc);
create index if not exists products_is_active_idx       on public.products (is_active);
create index if not exists products_subcategory_id_idx  on public.products (subcategory_id);

-- ── 3. brands ────────────────────────────────────────────────
create table if not exists public.brands (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  logo_url    text        not null,
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists brands_sort_order_created_at_idx on public.brands (sort_order asc, created_at desc);
create index if not exists brands_is_active_idx             on public.brands (is_active);

-- ── 4. site_announcements ────────────────────────────────────
create table if not exists public.site_announcements (
  id          text        primary key default 'homepage',
  eyebrow     text        not null default 'Store update',
  title       text        not null default 'Announcements and Offers',
  message     text        not null default 'Explore fresh arrivals and in-store offers at Anurag Apparel.',
  offer_text  text        not null default 'Visit the store for the latest seasonal deals.',
  cta_label   text        not null default 'Get Directions',
  cta_url     text        not null default 'https://maps.app.goo.gl/ZsyAXskboHbKB6RA6',
  offer_images text[]        not null default '{}',
  is_active   boolean     not null default true,
  updated_at  timestamptz not null default now()
);

create or replace function public.set_site_announcements_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists site_announcements_updated_at on public.site_announcements;
create trigger site_announcements_updated_at
  before update on public.site_announcements
  for each row execute function public.set_site_announcements_updated_at();

-- ── 5. site_settings ─────────────────────────────────────────
create table if not exists public.site_settings (
  id           text        primary key default 'storefront',
  phone_number text        not null default '',
  updated_at   timestamptz not null default now(),
  constraint site_settings_phone_number_length
    check (phone_number = '' or length(regexp_replace(phone_number, '\D', '', 'g')) between 7 and 15)
);

create or replace function public.set_site_settings_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists site_settings_updated_at on public.site_settings;
create trigger site_settings_updated_at
  before update on public.site_settings
  for each row execute function public.set_site_settings_updated_at();

-- ── 6. email_contacts ────────────────────────────────────────
-- Stores customer email addresses for the Email Customers feature.
-- Contacts are auto-assigned into groups of 100 (Resend free-tier limit).
create table if not exists public.email_contacts (
  id          uuid        primary key default gen_random_uuid(),
  email       text        not null,
  name        text        not null default '',
  group_name  text        not null default 'Group 1',
  group_index integer     not null default 1,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint email_contacts_email_unique unique (email)
);

create index if not exists email_contacts_group_index_idx  on public.email_contacts (group_index asc);
create index if not exists email_contacts_is_active_idx    on public.email_contacts (is_active);
create index if not exists email_contacts_created_at_idx   on public.email_contacts (created_at asc);

create or replace function public.set_email_contacts_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_email_contacts_updated_at on public.email_contacts;
create trigger trg_email_contacts_updated_at
  before update on public.email_contacts
  for each row execute function public.set_email_contacts_updated_at();

-- Stores reusable named campaign images for the Email Customers feature.
create table if not exists public.email_campaign_images (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,
  image_url    text        not null,
  storage_path text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint email_campaign_images_name_not_blank check (length(trim(name)) > 0),
  constraint email_campaign_images_image_url_not_blank check (length(trim(image_url)) > 0),
  constraint email_campaign_images_storage_path_unique unique (storage_path)
);

create index if not exists email_campaign_images_created_at_idx
  on public.email_campaign_images (created_at desc);

create or replace function public.set_email_campaign_images_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_email_campaign_images_updated_at on public.email_campaign_images;
create trigger trg_email_campaign_images_updated_at
  before update on public.email_campaign_images
  for each row execute function public.set_email_campaign_images_updated_at();

-- ── 7. Admin credentials (private schema) ───────────────────
create table if not exists private.admin_credentials (
  id            text        primary key default 'dashboard',
  username      text        not null unique,
  password_hash text        not null,
  updated_at    timestamptz not null default now()
);

alter table private.admin_credentials enable row level security;

drop policy if exists "No direct admin credential access" on private.admin_credentials;
create policy "No direct admin credential access"
  on private.admin_credentials for all to public
  using (false) with check (false);

insert into private.admin_credentials (id, username, password_hash)
values ('dashboard', 'anurag', extensions.crypt('Anurag@2026', extensions.gen_salt('bf')))
on conflict (id) do nothing;

-- ── 8. Admin RPC functions ───────────────────────────────────
create or replace function private.verify_admin_login(input_username text, input_password text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare stored_hash text;
begin
  if coalesce(input_username, '') = '' or coalesce(input_password, '') = '' then return false; end if;
  select password_hash into stored_hash
    from private.admin_credentials
   where id = 'dashboard' and username = input_username;
  return stored_hash is not null and stored_hash = extensions.crypt(input_password, stored_hash);
end; $$;

create or replace function private.change_admin_password(input_username text, current_password text, new_password text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new_password, '') = '' or length(new_password) < 8 then return false; end if;
  if not private.verify_admin_login(input_username, current_password) then return false; end if;
  update private.admin_credentials
     set password_hash = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = 'dashboard' and username = input_username;
  return found;
end; $$;

-- Public-facing wrappers (callable from the browser via anon key)
create or replace function public.verify_admin_login(input_username text, input_password text)
returns boolean language sql security invoker set search_path = '' as $$
  select private.verify_admin_login(input_username, input_password); $$;

create or replace function public.change_admin_password(input_username text, current_password text, new_password text)
returns boolean language sql security invoker set search_path = '' as $$
  select private.change_admin_password(input_username, current_password, new_password); $$;

-- ── 9. Grants & revokes ──────────────────────────────────────
revoke all on schema private from public;
revoke all on private.admin_credentials              from public, anon, authenticated;
revoke all on function private.verify_admin_login(text,text)          from public;
revoke all on function private.change_admin_password(text,text,text)   from public;
revoke all on function public.verify_admin_login(text,text)            from public;
revoke all on function public.change_admin_password(text,text,text)    from public;

grant usage   on schema private                                          to anon;
grant execute on function private.verify_admin_login(text,text)         to anon;
grant execute on function private.change_admin_password(text,text,text) to anon;
grant execute on function public.verify_admin_login(text,text)          to anon;
grant execute on function public.change_admin_password(text,text,text)  to anon;

-- ── 10. Enable RLS on all public tables ──────────────────────
alter table public.products             enable row level security;
alter table public.product_subcategories enable row level security;
alter table public.brands               enable row level security;
alter table public.site_announcements   enable row level security;
alter table public.site_settings        enable row level security;
alter table public.email_contacts       enable row level security;
alter table public.email_campaign_images enable row level security;

-- ── 11. Table grants ─────────────────────────────────────────
grant select, insert, update, delete on table public.products              to anon;
grant select, insert, update, delete on table public.product_subcategories to anon;
grant select, insert, update, delete on table public.brands                to anon;
grant select, insert, update         on table public.site_announcements    to anon;
grant select, insert, update         on table public.site_settings         to anon;
grant select, insert, update, delete on table public.email_contacts        to anon;
grant select, insert, update, delete on table public.email_campaign_images to anon;

-- ── 12. RLS Policies ─────────────────────────────────────────

-- product_subcategories
drop policy if exists "Public can read product subcategories"                on public.product_subcategories;
drop policy if exists "Anon can create product subcategories for static admin" on public.product_subcategories;
drop policy if exists "Anon can update product subcategories for static admin" on public.product_subcategories;
drop policy if exists "Anon can delete product subcategories"                on public.product_subcategories;

create policy "Public can read product subcategories"
  on public.product_subcategories for select to anon using (true);
create policy "Anon can create product subcategories for static admin"
  on public.product_subcategories for insert to anon with check (true);
create policy "Anon can update product subcategories for static admin"
  on public.product_subcategories for update to anon using (true) with check (true);
create policy "Anon can delete product subcategories"
  on public.product_subcategories for delete to anon using (true);

-- products
drop policy if exists "Public can read products"                on public.products;
drop policy if exists "Anon can create products for static admin" on public.products;
drop policy if exists "Anon can update products for static admin" on public.products;
drop policy if exists "Anon can delete products for static admin" on public.products;

create policy "Public can read products"
  on public.products for select to anon using (true);
create policy "Anon can create products for static admin"
  on public.products for insert to anon with check (true);
create policy "Anon can update products for static admin"
  on public.products for update to anon using (true) with check (true);
create policy "Anon can delete products for static admin"
  on public.products for delete to anon using (true);

-- brands
drop policy if exists "Public can read brands"                on public.brands;
drop policy if exists "Anon can create brands for static admin" on public.brands;
drop policy if exists "Anon can update brands for static admin" on public.brands;
drop policy if exists "Anon can delete brands for static admin" on public.brands;
drop policy if exists "Anon can delete brands"                on public.brands;

create policy "Public can read brands"
  on public.brands for select to anon using (true);
create policy "Anon can create brands for static admin"
  on public.brands for insert to anon with check (true);
create policy "Anon can update brands for static admin"
  on public.brands for update to anon using (true) with check (true);
create policy "Anon can delete brands"
  on public.brands for delete to anon using (true);

-- site_announcements
drop policy if exists "Public can read site announcements"                    on public.site_announcements;
drop policy if exists "Anon can create site announcements for static admin"   on public.site_announcements;
drop policy if exists "Anon can update site announcements for static admin"   on public.site_announcements;

create policy "Public can read site announcements"
  on public.site_announcements for select to anon using (true);
create policy "Anon can create site announcements for static admin"
  on public.site_announcements for insert to anon with check (true);
create policy "Anon can update site announcements for static admin"
  on public.site_announcements for update to anon using (true) with check (true);

-- site_settings
drop policy if exists "Public can read site settings"                  on public.site_settings;
drop policy if exists "Anon can create site settings for static admin" on public.site_settings;
drop policy if exists "Anon can update site settings for static admin" on public.site_settings;

create policy "Public can read site settings"
  on public.site_settings for select to anon using (true);
create policy "Anon can create site settings for static admin"
  on public.site_settings for insert to anon
  with check (
    id = 'storefront'
    and (phone_number = '' or length(regexp_replace(phone_number, '\D', '', 'g')) between 7 and 15)
  );
create policy "Anon can update site settings for static admin"
  on public.site_settings for update to anon
  using (id = 'storefront')
  with check (
    id = 'storefront'
    and (phone_number = '' or length(regexp_replace(phone_number, '\D', '', 'g')) between 7 and 15)
  );

-- email_contacts
drop policy if exists "Public can read email contacts"                  on public.email_contacts;
drop policy if exists "Anon can create email contacts for static admin" on public.email_contacts;
drop policy if exists "Anon can update email contacts for static admin" on public.email_contacts;
drop policy if exists "Anon can delete email contacts"                  on public.email_contacts;
-- clean up old generic policy names from email-contacts-schema.sql
drop policy if exists "email_contacts_select" on public.email_contacts;
drop policy if exists "email_contacts_insert" on public.email_contacts;
drop policy if exists "email_contacts_update" on public.email_contacts;
drop policy if exists "email_contacts_delete" on public.email_contacts;

create policy "Public can read email contacts"
  on public.email_contacts for select to anon using (true);
create policy "Anon can create email contacts for static admin"
  on public.email_contacts for insert to anon with check (true);
create policy "Anon can update email contacts for static admin"
  on public.email_contacts for update to anon using (true) with check (true);
create policy "Anon can delete email contacts"
  on public.email_contacts for delete to anon using (true);

-- email_campaign_images
drop policy if exists "Public can read email campaign images"                  on public.email_campaign_images;
drop policy if exists "Anon can create email campaign images for static admin" on public.email_campaign_images;
drop policy if exists "Anon can update email campaign images for static admin" on public.email_campaign_images;
drop policy if exists "Anon can delete email campaign images"                  on public.email_campaign_images;

create policy "Public can read email campaign images"
  on public.email_campaign_images for select to anon using (true);
create policy "Anon can create email campaign images for static admin"
  on public.email_campaign_images for insert to anon
  with check (
    length(trim(name)) > 0
    and length(trim(image_url)) > 0
    and storage_path like 'campaigns/%'
  );
create policy "Anon can update email campaign images for static admin"
  on public.email_campaign_images for update to anon
  using (storage_path like 'campaigns/%')
  with check (
    length(trim(name)) > 0
    and length(trim(image_url)) > 0
    and storage_path like 'campaigns/%'
  );
create policy "Anon can delete email campaign images"
  on public.email_campaign_images for delete to anon
  using (storage_path like 'campaigns/%');

-- ── 13. Storage bucket ───────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Anon can upload product images" on storage.objects;
drop policy if exists "Anon can update product images" on storage.objects;
drop policy if exists "Anon can delete product images" on storage.objects;

create policy "Anon can upload product images"
  on storage.objects for insert to anon
  with check (bucket_id = 'product-images');
create policy "Anon can update product images"
  on storage.objects for update to anon
  using (bucket_id = 'product-images') with check (bucket_id = 'product-images');
create policy "Anon can delete product images"
  on storage.objects for delete to anon
  using (bucket_id = 'product-images');

-- ── 14. Seed data (idempotent) ───────────────────────────────
insert into public.site_announcements (id, eyebrow, title, message, offer_text, cta_label, cta_url, is_active)
values (
  'homepage', 'Store update', 'New Arrivals Are Live',
  'Fresh apparel selections are now available at Anurag Apparel in Hazaribagh.',
  'Ask in store for current festive and seasonal offers.',
  'Get Directions', 'https://maps.app.goo.gl/ZsyAXskboHbKB6RA6', true
) on conflict (id) do nothing;

insert into public.site_settings (id, phone_number)
values ('storefront', '') on conflict (id) do nothing;

insert into public.product_subcategories (name, slug, description, sort_order, is_active)
values
  ('Shirts',   'shirts',   'Button-downs, casual shirts, and formal shirts.', 10, true),
  ('T-Shirts', 't-shirts', 'Everyday tees and casual essentials.',            20, true),
  ('Jeans',    'jeans',    'Denim fits and jeans for daily wear.',            30, true),
  ('Trousers', 'trousers', 'Smart trousers and weekday bottoms.',             40, true),
  ('Kurtas',   'kurtas',   'Festive and everyday ethnic wear.',               50, true),
  ('Jackets',  'jackets',  'Layering pieces and occasion jackets.',           60, true)
on conflict (slug) do nothing;

-- ── 15. Revoke stale helper function (if it exists) ──────────
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end; $$;
