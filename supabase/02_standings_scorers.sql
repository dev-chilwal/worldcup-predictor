-- =====================================================================
--  World Cup Predictor — migration 02
--  Adds group standings + top scorers/assisters, for the ESPN data source.
--  Run this ONCE in Supabase > SQL Editor (after the original schema.sql).
--  It is additive and safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
--  GROUP STANDINGS  (one row per team; synced from ESPN standings)
-- ---------------------------------------------------------------------
create table if not exists public.standings (
  team_id       text primary key,
  group_name    text not null,            -- 'Group A' .. 'Group H'
  team_name     text not null,
  team_abbr     text,
  logo          text,
  rank          int,                       -- position within the group
  played        int not null default 0,
  wins          int not null default 0,
  draws         int not null default 0,
  losses        int not null default 0,
  goals_for     int not null default 0,
  goals_against int not null default 0,
  goal_diff     int not null default 0,
  points        int not null default 0,
  updated_at    timestamptz not null default now()
);

create index if not exists standings_group_idx on public.standings (group_name, rank);

-- ---------------------------------------------------------------------
--  SCORERS  (one row per player; goals + assists accumulated)
-- ---------------------------------------------------------------------
create table if not exists public.scorers (
  athlete_id   text primary key,
  athlete_name text not null,
  team_name    text,
  team_abbr    text,
  goals        int not null default 0,
  assists      int not null default 0,
  updated_at   timestamptz not null default now()
);

-- Track which finished matches have already had their goals/assists counted,
-- so the sync only processes each match once (incremental aggregation).
alter table public.matches
  add column if not exists scorers_processed boolean not null default false;

-- Increment helper used by the sync (service role) to bump a player's tallies.
create or replace function public.increment_scorer(
  p_id text, p_name text, p_team text, p_team_abbr text, p_goals int, p_assists int
) returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.scorers (athlete_id, athlete_name, team_name, team_abbr, goals, assists, updated_at)
  values (p_id, p_name, p_team, p_team_abbr, coalesce(p_goals, 0), coalesce(p_assists, 0), now())
  on conflict (athlete_id) do update
    set goals        = public.scorers.goals   + coalesce(p_goals, 0),
        assists      = public.scorers.assists + coalesce(p_assists, 0),
        athlete_name = excluded.athlete_name,
        team_name    = coalesce(excluded.team_name, public.scorers.team_name),
        team_abbr    = coalesce(excluded.team_abbr, public.scorers.team_abbr),
        updated_at   = now();
end;
$$;

-- ---------------------------------------------------------------------
--  ROW LEVEL SECURITY  (read-only for signed-in users; writes via service role)
-- ---------------------------------------------------------------------
alter table public.standings enable row level security;
alter table public.scorers   enable row level security;

drop policy if exists "standings readable by authenticated" on public.standings;
create policy "standings readable by authenticated"
  on public.standings for select to authenticated using (true);

drop policy if exists "scorers readable by authenticated" on public.scorers;
create policy "scorers readable by authenticated"
  on public.scorers for select to authenticated using (true);

-- =====================================================================
--  NOTE: switching to ESPN changes match IDs. Before the first ESPN
--  sync, clear any old football-data fixtures (and test predictions):
--      delete from public.predictions;
--      delete from public.matches;
--  (Skip this if your matches table is already empty.)
-- =====================================================================
