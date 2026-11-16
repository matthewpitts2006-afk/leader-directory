-- Leader Directory, update 2: scheduled emails.
-- Run AFTER the onboarding-email Edge Function is deployed. Safe to run more than once.
--
-- Supabase schedules in UTC. 7:30 AM Central is 13:30 UTC in winter and 12:30 UTC
-- in summer, so each job is scheduled at both times; the function itself only
-- sends during the 7 AM Central hour and at most once a day.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobname) from cron.job where jobname like 'onboarding-%';

select cron.schedule('onboarding-stall-winter', '30 13 * * *', $job$
  select net.http_post(
    url := 'https://dadheigbxeexvnldrpvo.supabase.co/functions/v1/onboarding-email',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"kind": "stall"}'::jsonb);
$job$);
select cron.schedule('onboarding-stall-summer', '30 12 * * *', $job$
  select net.http_post(
    url := 'https://dadheigbxeexvnldrpvo.supabase.co/functions/v1/onboarding-email',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"kind": "stall"}'::jsonb);
$job$);

-- Weekly export: Mondays, a few minutes after the reminder.
select cron.schedule('onboarding-export-winter', '35 13 * * 1', $job$
  select net.http_post(
    url := 'https://dadheigbxeexvnldrpvo.supabase.co/functions/v1/onboarding-email',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"kind": "export"}'::jsonb);
$job$);
select cron.schedule('onboarding-export-summer', '35 12 * * 1', $job$
  select net.http_post(
    url := 'https://dadheigbxeexvnldrpvo.supabase.co/functions/v1/onboarding-email',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"kind": "export"}'::jsonb);
$job$);
