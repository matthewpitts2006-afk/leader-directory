-- Leader Directory, update 2: passwords, availability, more event types, onboarding.
-- Run AFTER schema.sql. Safe to run more than once. Contains no personal data.
-- Nothing here drops or empties an existing table.

-- ---------------------------------------------------------------- existing tables: new columns

alter table public.allowed_emails add column if not exists must_change_password boolean not null default false;

alter table public.leaders add column if not exists tags text[] not null default '{}';

alter table public.visits add column if not exists end_time     text;      -- HH:MM, 24 hour
alter table public.visits add column if not exists custom_name  text;      -- the name when type is 'Other'
alter table public.visits add column if not exists status       text not null default 'scheduled';
alter table public.visits add column if not exists attended_ids uuid[] not null default '{}';
alter table public.visits add column if not exists closed_by    text;
alter table public.visits add column if not exists closed_at    timestamptz;

-- The "school" column now holds a site: a school or a group such as Small Group.
alter table public.visits drop constraint if exists visits_type_check;
alter table public.visits add constraint visits_type_check
  check (type in ('Club', 'Lunch Room Visit', 'Cookie Run', 'Hang Out', 'Small Group', 'Other'));
alter table public.visits drop constraint if exists visits_status_check;
alter table public.visits add constraint visits_status_check
  check (status in ('scheduled', 'completed', 'canceled'));

-- ---------------------------------------------------------------- new tables

-- Weekly availability: one row per time block. Minutes are counted from midnight.
create table if not exists public.availability (
  id         uuid primary key default gen_random_uuid(),
  leader_id  uuid not null references public.leaders (id) on delete cascade,
  weekday    smallint not null check (weekday between 0 and 6),   -- 0 = Sunday
  start_min  smallint not null check (start_min between 0 and 1439),
  end_min    smallint not null check (end_min between 1 and 1440),
  check (end_min > start_min)
);
create index if not exists availability_leader_idx on public.availability (leader_id);

-- When a leader's availability was last saved (a row with no blocks means "not available").
create table if not exists public.availability_status (
  leader_id  uuid primary key references public.leaders (id) on delete cascade,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Custom event names typed under "Other", offered again next time.
create table if not exists public.event_names (
  name       text primary key,
  created_by text,
  created_at timestamptz not null default now()
);

-- Small settings: stall thresholds, semester start dates.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Onboarding. Only the stage is tracked; never store background-check results here.
create table if not exists public.prospects (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  phone             text,
  church            text,
  referred_by       text,
  year              text,
  has_car           boolean not null default false,
  hometown          text,
  rating            smallint check (rating between 1 and 3),
  site_interest     text,
  poc_ids           uuid[] not null default '{}',   -- leaders who are the points of contact
  poc_other         text,                           -- contact names that did not match one leader
  next_step         text,
  stage             text not null default 'Not Sent'
    check (stage in ('Not Sent', 'Sent App', 'Application Review', 'Background Check', 'Prerequisites', 'Final Decision')),
  stage_changed_at  timestamptz not null default now(),
  status            text not null default 'pipeline'
    check (status in ('pipeline', 'holding', 'released', 'added')),
  holding_list      text check (holding_list in ('Next Semester', 'Keep in Mind')),
  reason            text,
  status_changed_at timestamptz not null default now(),
  needs_review      text[] not null default '{}',
  leader_id         uuid references public.leaders (id) on delete set null,
  created_by        text,
  created_at        timestamptz not null default now()
);

create table if not exists public.prospect_notes (
  id          uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.prospects (id) on delete cascade,
  body        text not null,
  author      text,
  created_at  timestamptz not null default now()
);
create index if not exists prospect_notes_idx on public.prospect_notes (prospect_id);

create table if not exists public.prospect_history (
  id          uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.prospects (id) on delete cascade,
  from_label  text,
  to_label    text not null,
  changed_by  text,
  changed_at  timestamptz not null default now()
);
create index if not exists prospect_history_idx on public.prospect_history (prospect_id);

-- One row per email the scheduled jobs send, so each goes out at most once a day.
create table if not exists public.email_log (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  sent_on    date not null,
  recipients integer not null default 0,
  detail     text,
  created_at timestamptz not null default now(),
  unique (kind, sent_on)
);

insert into public.app_settings (key, value) values
  ('stall_thresholds', '{"Not Sent": 3, "Sent App": 4, "Application Review": 3, "Background Check": 5, "Prerequisites": 5, "Final Decision": 3}'),
  ('semester_starts', '["01-06", "08-01"]')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- functions

-- A signed-in leader clears their own "must set a new password" flag after setting one.
create or replace function public.password_changed() returns void
language sql security definer set search_path = public as $$
  update public.allowed_emails set must_change_password = false
  where lower(email) = lower(auth.jwt() ->> 'email');
$$;

-- Admins, and the team lead of the leader's team, may edit that leader's availability.
-- "All Schools" leaders belong to every team. A lead is matched by the email on their roster row.
create or replace function public.can_edit_availability(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_allowed() and exists (
    select 1 from public.leaders me, public.leaders t
    where t.id = target
      and me.is_team_lead
      and lower(me.email) = lower(auth.jwt() ->> 'email')
      and (t.assignment = me.assignment or t.assignment = 'All Schools')
  ));
$$;

-- "Add to roster" at Final Decision: copies name, phone and church into the roster.
create or replace function public.add_prospect_to_roster(p_id uuid, p_assignment text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  p public.prospects;
  new_id uuid;
  first_name text;
begin
  if not public.is_allowed() then raise exception 'Not allowed.'; end if;
  select * into p from public.prospects where id = p_id;
  if not found then raise exception 'That prospect no longer exists.'; end if;
  if p.status <> 'pipeline' or p.stage <> 'Final Decision' then
    raise exception 'Only a prospect at Final Decision can be added to the roster.';
  end if;
  first_name := split_part(trim(p.name), ' ', 1);
  insert into public.leaders (first, last, name, assignment, church, phone)
  values (first_name, trim(substr(trim(p.name), length(first_name) + 1)), trim(p.name),
          coalesce(nullif(trim(p_assignment), ''), 'TBD'), p.church, p.phone)
  returning id into new_id;
  update public.prospects
    set status = 'added', leader_id = new_id, status_changed_at = now()
    where id = p_id;
  insert into public.prospect_history (prospect_id, from_label, to_label, changed_by)
  values (p_id, p.stage, 'Added to roster (' || coalesce(nullif(trim(p_assignment), ''), 'TBD') || ')', auth.jwt() ->> 'email');
  return new_id;
end;
$$;

-- Only an admin may clear or change a prospect's "needs review" reasons.
create or replace function public.guard_needs_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.needs_review is distinct from old.needs_review
     and auth.jwt() ->> 'email' is not null and not public.is_admin() then
    raise exception 'Only an admin can clear "needs review".';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_needs_review on public.prospects;
create trigger guard_needs_review before update on public.prospects
  for each row execute function public.guard_needs_review();

revoke all on function public.password_changed(), public.can_edit_availability(uuid),
  public.add_prospect_to_roster(uuid, text) from public, anon;
grant execute on function public.password_changed(), public.can_edit_availability(uuid),
  public.add_prospect_to_roster(uuid, text) to authenticated;

-- ---------------------------------------------------------------- row level security

alter table public.availability        enable row level security;
alter table public.availability_status enable row level security;
alter table public.event_names         enable row level security;
alter table public.app_settings        enable row level security;
alter table public.prospects           enable row level security;
alter table public.prospect_notes      enable row level security;
alter table public.prospect_history    enable row level security;
alter table public.email_log           enable row level security;

revoke all on public.availability, public.availability_status, public.event_names, public.app_settings,
  public.prospects, public.prospect_notes, public.prospect_history, public.email_log from anon;
grant select, insert, update, delete on public.availability, public.availability_status, public.event_names,
  public.app_settings, public.prospects, public.prospect_notes, public.prospect_history to authenticated;
grant select on public.email_log to authenticated;

-- availability: approved people read; the team's lead and admins write.
drop policy if exists availability_select on public.availability;
create policy availability_select on public.availability for select to authenticated
  using (public.is_allowed());
drop policy if exists availability_write on public.availability;
create policy availability_write on public.availability for all to authenticated
  using (public.can_edit_availability(leader_id)) with check (public.can_edit_availability(leader_id));

drop policy if exists availability_status_select on public.availability_status;
create policy availability_status_select on public.availability_status for select to authenticated
  using (public.is_allowed());
drop policy if exists availability_status_write on public.availability_status;
create policy availability_status_write on public.availability_status for all to authenticated
  using (public.can_edit_availability(leader_id)) with check (public.can_edit_availability(leader_id));

-- event_names: approved people read and add; admins remove.
drop policy if exists event_names_select on public.event_names;
create policy event_names_select on public.event_names for select to authenticated
  using (public.is_allowed());
drop policy if exists event_names_insert on public.event_names;
create policy event_names_insert on public.event_names for insert to authenticated
  with check (public.is_allowed());
drop policy if exists event_names_delete on public.event_names;
create policy event_names_delete on public.event_names for delete to authenticated
  using (public.is_admin());

-- app_settings: approved people read; admins write.
drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select to authenticated
  using (public.is_allowed());
drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_write on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- onboarding: every approved person can read and work the pipeline.
drop policy if exists prospects_all on public.prospects;
create policy prospects_all on public.prospects for all to authenticated
  using (public.is_allowed()) with check (public.is_allowed());
drop policy if exists prospect_notes_all on public.prospect_notes;
create policy prospect_notes_all on public.prospect_notes for all to authenticated
  using (public.is_allowed()) with check (public.is_allowed());
drop policy if exists prospect_history_select on public.prospect_history;
create policy prospect_history_select on public.prospect_history for select to authenticated
  using (public.is_allowed());
drop policy if exists prospect_history_insert on public.prospect_history;
create policy prospect_history_insert on public.prospect_history for insert to authenticated
  with check (public.is_allowed());

-- email_log: admins can see what was sent. Only the scheduled function writes to it.
drop policy if exists email_log_select on public.email_log;
create policy email_log_select on public.email_log for select to authenticated
  using (public.is_admin());
