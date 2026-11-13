-- Leader Directory: tables, allowlist and Row Level Security.
-- Paste this whole file into the Supabase SQL editor and press Run.
-- Safe to run more than once. Contains no personal data.

-- ---------------------------------------------------------------- tables

create table if not exists public.allowed_emails (
  email      text primary key,
  is_admin   boolean not null default false,
  note       text,
  created_at timestamptz not null default now()
);

create table if not exists public.leaders (
  id           uuid primary key default gen_random_uuid(),
  first        text not null default '',
  last         text not null default '',
  name         text not null,
  assignment   text not null default 'TBD',
  church       text,
  is_team_lead boolean not null default false,
  phone        text,
  email        text,
  created_at   timestamptz not null default now()
);

create table if not exists public.school_events (
  id         uuid primary key default gen_random_uuid(),
  date       date not null,
  end_date   date not null,
  title      text not null,
  category   text not null,
  schools    text not null default '',   -- school names separated by |
  district   text,
  "time"     text,
  location   text,
  note       text,
  source     text,
  created_at timestamptz not null default now()
);

create table if not exists public.visits (
  id         uuid primary key default gen_random_uuid(),
  series_id  uuid,                        -- same value on every visit of a recurring series
  type       text not null check (type in ('Club', 'Lunch Room Visit')),
  school     text not null,
  date       date not null,
  "time"     text,                        -- HH:MM, 24 hour
  notes      text,
  leader_ids uuid[] not null default '{}',
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists visits_series_idx on public.visits (series_id);
create index if not exists visits_date_idx on public.visits (date);

-- ---------------------------------------------------------------- who is allowed

create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(auth.jwt() ->> 'email') and is_admin
  );
$$;

-- No public sign-up: refuse to create an account for an email that is not approved.
create or replace function public.enforce_allowlist() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.allowed_emails where lower(email) = lower(new.email)
  ) then
    raise exception 'This email is not on the approved list.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_allowlist on auth.users;
create trigger enforce_allowlist
  before insert on auth.users
  for each row execute function public.enforce_allowlist();

-- ---------------------------------------------------------------- row level security

alter table public.allowed_emails enable row level security;
alter table public.leaders        enable row level security;
alter table public.school_events  enable row level security;
alter table public.visits         enable row level security;

revoke all on public.allowed_emails, public.leaders, public.school_events, public.visits from anon;
grant select, insert, update, delete
  on public.allowed_emails, public.leaders, public.school_events, public.visits
  to authenticated;

-- allowed_emails: you can see your own row; admins see and manage all of them.
drop policy if exists allowed_emails_select on public.allowed_emails;
create policy allowed_emails_select on public.allowed_emails for select to authenticated
  using (public.is_admin() or lower(email) = lower(auth.jwt() ->> 'email'));

drop policy if exists allowed_emails_write on public.allowed_emails;
create policy allowed_emails_write on public.allowed_emails for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- leaders (includes phone and email): approved people read, admins write.
drop policy if exists leaders_select on public.leaders;
create policy leaders_select on public.leaders for select to authenticated
  using (public.is_allowed());

drop policy if exists leaders_write on public.leaders;
create policy leaders_write on public.leaders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- school_events: approved people read, admins write.
drop policy if exists school_events_select on public.school_events;
create policy school_events_select on public.school_events for select to authenticated
  using (public.is_allowed());

drop policy if exists school_events_write on public.school_events;
create policy school_events_write on public.school_events for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- visits: every approved person can read, create, edit and delete.
drop policy if exists visits_all on public.visits;
create policy visits_all on public.visits for all to authenticated
  using (public.is_allowed()) with check (public.is_allowed());
