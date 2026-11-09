-- ACTIVATE ONLY with deployment of feature/online-order-commerce.
-- This replaces the old anonymous/boolean-based admin boundary. It deliberately
-- breaks old admin clients: deploy the branch's server-validated admin session UI first.
-- Run after commerce-schema.sql, then change the admin password and re-login.

begin;
revoke all on function public.verify_admin_login(text,text) from public,anon,authenticated;
revoke all on function private.verify_admin_login(text,text) from public,anon,authenticated;
revoke all on function private.change_admin_password(text,text,text) from public,anon,authenticated;
create or replace function public.change_admin_password(input_username text,current_password text,new_password text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if not private.commerce_token_valid(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-admin-session') then raise insufficient_privilege using message='Admin session required'; end if;
  -- pgcrypto bcrypt processes at most 72 bytes; reject suffixes it would ignore.
  if length(coalesce(new_password,''))<12 or octet_length(new_password)>72 then raise exception 'Use at least 12 characters and at most 72 UTF-8 bytes'; end if;
  if not private.change_admin_password(input_username,current_password,new_password) then return false; end if;
  update private.commerce_security_state set admin_password_ready=true where id;
  delete from private.commerce_admin_sessions;
  return true;
end; $$;
revoke all on function public.change_admin_password(text,text,text) from public;
grant execute on function public.change_admin_password(text,text,text) to anon,authenticated,service_role;

-- RLS still evaluates the opaque admin session at every request; changing a
-- browser sessionStorage boolean or customer user_metadata grants no authority.
do $$
declare r record; table_name text;
begin
  foreach table_name in array array['products','product_subcategories','brands','site_announcements','site_settings','email_contacts','email_campaign_images','website_analytics_events','google_reviews'] loop
    for r in select policyname from pg_policies where schemaname='public' and tablename=table_name loop
      execute format('drop policy %I on public.%I',r.policyname,table_name);
    end loop;
    execute format('grant select,insert,update,delete on public.%I to anon,authenticated',table_name);
    execute format('create policy %I on public.%I for all to anon,authenticated using ((select private.is_commerce_admin())) with check ((select private.is_commerce_admin()))','Verified admin access',table_name);
    if table_name not in('email_contacts','email_campaign_images','website_analytics_events') then
      execute format('create policy %I on public.%I for select to anon,authenticated using (true)','Public catalogue read',table_name);
    end if;
  end loop;
end; $$;
create policy "Public analytics insert" on public.website_analytics_events for insert to anon,authenticated
  with check(length(btrim(event_name)) between 1 and 100 and length(btrim(visitor_id)) between 1 and 100 and length(btrim(session_id)) between 1 and 100 and octet_length(metadata::text)<16384);

-- Storage's SQL layer need not forward custom admin headers. Therefore uploads
-- and removals use the authenticated commerce server, never a header-based policy.
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='storage' and tablename='objects'
    and (policyname like 'Anon can % product images' or policyname like 'Commerce %') loop
    execute format('drop policy %I on storage.objects',r.policyname);
  end loop;
end; $$;
create policy "Commerce public product images" on storage.objects for select to anon,authenticated using(bucket_id='product-images');

revoke all on function public.purge_old_analytics_events() from public,anon,authenticated;
revoke all on function public.purge_old_analytics_events_rpc() from public,anon,authenticated;
grant execute on function public.purge_old_analytics_events(),public.purge_old_analytics_events_rpc() to service_role;
update private.commerce_security_state set sealed=true where id;
commit;
