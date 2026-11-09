-- Run in Supabase SQL editor. All synthetic users/data are rolled back.
begin;
select set_config('test.customer_a', gen_random_uuid()::text, true);
select set_config('test.customer_b', gen_random_uuid()::text, true);
insert into auth.users (id, email) values
  (current_setting('test.customer_a')::uuid, current_setting('test.customer_a') || '@example.invalid'),
  (current_setting('test.customer_b')::uuid, current_setting('test.customer_b') || '@example.invalid');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.customer_a'), 'role', 'authenticated')::text, true);
insert into public.customer_profiles (id, full_name, phone)
values (current_setting('test.customer_a')::uuid, 'Test Customer A', '+919876543210');

do $$
begin
  if (select count(*) from public.customer_profiles) <> 1 then raise exception 'Own-profile read failed'; end if;
  begin
    insert into public.customer_profiles (id, full_name, phone) values (current_setting('test.customer_b')::uuid, 'Other Customer', '+919876543210');
    raise exception 'Cross-customer INSERT was allowed';
  exception when insufficient_privilege then null; end;
  begin
    update public.customer_profiles set id = current_setting('test.customer_b')::uuid;
    raise exception 'Profile ownership could be reassigned';
  exception when insufficient_privilege then null; end;
  begin
    update public.customer_profiles set created_at = now();
    raise exception 'Customer could change server timestamps';
  exception when insufficient_privilege then null; end;
  begin
    update public.customer_profiles set phone = 'invalid';
    raise exception 'Invalid phone passed database validation';
  exception when check_violation then null; end;
  begin
    update public.customer_profiles set full_name = ' ';
    raise exception 'Empty name passed database validation';
  exception when check_violation then null; end;
  update public.customer_profiles set full_name = 'Updated Customer A';
  if not exists (select 1 from public.customer_profiles where full_name = 'Updated Customer A' and updated_at = now()) then raise exception 'Own-profile update/trigger failed'; end if;
  -- PostgREST upsert writes id as well as contact fields on conflict.
  insert into public.customer_profiles (id, full_name, phone)
    values (current_setting('test.customer_a')::uuid, 'Upserted Customer A', '+919876543210')
    on conflict (id) do update set id = excluded.id, full_name = excluded.full_name, phone = excluded.phone;
  if not exists (select 1 from public.customer_profiles where full_name = 'Upserted Customer A') then raise exception 'Own-profile upsert failed'; end if;
  begin
    delete from public.customer_profiles;
    raise exception 'Customer could delete profiles';
  exception when insufficient_privilege then null; end;
end;
$$;

select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.customer_b'), 'role', 'authenticated')::text, true);
do $$
declare changed integer;
begin
  if exists (select 1 from public.customer_profiles) then raise exception 'Cross-customer SELECT was allowed'; end if;
  update public.customer_profiles set full_name = 'Attacker';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'Cross-customer UPDATE was allowed'; end if;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform 1 from public.customer_profiles;
    raise exception 'Anonymous profile access was allowed';
  exception when insufficient_privilege then null; end;
end;
$$;
reset role;
rollback;
select 'PASS: owner access, isolation, validation, timestamps and anonymous denial; fixtures rolled back' as result;
