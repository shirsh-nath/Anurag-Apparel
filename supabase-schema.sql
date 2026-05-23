-- Anurag Apparel Supabase setup
-- Run this in the Supabase SQL editor.
-- Important: browser-only hardcoded admin credentials can hide the UI, but they
-- cannot secure database writes. These demo policies allow the static admin
-- portal to work with the anon key. For production, replace them with Supabase
-- Auth, server-side admin actions, or Edge Functions using proper authorization.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  price numeric(10, 2) not null check (price >= 0),
  -- Stores public Supabase Storage URLs for product media.
  -- The existing column name is kept for compatibility; it can contain image and video URLs.
  gallery_images text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists products_created_at_idx
  on public.products (created_at desc);

create index if not exists products_is_active_idx
  on public.products (is_active);

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists brands_sort_order_created_at_idx
  on public.brands (sort_order asc, created_at desc);

create index if not exists brands_is_active_idx
  on public.brands (is_active);

create table if not exists public.site_announcements (
  id text primary key default 'homepage',
  eyebrow text not null default 'Store update',
  title text not null default 'Announcements and Offers',
  message text not null default 'Explore fresh arrivals and in-store offers at Anurag Apparel.',
  offer_text text not null default 'Visit the store for the latest seasonal deals.',
  cta_label text not null default 'Get Directions',
  cta_url text not null default 'https://maps.app.goo.gl/ZsyAXskboHbKB6RA6',
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.site_settings (
  id text primary key default 'storefront',
  phone_number text not null default '',
  constraint site_settings_phone_number_length
    check (phone_number = '' or length(regexp_replace(phone_number, '\D', '', 'g')) between 7 and 15),
  updated_at timestamptz not null default now()
);

create or replace function public.set_site_announcements_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists site_announcements_updated_at on public.site_announcements;
create trigger site_announcements_updated_at
before update on public.site_announcements
for each row
execute function public.set_site_announcements_updated_at();

create or replace function public.set_site_settings_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists site_settings_updated_at on public.site_settings;
create trigger site_settings_updated_at
before update on public.site_settings
for each row
execute function public.set_site_settings_updated_at();

create table if not exists private.admin_credentials (
  id text primary key default 'dashboard',
  username text not null unique,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

alter table private.admin_credentials enable row level security;

drop policy if exists "No direct admin credential access" on private.admin_credentials;
create policy "No direct admin credential access"
  on private.admin_credentials
  for all
  to public
  using (false)
  with check (false);

insert into private.admin_credentials (id, username, password_hash)
values ('dashboard', 'anurag', extensions.crypt('Anurag@2026', extensions.gen_salt('bf')))
on conflict (id) do nothing;

create or replace function private.verify_admin_login(input_username text, input_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored_hash text;
begin
  if coalesce(input_username, '') = '' or coalesce(input_password, '') = '' then
    return false;
  end if;

  select password_hash
    into stored_hash
    from private.admin_credentials
   where id = 'dashboard'
     and username = input_username;

  return stored_hash is not null and stored_hash = extensions.crypt(input_password, stored_hash);
end;
$$;

create or replace function private.change_admin_password(input_username text, current_password text, new_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new_password, '') = '' or length(new_password) < 8 then
    return false;
  end if;

  if not private.verify_admin_login(input_username, current_password) then
    return false;
  end if;

  update private.admin_credentials
     set password_hash = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = 'dashboard'
     and username = input_username;

  return found;
end;
$$;

create or replace function public.verify_admin_login(input_username text, input_password text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.verify_admin_login(input_username, input_password);
$$;

create or replace function public.change_admin_password(input_username text, current_password text, new_password text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.change_admin_password(input_username, current_password, new_password);
$$;

revoke all on schema private from public;
revoke all on private.admin_credentials from public, anon, authenticated;
revoke all on function private.verify_admin_login(text, text) from public;
revoke all on function private.change_admin_password(text, text, text) from public;
revoke all on function public.verify_admin_login(text, text) from public;
revoke all on function public.change_admin_password(text, text, text) from public;

grant usage on schema private to anon;
grant execute on function private.verify_admin_login(text, text) to anon;
grant execute on function private.change_admin_password(text, text, text) to anon;
grant execute on function public.verify_admin_login(text, text) to anon;
grant execute on function public.change_admin_password(text, text, text) to anon;

alter table public.products enable row level security;
alter table public.brands enable row level security;
alter table public.site_announcements enable row level security;
alter table public.site_settings enable row level security;

grant select, insert, update, delete on table public.products to anon;
grant select, insert, update, delete on table public.brands to anon;
grant select, insert, update on table public.site_announcements to anon;
grant select, insert, update on table public.site_settings to anon;

drop policy if exists "Public can read products" on public.products;
drop policy if exists "Anon can create products for static admin" on public.products;
drop policy if exists "Anon can update products for static admin" on public.products;
drop policy if exists "Anon can delete products for static admin" on public.products;

create policy "Public can read products"
  on public.products
  for select
  to anon
  using (true);

create policy "Anon can create products for static admin"
  on public.products
  for insert
  to anon
  with check (true);

create policy "Anon can update products for static admin"
  on public.products
  for update
  to anon
  using (true)
  with check (true);

create policy "Anon can delete products for static admin"
  on public.products
  for delete
  to anon
  using (true);

drop policy if exists "Public can read brands" on public.brands;
drop policy if exists "Anon can create brands for static admin" on public.brands;
drop policy if exists "Anon can update brands for static admin" on public.brands;
drop policy if exists "Anon can delete brands for static admin" on public.brands;
drop policy if exists "Anon can delete brands" on public.brands;

create policy "Public can read brands"
  on public.brands
  for select
  to anon
  using (true);

create policy "Anon can create brands for static admin"
  on public.brands
  for insert
  to anon
  with check (true);

create policy "Anon can update brands for static admin"
  on public.brands
  for update
  to anon
  using (true)
  with check (true);

create policy "Anon can delete brands"
  on public.brands
  for delete
  to anon
  using (true);

drop policy if exists "Public can read site announcements" on public.site_announcements;
drop policy if exists "Anon can create site announcements for static admin" on public.site_announcements;
drop policy if exists "Anon can update site announcements for static admin" on public.site_announcements;

create policy "Public can read site announcements"
  on public.site_announcements
  for select
  to anon
  using (true);

create policy "Anon can create site announcements for static admin"
  on public.site_announcements
  for insert
  to anon
  with check (true);

create policy "Anon can update site announcements for static admin"
  on public.site_announcements
  for update
  to anon
  using (true)
  with check (true);

drop policy if exists "Public can read site settings" on public.site_settings;
drop policy if exists "Anon can create site settings for static admin" on public.site_settings;
drop policy if exists "Anon can update site settings for static admin" on public.site_settings;

create policy "Public can read site settings"
  on public.site_settings
  for select
  to anon
  using (true);

create policy "Anon can create site settings for static admin"
  on public.site_settings
  for insert
  to anon
  with check (
    id = 'storefront'
    and (phone_number = '' or length(regexp_replace(phone_number, '\D', '', 'g')) between 7 and 15)
  );

create policy "Anon can update site settings for static admin"
  on public.site_settings
  for update
  to anon
  using (id = 'storefront')
  with check (
    id = 'storefront'
    and (phone_number = '' or length(regexp_replace(phone_number, '\D', '', 'g')) between 7 and 15)
  );

insert into public.site_announcements (id, eyebrow, title, message, offer_text, cta_label, cta_url, is_active)
values (
  'homepage',
  'Store update',
  'New Arrivals Are Live',
  'Fresh apparel selections are now available at Anurag Apparel in Hazaribagh.',
  'Ask in store for current festive and seasonal offers.',
  'Get Directions',
  'https://maps.app.goo.gl/ZsyAXskboHbKB6RA6',
  true
)
on conflict (id) do nothing;

insert into public.site_settings (id, phone_number)
values ('storefront', '')
on conflict (id) do nothing;

-- The existing bucket is named product-images for compatibility, but it may store videos too.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Anon can upload product images" on storage.objects;
drop policy if exists "Anon can update product images" on storage.objects;
drop policy if exists "Anon can delete product images" on storage.objects;

create policy "Anon can upload product images"
  on storage.objects
  for insert
  to anon
  with check (bucket_id = 'product-images');

create policy "Anon can update product images"
  on storage.objects
  for update
  to anon
  using (bucket_id = 'product-images')
  with check (bucket_id = 'product-images');

create policy "Anon can delete product images"
  on storage.objects
  for delete
  to anon
  using (bucket_id = 'product-images');

do $$
begin
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'rls_auto_enable'
       and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
