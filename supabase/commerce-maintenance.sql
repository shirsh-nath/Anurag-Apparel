-- Apply after commerce-schema.sql, commerce Edge deployment, and local
-- node scripts/configure-commerce.mjs --secrets --schedule-config.
-- Only a scoped maintenance token lives in Vault; delivery-code keys never do.
begin;
create extension if not exists pg_net with schema extensions;
do $$ begin
  if not exists(select 1 from vault.secrets where name='commerce_maintenance_key')
    or not exists(select 1 from vault.secrets where name='commerce_project_url') then
    raise exception 'Configure the commerce maintenance Vault entries first';
  end if;
end; $$;
select cron.schedule('anurag-commerce-maintenance','*/5 * * * *',$job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='commerce_project_url')||'/functions/v1/commerce',
    headers := jsonb_build_object('Content-Type','application/json','x-commerce-maintenance',(select decrypted_secret from vault.decrypted_secrets where name='commerce_maintenance_key')),
    body := '{"action":"maintenance"}'::jsonb,
    timeout_milliseconds := 10000
  );
$job$);
commit;
