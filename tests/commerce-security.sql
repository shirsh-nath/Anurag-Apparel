-- Run after commerce-security.sql, or inside an enclosing rolled-back validation
-- transaction which also applies that script. All fixtures and password edits roll back.
begin;
create or replace function pg_temp.assert_true(input_value boolean,input_message text) returns void language plpgsql as $$
begin if not coalesce(input_value,false) then raise exception 'FAIL: %',input_message; end if; end; $$;
select set_config('test.product',gen_random_uuid()::text,true);
select set_config('test.password',encode(extensions.gen_random_bytes(24),'hex'),true);
update private.admin_credentials set username='commerce-security-fixture',password_hash=extensions.crypt(current_setting('test.password'),extensions.gen_salt('bf')) where id='dashboard';
update private.commerce_security_state set admin_password_ready=false where id;
update private.commerce_login_attempts set failures=0,window_start=now(),locked_until=null where id;
insert into public.products(id,title,price,stock_quantity) values(current_setting('test.product')::uuid,'Security Fixture',100,5);
insert into public.email_contacts(email,name) values(current_setting('test.product')||'@example.invalid','Security fixture');
do $$ declare result jsonb; i integer; begin
  perform pg_temp.assert_true((select sealed from private.commerce_security_state where id),'security rollout sealed');
  for i in 1..5 loop result:=public.commerce_admin_login('commerce-security-fixture','wrong-password'); end loop;
  perform pg_temp.assert_true((select failures=5 and locked_until>now() from private.commerce_login_attempts where id),'login throttling persisted');
  result:=public.commerce_admin_login('commerce-security-fixture',current_setting('test.password'));
  perform pg_temp.assert_true(result->>'error'='login_locked','correct password cannot bypass lock');
  update private.commerce_login_attempts set locked_until=now()-interval '1 second',window_start=now()-interval '16 minutes' where id;
  result:=public.commerce_admin_login('commerce-security-fixture',current_setting('test.password'));
  perform pg_temp.assert_true((result->>'ok')::boolean and length(result->>'token')=64,'opaque session issued');
  perform set_config('test.admin_token',result->>'token',true);
  perform pg_temp.assert_true(exists(select 1 from private.commerce_admin_sessions where token_hash=extensions.digest(result->>'token','sha256')),'only token digest stored');
end; $$;
set local role anon;
select set_config('request.headers','{}',true);
do $$ begin
  if public.commerce_admin_session_valid() then raise exception 'Anonymous browser considered admin'; end if;
  begin update public.products set stock_quantity=100 where id=current_setting('test.product')::uuid;
    if found then raise exception 'Anonymous product mutation'; end if;
  exception when insufficient_privilege then null; end;
  if exists(select 1 from public.email_contacts) then raise exception 'Anonymous contact disclosure'; end if;
  if exists(select 1 from public.website_analytics_events) then raise exception 'Anonymous analytics disclosure'; end if;
  begin perform public.verify_admin_login('commerce-security-fixture',current_setting('test.password')); raise exception 'Legacy verifier exposed'; exception when insufficient_privilege then null; end;
  begin perform public.purge_old_analytics_events(); raise exception 'Public analytics purge'; exception when insufficient_privilege then null; end;
  begin perform 1 from private.commerce_admin_sessions; raise exception 'Anonymous session digest access'; exception when insufficient_privilege then null; end;
end; $$;
-- A signed-in administrator must review the password before receiving private
-- data or catalogue write access. Password change itself remains available.
select set_config('request.headers',json_build_object('x-admin-session',current_setting('test.admin_token'))::text,true);
do $$ begin
  if not public.commerce_admin_session_valid() then raise exception 'Valid admin token rejected'; end if;
  update public.products set stock_quantity=6 where id=current_setting('test.product')::uuid;
  if found then raise exception 'Unreviewed administrator could mutate products'; end if;
  if exists(select 1 from public.email_contacts) then raise exception 'Unreviewed administrator could read private contacts'; end if;
  begin
    perform public.change_admin_password('commerce-security-fixture',current_setting('test.password'),'too-short');
    raise exception 'Short administrator password accepted';
  exception when others then if sqlerrm not like 'Use at least 12 characters%' then raise; end if; end;
  begin
    perform public.change_admin_password('commerce-security-fixture',current_setting('test.password'),repeat('x',73));
    raise exception 'Password exceeding bcrypt input limit accepted';
  exception when others then if sqlerrm not like 'Use at least 12 characters%' then raise; end if; end;
  if not public.change_admin_password('commerce-security-fixture',current_setting('test.password'),current_setting('test.password')||'new') then raise exception 'Secure password change failed'; end if;
  if public.commerce_admin_session_valid() then raise exception 'Password change did not revoke session'; end if;
end; $$;
reset role;
do $$ declare response jsonb; begin
  perform pg_temp.assert_true((select admin_password_ready from private.commerce_security_state where id),'password review unlocks private admin access');
  response:=public.commerce_admin_login('commerce-security-fixture',current_setting('test.password')||'new');
  perform pg_temp.assert_true((response->>'ok')::boolean,'new password signs in');
  perform set_config('test.admin_token',response->>'token',true);
end; $$;
set local role anon;
select set_config('request.headers',json_build_object('x-admin-session',current_setting('test.admin_token'))::text,true);
do $$ begin
  if not public.commerce_admin_session_valid() then raise exception 'New admin token rejected'; end if;
  update public.products set stock_quantity=6 where id=current_setting('test.product')::uuid;
  if not found then raise exception 'Reviewed admin product update denied'; end if;
  update public.email_contacts set name='Updated security fixture' where email=current_setting('test.product')||'@example.invalid';
  if not found then raise exception 'Reviewed admin contact management denied'; end if;
  begin insert into storage.objects(bucket_id,name) values('product-images','security-fixture-'||current_setting('test.product')||'.jpg');
    raise exception 'Direct public-role Storage upload succeeded';
  exception when insufficient_privilege then null; end;
  if not public.change_admin_password('commerce-security-fixture',current_setting('test.password')||'new',current_setting('test.password')||'last') then raise exception 'Second secure password change failed'; end if;
  if public.commerce_admin_session_valid() then raise exception 'Second password change did not revoke session'; end if;
end; $$;
reset role;
select pg_temp.assert_true((select admin_password_ready from private.commerce_security_state where id),'password review unlocks commerce');
rollback;
select 'PASS: sessions, throttling, private-data isolation, write/Storage protection, password revocation; fixtures rolled back' as result;
