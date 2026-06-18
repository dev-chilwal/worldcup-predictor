# World Cup Predictor

A free web app where you and your friends predict 2026 FIFA World Cup scores. Points are awarded automatically and a leaderboard updates every few hours.

**Scoring (highest tier only, per prediction):**
- **5 points** — exact score
- **4 points** — correct goal difference
- **3 points** — correct result (winner/draw)
- **0 points** — otherwise

**Stack (all free):** Netlify (hosts the site + runs the scheduled results sync) · Supabase (database + magic-link login) · football-data.org (live fixtures and results).

---

## What's in this folder

```
worldcup-predictor/
├── public/                     ← the website (deployed to Netlify)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── config.js               ← YOU edit this (Supabase URL + anon key)
├── netlify/functions/
│   ├── lib/sync.js             ← fetches results + grades predictions
│   ├── sync-results.js         ← on-demand "Refresh results" endpoint
│   └── sync-cron.js            ← runs automatically every 3 hours
├── supabase/schema.sql         ← run once in Supabase to create the database
├── netlify.toml
├── package.json
└── README.md
```

---

## Setup — about 20 minutes, no coding required

You'll create three free accounts, copy a few keys between them, and deploy. Follow in order.

### 1. Create the Supabase project (database + login)

1. Go to **https://supabase.com**, sign up, and click **New project**. Pick any name, set a database password (save it somewhere), choose a region near you, and create it. Wait ~2 minutes for it to finish provisioning.
2. In the left sidebar open **SQL Editor → New query**. Open `supabase/schema.sql` from this folder, copy the **entire** contents, paste it in, and click **Run**. You should see "Success". This creates the tables, security rules, the scoring function, and the leaderboard.
3. Magic-link login is on by default. (Optional but recommended for friends: go to **Authentication → Providers → Email** and make sure "Email" is enabled; you can leave "Confirm email" on.)
4. Get your two public keys: **Project Settings → API**. Copy:
   - **Project URL** (looks like `https://abcdxyz.supabase.co`)
   - **anon / public** key (a long string)

### 2. Get a football data API key (results source)

1. Go to **https://www.football-data.org/client/register** and register for the **free** tier. You'll get an API token by email.
2. Keep that token handy. (Note: the free tier's competition coverage is limited. If the World Cup isn't included on the free plan when the tournament starts, you may need their lowest paid tier or a free alternative — see Troubleshooting. The app surfaces a clear error if the token can't access the World Cup.)

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

In your Netlify site dashboard go to **Site configuration → Environment variables** and add three variables:

| Key | Value |
|-----|-------|
| `FOOTBALL_DATA_TOKEN` | your football-data.org token (step 2) |
| `SUPABASE_URL` | the same Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role** key from Project Settings → API (the secret one — used only server-side) |

Then trigger a redeploy (**Deploys → Trigger deploy → Deploy site**) so the functions pick up the variables.

### 6. Tell Supabase your site URL (so magic links work)

In Supabase: **Authentication → URL Configuration** → set **Site URL** to your Netlify address (e.g. `https://your-site.netlify.app`) and add it under **Redirect URLs** too. This makes the email login links return users to your app.

### 7. Load the fixtures and go

1. Visit `https://your-site.netlify.app/.netlify/functions/sync-results` once in your browser to pull the World Cup fixtures into the database. You should get a small JSON summary like `{"matchesUpserted":104,...}`.
2. Open your site, log in with your email (check your inbox for the magic link), make some predictions, and share the URL with your friends.

The `sync-cron` function then refreshes results and regrades every 3 hours automatically. Anyone can also hit the **Refresh results** button in the app to pull the latest.

---

## How it works

- **Predictions lock at kickoff.** The database security rules reject any insert or edit once a match's kickoff time has passed — so no one can change a prediction after the game starts, even if they tried to bypass the app.
- **Grading is server-side only.** Points are computed by the `grade_predictions()` database function (run by the scheduled sync), never in the browser, so scores can't be faked.
- **Leaderboard** is an aggregated view exposing only display names and totals — never anyone's individual predictions.

## Free-tier notes

- Supabase free projects **pause after 7 days of no activity**; just open the dashboard to resume. Database storage on Netlify isn't used here (all data lives in Supabase), so no billing-date concerns.
- Netlify free includes scheduled functions and is far more than enough for a friend group.
- The football-data.org free token is rate-limited (about 10 requests/min); the app only calls it on the schedule and on manual refresh, well within limits.

## Troubleshooting

- **`/.netlify/functions/sync-results` returns a 403** → your football-data.org token can't access competition `WC`. Confirm your plan covers the World Cup, or swap in an alternative results source (e.g. API-Football's free tier) by editing `netlify/functions/lib/sync.js`.
- **Magic link logs you into a blank/old page** → double-check the Site URL and Redirect URLs in Supabase (step 6) match your real Netlify domain.
- **"App not configured yet"** → `public/config.js` still has placeholders, or wasn't deployed. Re-check step 3 and redeploy.
- **No fixtures showing** → run the sync URL from step 7.1 once; check the function logs in Netlify if it errors.
- **Friends can't sign up** → make sure Email auth is enabled in Supabase (step 1.3).
