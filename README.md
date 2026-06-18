# World Cup Predictor

A free web app where you and your friends predict 2026 FIFA World Cup scores. Points are awarded automatically and the leaderboard refreshes about every 15 minutes. It also shows live group standings and a top scorers/assisters board.

**Scoring (highest tier only, per prediction):**
- **5 points** — exact score
- **4 points** — correct goal difference
- **3 points** — correct result (winner/draw)
- **0 points** — otherwise

**Stack (all free):** Netlify (hosts the site + runs the scheduled results sync) · Supabase (database + accounts) · ESPN's free public soccer API (live fixtures, results, standings — no API key required).

**Login:** friends join with a **display name + a shared group code** (set in `public/config.js` as `GROUP_CODE`). No emails are sent — share the code with your friends however you like.

---

## What's in this folder

```
worldcup-predictor/
├── public/                     ← the website (deployed to Netlify)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── config.js               ← YOU edit this (Supabase URL, anon key, group code)
├── netlify/functions/
│   ├── lib/sync.js             ← fetches results/standings/scorers + grades
│   ├── sync-results.js         ← on-demand "Refresh results" endpoint
│   └── sync-cron.js            ← runs automatically every 15 minutes
├── supabase/schema.sql                 ← run first (core tables + scoring)
├── supabase/02_standings_scorers.sql   ← run second (standings + scorers)
├── netlify.toml
├── package.json
└── README.md
```

---

## Setup — about 20 minutes, no coding required

You'll create two free accounts (Supabase + Netlify), copy a few keys between them, and deploy. The results data comes from ESPN's free public API, so there's no third signup. Follow in order.

### 1. Create the Supabase project (database + login)

1. Go to **https://supabase.com**, sign up, and click **New project**. Pick any name, set a database password (save it somewhere), choose a region near you, and create it. Wait ~2 minutes for it to finish provisioning.
2. In the left sidebar open **SQL Editor → New query**. Open `supabase/schema.sql`, copy the **entire** contents, paste it in, and click **Run** (creates the core tables, security rules, scoring function, and leaderboard). Then open a **New query** again, paste the contents of `supabase/02_standings_scorers.sql`, and **Run** that too (adds the group standings and top-scorers tables). Both should say "Success".
3. Set up accounts for the name + code login: go to **Authentication → Providers → Email**, make sure **Email** is enabled, and turn **OFF "Confirm email"** (this is what stops any emails being sent). Save.
4. Get your two public keys: **Project Settings → API**. Copy:
   - **Project URL** (looks like `https://abcdxyz.supabase.co`)
   - **anon / public** key (a long string)

### 2. Results data source (nothing to do)

Fixtures, live scores, and standings come from ESPN's free public soccer API — **no signup and no API key required**. Skip straight to the next step. (See Troubleshooting for notes on the top-scorers data, which is best-effort on a free source.)

### 3. Fill in your config

Open `public/config.js` and replace the placeholders with the **Supabase Project URL** and **anon key** from step 1.4:

```js
window.SUPABASE_URL = "https://abcdxyz.supabase.co";
window.SUPABASE_ANON_KEY = "your-long-anon-public-key";
```

The anon key is safe to ship in the browser — your data is protected by the row-level security rules in the schema. Never put the **service role** key here.

### 4. Deploy to Netlify

**Easiest (drag-and-drop won't work because of the functions — use Git or the CLI):**

Option A — GitHub + Netlify (recommended, gives auto-deploys):
1. Put this `worldcup-predictor` folder in a GitHub repo (new repo → upload the files).
2. Go to **https://netlify.com**, sign up, **Add new site → Import an existing project**, connect GitHub, and pick the repo.
3. Build settings are read from `netlify.toml` automatically (publish directory `public`, functions in `netlify/functions`). Just click **Deploy**.

Option B — Netlify CLI:
```bash
npm install -g netlify-cli
cd worldcup-predictor
netlify deploy --prod
```
(Accept the defaults; it reads `netlify.toml`.)

### 5. Add the backend secrets to Netlify

In your Netlify site dashboard go to **Site configuration → Environment variables** and add just two variables (no results API key is needed — ESPN is keyless):

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | the same Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role** key from Project Settings → API (the secret one — used only server-side) |

Then trigger a redeploy (**Deploys → Trigger deploy → Deploy site**) so the functions pick up the variables.

### 6. Set your group code

Open `public/config.js` and set `window.GROUP_CODE` to the shared code your friends will type to join (at least 6 characters). Pick it **once** before sharing — changing it later locks out anyone who already joined. Commit and push so Netlify redeploys.

### 7. Load the fixtures and go

1. Visit `https://your-site.netlify.app/.netlify/functions/sync-results` once in your browser to pull the World Cup fixtures, standings, and any results into the database. You should get a small JSON summary like `{"matchesUpserted":104,"standingsUpserted":48,...}`.
2. Open your site, enter a display name and the group code to join, make some predictions, and share the site URL **and the code** with your friends.

The `sync-cron` function then refreshes results, standings, and scorers and regrades every 15 minutes automatically. Anyone can also hit the **Refresh results** button in the app to pull the latest.

> **Switching from an earlier (football-data.org) setup?** ESPN uses different match IDs. Before the first ESPN sync, clear old fixtures so you don't get duplicates: in the SQL Editor run `delete from public.predictions; delete from public.matches;` (the `02_standings_scorers.sql` file has this note at the bottom). Skip this on a fresh project.

---

## How it works

- **Predictions lock at kickoff.** The database security rules reject any insert or edit once a match's kickoff time has passed — so no one can change a prediction after the game starts, even if they tried to bypass the app.
- **Grading is server-side only.** Points are computed by the `grade_predictions()` database function (run by the scheduled sync), never in the browser, so scores can't be faked.
- **Leaderboard** is an aggregated view exposing only display names and totals — never anyone's individual predictions.
- **Standings and scorers** are synced from ESPN into read-only tables. Group standings come directly from ESPN; top scorers/assisters are tallied incrementally from each finished match (best-effort — see Troubleshooting).

## Free-tier notes

- Supabase free projects **pause after 7 days of no activity**; just open the dashboard to resume. Database storage on Netlify isn't used here (all data lives in Supabase), so no billing-date concerns.
- Netlify free includes scheduled functions and is far more than enough for a friend group.
- ESPN's public API is keyless and free; the sync calls it on the schedule and on manual refresh.

## Troubleshooting

- **No fixtures showing** → run `https://your-site.netlify.app/.netlify/functions/sync-results` once; check the function logs in Netlify if it errors. ESPN is unofficial, so if its API format ever changes the mapping in `netlify/functions/lib/sync.js` may need a tweak.
- **Standings empty but fixtures work** → ESPN populates group standings once the tournament data is live; re-run the sync.
- **Top scorers/assisters stay empty** → this is the known best-effort part. ESPN has no free tournament-wide scorers feed, so the app tallies goals from each finished match's data; if that data isn't exposed, the board stays empty. Everything else still works. For guaranteed scorer data you'd swap in a paid API in `lib/sync.js`.
- **"App not configured yet"** → `public/config.js` still has placeholders (URL, anon key, or group code), or wasn't deployed. Re-check step 3 and redeploy.
- **Friends can't join** → Email auth enabled and **"Confirm email" OFF** in Supabase, and they're typing the exact group code.
- **Friends can't join** → make sure Email auth is enabled and **"Confirm email" is OFF** in Supabase (step 1.3), and that they're typing the exact group code.
