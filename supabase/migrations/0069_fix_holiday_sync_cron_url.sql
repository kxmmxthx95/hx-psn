-- Supabase project relinked (old ref hncabywwkvdekongabln -> jplypcfrfrgkfpnlcrvu,
-- see commit "relink Supabase project"), so the yearly holiday-sync cron job
-- from migration 0045 was still posting to the dead project. cron.schedule
-- with the same job name replaces the existing job in place.
select cron.schedule(
  'holiday-sync-yearly',
  '0 3 2 1 *',
  $$
  select net.http_post(
    url := 'https://jplypcfrfrgkfpnlcrvu.functions.supabase.co/sync-holidays',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'holiday_sync_cron_secret')
    ),
    body := jsonb_build_object('years', jsonb_build_array(extract(year from now())::int, extract(year from now())::int + 1))
  );
  $$
);
