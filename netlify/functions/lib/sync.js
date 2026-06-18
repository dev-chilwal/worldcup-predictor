// =====================================================================
//  sync.js — shared module for syncing World Cup results and grading.
//
//  Exposes a single function, syncAndGrade(), used by both the on-demand
//  HTTP function (sync-results.js) and the scheduled function (sync-cron.js).
//
//  Data source: ESPN's unofficial (free, no API key) soccer API.
//
//  Flow inside syncAndGrade():
//    1. Fetch + upsert matches (scoreboard, day-by-day across the window).
//    2. Fetch + upsert standings (best-effort; failure is non-fatal).
//    3. Call grade_predictions() RPC (scores newly-finished predictions).
//    4. Process scorers/assists for newly-finished matches (best-effort).
//    5. Return a small summary object.
// =====================================================================

const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------
//  ESPN endpoints (all free, no key; return JSON via global fetch).
// ---------------------------------------------------------------------
const ESPN_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const ESPN_STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings';
const ESPN_SUMMARY_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary';

// Tournament window (inclusive). Scoreboard is fetched one day at a time
// because a multi-day range in a single call can truncate / cap results.
const TOURNAMENT_START = '2026-06-11';
const TOURNAMENT_END = '2026-07-19';

// Polite concurrency for the day-by-day scoreboard fetches.
const SCOREBOARD_CONCURRENCY = 5;
// Concurrency for per-match summary fetches.
const SUMMARY_CONCURRENCY = 4;
// Upsert batch size for Supabase writes.
const UPSERT_BATCH_SIZE = 200;

// =====================================================================
//  Small utilities
// =====================================================================

/**
 * Read and validate the environment variables this module depends on.
 * Only SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required now.
 *
 * @returns {{supabaseUrl: string, supabaseServiceRoleKey: string}}
 */
function readEnv() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    throw new Error(
      'Missing required environment variable(s): ' + missing.join(', ')
    );
  }

  return { supabaseUrl, supabaseServiceRoleKey };
}

/**
 * Fetch a URL and parse JSON, throwing a descriptive error on non-200.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(
      'ESPN request failed: ' +
        response.status +
        ' ' +
        response.statusText +
        ' (' +
        url +
        ') — ' +
        body
    );
  }
  return response.json();
}

/**
 * Run an async worker over a list of items with bounded concurrency.
 * Returns the array of results (in completion order is not guaranteed,
 * but order is preserved by index). Individual rejections propagate; use
 * a worker that swallows its own errors when failures should be tolerated.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = [];
  const n = Math.min(limit, items.length);
  for (let k = 0; k < n; k++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

/**
 * Build the inclusive list of YYYYMMDD strings from start to end (ISO dates).
 *
 * @param {string} startIso 'YYYY-MM-DD'
 * @param {string} endIso   'YYYY-MM-DD'
 * @returns {string[]}
 */
function buildDateList(startIso, endIso) {
  const dates = [];
  const start = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    dates.push('' + y + m + day);
  }
  return dates;
}

/**
 * Title-case a hyphen/underscore-separated slug, e.g. 'group-stage' -> 'Group Stage'.
 *
 * @param {string} slug
 * @returns {string}
 */
function titleCaseSlug(slug) {
  return String(slug)
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Derive a human-readable matchday label from an ESPN season slug.
 *
 * @param {string|undefined} slug e.g. 'group-stage', 'round-of-16'
 * @returns {string}
 */
function matchdayFromSlug(slug) {
  const s = String(slug || '').toLowerCase();
  const map = {
    'group-stage': 'Group Stage',
    'round-of-16': 'Round of 16',
    'round-of-32': 'Round of 32',
    quarterfinals: 'Quarterfinals',
    semifinals: 'Semifinals',
    'third-place': 'Third Place',
    '3rd-place': 'Third Place',
    final: 'Final',
  };
  if (map[s]) return map[s];
  if (s) return titleCaseSlug(s);
  return 'Group Stage';
}

/**
 * Map an ESPN status.type.state into the app's status vocabulary.
 *
 * @param {object} statusType e.status.type
 * @returns {string}
 */
function mapStatus(statusType) {
  const st = statusType || {};
  if (st.completed === true) return 'FINISHED';
  switch (st.state) {
    case 'pre':
      return 'TIMED';
    case 'in':
      return 'IN_PLAY';
    case 'post':
      return 'FINISHED';
    default:
      return 'TIMED';
  }
}

/**
 * Parse a competitor's score string/number into an int, or null.
 *
 * @param {*} raw
 * @returns {number|null}
 */
function parseScore(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

// =====================================================================
//  Matches
// =====================================================================

/**
 * Map a single ESPN scoreboard event into a row for the `matches` table.
 *
 * @param {object} e ESPN event
 * @param {string} nowIso shared ISO timestamp for the batch
 * @returns {object|null} row, or null if the event is unusable
 */
function mapEventToRow(e, nowIso) {
  if (!e || e.id == null) return null;
  const comp = (e.competitions && e.competitions[0]) || {};
  const competitors = Array.isArray(comp.competitors) ? comp.competitors : [];

  // Resolve home/away by competitor.homeAway, NOT array order.
  const homeC = competitors.find((c) => c && c.homeAway === 'home') || {};
  const awayC = competitors.find((c) => c && c.homeAway === 'away') || {};

  const homeTeam = homeC.team || {};
  const awayTeam = awayC.team || {};

  const status = mapStatus(e.status && e.status.type);
  const isPre = e.status && e.status.type && e.status.type.state === 'pre';

  const homeScore = isPre ? null : parseScore(homeC.score);
  const awayScore = isPre ? null : parseScore(awayC.score);

  const seasonSlug = e.season && e.season.slug;

  return {
    id: parseInt(e.id, 10),
    matchday: matchdayFromSlug(seasonSlug),
    utc_kickoff: e.date,
    home_team:
      homeTeam.displayName || homeTeam.shortDisplayName || 'TBD',
    away_team:
      awayTeam.displayName || awayTeam.shortDisplayName || 'TBD',
    home_crest: homeTeam.logo || null,
    away_crest: awayTeam.logo || null,
    status,
    home_score: homeScore,
    away_score: awayScore,
    updated_at: nowIso,
  };
}

/**
 * Fetch every scoreboard event across the tournament window, one day at a
 * time, with bounded concurrency. Individual day failures are logged and
 * tolerated. De-duplicates events by id.
 *
 * @returns {Promise<{events: object[], days: number}>}
 */
async function fetchAllEvents() {
  const dates = buildDateList(TOURNAMENT_START, TOURNAMENT_END);

  const perDay = await mapWithConcurrency(
    dates,
    SCOREBOARD_CONCURRENCY,
    async (yyyymmdd) => {
      try {
        const data = await fetchJson(
          ESPN_SCOREBOARD_URL + '?dates=' + yyyymmdd
        );
        return Array.isArray(data.events) ? data.events : [];
      } catch (err) {
        console.error(
          '[sync] scoreboard fetch failed for ' + yyyymmdd + ': ' + err.message
        );
        return [];
      }
    }
  );

  // Flatten + de-dupe by event id (a fixture can appear on adjacent days).
  const byId = new Map();
  for (const dayEvents of perDay) {
    for (const e of dayEvents) {
      if (e && e.id != null) byId.set(String(e.id), e);
    }
  }

  return { events: Array.from(byId.values()), days: dates.length };
}

/**
 * Upsert match rows into Supabase in batches.
 *
 * @param {object} supabase
 * @param {object[]} rows
 * @returns {Promise<number>} number of rows upserted
 */
async function upsertMatches(supabase, rows) {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .from('matches')
      .upsert(batch, { onConflict: 'id' });
    if (error) {
      throw new Error('Supabase matches upsert failed: ' + error.message);
    }
    upserted += batch.length;
  }
  return upserted;
}

// =====================================================================
//  Standings
// =====================================================================

/**
 * Read a numeric stat value from an ESPN stats[] array by its `name`.
 *
 * @param {object[]} stats
 * @param {string} name
 * @returns {number} numeric value, or 0 if not found
 */
function getStat(stats, name) {
  if (!Array.isArray(stats)) return 0;
  const s = stats.find((x) => x && x.name === name);
  if (!s) return 0;
  const v = typeof s.value === 'number' ? s.value : parseFloat(s.value);
  return Number.isNaN(v) ? 0 : v;
}

/**
 * Fetch + upsert standings. Best-effort: any failure is logged and the
 * function returns 0 without throwing.
 *
 * @param {object} supabase
 * @param {string} nowIso
 * @returns {Promise<number>} number of standings rows upserted
 */
async function syncStandings(supabase, nowIso) {
  let rows;
  try {
    const root = await fetchJson(ESPN_STANDINGS_URL);
    const groups = Array.isArray(root.children) ? root.children : [];
    rows = [];
    for (const g of groups) {
      const groupName = g && g.name;
      const entries =
        (g && g.standings && Array.isArray(g.standings.entries)
          ? g.standings.entries
          : []) || [];
      for (const ent of entries) {
        const team = (ent && ent.team) || {};
        const stats = (ent && ent.stats) || [];
        rows.push({
          team_id: team.id,
          group_name: groupName,
          team_name: team.displayName,
          team_abbr: team.abbreviation,
          logo:
            (team.logos && team.logos[0] && team.logos[0].href) || null,
          played: getStat(stats, 'gamesPlayed'),
          wins: getStat(stats, 'wins'),
          draws: getStat(stats, 'ties'),
          losses: getStat(stats, 'losses'),
          goals_for: getStat(stats, 'pointsFor'),
          goals_against: getStat(stats, 'pointsAgainst'),
          goal_diff: getStat(stats, 'pointDifferential'),
          points: getStat(stats, 'points'),
          rank: getStat(stats, 'rank'),
          updated_at: nowIso,
        });
      }
    }
  } catch (err) {
    console.error('[sync] standings fetch failed: ' + err.message);
    return 0;
  }

  // Only keep rows with a usable primary key.
  rows = rows.filter((r) => r.team_id != null);

  if (rows.length === 0) return 0;

  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .from('standings')
      .upsert(batch, { onConflict: 'team_id' });
    if (error) {
      console.error('[sync] standings upsert failed: ' + error.message);
      return upserted;
    }
    upserted += batch.length;
  }
  return upserted;
}

// =====================================================================
//  Scorers / assists
// =====================================================================

/**
 * Heuristically decide whether an ESPN scoring/play event is a goal.
 *
 * @param {object} ev
 * @returns {boolean}
 */
function isGoalEvent(ev) {
  if (!ev) return false;
  if (ev.scoringPlay === true) return true;
  const type = ev.type || {};
  const text = String(type.text || ev.text || '').toLowerCase();
  if (text.includes('goal')) return true;
  // ESPN sometimes encodes goal type via a numeric/string id.
  const id = String(type.id || '');
  if (id && /goal/i.test(String(type.name || ''))) return true;
  return false;
}

/**
 * Extract { scorer, assister, teamName, teamAbbr } from a goal event,
 * handling ESPN's varying shapes. Returns null if no scorer found.
 *
 * Shapes handled:
 *   - event.participants[] with .athlete {id, displayName} and .type (role)
 *   - event.athletesInvolved[] ({id, displayName})
 *
 * @param {object} ev
 * @returns {{scorer: object, assister: object|null, teamName: string|null, teamAbbr: string|null}|null}
 */
function extractGoalParticipants(ev) {
  const team = ev.team || {};
  const teamName = team.displayName || team.name || null;
  const teamAbbr = team.abbreviation || null;

  let participants = null;
  if (Array.isArray(ev.participants) && ev.participants.length > 0) {
    participants = ev.participants;
  } else if (
    Array.isArray(ev.athletesInvolved) &&
    ev.athletesInvolved.length > 0
  ) {
    // Normalize the alternate shape into a participants-like list.
    participants = ev.athletesInvolved.map((a) => ({ athlete: a }));
  }

  if (!participants) return null;

  // Try explicit roles first.
  let scorerP = null;
  let assistP = null;
  for (const p of participants) {
    const role = String((p && p.type) || '').toLowerCase();
    if (!scorerP && (role.includes('scorer') || role === 'goal')) scorerP = p;
    else if (!assistP && role.includes('assist')) assistP = p;
  }

  // Fall back to positional: first = scorer, second = assister.
  if (!scorerP) scorerP = participants[0] || null;
  if (!assistP && participants.length > 1) {
    // Only treat the second as an assister if it isn't the scorer.
    const candidate = participants[1];
    if (candidate && candidate !== scorerP) assistP = candidate;
  }

  const scorerAthlete = scorerP && (scorerP.athlete || scorerP);
  if (!scorerAthlete || scorerAthlete.id == null) return null;

  const assistAthlete = assistP && (assistP.athlete || assistP);

  return {
    scorer: scorerAthlete,
    assister:
      assistAthlete && assistAthlete.id != null ? assistAthlete : null,
    teamName,
    teamAbbr,
  };
}

/**
 * Locate the array of scoring-ish events within a summary payload, trying
 * the likely locations in order and using the first non-empty array.
 *
 * @param {object} data summary response
 * @returns {object[]}
 */
function findGoalEvents(data) {
  if (data && Array.isArray(data.keyEvents) && data.keyEvents.length > 0) {
    return data.keyEvents.filter(isGoalEvent);
  }
  if (data && Array.isArray(data.commentary) && data.commentary.length > 0) {
    const goals = data.commentary.filter(isGoalEvent);
    if (goals.length > 0) return goals;
  }
  if (data && Array.isArray(data.plays) && data.plays.length > 0) {
    const goals = data.plays.filter(isGoalEvent);
    if (goals.length > 0) return goals;
  }
  return [];
}

/**
 * Process scorers/assists for newly-finished matches (incremental).
 *
 * @param {object} supabase
 * @returns {Promise<number>} number of matches successfully processed
 */
async function processScorers(supabase) {
  // 1. Which finished matches still need processing?
  const { data: pending, error: selErr } = await supabase
    .from('matches')
    .select('id')
    .eq('status', 'FINISHED')
    .eq('scorers_processed', false);

  if (selErr) {
    console.error('[sync] scorers select failed: ' + selErr.message);
    return 0;
  }

  const ids = (pending || []).map((r) => r.id);
  if (ids.length === 0) return 0;

  let processed = 0;

  await mapWithConcurrency(ids, SUMMARY_CONCURRENCY, async (matchId) => {
    let data;
    try {
      data = await fetchJson(ESPN_SUMMARY_URL + '?event=' + matchId);
    } catch (err) {
      // Fetch failed: leave scorers_processed=false so it retries next run.
      console.error(
        '[sync] summary fetch failed for match ' + matchId + ': ' + err.message
      );
      return;
    }

    // Parse goals defensively — never let one match break the run.
    try {
      const goalEvents = findGoalEvents(data);
      for (const ev of goalEvents) {
        try {
          const parsed = extractGoalParticipants(ev);
          if (!parsed) continue;

          const { scorer, assister, teamName, teamAbbr } = parsed;

          await supabase.rpc('increment_scorer', {
            p_id: String(scorer.id),
            p_name: scorer.displayName || scorer.shortName || 'Unknown',
            p_team: teamName,
            p_team_abbr: teamAbbr,
            p_goals: 1,
            p_assists: 0,
          });

          if (assister) {
            await supabase.rpc('increment_scorer', {
              p_id: String(assister.id),
              p_name:
                assister.displayName || assister.shortName || 'Unknown',
              p_team: teamName,
              p_team_abbr: teamAbbr,
              p_goals: 0,
              p_assists: 1,
            });
          }
        } catch (evErr) {
          console.error(
            '[sync] goal event parse failed (match ' +
              matchId +
              '): ' +
              evErr.message
          );
        }
      }
    } catch (parseErr) {
      console.error(
        '[sync] summary parse failed for match ' +
          matchId +
          ': ' +
          parseErr.message
      );
    }

    // 3. Mark processed: the summary fetch succeeded, so don't retry it.
    const { error: updErr } = await supabase
      .from('matches')
      .update({ scorers_processed: true })
      .eq('id', matchId);
    if (updErr) {
      console.error(
        '[sync] mark scorers_processed failed for match ' +
          matchId +
          ': ' +
          updErr.message
      );
      return;
    }

    processed += 1;
  });

  return processed;
}

// =====================================================================
//  Orchestration
// =====================================================================

/**
 * Sync World Cup data from ESPN into Supabase, then grade predictions.
 *
 * Order:
 *   1. fetch + upsert matches (scoreboard, day-by-day)
 *   2. fetch + upsert standings (best-effort)
 *   3. call grade_predictions() RPC
 *   4. process scorers/assists for newly-finished matches (best-effort)
 *
 * @returns {Promise<{days:number, matchesUpserted:number, standingsUpserted:number, graded:number, matchesScored:number}>}
 */
async function syncAndGrade() {
  const { supabaseUrl, supabaseServiceRoleKey } = readEnv();

  // Service-role key bypasses RLS, required to write matches/standings/scorers.
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const nowIso = new Date().toISOString();

  // --- 1. Matches (day-by-day scoreboard) ------------------------------
  const { events, days } = await fetchAllEvents();
  const rows = events
    .map((e) => mapEventToRow(e, nowIso))
    .filter((r) => r !== null && !Number.isNaN(r.id));
  const matchesUpserted = await upsertMatches(supabase, rows);

  // --- 2. Standings (best-effort; never fatal) -------------------------
  const standingsUpserted = await syncStandings(supabase, nowIso);

  // --- 3. Grade predictions for newly-finished matches -----------------
  const { data: gradedCount, error: rpcError } = await supabase.rpc(
    'grade_predictions'
  );
  if (rpcError) {
    throw new Error('grade_predictions RPC failed: ' + rpcError.message);
  }
  const graded = typeof gradedCount === 'number' ? gradedCount : 0;

  // --- 4. Scorers / assists (best-effort; never fatal) -----------------
  let matchesScored = 0;
  try {
    matchesScored = await processScorers(supabase);
  } catch (err) {
    console.error('[sync] processScorers failed: ' + err.message);
  }

  return { days, matchesUpserted, standingsUpserted, graded, matchesScored };
}

module.exports = { syncAndGrade };
