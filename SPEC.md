# World Cup Predictor — Build Contract (shared by all components)

A free web app for a group of friends to predict 2026 FIFA World Cup match scores.
Frontend on Netlify (static). Backend on Supabase (Postgres + magic-link auth).
Results synced + graded daily by a Netlify scheduled function.

## Database (already defined in supabase/schema.sql — DO NOT change names)

Table `matches`:
- id (bigint, = football-data.org match id), matchday (text label), utc_kickoff (timestamptz),
  home_team (text), away_team (text), home_crest (text), away_crest (text),
  status (text: SCHEDULED|TIMED|IN_PLAY|PAUSED|FINISHED), home_score (int|null), away_score (int|null), updated_at.

Table `predictions`:
- id, user_id (uuid), match_id (bigint), home_pred (int 0..30), away_pred (int 0..30),
  points (int|null), created_at, updated_at. UNIQUE(user_id, match_id).
- RLS: a user may read ONLY their own rows; may insert/update their own row ONLY while matches.utc_kickoff > now().

Table `profiles`: id (uuid = auth user), display_name (text), created_at.
- RLS: any authenticated user can SELECT (for leaderboard names); user can UPDATE only their own.

View `leaderboard` (read-only, all authenticated): columns
- user_id, display_name, total_points, graded_predictions, exact_scores, goal_diffs, correct_results.

RPC `grade_predictions()` -> integer (count graded). Service-role only path uses it.

## Scoring (exclusive, highest tier only) — already implemented in grade_predictions()
- 5 pts exact score
- 4 pts correct goal difference (else)
- 3 pts correct result/outcome (else)
- 0 otherwise

## Auth
Magic link (Supabase `signInWithOtp`). No passwords. A DB trigger auto-creates a profile on signup.

## Config contract (frontend)
A file `config.js` defines globals the app reads:
```
window.SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
window.SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";
```
Frontend loads Supabase JS v2 from CDN: https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2

## Netlify function contract
Env vars (set in Netlify dashboard): FOOTBALL_DATA_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
Source: GET https://api.football-data.org/v4/competitions/WC/matches  header `X-Auth-Token: <FOOTBALL_DATA_TOKEN>`.
Map each match -> upsert into `matches`, then call rpc `grade_predictions`.
Provide a scheduled version (every 3 hours) AND an on-demand HTTP endpoint for a manual "refresh now".
