-- Execute after commerce-schema.sql. Synthetic fixtures and settings changes roll back.
-- No mail worker is called; transactional outbox fixtures never become visible.
begin;
create or replace function pg_temp.assert_true(input_value boolean,input_message text) returns void language plpgsql as $$
begin if not coalesce(input_value,false) then raise exception 'FAIL: %',input_message; end if; end; $$;
select set_config('test.customer_a',gen_random_uuid()::text,true);
select set_config('test.customer_b',gen_random_uuid()::text,true);
select set_config('test.product_a',gen_random_uuid()::text,true);
select set_config('test.order_a',gen_random_uuid()::text,true);
select set_config('test.order_b',gen_random_uuid()::text,true);
select set_config('test.key_a',gen_random_uuid()::text,true);
insert into auth.users(id,email,email_confirmed_at) values
  (current_setting('test.customer_a')::uuid,current_setting('test.customer_a')||'@example.invalid',now()),
  (current_setting('test.customer_b')::uuid,current_setting('test.customer_b')||'@example.invalid',now());
insert into public.customer_profiles(id,full_name,phone) values
  (current_setting('test.customer_a')::uuid,'Commerce Test A','+919876543210'),
  (current_setting('test.customer_b')::uuid,'Commerce Test B','+919876543211');
insert into public.products(id,title,price,stock_quantity,size_options,color_options) values
  (current_setting('test.product_a')::uuid,'Commerce Test Product',125,12,array['M','L'],array['Blue']);
select set_config('test.cart',jsonb_build_array(jsonb_build_object('product_id',current_setting('test.product_a'),'quantity',2,'size','M','color','Blue'))::text,true);
select set_config('test.address','{"recipient":"Commerce Test A","phone":"+919876543210","line1":"123 Test Street","line2":"","landmark":"Test landmark","city":"Hazaribagh","state":"Jharkhand","postal_code":"825301","latitude":23.9932828,"longitude":85.3593752}'::text,true);

-- Ordering cannot be enabled before the irreversible security rollout and password review.
update private.commerce_security_state set sealed=false,admin_password_ready=false where id;
do $$ begin
  begin
    perform public.commerce_save_settings('{"allow_orders":true}');
    raise exception 'Unsealed ordering could be enabled';
  exception when others then
    if sqlerrm not like 'Deploy the secure admin rollout%' then raise; end if;
  end;
end; $$;
update private.commerce_security_state set sealed=true where id;
do $$ begin
  begin
    perform public.commerce_save_settings('{"allow_orders":true}');
    raise exception 'Unreviewed password could enable ordering';
  exception when others then
    if sqlerrm not like 'Change the administrator password%' then raise; end if;
  end;
end; $$;
update private.commerce_security_state set admin_password_ready=true where id;
update public.commerce_settings set allow_orders=true,max_orders_per_day=10000,slot_capacity=10000,
  delivery_slots=array['09:00','15:00','21:00'],default_slot_offset=2,delivery_fee=20,
  delivery_radius_km=5,serviceable_pincodes=array['825301'],delivery_code_enabled=true where id;

do $$
declare quote jsonb; booked jsonb; retried jsonb; expected_slot timestamptz;
begin
  quote:=public.commerce_quote(current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,null);
  perform pg_temp.assert_true((quote->>'subtotal')::numeric=250 and (quote->>'total')::numeric=270,'server prices and delivery fee');
  select candidate into expected_slot from (
    select ((d::date+s::time) at time zone 'Asia/Kolkata') candidate
    from generate_series((now() at time zone 'Asia/Kolkata')::date,(now() at time zone 'Asia/Kolkata')::date+3,interval '1 day') d
    cross join unnest(array['09:00','15:00','21:00']) s
  ) times where candidate>now() order by candidate offset 1 limit 1;
  perform pg_temp.assert_true((quote->>'slot_start')::timestamptz=expected_slot,'default is second upcoming slot');
  begin
    perform public.commerce_create_order(current_setting('test.order_a')::uuid,current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,'',current_setting('test.key_a')::uuid,repeat('a',64),repeat('a',64),repeat('x',48),1,(quote->>'slot_start')::timestamptz);
    raise exception 'Customer-supplied lower total was accepted';
  exception when others then if sqlerrm not like 'PRICE_CHANGED:%' then raise; end if; end;
  begin
    perform public.commerce_create_order(current_setting('test.order_a')::uuid,current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,'',current_setting('test.key_a')::uuid,repeat('a',64),repeat('a',64),repeat('x',48),(quote->>'total')::numeric,(quote->>'slot_start')::timestamptz+interval '1 day');
    raise exception 'Changed delivery slot was accepted';
  exception when others then if sqlerrm not like 'SLOT_CHANGED:%' then raise; end if; end;
  booked:=public.commerce_create_order(current_setting('test.order_a')::uuid,current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,'Test notes',current_setting('test.key_a')::uuid,repeat('a',64),repeat('a',64),repeat('x',48),(quote->>'total')::numeric,(quote->>'slot_start')::timestamptz);
  retried:=public.commerce_create_order(gen_random_uuid(),current_setting('test.customer_a')::uuid,'[]','{}','',current_setting('test.key_a')::uuid,repeat('a',64),'','',null,null);
  perform pg_temp.assert_true(booked->>'id'=retried->>'id','idempotent retry returns original order before revalidation');
  perform pg_temp.assert_true((select stock_quantity=10 from public.products where id=current_setting('test.product_a')::uuid),'stock reserved exactly once');
  perform pg_temp.assert_true(not(booked ? 'code_digest') and not(booked ? 'code_ciphertext') and not(booked ? 'request_hash'),'safe order response excludes secrets');
  perform pg_temp.assert_true((select count(*)=1 from private.order_email_outbox where order_id=current_setting('test.order_a')::uuid and event_type='booked'),'one transactional booking email');
  begin
    perform public.commerce_create_order(gen_random_uuid(),current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,'',current_setting('test.key_a')::uuid,repeat('b',64),repeat('a',64),repeat('x',48),270,expected_slot);
    raise exception 'Idempotency key reused with different payload';
  exception when others then if sqlerrm not like 'Idempotency key was already used%' then raise; end if; end;
  begin
    perform public.commerce_order_secret(current_setting('test.order_a')::uuid,current_setting('test.customer_b')::uuid);
    raise exception 'Another customer could retrieve encrypted code';
  exception when insufficient_privilege then null; end;
  begin
    perform public.commerce_quote(current_setting('test.customer_a')::uuid,jsonb_build_array(jsonb_build_object('product_id',current_setting('test.product_a'),'quantity',20,'size','M','color','Blue')),current_setting('test.address')::jsonb,null);
    raise exception 'Invalid quantity/stock accepted';
  exception when others then if sqlerrm not like 'Check the item quantity limit%' and sqlerrm not like 'Insufficient stock%' then raise; end if; end;
  begin
    perform public.commerce_quote(current_setting('test.customer_a')::uuid,jsonb_build_array(
      jsonb_build_object('product_id',current_setting('test.product_a'),'quantity',6,'size','M','color','Blue'),
      jsonb_build_object('product_id',current_setting('test.product_a'),'quantity',6,'size','L','color','Blue')),current_setting('test.address')::jsonb,null);
    raise exception 'Duplicate product lines bypassed stock checks';
  exception when others then if sqlerrm not like 'Insufficient stock%' then raise; end if; end;
  update public.commerce_settings set max_quantity_per_item=3 where id;
  begin
    perform public.commerce_quote(current_setting('test.customer_a')::uuid,jsonb_build_array(
      jsonb_build_object('product_id',current_setting('test.product_a'),'quantity',2,'size','M','color','Blue'),
      jsonb_build_object('product_id',current_setting('test.product_a'),'quantity',2,'size','M','color','Blue')),current_setting('test.address')::jsonb,null);
    raise exception 'Duplicate identical lines bypassed quantity limit';
  exception when others then if sqlerrm not like 'Check the item quantity limit%' then raise; end if; end;
  update public.commerce_settings set max_quantity_per_item=10 where id;
  update public.commerce_settings set max_orders_per_day=1 where id;
  begin
    perform public.commerce_create_order(gen_random_uuid(),current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,'',gen_random_uuid(),repeat('d',64),repeat('a',64),repeat('x',48),270,expected_slot);
    raise exception 'Daily booking cap was bypassed';
  exception when others then if sqlerrm not like 'Today''s order limit%' then raise; end if; end;
  update public.commerce_settings set max_orders_per_day=10000,slot_capacity=1 where id;
  quote:=public.commerce_quote(current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,null);
  perform pg_temp.assert_true((quote->>'slot_start')::timestamptz>expected_slot,'full slot moves quote to next available slot');
  update public.commerce_settings set slot_capacity=10000 where id;
  begin
    perform public.commerce_quote(current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb||'{"postal_code":"100001"}',null);
    raise exception 'Outside delivery pincode accepted';
  exception when others then if sqlerrm not like 'This pincode is outside%' then raise; end if; end;
end; $$;

set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',current_setting('test.customer_b'),'role','authenticated')::text,true);
do $$ begin
  if exists(select 1 from public.orders where id=current_setting('test.order_a')::uuid) then raise exception 'Cross-customer order SELECT'; end if;
  begin perform 1 from private.order_secrets; raise exception 'Customer could read private delivery secrets'; exception when insufficient_privilege then null; end;
  begin perform public.commerce_list_orders(null,true); raise exception 'Customer could call admin data RPC'; exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claims',json_build_object('sub',current_setting('test.customer_a'),'role','authenticated')::text,true);
do $$ begin
  if not exists(select 1 from public.orders where id=current_setting('test.order_a')::uuid) then raise exception 'Owner cannot read order'; end if;
  begin update public.orders set status='delivered' where id=current_setting('test.order_a')::uuid; raise exception 'Direct customer order mutation'; exception when insufficient_privilege then null; end;
  begin perform public.commerce_complete_delivery(current_setting('test.order_a')::uuid,repeat('a',64),true); raise exception 'Customer could complete delivery'; exception when insufficient_privilege then null; end;
  begin perform private.commerce_order_admin_json(current_setting('test.order_a')::uuid); raise exception 'Customer could retrieve private email delivery metadata'; exception when insufficient_privilege then null; end;
end; $$;
reset role;

do $$
declare result jsonb; quote jsonb; i integer;
begin
  perform public.commerce_update_order(current_setting('test.order_a')::uuid,'confirmed');
  perform public.commerce_update_order(current_setting('test.order_a')::uuid,'preparing');
  perform public.commerce_update_order(current_setting('test.order_a')::uuid,'out_for_delivery');
  begin perform public.commerce_update_order(current_setting('test.order_a')::uuid,'delivered'); raise exception 'Generic status update bypassed code';
  exception when others then if sqlerrm not like 'Complete delivery through%' then raise; end if; end;
  result:=public.commerce_complete_delivery(current_setting('test.order_a')::uuid,repeat('a',64),false);
  perform pg_temp.assert_true(result->>'error'='payment_not_collected','COD cash confirmation required');
  -- Toggling off code verification affects new orders only.
  update public.commerce_settings set delivery_code_enabled=false where id;
  for i in 1..5 loop result:=public.commerce_complete_delivery(current_setting('test.order_a')::uuid,repeat('b',64),true); end loop;
  perform pg_temp.assert_true(result->>'error'='code_locked','five wrong attempts lock verification');
  perform pg_temp.assert_true((select failed_attempts=5 from private.order_secrets where order_id=current_setting('test.order_a')::uuid),'failed attempts persist');
  result:=public.commerce_complete_delivery(current_setting('test.order_a')::uuid,repeat('a',64),true);
  perform pg_temp.assert_true(result->>'error'='code_locked','correct code cannot bypass active lock');
  update private.order_secrets set locked_until=now()-interval '1 second' where order_id=current_setting('test.order_a')::uuid;
  result:=public.commerce_complete_delivery(current_setting('test.order_a')::uuid,repeat('a',64),true);
  perform pg_temp.assert_true((result->>'ok')::boolean,'correct code delivers after lock expires');
  perform pg_temp.assert_true(not exists(select 1 from private.order_secrets where order_id=current_setting('test.order_a')::uuid),'secret removed after delivery');
  perform pg_temp.assert_true((select status='delivered' and payment_status='collected' from public.orders where id=current_setting('test.order_a')::uuid),'delivery is terminal and cash collected');
  result:=public.commerce_complete_delivery(current_setting('test.order_a')::uuid,repeat('a',64),true);
  perform pg_temp.assert_true((select count(*)=1 from private.order_email_outbox where order_id=current_setting('test.order_a')::uuid and event_type='delivered'),'idempotent delivered email');
  update public.commerce_settings set slot_capacity=1 where id;
  quote:=public.commerce_quote(current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,null);
  perform pg_temp.assert_true((quote->>'slot_start')::timestamptz>(select slot_start from public.orders where id=current_setting('test.order_a')::uuid),'completed deliveries still consume the allocated slot capacity');
  update public.commerce_settings set slot_capacity=10000 where id;
  quote:=public.commerce_quote(current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,null);
  perform public.commerce_create_order(current_setting('test.order_b')::uuid,current_setting('test.customer_a')::uuid,current_setting('test.cart')::jsonb,current_setting('test.address')::jsonb,'',gen_random_uuid(),repeat('c',64),'','',(quote->>'total')::numeric,(quote->>'slot_start')::timestamptz);
  perform pg_temp.assert_true((select not delivery_code_required from public.orders where id=current_setting('test.order_b')::uuid),'new code-toggle snapshot');
  perform public.commerce_update_order(current_setting('test.order_b')::uuid,'cancelled',null,'Test cancellation');
  perform pg_temp.assert_true((select stock_quantity=10 from public.products where id=current_setting('test.product_a')::uuid),'cancel restores reserved stock');
  begin perform public.commerce_update_order(current_setting('test.order_b')::uuid,'cancelled',null,'Test again'); raise exception 'Terminal order could be cancelled twice';
  exception when others then if sqlerrm not like 'Completed and cancelled orders cannot%' then raise; end if; end;
  perform pg_temp.assert_true((select stock_quantity=10 from public.products where id=current_setting('test.product_a')::uuid),'repeat cancellation does not restore twice');
end; $$;

-- Outbox leases, bounded retry and private administrative email status. These
-- calls only mutate rolled-back fixtures; no Resend worker or network is invoked.
do $$
declare booking uuid; delivered uuid; cancelled uuid; lease uuid; old_lease uuid; claimed jsonb; result jsonb; response jsonb; event jsonb; context jsonb; first_payload jsonb; retry_payload jsonb;
begin
  select id into booking from private.order_email_outbox where order_id=current_setting('test.order_a')::uuid and event_type='booked';
  select id into delivered from private.order_email_outbox where order_id=current_setting('test.order_a')::uuid and event_type='delivered';
  select id into cancelled from private.order_email_outbox where order_id=current_setting('test.order_b')::uuid and event_type='cancelled';
  select outbox.context into context from private.order_email_outbox outbox where id=booking;
  perform pg_temp.assert_true(context->'order'->>'status'='placed' and context->>'timezone'='Asia/Kolkata','booking email captures its original order event and business timezone');
  perform pg_temp.assert_true(not(context->'order' ? 'code_digest') and not(context->'order' ? 'code_ciphertext') and not(context->'order' ? 'email_events'),'email context snapshots only the safe common order projection');
  -- Later changes must not change a payload retried under the same provider key.
  update public.orders set slot_start=slot_start+interval '1 hour',slot_end=slot_end+interval '1 hour' where id=current_setting('test.order_a')::uuid;
  update public.commerce_settings set timezone='UTC' where id;
  update public.site_settings set email_address='changed-commerce-fixture@example.invalid',phone_number='+919999999999' where id='storefront';
  claimed:=public.commerce_claim_emails(50);
  select entry-'lease_token'-'attempts' into first_payload from jsonb_array_elements(claimed) entry where (entry->>'id')::uuid=booking;
  perform pg_temp.assert_true(first_payload->'order'=context->'order' and first_payload->>'timezone'=context->>'timezone' and first_payload->'store'=context->'store','claim preserves original order, slot, timezone and store contact snapshots');
  select (entry->>'lease_token')::uuid into lease from jsonb_array_elements(claimed) entry where (entry->>'id')::uuid=booking;
  perform pg_temp.assert_true(lease is not null and (select state='sending' and attempts=1 from private.order_email_outbox where id=booking),'claim establishes a sending lease and increments attempts');
  perform pg_temp.assert_true(not public.commerce_finish_email(booking,gen_random_uuid(),true,''),'wrong lease cannot acknowledge an email');
  perform pg_temp.assert_true(public.commerce_finish_email(booking,lease,false,repeat('x',400)),'current lease records a failed delivery attempt');
  perform pg_temp.assert_true((select state='queued' and available_at>now() and attempts=1 and length(last_error)=250 from private.order_email_outbox where id=booking),'failed attempt backs off and bounds provider error text');
  claimed:=public.commerce_claim_emails(50);
  perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(claimed) entry where (entry->>'id')::uuid=booking),'backoff prevents immediate claim');
  update private.order_email_outbox set available_at=now()-interval '1 second' where id=booking;
  old_lease:=lease;
  claimed:=public.commerce_claim_emails(50);
  select (entry->>'lease_token')::uuid into lease from jsonb_array_elements(claimed) entry where (entry->>'id')::uuid=booking;
  select entry-'lease_token'-'attempts' into retry_payload from jsonb_array_elements(claimed) entry where (entry->>'id')::uuid=booking;
  perform pg_temp.assert_true(retry_payload=first_payload,'retry renders exactly the same event payload despite current order and store changes');
  perform pg_temp.assert_true(lease is not null and lease<>old_lease,'retry receives a fresh lease');
  perform pg_temp.assert_true(not public.commerce_finish_email(booking,old_lease,true,''),'stale lease cannot finish a reclaimed job');
  perform pg_temp.assert_true(public.commerce_finish_email(booking,lease,true,''),'current lease acknowledges delivery');
  perform pg_temp.assert_true(not public.commerce_finish_email(booking,lease,true,''),'duplicate acknowledgement has no effect');
  perform pg_temp.assert_true((select state='sent' and sent_at is not null and attempts=2 from private.order_email_outbox where id=booking),'successful job is recorded once');
  select lease_token into old_lease from private.order_email_outbox where id=delivered;
  update private.order_email_outbox set lease_until=now()-interval '1 second' where id=delivered;
  claimed:=public.commerce_claim_emails(50);
  select (entry->>'lease_token')::uuid into lease from jsonb_array_elements(claimed) entry where (entry->>'id')::uuid=delivered;
  perform pg_temp.assert_true(lease is not null and lease<>old_lease and (select attempts=2 from private.order_email_outbox where id=delivered),'expired lease is reclaimed with a new identity');
  -- The fifth failed attempt becomes terminal until an explicit bounded retry.
  update private.order_email_outbox set attempts=4 where id=delivered;
  perform pg_temp.assert_true(public.commerce_finish_email(delivered,lease,false,'Provider unavailable'),'failed leased attempt is persisted');
  update private.order_email_outbox set available_at=now()-interval '1 second' where id=delivered;
  claimed:=public.commerce_claim_emails(50);
  select (entry->>'lease_token')::uuid into lease from jsonb_array_elements(claimed) entry where (entry->>'id')::uuid=delivered;
  perform pg_temp.assert_true(lease is not null and (select attempts=5 from private.order_email_outbox where id=delivered),'fifth attempt can be claimed');
  perform public.commerce_finish_email(delivered,lease,false,'Provider unavailable');
  response:=private.commerce_order_admin_json(current_setting('test.order_a')::uuid);
  perform pg_temp.assert_true(response->>'email_status'='failed','admin aggregate surfaces a failed email');
  select entry into event from jsonb_array_elements(response->'email_events') entry where entry->>'event_type'='delivered';
  perform pg_temp.assert_true((event->>'can_retry')::boolean and (event->>'attempts')::integer=5,'recent failed event advertises bounded manual retry');
  perform pg_temp.assert_true(not(event ? 'template') and not(event ? 'last_error') and not(event ? 'lease_token') and not(event ? 'code_ciphertext'),'admin event summaries omit sensitive payloads and leases');
  result:=public.commerce_retry_emails(current_setting('test.order_a')::uuid);
  perform pg_temp.assert_true((result->>'queued')::integer=1 and result->'order'->>'email_status'='queued','manual retry reports the actual queued count and refreshed admin order');
  response:=public.commerce_list_orders(current_setting('test.customer_a')::uuid,false,'all');
  perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(response->'orders') entry where entry ? 'email_status' or entry ? 'email_events'),'customer order list excludes email administration metadata');
  response:=public.commerce_list_orders(null,true,'all');
  perform pg_temp.assert_true(exists(select 1 from jsonb_array_elements(response->'orders') entry where entry->>'id'=current_setting('test.order_a') and entry ? 'email_status' and entry ? 'email_events'),'admin order list includes safe email administration metadata');
  -- Provider idempotency only covers 24h, so retries stop conservatively at 23h.
  update private.order_email_outbox set state='queued',lease_token=null,lease_until=null,created_at=now()-interval '24 hours',available_at=now()-interval '1 second' where id=cancelled;
  claimed:=public.commerce_claim_emails(50);
  perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(claimed) entry where (entry->>'id')::uuid=cancelled) and (select state='failed' from private.order_email_outbox where id=cancelled),'expired deduplication window prevents provider resend');
  response:=private.commerce_order_admin_json(current_setting('test.order_b')::uuid);
  select entry into event from jsonb_array_elements(response->'email_events') entry where entry->>'event_type'='cancelled';
  perform pg_temp.assert_true(not(event->>'can_retry')::boolean,'expired email cannot advertise retry');
  result:=public.commerce_retry_emails(current_setting('test.order_b')::uuid);
  perform pg_temp.assert_true((result->>'queued')::integer=0,'manual retry cannot bypass the provider deduplication window');
end; $$;

-- Visibility is audience-specific; final deletion waits for BOTH periods.
update public.commerce_settings set auto_delete_enabled=true,customer_history_days=1,admin_history_days=3 where id;
update public.orders set terminal_at=now()-interval '2 days' where id=current_setting('test.order_a')::uuid;
do $$ declare customer_view jsonb; admin_view jsonb; begin
  customer_view:=public.commerce_list_orders(current_setting('test.customer_a')::uuid,false,'past');
  admin_view:=public.commerce_list_orders(null,true,'past');
  perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(customer_view->'orders') o where o->>'id'=current_setting('test.order_a')),'customer history expires independently');
  perform pg_temp.assert_true(exists(select 1 from jsonb_array_elements(admin_view->'orders') o where o->>'id'=current_setting('test.order_a')),'admin history retained');
  begin
    perform public.commerce_create_order(gen_random_uuid(),current_setting('test.customer_a')::uuid,'[]','{}','',current_setting('test.key_a')::uuid,repeat('a',64),'','',null,null);
    raise exception 'Idempotency replay disclosed expired customer history';
  exception when insufficient_privilege then null; end;
  perform public.commerce_housekeeping();
  perform pg_temp.assert_true(exists(select 1 from public.orders where id=current_setting('test.order_a')::uuid),'no premature permanent deletion');
end; $$;
update public.orders set terminal_at=now()-interval '4 days' where id=current_setting('test.order_a')::uuid;
do $$ declare response jsonb; begin
  response:=public.commerce_complete_delivery(current_setting('test.order_a')::uuid,'',true);
  perform pg_temp.assert_true((response->>'ok')::boolean and not(response ? 'order'),'idempotent completion does not disclose expired admin history');
  response:=public.commerce_retry_emails(current_setting('test.order_a')::uuid);
  perform pg_temp.assert_true((response->>'queued')::integer=0 and response->'order'='null'::jsonb,'email retry cannot disclose or mutate expired admin history');
end; $$;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',current_setting('test.customer_a'),'role','authenticated')::text,true);
do $$ begin
  if exists(select 1 from public.orders where id=current_setting('test.order_a')::uuid)
    or exists(select 1 from public.order_items where order_id=current_setting('test.order_a')::uuid)
    or exists(select 1 from public.order_events where order_id=current_setting('test.order_a')::uuid) then raise exception 'Direct customer SELECT bypassed expired history'; end if;
end; $$;
reset role;
select public.commerce_housekeeping();
select pg_temp.assert_true(not exists(select 1 from public.orders where id=current_setting('test.order_a')::uuid),'expired order physically deleted');
select pg_temp.assert_true(not exists(select 1 from public.order_items where order_id=current_setting('test.order_a')::uuid),'items cascade deleted');
select pg_temp.assert_true(not exists(select 1 from public.order_events where order_id=current_setting('test.order_a')::uuid),'events cascade deleted');
select pg_temp.assert_true(not exists(select 1 from private.order_email_outbox where order_id=current_setting('test.order_a')::uuid),'email outbox cascade deleted');
select public.commerce_delete_order(current_setting('test.order_b')::uuid);
select pg_temp.assert_true(not exists(select 1 from public.orders where id=current_setting('test.order_b')::uuid),'manual delete physically deletes order');

rollback;
select 'PASS: atomic checkout, prices/slots, idempotency, stock, customer isolation, delivery codes/lockout, cancellation and retention; fixtures rolled back' as result;
