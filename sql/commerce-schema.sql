-- Additive commerce extension. Apply after sql/supabase-schema.sql.
-- Legacy admin hardening is deliberately separate: commerce-security.sql.
-- New ordering remains sealed until that hardening is activated with the branch rollout.
-- No plaintext delivery code or admin session token is stored in the database.
create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;
alter table public.products add column if not exists stock_quantity integer not null default 0 check(stock_quantity>=0);
alter table public.products add column if not exists size_options text[] not null default '{}';
alter table public.products add column if not exists color_options text[] not null default '{}';

create table if not exists private.commerce_security_state(id boolean primary key default true check(id),sealed boolean not null default false);
insert into private.commerce_security_state(id) values(true) on conflict do nothing;
alter table private.commerce_security_state add column if not exists admin_password_ready boolean not null default false;
create table if not exists public.commerce_settings (
  id boolean primary key default true check(id), allow_orders boolean not null default false,
  max_orders_per_day integer not null default 50 check(max_orders_per_day between 1 and 10000),
  max_items_per_order integer not null default 20 check(max_items_per_order between 1 and 100),
  max_quantity_per_item integer not null default 10 check(max_quantity_per_item between 1 and 100),
  slot_capacity integer not null default 25 check(slot_capacity between 1 and 10000),
  timezone text not null default 'Asia/Kolkata', delivery_slots text[] not null default array['11:00','17:00'],
  default_slot_offset integer not null default 2 check(default_slot_offset between 1 and 28),
  slot_duration_minutes integer not null default 120 check(slot_duration_minutes between 15 and 1440),
  delivery_fee numeric(10,2) not null default 0 check(delivery_fee between 0 and 100000),
  min_order_amount numeric(10,2) not null default 0 check(min_order_amount between 0 and 10000000),
  store_latitude double precision not null default 23.9932828 check(store_latitude between -90 and 90),
  store_longitude double precision not null default 85.3593752 check(store_longitude between -180 and 180),
  delivery_radius_km numeric(8,2) not null default 0 check(delivery_radius_km between 0 and 1000),
  serviceable_pincodes text[] not null default '{}', delivery_code_enabled boolean not null default true,
  auto_delete_enabled boolean not null default false,
  customer_history_days integer not null default 180 check(customer_history_days between 0 and 3650),
  admin_history_days integer not null default 365 check(admin_history_days between 0 and 3650),
  email_templates jsonb not null default '{"booked":{"subject":"Your order {{order_number}} is booked","body":"Hi {{customer_name}},\nYour cash-on-delivery order {{order_number}} is booked.\nTotal: {{order_total}}\nDelivery slot: {{delivery_slot}}\nTrack your order: {{order_url}}\nThank you for shopping with Anurag Apparel."},"delivered":{"subject":"Order {{order_number}} delivered","body":"Hi {{customer_name}},\nYour order {{order_number}} has been delivered. Cash collected: {{order_total}}.\nThank you for shopping with Anurag Apparel."},"cancelled":{"subject":"Order {{order_number}} cancelled","body":"Hi {{customer_name}},\nYour order {{order_number}} was cancelled.\nReason: {{cancel_reason}}\nNo online payment was collected. Contact the store if you need help."}}',
  updated_at timestamptz not null default now()
);
create or replace function private.validate_commerce_settings() returns trigger
language plpgsql security invoker set search_path='' as $$
declare item text; event text;
begin
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then raise exception 'Invalid time zone'; end if;
  if cardinality(new.delivery_slots) not between 1 and 12 or array_position(new.delivery_slots,null) is not null then raise exception 'Choose 1 to 12 delivery slots'; end if;
  if (select count(distinct value) from unnest(new.delivery_slots) value)<>cardinality(new.delivery_slots) then raise exception 'Delivery slots must be unique'; end if;
  foreach item in array new.delivery_slots loop
    if item !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Delivery slots must use HH:MM'; end if;
  end loop;
  if cardinality(new.serviceable_pincodes)>500 or array_position(new.serviceable_pincodes,null) is not null then raise exception 'Invalid pincodes'; end if;
  foreach item in array new.serviceable_pincodes loop if item !~ '^[1-9][0-9]{5}$' then raise exception 'Invalid pincode'; end if; end loop;
  if jsonb_typeof(new.email_templates)<>'object' then raise exception 'Invalid email templates'; end if;
  foreach event in array array['booked','delivered','cancelled'] loop
    if jsonb_typeof(new.email_templates->event)<>'object' or coalesce(length(btrim(new.email_templates->event->>'subject')),0) not between 1 and 160
      or coalesce(length(btrim(new.email_templates->event->>'body')),0) not between 1 and 8000 or (new.email_templates->event->>'subject') ~ '[\r\n]' then raise exception 'Invalid % email template',event; end if;
  end loop;
  new.updated_at:=now(); return new;
end; $$;
drop trigger if exists validate_commerce_settings on public.commerce_settings;
create trigger validate_commerce_settings before insert or update on public.commerce_settings for each row execute function private.validate_commerce_settings();
insert into public.commerce_settings(id) values(true) on conflict do nothing;
create sequence if not exists private.commerce_order_number_seq;
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default ('AA-'||lpad(nextval('private.commerce_order_number_seq')::text,6,'0')),
  customer_id uuid not null references auth.users(id) on delete cascade,
  customer_name text not null,customer_email text not null,customer_phone text not null,address jsonb not null,
  status text not null default 'placed' check(status in('placed','confirmed','preparing','out_for_delivery','delivered','cancelled')),
  payment_method text not null default 'cod' check(payment_method='cod'),
  payment_status text not null default 'pending' check(payment_status in('pending','collected')),
  subtotal numeric(12,2) not null check(subtotal>=0),delivery_fee numeric(10,2) not null check(delivery_fee>=0),
  total numeric(12,2) not null check(total=subtotal+delivery_fee),slot_start timestamptz not null,slot_end timestamptz not null,
  delivery_code_required boolean not null,notes text not null default '',cancel_reason text not null default '',
  terminal_at timestamptz,idempotency_key uuid not null,request_hash text not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(customer_id,idempotency_key),check(slot_end>slot_start),
  check((status in('delivered','cancelled'))=(terminal_at is not null)),check(status='delivered' or payment_status='pending')
);
create index if not exists orders_customer_created_idx on public.orders(customer_id,created_at desc);
create index if not exists orders_created_idx on public.orders(created_at desc);
create index if not exists orders_active_slot_idx on public.orders(slot_start) where status not in('delivered','cancelled');
create index if not exists orders_terminal_idx on public.orders(terminal_at) where terminal_at is not null;
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,title text not null,image_url text not null default '',
  unit_price numeric(10,2) not null check(unit_price>=0),quantity integer not null check(quantity between 1 and 100),
  size text not null default '',color text not null default '',line_total numeric(12,2) not null check(line_total=unit_price*quantity)
);
create index if not exists order_items_order_idx on public.order_items(order_id);
create index if not exists order_items_product_idx on public.order_items(product_id);
create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete cascade,
  status text not null,message text not null default '',created_at timestamptz not null default now()
);
create index if not exists order_events_order_idx on public.order_events(order_id,created_at);
create table if not exists private.order_secrets (
  order_id uuid primary key references public.orders(id) on delete cascade,code_digest text not null,code_ciphertext text not null,
  failed_attempts integer not null default 0,locked_until timestamptz,last_attempt_at timestamptz
);
create table if not exists private.order_email_outbox (
  id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete cascade,
  event_type text not null check(event_type in('booked','delivered','cancelled')),template jsonb not null,
  state text not null default 'queued' check(state in('queued','sending','sent','failed')),attempts integer not null default 0,
  available_at timestamptz not null default now(),lease_token uuid,lease_until timestamptz,last_error text not null default '',
  created_at timestamptz not null default now(),sent_at timestamptz,unique(order_id,event_type)
);
-- Immutable rendering context keeps retries identical for the provider's
-- idempotency key even when the order, delivery slot or store settings change.
alter table private.order_email_outbox add column if not exists context jsonb;
create index if not exists order_email_available_idx on private.order_email_outbox(available_at) where state in('queued','sending');
create table if not exists private.commerce_admin_sessions(token_hash bytea primary key,expires_at timestamptz not null,created_at timestamptz not null default now());
create index if not exists commerce_admin_sessions_expiry_idx on private.commerce_admin_sessions(expires_at);
create table if not exists private.commerce_login_attempts(id boolean primary key default true check(id),failures integer not null default 0,window_start timestamptz not null default now(),locked_until timestamptz);
insert into private.commerce_login_attempts(id) values(true) on conflict do nothing;

do $$ declare name text; begin
  foreach name in array array['commerce_settings','orders','order_items','order_events'] loop
    execute format('alter table public.%I enable row level security',name);
    execute format('revoke all on public.%I from public,anon,authenticated',name);
    execute format('grant all on public.%I to service_role',name);
  end loop;
  foreach name in array array['commerce_security_state','order_secrets','order_email_outbox','commerce_admin_sessions','commerce_login_attempts'] loop
    execute format('alter table private.%I enable row level security',name);
    execute format('revoke all on private.%I from public,anon,authenticated',name);
    execute format('grant all on private.%I to service_role',name);
  end loop;
end; $$;
grant usage on schema private to service_role,anon,authenticated;
grant usage,select on sequence private.commerce_order_number_seq to service_role;

create or replace function private.commerce_token_valid(input_token text) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(length(input_token)=64 and input_token ~ '^[0-9a-f]+$' and exists(
    select 1 from private.commerce_admin_sessions where token_hash=extensions.digest(input_token,'sha256') and expires_at>now()),false);
$$;
create or replace function private.is_commerce_admin() returns boolean
language sql stable security definer set search_path='' as $$
  select private.commerce_token_valid(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-admin-session')
    and (select admin_password_ready from private.commerce_security_state where id);
$$;
create or replace function public.commerce_admin_session_valid() returns boolean
language sql stable security definer set search_path='' as $$
  select private.commerce_token_valid(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-admin-session');
$$;
create or replace function public.commerce_validate_admin_token(input_token text) returns boolean
language sql stable security definer set search_path='' as $$ select private.commerce_token_valid(input_token); $$;
create or replace function public.commerce_admin_login(input_username text,input_password text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare guard private.commerce_login_attempts; token text; expires timestamptz;
begin
  select * into guard from private.commerce_login_attempts where id for update;
  if guard.locked_until>now() then return jsonb_build_object('ok',false,'error','login_locked','retry_after',greatest(1,ceil(extract(epoch from guard.locked_until-now())))); end if;
  if guard.window_start<now()-interval '15 minutes' then
    update private.commerce_login_attempts set failures=0,window_start=now(),locked_until=null where id; guard.failures:=0;
  end if;
  if length(coalesce(input_username,''))>100 or octet_length(coalesce(input_password,''))>72 or not private.verify_admin_login(input_username,input_password) then
    update private.commerce_login_attempts set failures=guard.failures+1,locked_until=case when guard.failures+1>=5 then now()+interval '15 minutes' else null end where id;
    return jsonb_build_object('ok',false,'error','invalid_credentials');
  end if;
  -- Fingerprint of the historically published seed; never grant it a new session.
  if encode(extensions.digest(input_password,'sha256'),'hex')='fb109328f9aafbf6d50515aeb58fd115c0cf47224d60127af79cf96ca6f5c242' then
    return jsonb_build_object('ok',false,'error','weak_admin_password','message','Change the legacy administrator password before using the commerce dashboard.');
  end if;
  token:=encode(extensions.gen_random_bytes(32),'hex'); expires:=now()+interval '8 hours';
  insert into private.commerce_admin_sessions(token_hash,expires_at) values(extensions.digest(token,'sha256'),expires);
  update private.commerce_login_attempts set failures=0,window_start=now(),locked_until=null where id;
  return jsonb_build_object('ok',true,'token',token,'expires_at',expires,'password_change_required',not(select admin_password_ready from private.commerce_security_state where id));
end; $$;
create or replace function public.commerce_admin_logout(input_token text) returns boolean
language plpgsql security definer set search_path='' as $$
begin delete from private.commerce_admin_sessions where token_hash=extensions.digest(coalesce(input_token,''),'sha256'); return true; end; $$;

create or replace function private.commerce_customer_visible(input_terminal_at timestamptz) returns boolean
language sql stable security definer set search_path='' as $$
  select input_terminal_at is null or not auto_delete_enabled or customer_history_days=0 or input_terminal_at+customer_history_days*interval '1 day'>now() from public.commerce_settings where id;
$$;
create or replace function private.commerce_admin_visible(input_terminal_at timestamptz) returns boolean
language sql stable security definer set search_path='' as $$
  select input_terminal_at is null or not auto_delete_enabled or admin_history_days=0 or input_terminal_at+admin_history_days*interval '1 day'>now() from public.commerce_settings where id;
$$;
grant select on public.orders,public.order_items,public.order_events to authenticated;
drop policy if exists "Customers read own commerce orders" on public.orders;
create policy "Customers read own commerce orders" on public.orders for select to authenticated
  using(customer_id=(select auth.uid()) and private.commerce_customer_visible(terminal_at));
drop policy if exists "Customers read own order items" on public.order_items;
create policy "Customers read own order items" on public.order_items for select to authenticated
  using(exists(select 1 from public.orders o where o.id=order_id and o.customer_id=(select auth.uid())));
drop policy if exists "Customers read own order events" on public.order_events;
create policy "Customers read own order events" on public.order_events for select to authenticated
  using(exists(select 1 from public.orders o where o.id=order_id and o.customer_id=(select auth.uid())));
create or replace function private.commerce_order_json(input_order_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select (to_jsonb(o)-'idempotency_key'-'request_hash')||jsonb_build_object(
    'items',coalesce((select jsonb_agg(to_jsonb(i)-'order_id' order by i.id) from public.order_items i where i.order_id=o.id),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(to_jsonb(e)-'order_id' order by e.created_at,e.id) from public.order_events e where e.order_id=o.id),'[]'::jsonb)
  ) from public.orders o where o.id=input_order_id;
$$;
-- Administrative email delivery metadata is deliberately separate from the
-- customer JSON projection. No provider error, template or lease token is exposed.
create or replace function private.commerce_order_admin_json(input_order_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select private.commerce_order_json(input_order_id)||jsonb_build_object(
    'email_status',coalesce((select case
      when bool_or(state='failed') then 'failed'
      when bool_or(state='sending') then 'sending'
      when bool_or(state='queued') then 'queued'
      when bool_and(state='sent') then 'sent'
      else 'none' end from private.order_email_outbox where order_id=input_order_id),'none'),
    'email_events',coalesce((select jsonb_agg(jsonb_build_object(
      'event_type',event_type,'state',state,'attempts',attempts,'sent_at',sent_at,
      'can_retry',state='failed' and created_at>now()-interval '23 hours') order by created_at,event_type)
      from private.order_email_outbox where order_id=input_order_id),'[]'::jsonb));
$$;
create or replace function public.commerce_get_settings(input_public boolean default true) returns jsonb
language sql stable security definer set search_path='' as $$
  select (case when input_public then to_jsonb(s)-'email_templates'-'customer_history_days'-'admin_history_days'-'auto_delete_enabled' else to_jsonb(s) end)
    ||jsonb_build_object('security_ready',(select sealed from private.commerce_security_state where id),'admin_password_ready',(select admin_password_ready from private.commerce_security_state where id))
    ||case when input_public then jsonb_build_object('allow_orders',s.allow_orders and(select sealed and admin_password_ready from private.commerce_security_state where id)) else '{}'::jsonb end
    from public.commerce_settings s where id;
$$;
create or replace function private.commerce_select_slot(input_settings public.commerce_settings,input_slot_start timestamptz default null,input_exclude_order uuid default null) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare candidate timestamptz; seen integer:=0; occupied integer;
begin
  if input_slot_start is not null and input_slot_start<=now() then raise exception 'Delivery slot must be in the future'; end if;
  for candidate in
    select ((day_value::date+slot::time) at time zone input_settings.timezone)
    from generate_series((now() at time zone input_settings.timezone)::date,(now() at time zone input_settings.timezone)::date+60,interval '1 day') day_value
    cross join unnest(input_settings.delivery_slots) slot
    where ((day_value::date+slot::time) at time zone input_settings.timezone)>now() order by 1
  loop
    if input_slot_start is not null then if candidate<>input_slot_start then continue; end if;
    else seen:=seen+1; if seen<input_settings.default_slot_offset then continue; end if; end if;
    select count(*) into occupied from public.orders where slot_start=candidate and status<>'cancelled' and (input_exclude_order is null or id<>input_exclude_order);
    if occupied<input_settings.slot_capacity then return candidate; end if;
    if input_slot_start is not null then raise exception 'Delivery slot is full'; end if;
  end loop;
  raise exception 'No available delivery slot in the next 60 days';
end; $$;
create or replace function private.commerce_validate_address(input_address jsonb,input_settings public.commerce_settings) returns void
language plpgsql security invoker set search_path='' as $$
declare lat double precision; lng double precision; distance_km double precision;
begin
  if jsonb_typeof(input_address)<>'object' then raise exception 'Delivery address is required'; end if;
  if coalesce(length(btrim(input_address->>'recipient')),0) not between 2 and 100 or coalesce(input_address->>'phone','') !~ '^\+[1-9][0-9]{7,14}$'
    or coalesce(length(btrim(input_address->>'line1')),0) not between 5 and 250 or coalesce(length(btrim(input_address->>'city')),0) not between 2 and 100
    or coalesce(length(btrim(input_address->>'state')),0) not between 2 and 100 or coalesce(input_address->>'postal_code','') !~ '^[1-9][0-9]{5}$'
    or length(coalesce(input_address->>'line2',''))>250 or length(coalesce(input_address->>'landmark',''))>250 then raise exception 'Check the delivery name, phone, full address and pincode'; end if;
  begin lat:=(input_address->>'latitude')::double precision; lng:=(input_address->>'longitude')::double precision;
  exception when others then raise exception 'Select a valid delivery map location'; end;
  if lat is null or lng is null or not(lat between -90 and 90) or not(lng between -180 and 180) then raise exception 'Select a valid delivery map location'; end if;
  if cardinality(input_settings.serviceable_pincodes)>0 and not(input_address->>'postal_code'=any(input_settings.serviceable_pincodes)) then raise exception 'This pincode is outside the delivery area'; end if;
  distance_km:=6371*2*asin(sqrt(least(1.0,power(sin(radians(lat-input_settings.store_latitude)/2),2)+cos(radians(input_settings.store_latitude))*cos(radians(lat))*power(sin(radians(lng-input_settings.store_longitude)/2),2))));
  if input_settings.delivery_radius_km>0 and distance_km>input_settings.delivery_radius_km then raise exception 'This map location is outside the delivery radius'; end if;
end; $$;
create or replace function private.commerce_quote_data(input_customer_id uuid,input_items jsonb,input_address jsonb,input_slot_start timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.commerce_settings; item jsonb; product public.products; quantity integer; size text; color text; lines jsonb:='[]'; subtotal numeric:=0; slot timestamptz; total_quantity integer;
begin
  select * into s from public.commerce_settings where id;
  if not s.allow_orders or not(select sealed and admin_password_ready from private.commerce_security_state where id) then raise exception 'Online orders are currently off. Please visit the store.'; end if;
  if not exists(select 1 from auth.users where id=input_customer_id and email is not null and email_confirmed_at is not null) then raise exception 'A verified customer account is required'; end if;
  if not exists(select 1 from public.customer_profiles where id=input_customer_id) then raise exception 'Complete your customer profile before ordering'; end if;
  if jsonb_typeof(input_items)<>'array' or coalesce(jsonb_array_length(input_items),0) not between 1 and s.max_items_per_order then raise exception 'Check the cart item limit'; end if;
  if input_address is not null then perform private.commerce_validate_address(input_address,s); end if;
  for item in select value from jsonb_array_elements(input_items) loop
    begin quantity:=(item->>'quantity')::integer; exception when others then raise exception 'Invalid item quantity'; end;
    if quantity is null or quantity not between 1 and s.max_quantity_per_item then raise exception 'Check the item quantity limit'; end if;
    select * into product from public.products where id=(item->>'product_id')::uuid;
    if not found or not product.is_active or product.price is null then raise exception 'A cart product is not available to order'; end if;
    size:=coalesce(item->>'size',''); color:=coalesce(item->>'color','');
    if length(size)>80 or length(color)>80 or (cardinality(product.size_options)>0 and not(size=any(product.size_options))) or (cardinality(product.color_options)>0 and not(color=any(product.color_options)))
      or (cardinality(product.size_options)=0 and size<>'') or (cardinality(product.color_options)=0 and color<>'') then raise exception 'Choose an available size and colour'; end if;
    select sum((x->>'quantity')::integer) into total_quantity from jsonb_array_elements(input_items) x where (x->>'product_id')::uuid=product.id;
    if total_quantity>product.stock_quantity then raise exception 'Insufficient stock for %',product.title; end if;
    select sum((x->>'quantity')::integer) into total_quantity from jsonb_array_elements(input_items) x where (x->>'product_id')::uuid=product.id and coalesce(x->>'size','')=size and coalesce(x->>'color','')=color;
    if total_quantity>s.max_quantity_per_item then raise exception 'Check the item quantity limit'; end if;
    subtotal:=subtotal+product.price*quantity;
    lines:=lines||jsonb_build_array(jsonb_build_object('product_id',product.id,'title',product.title,'image_url',coalesce(product.gallery_images[1],''),'unit_price',product.price,'quantity',quantity,'size',size,'color',color,'line_total',product.price*quantity));
  end loop;
  if subtotal<s.min_order_amount then raise exception 'The order is below the minimum amount'; end if;
  slot:=private.commerce_select_slot(s,input_slot_start);
  return jsonb_build_object('items',lines,'subtotal',subtotal,'delivery_fee',s.delivery_fee,'total',subtotal+s.delivery_fee,'currency','INR','payment_method','cod','slot_start',slot,'slot_end',slot+s.slot_duration_minutes*interval '1 minute','delivery_code_required',s.delivery_code_enabled);
end; $$;
create or replace function public.commerce_quote(input_customer_id uuid,input_items jsonb,input_address jsonb default null,input_slot_start timestamptz default null) returns jsonb
language sql security definer set search_path='' as $$ select private.commerce_quote_data(input_customer_id,input_items,input_address,input_slot_start); $$;

create or replace function private.commerce_queue_email(input_order_id uuid,input_event text) returns void
language sql security definer set search_path='' as $$
  insert into private.order_email_outbox(order_id,event_type,template,context)
    select input_order_id,input_event,s.email_templates->input_event,jsonb_build_object(
      'order',private.commerce_order_json(input_order_id),'timezone',s.timezone,
      'store',coalesce((select jsonb_build_object('email_address',email_address,'phone_number',phone_number)
        from public.site_settings where id='storefront'),'{}'::jsonb))
    from public.commerce_settings s where s.id on conflict(order_id,event_type) do nothing;
$$;
create or replace function public.commerce_create_order(input_order_id uuid,input_customer_id uuid,input_items jsonb,input_address jsonb,input_notes text,input_idempotency_key uuid,input_request_hash text,input_code_digest text,input_code_ciphertext text,input_expected_total numeric,input_expected_slot_start timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.commerce_settings; existing public.orders; quote jsonb; oid uuid:=input_order_id; item jsonb; email text; daily_count integer; normalized_address jsonb;
begin
  -- Serialize settings/daily/slot capacity, idempotency and inventory reservation.
  select * into s from public.commerce_settings where id for update;
  select * into existing from public.orders where customer_id=input_customer_id and idempotency_key=input_idempotency_key;
  if found then
    if existing.request_hash<>input_request_hash then raise exception 'Idempotency key was already used for another checkout'; end if;
    if not private.commerce_customer_visible(existing.terminal_at) then raise insufficient_privilege using message='Order history is no longer available'; end if;
    return private.commerce_order_json(existing.id);
  end if;
  if oid is null or input_idempotency_key is null or coalesce(input_request_hash,'') !~ '^[a-f0-9]{64}$' or length(coalesce(input_notes,''))>1000 or input_expected_total is null or input_expected_slot_start is null then raise exception 'Invalid checkout request'; end if;
  if input_address is null then raise exception 'Delivery address is required'; end if;
  perform 1 from public.products p where p.id in(select (x->>'product_id')::uuid from jsonb_array_elements(input_items) x) order by p.id for update;
  quote:=private.commerce_quote_data(input_customer_id,input_items,input_address,null);
  if (quote->>'total')::numeric<>input_expected_total then raise exception 'PRICE_CHANGED: Prices changed. Review the updated total before placing your order.'; end if;
  if (quote->>'slot_start')::timestamptz<>input_expected_slot_start then raise exception 'SLOT_CHANGED: Delivery availability changed. Review the new slot before placing your order.'; end if;
  select count(*) into daily_count from public.orders where created_at>=((now() at time zone s.timezone)::date::timestamp at time zone s.timezone) and created_at<(((now() at time zone s.timezone)::date+1)::timestamp at time zone s.timezone);
  if daily_count>=s.max_orders_per_day then raise exception 'Today''s order limit has been reached. Please try tomorrow.'; end if;
  if s.delivery_code_enabled and (coalesce(input_code_digest,'') !~ '^[a-f0-9]{64}$' or coalesce(length(input_code_ciphertext),0) not between 20 and 2000) then raise exception 'Delivery-code protection is not configured'; end if;
  select u.email into email from auth.users u where u.id=input_customer_id;
  normalized_address:=jsonb_build_object('recipient',btrim(input_address->>'recipient'),'phone',input_address->>'phone','line1',btrim(input_address->>'line1'),'line2',btrim(coalesce(input_address->>'line2','')),'landmark',btrim(coalesce(input_address->>'landmark','')),'city',btrim(input_address->>'city'),'state',btrim(input_address->>'state'),'postal_code',input_address->>'postal_code','latitude',(input_address->>'latitude')::double precision,'longitude',(input_address->>'longitude')::double precision);
  insert into public.orders(id,customer_id,customer_name,customer_email,customer_phone,address,subtotal,delivery_fee,total,slot_start,slot_end,delivery_code_required,notes,idempotency_key,request_hash)
    values(oid,input_customer_id,normalized_address->>'recipient',email,normalized_address->>'phone',normalized_address,(quote->>'subtotal')::numeric,(quote->>'delivery_fee')::numeric,(quote->>'total')::numeric,(quote->>'slot_start')::timestamptz,(quote->>'slot_end')::timestamptz,s.delivery_code_enabled,btrim(coalesce(input_notes,'')),input_idempotency_key,input_request_hash);
  for item in select value from jsonb_array_elements(quote->'items') loop
    insert into public.order_items(order_id,product_id,title,image_url,unit_price,quantity,size,color,line_total)
      values(oid,(item->>'product_id')::uuid,item->>'title',item->>'image_url',(item->>'unit_price')::numeric,(item->>'quantity')::integer,item->>'size',item->>'color',(item->>'line_total')::numeric);
    update public.products set stock_quantity=stock_quantity-(item->>'quantity')::integer where id=(item->>'product_id')::uuid;
  end loop;
  if s.delivery_code_enabled then insert into private.order_secrets(order_id,code_digest,code_ciphertext) values(oid,input_code_digest,input_code_ciphertext); end if;
  insert into public.order_events(order_id,status,message) values(oid,'placed','Order booked. Payment: cash on delivery.');
  perform private.commerce_queue_email(oid,'booked');
  return private.commerce_order_json(oid);
end; $$;

create or replace function public.commerce_list_orders(input_customer_id uuid default null,input_admin boolean default false,input_filter text default 'all',input_status text default null,input_search text default '',input_from date default null,input_to date default null,input_page integer default 1,input_limit integer default 25) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.commerce_settings; count_total integer; data jsonb; page_no integer:=greatest(1,coalesce(input_page,1)); limit_no integer:=least(100,greatest(1,coalesce(input_limit,25)));
begin
  select * into s from public.commerce_settings where id;
  if not input_admin and input_customer_id is null then raise insufficient_privilege; end if;
  with selected as (
    select o.id,o.created_at from public.orders o
    where (input_admin or o.customer_id=input_customer_id)
      and (o.terminal_at is null or not s.auto_delete_enabled or (case when input_admin then s.admin_history_days else s.customer_history_days end)=0 or o.terminal_at+(case when input_admin then s.admin_history_days else s.customer_history_days end)*interval '1 day'>now())
      and (input_filter='all' or (input_filter='active' and o.terminal_at is null) or (input_filter='past' and o.terminal_at is not null))
      and (input_status is null or input_status='' or o.status=input_status)
      and (coalesce(input_search,'')='' or o.order_number ilike '%'||left(input_search,100)||'%' or o.customer_name ilike '%'||left(input_search,100)||'%' or (input_admin and (o.customer_phone ilike '%'||left(input_search,100)||'%' or o.customer_email ilike '%'||left(input_search,100)||'%')))
      and (input_from is null or (o.slot_start at time zone s.timezone)::date>=input_from) and (input_to is null or (o.slot_start at time zone s.timezone)::date<=input_to)
  ), paged as(select * from selected order by created_at desc,id limit limit_no offset (page_no-1)*limit_no)
  select (select count(*) from selected),coalesce((select jsonb_agg(case when input_admin then private.commerce_order_admin_json(id) else private.commerce_order_json(id) end order by created_at desc,id) from paged),'[]'::jsonb) into count_total,data;
  return jsonb_build_object('orders',data,'total',count_total,'page',page_no,'page_size',limit_no);
end; $$;
create or replace function public.commerce_list_customers(input_search text default '',input_page integer default 1,input_limit integer default 25) returns jsonb
language sql stable security definer set search_path='' as $$
  with selected as(
    select u.id,u.email,coalesce(p.full_name,u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name','') as full_name,coalesce(p.phone,'') as phone,u.created_at,p.updated_at,u.last_sign_in_at,(u.email_confirmed_at is not null) as email_verified,
      (select count(*) from public.orders o where o.customer_id=u.id) as order_count
    from auth.users u left join public.customer_profiles p on p.id=u.id
    where coalesce(input_search,'')='' or coalesce(p.full_name,'') ilike '%'||left(input_search,100)||'%' or coalesce(p.phone,'') ilike '%'||left(input_search,100)||'%' or coalesce(u.email,'') ilike '%'||left(input_search,100)||'%'
  ), paged as(select * from selected order by created_at desc,id limit least(100,greatest(1,coalesce(input_limit,25))) offset (greatest(1,coalesce(input_page,1))-1)*least(100,greatest(1,coalesce(input_limit,25))))
  select jsonb_build_object('customers',coalesce((select jsonb_agg(to_jsonb(paged) order by created_at desc,id) from paged),'[]'::jsonb),'total',(select count(*) from selected),'page',greatest(1,coalesce(input_page,1)),'page_size',least(100,greatest(1,coalesce(input_limit,25))));
$$;
create or replace function public.commerce_order_secret(input_order_id uuid,input_customer_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare encrypted text;
begin
  select sec.code_ciphertext into encrypted from private.order_secrets sec join public.orders o on o.id=sec.order_id where o.id=input_order_id and o.customer_id=input_customer_id and o.terminal_at is null and o.delivery_code_required;
  if encrypted is null then raise insufficient_privilege using message='Delivery code is unavailable'; end if;
  return jsonb_build_object('ciphertext',encrypted);
end; $$;
create or replace function public.commerce_delivery_context(input_order_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('customer_id',customer_id,'delivery_code_required',delivery_code_required) from public.orders where id=input_order_id;
$$;

create or replace function public.commerce_update_order(input_order_id uuid,input_status text default null,input_slot_start timestamptz default null,input_cancel_reason text default '',input_actor text default 'admin',input_customer_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.commerce_settings; o public.orders; new_slot timestamptz; restored record;
begin
  select * into s from public.commerce_settings where id for update;
  select * into o from public.orders where id=input_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if input_actor not in('admin','customer') then raise insufficient_privilege; end if;
  if input_actor='customer' and (o.customer_id<>input_customer_id or input_customer_id is null or o.status<>'placed' or input_status<>'cancelled' or input_slot_start is not null) then raise insufficient_privilege using message='Only a newly placed order can be cancelled by its customer'; end if;
  if o.terminal_at is not null then raise exception 'Completed and cancelled orders cannot be changed'; end if;
  if input_status is not null and input_status<>o.status then
    if input_status='delivered' then raise exception 'Complete delivery through the delivery verification action'; end if;
    if input_status='cancelled' then
      if length(btrim(coalesce(input_cancel_reason,''))) not between 2 and 500 then raise exception 'Enter a cancellation reason'; end if;
      for restored in select product_id,sum(quantity) quantity from public.order_items where order_id=o.id and product_id is not null group by product_id order by product_id loop
        update public.products set stock_quantity=stock_quantity+restored.quantity where id=restored.product_id;
      end loop;
      update public.orders set status='cancelled',cancel_reason=btrim(input_cancel_reason),terminal_at=now(),updated_at=now() where id=o.id;
      delete from private.order_secrets where order_id=o.id;
      perform private.commerce_queue_email(o.id,'cancelled');
    elsif (o.status='placed' and input_status='confirmed') or (o.status='confirmed' and input_status='preparing') or (o.status='preparing' and input_status='out_for_delivery') then
      update public.orders set status=input_status,updated_at=now() where id=o.id;
    else raise exception 'Invalid order status transition'; end if;
    insert into public.order_events(order_id,status,message) values(o.id,input_status,case when input_status='cancelled' then btrim(input_cancel_reason) else replace(initcap(input_status),'_',' ') end);
  end if;
  if input_slot_start is not null then
    if input_status='cancelled' then raise exception 'Cancelled orders cannot be rescheduled'; end if;
    new_slot:=private.commerce_select_slot(s,input_slot_start,o.id);
    update public.orders set slot_start=new_slot,slot_end=new_slot+s.slot_duration_minutes*interval '1 minute',updated_at=now() where id=o.id;
    insert into public.order_events(order_id,status,message) select o.id,status,'Delivery slot updated by the store.' from public.orders where id=o.id;
  end if;
  return case when input_actor='admin' then private.commerce_order_admin_json(o.id) else private.commerce_order_json(o.id) end;
end; $$;
create or replace function public.commerce_complete_delivery(input_order_id uuid,input_candidate_digest text default '',input_payment_collected boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.orders; secret private.order_secrets; failures integer;
begin
  select * into o from public.orders where id=input_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status='delivered' then
    if not private.commerce_admin_visible(o.terminal_at) then return jsonb_build_object('ok',true,'already_completed',true); end if;
    return jsonb_build_object('ok',true,'order',private.commerce_order_admin_json(o.id));
  end if;
  if o.status<>'out_for_delivery' then raise exception 'Mark the order out for delivery first'; end if;
  if not coalesce(input_payment_collected,false) then return jsonb_build_object('ok',false,'error','payment_not_collected'); end if;
  if o.delivery_code_required then
    select * into secret from private.order_secrets where order_id=o.id for update;
    if not found then raise exception 'Delivery verification is unavailable'; end if;
    if secret.locked_until>now() then return jsonb_build_object('ok',false,'error','code_locked','retry_after',greatest(1,ceil(extract(epoch from secret.locked_until-now())))); end if;
    if secret.last_attempt_at is null or secret.last_attempt_at<now()-interval '15 minutes' or secret.locked_until is not null then secret.failed_attempts:=0; end if;
    if coalesce(input_candidate_digest,'')<>secret.code_digest then
      failures:=secret.failed_attempts+1;
      update private.order_secrets set failed_attempts=failures,last_attempt_at=now(),locked_until=case when failures>=5 then now()+interval '15 minutes' else null end where order_id=o.id;
      return jsonb_build_object('ok',false,'error',case when failures>=5 then 'code_locked' else 'invalid_code' end,'attempts_remaining',greatest(0,5-failures),'retry_after',case when failures>=5 then 900 else 0 end);
    end if;
  end if;
  update public.orders set status='delivered',payment_status='collected',terminal_at=now(),updated_at=now() where id=o.id;
  delete from private.order_secrets where order_id=o.id;
  insert into public.order_events(order_id,status,message) values(o.id,'delivered','Delivery completed and cash payment collected.');
  perform private.commerce_queue_email(o.id,'delivered');
  return jsonb_build_object('ok',true,'order',private.commerce_order_admin_json(o.id));
end; $$;
create or replace function public.commerce_delete_order(input_order_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare state text;
begin
  select status into state from public.orders where id=input_order_id for update;
  if not found then return jsonb_build_object('deleted',false); end if;
  if state not in('cancelled','delivered') then raise exception 'Only completed or cancelled orders can be permanently deleted'; end if;
  delete from public.orders where id=input_order_id;
  return jsonb_build_object('deleted',true);
end; $$;

create or replace function public.commerce_save_settings(input_settings jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare current_row public.commerce_settings; updated public.commerce_settings; unknown text;
begin
  if jsonb_typeof(input_settings)<>'object' then raise exception 'Invalid settings'; end if;
  select key into unknown from jsonb_object_keys(input_settings) key where key not in('allow_orders','max_orders_per_day','max_items_per_order','max_quantity_per_item','slot_capacity','timezone','delivery_slots','default_slot_offset','slot_duration_minutes','delivery_fee','min_order_amount','store_latitude','store_longitude','delivery_radius_km','serviceable_pincodes','delivery_code_enabled','auto_delete_enabled','customer_history_days','admin_history_days','email_templates') limit 1;
  if unknown is not null then raise exception 'Unsupported setting: %',unknown; end if;
  select * into current_row from public.commerce_settings where id for update;
  select * into updated from jsonb_populate_record(current_row,input_settings);
  if updated.allow_orders then
    if not(select sealed from private.commerce_security_state where id) then raise exception 'Deploy the secure admin rollout before enabling orders'; end if;
    if not(select admin_password_ready from private.commerce_security_state where id) then raise exception 'Change the administrator password before enabling orders'; end if;
  end if;
  update public.commerce_settings set
    allow_orders=updated.allow_orders,max_orders_per_day=updated.max_orders_per_day,max_items_per_order=updated.max_items_per_order,max_quantity_per_item=updated.max_quantity_per_item,
    slot_capacity=updated.slot_capacity,timezone=updated.timezone,delivery_slots=updated.delivery_slots,default_slot_offset=updated.default_slot_offset,slot_duration_minutes=updated.slot_duration_minutes,
    delivery_fee=updated.delivery_fee,min_order_amount=updated.min_order_amount,store_latitude=updated.store_latitude,store_longitude=updated.store_longitude,delivery_radius_km=updated.delivery_radius_km,
    serviceable_pincodes=updated.serviceable_pincodes,delivery_code_enabled=updated.delivery_code_enabled,auto_delete_enabled=updated.auto_delete_enabled,customer_history_days=updated.customer_history_days,admin_history_days=updated.admin_history_days,email_templates=updated.email_templates where id;
  return public.commerce_get_settings(false);
end; $$;
create or replace function public.commerce_get_inventory() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'price',price,'is_active',is_active,'stock_quantity',stock_quantity,'size_options',size_options,'color_options',color_options) order by title),'[]'::jsonb) from public.products;
$$;
create or replace function public.commerce_save_inventory(input_product_id uuid,input_stock_quantity integer,input_size_options text[] default '{}',input_color_options text[] default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare option text; result jsonb;
begin
  if input_stock_quantity is null or input_stock_quantity not between 0 and 1000000 or cardinality(input_size_options)>50 or cardinality(input_color_options)>50 or input_size_options is null or input_color_options is null then raise exception 'Invalid inventory values'; end if;
  foreach option in array input_size_options||input_color_options loop if option is null or length(btrim(option)) not between 1 and 80 then raise exception 'Invalid size or colour option'; end if; end loop;
  update public.products set stock_quantity=input_stock_quantity,size_options=input_size_options,color_options=input_color_options where id=input_product_id;
  if not found then raise exception 'Product not found'; end if;
  select jsonb_build_object('id',id,'stock_quantity',stock_quantity,'size_options',size_options,'color_options',color_options) into result from public.products where id=input_product_id;
  return result;
end; $$;
create or replace function public.commerce_claim_emails(input_limit integer default 10) returns jsonb
language plpgsql security definer set search_path='' as $$
declare row private.order_email_outbox; result jsonb:='[]'; lease uuid; zone text;
begin
  select timezone into zone from public.commerce_settings where id;
  for row in select * from private.order_email_outbox where (state='queued' and available_at<=now()) or (state='sending' and lease_until<now()) order by created_at limit least(50,greatest(1,input_limit)) for update skip locked loop
    if row.attempts>=5 or row.created_at<now()-interval '23 hours' then
      update private.order_email_outbox set state='failed',last_error='Automatic retry limit reached',lease_until=null where id=row.id; continue;
    end if;
    lease:=gen_random_uuid();
    update private.order_email_outbox set state='sending',attempts=attempts+1,lease_token=lease,lease_until=now()+interval '5 minutes' where id=row.id;
    result:=result||jsonb_build_array(jsonb_build_object('id',row.id,'order_id',row.order_id,'event_type',row.event_type,'template',row.template,'lease_token',lease,'attempts',row.attempts+1,'timezone',coalesce(row.context->>'timezone',zone),'order',coalesce(row.context->'order',private.commerce_order_json(row.order_id)),'store',row.context->'store'));
  end loop;
  return result;
end; $$;
create or replace function public.commerce_finish_email(input_email_id uuid,input_lease_token uuid,input_success boolean,input_error text default '') returns boolean
language plpgsql security definer set search_path='' as $$
begin
  update private.order_email_outbox set state=case when input_success then 'sent' when attempts>=5 or created_at<now()-interval '23 hours' then 'failed' else 'queued' end,
    sent_at=case when input_success then now() else null end,last_error=case when input_success then '' else left(coalesce(input_error,'Provider delivery failed'),250) end,
    available_at=now()+least(3600,power(2,attempts)::integer*60)*interval '1 second',lease_token=null,lease_until=null where id=input_email_id and lease_token=input_lease_token and state='sending';
  return found;
end; $$;
create or replace function public.commerce_retry_emails(input_order_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare changed integer; terminal timestamptz;
begin
  select terminal_at into terminal from public.orders where id=input_order_id for update;
  if not found or not private.commerce_admin_visible(terminal) then return jsonb_build_object('queued',0,'order',null); end if;
  -- Keep the original idempotency identity; do not retry beyond provider deduplication.
  update private.order_email_outbox set state='queued',available_at=now(),attempts=0,last_error='',lease_token=null,lease_until=null where order_id=input_order_id and state='failed' and created_at>now()-interval '23 hours';
  get diagnostics changed=row_count;
  return jsonb_build_object('queued',changed,'order',private.commerce_order_admin_json(input_order_id));
end; $$;
create or replace function public.commerce_housekeeping() returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.commerce_settings; count_deleted integer:=0; sessions_deleted integer;
begin
  select * into s from public.commerce_settings where id for update;
  if s.auto_delete_enabled and s.customer_history_days>0 and s.admin_history_days>0 then
    delete from public.orders where terminal_at is not null and terminal_at+greatest(s.customer_history_days,s.admin_history_days)*interval '1 day'<=now();
    get diagnostics count_deleted=row_count;
  end if;
  delete from private.commerce_admin_sessions where expires_at<=now(); get diagnostics sessions_deleted=row_count;
  return jsonb_build_object('deleted_orders',count_deleted,'expired_admin_sessions',sessions_deleted);
end; $$;

-- PostgreSQL defaults function EXECUTE to PUBLIC; explicitly narrow each API/helper.
do $$ declare r record; begin
  for r in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname like 'commerce_%') or (n.nspname='private' and (p.proname like 'commerce_%' or p.proname in('is_commerce_admin','validate_commerce_settings')))
  loop
    execute format('revoke all on function %I.%I(%s) from public,anon,authenticated',r.nspname,r.proname,r.args);
    execute format('grant execute on function %I.%I(%s) to service_role',r.nspname,r.proname,r.args);
  end loop;
end; $$;
grant execute on function private.is_commerce_admin(),private.commerce_customer_visible(timestamptz) to anon,authenticated;
grant execute on function public.commerce_admin_login(text,text),public.commerce_admin_session_valid(),public.commerce_admin_logout(text) to anon,authenticated;
