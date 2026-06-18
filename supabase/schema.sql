-- =====================================================================
--  World Cup Predictor — Supabase schema, security, and scoring logic
--  Run this whole file once in: Supabase Dashboard > SQL Editor > New query
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PROFILES  (one row per signed-up user, linked to auth.users)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- Auto-create a profile when a new user signs up via magic link.
-- Display name defaults to the part of the email before "@", user can rename later.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 2. MATCHES  (fixtures + results; id is the football-data.org match id)
-- ---------------------------------------------------------------------
create table if not exists public.matches (
  id          bigint primary key,            -- football-data.org match id
  matchday    text,                          -- e.g. 'Matchday 1', 'Round of 16'
  utc_kickoff timestamptz not null,
  home_team   text not null,
  away_team   text not null,
  home_crest  text,
  away_crest  text,
  status      text not null default 'SCHEDULED', -- SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED
  home_score  int,                           -- null until result known
  away_score  int,
  updated_at  timestamptz not null default now()
);

create index if not exists matches_kickoff_idx on public.matches (utc_kickoff);

-- ---------------------------------------------------------------------
-- 3. PREDICTIONS  (one per user per match)
-- ---------------------------------------------------------------------
create table if not exists public.predictions (
  id         bigint generated always as identity primary key,
  user_id    uuid   not null references auth.users(id) on delete cascade,
  match_id   bigint not null references public.matches(id) on delete cascade,
  home_pred  int    not null check (home_pred >= 0 and home_pred <= 30),
  away_pred  int    not null check (away_pred >= 0 and away_pred <= 30),
  points     int,                            -- null until graded
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, match_id)
);

create index if not exists predictions_user_idx  on public.predictions (user_id);
create index if not exists predictions_match_idx on public.predictions (match_id);

-- ---------------------------------------------------------------------
-- 4. SCORING FUNCTION
--    Exclusive tiers (highest only):
--      5 pts  exact score
--      4 pts  correct goal difference (incl. correct draw margin)
--      3 pts  correct result (outcome) only
--      0 pts  otherwise
--    Grades every prediction whose match is FINISHED and not yet scored.
-- ---------------------------------------------------------------------
create or replace function public.grade_predictions()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  graded_count integer;
begin
  with scored as (
    update public.predictions p
    set points = case
        when p.home_pred = m.home_score and p.away_pred = m.away_score then 5
        when (p.home_pred - p.away_pred) = (m.home_score - m.away_score) then 4
        when sign(p.home_pred - p.away_pred) = sign(m.home_score - m.away_score) then 3
        else 0
      end,
      updated_at = now()
    from public.matches m
    where p.match_id = m.id
      and m.status = 'FINISHED'
      and m.home_score is not null
      and m.away_score is not null
      and p.points is null
    returning p.id
  )
  select count(*) into graded_count from scored;
  return graded_count;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. LEADERBOARD  (aggregated; safe to expose to all signed-in users)
--    Exposes only display name + totals, never individual predictions.
-- ---------------------------------------------------------------------
create or replace view public.leaderboard
with (security_invoker = off) as
select
  pr.id                                            as user_id,
  pr.display_name,
  coalesce(sum(p.points), 0)                       as total_points,
  count(p.points)                                  as graded_predictions,
  count(*) filter (where p.points = 5)             as exact_scores,
  count(*) filter (where p.points = 4)             as goal_diffs,
  count(*) filter (where p.points = 3)             as correct_results
from public.profiles pr
left join public.predictions p on p.user_id = pr.id
group by pr.id, pr.display_name;

-- ---------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.matches     enable row level security;
alter table public.predictions enable row level security;

-- profiles: anyone signed in can read (needed for leaderboard names); edit only your own
drop policy if exists "profiles readable by authenticated" on public.profiles;
create policy "profiles readable by authenticated"
  on public.profiles for select to authenticated using (true);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- matches: read-only for everyone signed in (writes happen via service role only)
drop policy if exists "matches readable by authenticated" on public.matches;
create policy "matches readable by authenticated"
  on public.matches for select to authenticated using (true);

-- predictions: you may read your own
drop policy if exists "read own predictions" on public.predictions;
create policy "read own predictions"
  on public.predictions for select to authenticated
  using (auth.uid() = user_id);

-- predictions: insert your own, only BEFORE kickoff
drop policy if exists "insert own prediction before kickoff" on public.predictions;
create policy "insert own prediction before kickoff"
  on public.predictions for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.matches m
      where m.id = match_id and m.utc_kickoff > now()
    )
  );

-- predictions: update your own, only BEFORE kickoff
drop policy if exists "update own prediction before kickoff" on public.predictions;
create policy "update own prediction before kickoff"
  on public.predictions for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.matches m
      where m.id = match_id and m.utc_kickoff > now()
    )
  );

-- Allow the leaderboard view (security definer) to be selected by all signed-in users
grant select on public.leaderboard to authenticated;

-- =====================================================================
--  Done. Magic-link auth is enabled by default in Supabase.
--  The matches table is populated by the Netlify scheduled function.
-- =====================================================================
