-- Anurag Apparel Supabase setup
-- Run this in the Supabase SQL editor.
-- Important: browser-only hardcoded admin credentials can hide the UI, but they
-- cannot secure database writes. These demo policies allow the static admin
-- portal to work with the anon key. For production, replace them with Supabase
-- Auth, server-side admin actions, or Edge Functions using proper authorization.

create extension if not exists pgcrypto;

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

create or replace function public.set_site_announcements_updated_at()
returns trigger
language plpgsql
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

alter table public.products enable row level security;
alter table public.site_announcements enable row level security;

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

-- The existing bucket is named product-images for compatibility, but it may store videos too.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Public can read product images" on storage.objects;
drop policy if exists "Anon can upload product images" on storage.objects;
drop policy if exists "Anon can update product images" on storage.objects;
drop policy if exists "Anon can delete product images" on storage.objects;

create policy "Public can read product images"
  on storage.objects
  for select
  to anon
  using (bucket_id = 'product-images');

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
