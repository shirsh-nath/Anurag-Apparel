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
  gallery_images text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists products_created_at_idx
  on public.products (created_at desc);

create index if not exists products_is_active_idx
  on public.products (is_active);

alter table public.products enable row level security;

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
