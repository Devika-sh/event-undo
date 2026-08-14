-- ==========================================================================
-- EventUndo — Supabase schema  (project: event-undo)
--
-- Run this whole file once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run).
-- It is idempotent: re-running it is safe.
--
-- Roles
--   admin      — full control. Manages volunteers, orgs, events, everything.
--   volunteer  — scoped to one organization. Adds/edits that org's events and
--                the org's own profile info. Cannot manage people.
--   user       — the public side. Saves events, RSVPs, picks interests.
-- ==========================================================================

create extension if not exists "pgcrypto";

-- --------------------------------------------------------------------------
-- 1. Tables
-- --------------------------------------------------------------------------

create table if not exists public.organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  category      text,                       -- "Innovation & Entrepreneurship"
  type          text not null default 'club', -- filter chip; admins can add new ones from the dashboard
  initials      text,                       -- fallback mark, e.g. "CI", "µL"
  logo_url      text,
  about         text,                       -- blank line separates paragraphs
  instagram_url text,
  linkedin_url  text,
  website_url   text,
  is_active     boolean not null default true,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.profiles (
  id                       uuid primary key references auth.users(id) on delete cascade,
  email                    text,
  full_name                text,
  avatar_url               text,
  bio                      text,
  phone                    text,
  department               text,
  semester                 text,
  role                     text not null default 'user'
                             check (role in ('admin','volunteer','user')),
  -- Staff affiliation — the org a volunteer/admin manages events for.
  organization_id          uuid references public.organizations(id) on delete set null,
  -- A plain user's own pick, purely a personalisation signal — distinct from
  -- organization_id above, which drives event/org edit permissions.
  favorite_organization_id uuid references public.organizations(id) on delete set null,
  status                   text not null default 'active'
                             check (status in ('active','suspended')),
  instagram_url            text,
  linkedin_url             text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Added after the initial release — safe to re-run against a database that
-- already has profiles without them.
alter table public.profiles add column if not exists department text;
alter table public.profiles add column if not exists semester text;
alter table public.profiles add column if not exists favorite_organization_id
  uuid references public.organizations(id) on delete set null;

-- `type` used to be locked to ('club','organisation') via CHECK; dropped so
-- admins can introduce new organisation types from the dashboard without a
-- schema change. Safe to re-run — no-op once already dropped.
alter table public.organizations drop constraint if exists organizations_type_check;

-- Filter chips on Discover + interest chips on the profile card.
-- `group_name` maps to the separated groups in the filter row.
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  group_name text not null default 'topic'
               check (group_name in ('mode','timing','organiser','topic')),
  sort_order int not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  slug            text not null unique,
  organization_id uuid references public.organizations(id) on delete set null,
  organizer_label text,                     -- overrides the org name on the card
  summary         text,
  description     text,
  -- Two distinct crops: thumbnail_url is the 6:5 card image (Discover grid,
  -- featured card, admin list); banner_url is the wide cover on the event's
  -- own detail page. Kept as separate columns rather than one image with two
  -- crop rects — the source photos are often different shots entirely.
  thumbnail_url   text,
  banner_url      text,
  starts_at       timestamptz not null,
  ends_at         timestamptz,
  venue           text,
  mode            text not null default 'offline'
                    check (mode in ('online','offline','hybrid')),
  fee_amount      numeric(10,2) not null default 0,
  currency        text not null default 'INR',
  capacity        int,
  register_url    text,
  status          text not null default 'draft'
                    -- 'pending' = a volunteer submitted it for review; only
                    -- an admin's approval (or the guard trigger below) moves
                    -- anything into 'published'.
                    check (status in ('draft','pending','published','cancelled')),
  is_featured     boolean not null default false,
  created_by      uuid references public.profiles(id) on delete set null,
  updated_by      uuid references public.profiles(id) on delete set null,
  -- Who reviewed a pending submission, and any note sent back with a rejection.
  reviewed_by     uuid references public.profiles(id) on delete set null,
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Added after the initial release — safe to re-run against a database that
-- already has events without them. created_by/updated_by used to point at
-- auth.users; repointed at profiles for the same reason event_saves etc. do
-- (PostgREST can't embed across a FK into the auth schema).
alter table public.events add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;
alter table public.events add column if not exists reviewed_at timestamptz;
alter table public.events add column if not exists review_note text;

-- thumbnail_url split out from banner_url so the card image and the detail
-- page's cover banner can be different crops (or different photos). Existing
-- rows keep working unsplit: every read falls back to banner_url when
-- thumbnail_url is blank (see public-data.js / admin.js).
alter table public.events add column if not exists thumbnail_url text;

alter table public.events drop constraint if exists events_created_by_fkey;
alter table public.events add constraint events_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;
alter table public.events drop constraint if exists events_updated_by_fkey;
alter table public.events add constraint events_updated_by_fkey
  foreign key (updated_by) references public.profiles(id) on delete set null;

-- 'pending' added for the volunteer-submission approval workflow — widen the
-- check constraint on databases created before it existed.
alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check
  check (status in ('draft','pending','published','cancelled'));

create table if not exists public.event_categories (
  event_id    uuid not null references public.events(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (event_id, category_id)
);

-- These three point at `profiles`, not `auth.users`. profiles.id is itself a
-- cascade reference to auth.users, so integrity is identical — but PostgREST
-- can only embed a related row when there's a foreign key it can see, and it
-- cannot see into the auth schema. Without this the dashboard's
-- `event_rsvps → profiles(full_name, email)` join has no relationship to use.
create table if not exists public.event_saves (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  event_id   uuid not null references public.events(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create table if not exists public.event_rsvps (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  response   text not null default 'yes' check (response in ('yes','no')),
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create table if not exists public.user_interests (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (user_id, category_id)
);

-- Powers team.html — the public "The Team" roster.
create table if not exists public.team_members (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  role_title      text,
  photo_url       text,
  instagram_url   text,
  linkedin_url    text,
  organization_id uuid references public.organizations(id) on delete set null,
  sort_order      int not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

-- Added after the initial release — safe to re-run against a database that
-- already has team_members without it.
alter table public.team_members
  add column if not exists organization_id uuid references public.organizations(id) on delete set null;

-- A roster member's picked interests — same shape as user_interests, just
-- keyed off team_members instead of profiles. Sourced from the same
-- `categories` table (topic group) as the profile's interest picker.
create table if not exists public.team_member_interests (
  team_member_id uuid not null references public.team_members(id) on delete cascade,
  category_id    uuid not null references public.categories(id) on delete cascade,
  primary key (team_member_id, category_id)
);

create table if not exists public.site_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_log (
  id          bigserial primary key,
  actor_id    uuid references auth.users(id) on delete set null,
  actor_email text,
  action      text not null,                -- 'created' | 'updated' | 'deleted' | 'signed_in'
  entity_type text not null,                -- 'event' | 'organization' | 'profile' | ...
  entity_id   text,
  summary     text,
  created_at  timestamptz not null default now()
);

create index if not exists events_starts_at_idx   on public.events (starts_at desc);
create index if not exists events_status_idx      on public.events (status);
create index if not exists events_org_idx         on public.events (organization_id);
create index if not exists profiles_role_idx      on public.profiles (role);
create index if not exists activity_created_idx   on public.activity_log (created_at desc);
create index if not exists team_members_org_idx   on public.team_members (organization_id);
create index if not exists profiles_fav_org_idx    on public.profiles (favorite_organization_id);

-- --------------------------------------------------------------------------
-- 2. Helper functions
--
-- SECURITY DEFINER so a policy on `profiles` can read `profiles` without
-- re-entering its own RLS check (which would recurse and error out).
-- --------------------------------------------------------------------------

create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_status()
returns text language sql stable security definer set search_path = public as $$
  select status from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'active'
  );
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin','volunteer') and status = 'active'
  );
$$;

create or replace function public.my_org()
returns uuid language sql stable security definer set search_path = public as $$
  select organization_id from public.profiles where id = auth.uid();
$$;

-- Every new auth user gets a profile row, always as a plain 'user'.
--
-- Two things this deliberately does NOT do:
--   • It never reads a role out of raw_user_meta_data. That field is
--     attacker-controlled — anyone can pass options.data to signUp — so
--     trusting it would let a stranger sign themselves up as an admin.
--   • It no longer auto-promotes the first account. Sign-up is now a public
--     surface on the Profile page, so "first one in wins" would hand the
--     console to whoever happened to register first.
--
-- Bootstrap the first admin by hand instead, once, after signing up normally:
--
--   update public.profiles set role = 'admin' where email = 'you@example.com';
--
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'user'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists events_touch on public.events;
create trigger events_touch before update on public.events
  for each row execute function public.touch_updated_at();

drop trigger if exists orgs_touch on public.organizations;
create trigger orgs_touch before update on public.organizations
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Up to MAX_FEATURED events at once (the homepage carousel), not just one —
-- replaces the old enforce_single_featured/events_single_featured pair, which
-- silently unfeatured every other event the moment a new one was picked, on
-- the assumption there could only ever be one. Rejects outright rather than
-- e.g. bumping the oldest, so the admin dashboard's own cap-of-5 chip picker
-- (the UI's only way to feature an event) never even offers a 6th — this is
-- the backstop for anything that reaches the table directly.
create or replace function public.enforce_featured_cap()
returns trigger language plpgsql as $$
begin
  if new.is_featured and (
    select count(*) from public.events where is_featured and id <> new.id
  ) >= 5 then
    raise exception 'At most 5 events can be featured at once.';
  end if;
  return new;
end;
$$;

drop trigger if exists events_single_featured on public.events;
drop function if exists public.enforce_single_featured();

drop trigger if exists events_featured_cap on public.events;
create trigger events_featured_cap before insert or update of is_featured on public.events
  for each row when (new.is_featured) execute function public.enforce_featured_cap();

-- Only an admin's approval can put an event live. If a volunteer (or anyone
-- forging a direct API call) tries to move a non-published event straight to
-- 'published', this quietly downgrades it to 'pending' instead of erroring —
-- the dashboard already hides the option, so hitting this means the request
-- didn't come through the UI. Editing an already-published event's other
-- fields is untouched: the guard only fires on an actual draft/pending →
-- published transition, not on a published → published no-op.
create or replace function public.guard_event_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'published'
     and not public.is_admin()
     and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    new.status := 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists events_guard_status on public.events;
create trigger events_guard_status before insert or update on public.events
  for each row execute function public.guard_event_status();

-- --------------------------------------------------------------------------
-- 3. Row Level Security
-- --------------------------------------------------------------------------

alter table public.organizations   enable row level security;
alter table public.profiles        enable row level security;
alter table public.categories      enable row level security;
alter table public.events          enable row level security;
alter table public.event_categories enable row level security;
alter table public.event_saves     enable row level security;
alter table public.event_rsvps     enable row level security;
alter table public.user_interests  enable row level security;
alter table public.team_members    enable row level security;
alter table public.team_member_interests enable row level security;
alter table public.site_settings   enable row level security;
alter table public.activity_log    enable row level security;

-- ---- organizations -------------------------------------------------------
drop policy if exists orgs_read on public.organizations;
create policy orgs_read on public.organizations
  for select using (is_active or public.is_staff());

drop policy if exists orgs_insert on public.organizations;
create policy orgs_insert on public.organizations
  for insert with check (public.is_admin());

drop policy if exists orgs_update on public.organizations;
create policy orgs_update on public.organizations
  for update using (public.is_admin() or id = public.my_org())
  with check (public.is_admin() or id = public.my_org());

drop policy if exists orgs_delete on public.organizations;
create policy orgs_delete on public.organizations
  for delete using (public.is_admin());

-- ---- profiles ------------------------------------------------------------
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select using (id = auth.uid() or public.is_staff());

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (id = auth.uid() or public.is_admin());

-- A user may edit their own row, but not promote themselves: the WITH CHECK
-- pins role and status to what they already are. Both comparisons go through
-- SECURITY DEFINER functions — reading `profiles` inline here would re-enter
-- this same policy and recurse.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = public.current_role_name()
    and status = public.current_status()
  );

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete using (public.is_admin());

-- ---- categories ----------------------------------------------------------
drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select using (true);

drop policy if exists categories_write on public.categories;
create policy categories_write on public.categories
  for all using (public.is_staff()) with check (public.is_staff());

-- ---- events --------------------------------------------------------------
drop policy if exists events_read on public.events;
create policy events_read on public.events
  for select using (status = 'published' or public.is_staff());

drop policy if exists events_insert on public.events;
create policy events_insert on public.events
  for insert with check (
    public.is_admin()
    or (public.is_staff() and organization_id = public.my_org())
  );

drop policy if exists events_update on public.events;
create policy events_update on public.events
  for update using (
    public.is_admin()
    or (public.is_staff() and organization_id = public.my_org())
  ) with check (
    public.is_admin()
    or (public.is_staff() and organization_id = public.my_org())
  );

drop policy if exists events_delete on public.events;
create policy events_delete on public.events
  for delete using (
    public.is_admin()
    or (public.is_staff() and organization_id = public.my_org())
  );

-- ---- event_categories ----------------------------------------------------
drop policy if exists event_cats_read on public.event_categories;
create policy event_cats_read on public.event_categories for select using (true);

drop policy if exists event_cats_write on public.event_categories;
create policy event_cats_write on public.event_categories
  for all using (
    public.is_admin() or exists (
      select 1 from public.events e
      where e.id = event_id and e.organization_id = public.my_org()
    )
  ) with check (
    public.is_admin() or exists (
      select 1 from public.events e
      where e.id = event_id and e.organization_id = public.my_org()
    )
  );

-- ---- event_saves ---------------------------------------------------------
drop policy if exists saves_read on public.event_saves;
create policy saves_read on public.event_saves
  for select using (user_id = auth.uid() or public.is_staff());

drop policy if exists saves_write on public.event_saves;
create policy saves_write on public.event_saves
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- event_rsvps ---------------------------------------------------------
drop policy if exists rsvps_read on public.event_rsvps;
create policy rsvps_read on public.event_rsvps
  for select using (user_id = auth.uid() or public.is_staff());

drop policy if exists rsvps_write on public.event_rsvps;
create policy rsvps_write on public.event_rsvps
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- user_interests ------------------------------------------------------
drop policy if exists interests_read on public.user_interests;
create policy interests_read on public.user_interests
  for select using (user_id = auth.uid() or public.is_staff());

drop policy if exists interests_write on public.user_interests;
create policy interests_write on public.user_interests
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- team_members --------------------------------------------------------
drop policy if exists team_read on public.team_members;
create policy team_read on public.team_members
  for select using (is_active or public.is_staff());

drop policy if exists team_write on public.team_members;
create policy team_write on public.team_members
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- team_member_interests ------------------------------------------------
-- Same public/staff split as team_members itself: readable by anyone (they
-- render on the public roster), writable only by admins.
drop policy if exists team_interests_read on public.team_member_interests;
create policy team_interests_read on public.team_member_interests for select using (true);

drop policy if exists team_interests_write on public.team_member_interests;
create policy team_interests_write on public.team_member_interests
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- site_settings -------------------------------------------------------
drop policy if exists settings_read on public.site_settings;
create policy settings_read on public.site_settings for select using (true);

drop policy if exists settings_write on public.site_settings;
create policy settings_write on public.site_settings
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- activity_log --------------------------------------------------------
drop policy if exists activity_read on public.activity_log;
create policy activity_read on public.activity_log
  for select using (public.is_staff());

-- Staff-only, and you can only log as yourself — otherwise the audit trail is
-- worth nothing the moment someone wants to forge an entry.
drop policy if exists activity_insert on public.activity_log;
create policy activity_insert on public.activity_log
  for insert with check (public.is_staff() and actor_id = auth.uid());

-- --------------------------------------------------------------------------
-- 4. Convenience views (public read, joins already resolved)
-- --------------------------------------------------------------------------

-- create or replace view can only append new columns at the end — inserting
-- thumbnail_url anywhere else shifts every later column's position, which
-- Postgres reports as "cannot change name of view column". Drop first so the
-- column order below can just read naturally, banner_url and thumbnail_url
-- together.
drop view if exists public.events_public;
create view public.events_public as
  select
    e.id, e.title, e.slug, e.summary, e.description, e.thumbnail_url, e.banner_url,
    e.starts_at, e.ends_at, e.venue, e.mode, e.fee_amount, e.currency,
    e.capacity, e.register_url, e.status, e.is_featured,
    e.organization_id,
    coalesce(e.organizer_label, o.name) as organizer,
    o.slug     as organization_slug,
    o.initials as organization_initials,
    coalesce(
      (select array_agg(c.name order by c.sort_order, c.name)
         from public.event_categories ec
         join public.categories c on c.id = ec.category_id
        where ec.event_id = e.id),
      '{}'::text[]
    ) as tags,
    (select count(*) from public.event_saves s where s.event_id = e.id) as save_count,
    (select count(*) from public.event_rsvps r
      where r.event_id = e.id and r.response = 'yes')                   as rsvp_count
  from public.events e
  left join public.organizations o on o.id = e.organization_id;

-- Views run with the definer's rights by default in older Postgres; pin them
-- to the querying user so the RLS above still applies.
alter view public.events_public set (security_invoker = true);

-- --------------------------------------------------------------------------
-- 5. Storage bucket for event banners / org logos / avatars
-- --------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects
  for select using (bucket_id = 'media');

drop policy if exists media_write on storage.objects;
create policy media_write on storage.objects
  for insert with check (bucket_id = 'media' and auth.uid() is not null);

drop policy if exists media_update on storage.objects;
create policy media_update on storage.objects
  for update using (bucket_id = 'media' and auth.uid() is not null);

drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects
  for delete using (bucket_id = 'media' and public.is_staff());

-- --------------------------------------------------------------------------
-- 6. Seed — the filter chips and organizations already on the static site
-- --------------------------------------------------------------------------

insert into public.categories (name, slug, group_name, sort_order) values
  ('Online',        'online',        'mode',      1),
  ('Offline',       'offline',       'mode',      2),
  ('Hybrid',        'hybrid',        'mode',      3),
  ('Past',          'past',          'timing',    1),
  ('Ongoing',       'ongoing',       'timing',    2),
  ('Upcoming',      'upcoming',      'timing',    3),
  ('IEDC',          'iedc',          'organiser', 1),
  ('MuLearn',       'mulearn',       'organiser', 2),
  ('IEEE',          'ieee',          'organiser', 3),
  ('CSI',           'csi',           'organiser', 4),
  ('GDSC',          'gdsc',          'organiser', 5),
  ('IET',           'iet',           'organiser', 6),
  ('ISTE',          'iste',          'organiser', 7),
  ('Design',        'design',        'topic',     1),
  ('Web Dev',       'web-dev',       'topic',     2),
  ('Cyber Security','cyber-security','topic',     3),
  ('Networking',    'networking',    'topic',     4),
  ('Startup',       'startup',       'topic',     5),
  ('Open Mic',      'open-mic',      'topic',     6),
  ('Music',         'music',         'topic',     7),
  ('Pitching',      'pitching',      'topic',     8),
  ('Beginner',      'beginner',      'topic',     9)
on conflict (slug) do nothing;

insert into public.organizations (name, slug, category, type, initials, about) values
  ('Catalyst IEDC', 'catalyst-iedc', 'Innovation & Entrepreneurship', 'club', 'CI',
   'Catalyst is the Innovation and Entrepreneurship Development Cell at Mar Baselios College of Engineering and Technology. It exists to turn half-formed student ideas into things that ship — products, prototypes, and the occasional company.'),
  ('MuLearn MBCET', 'mulearn-mbcet', 'Peer Learning Community', 'organisation', 'µL',
   'MuLearn is a peer-to-peer learning community where students pick an interest group, set their own pace, and learn in the open.'),
  ('IEEE SB MBCET', 'ieee-sb-mbcet', 'Technical Chapter', 'organisation', 'IEEE',
   'The IEEE Student Branch runs technical talks, workshops and paper presentations across the engineering disciplines.')
on conflict (slug) do nothing;

insert into public.site_settings (key, value) values
  ('site', '{"name":"eventundo","tagline":"Discover events"}'::jsonb)
on conflict (key) do nothing;
