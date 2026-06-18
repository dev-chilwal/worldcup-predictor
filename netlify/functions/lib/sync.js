// =====================================================================
//  sync.js — shared module for syncing World Cup results and grading.
//
//  Exposes a single function, syncAndGrade(), used by both the on-demand
//  HTTP function (sync-results.js) and the scheduled function (sync-cron.js).
//
//  Flow:
//    1. Read + validate required environment variables.
//    2. Fetch all WC matches from football-data.org.
//    3. Map each match into a row shaped for the `matches` table.
//    4. Upsert those rows via the Supabase service-role client.
//    5. Call the grade_predictions() RPC to score any newly-finished matches.
//    6. Return a small summary object.
// =====================================================================

const { createClient } = require('@supabase/supabase-js');

// football-data.org endpoint for the World Cup competition ('WC').
const FOOTBALL_DATA_URL =
  'https://api.football-data.org/v4/competitions/WC/matches';

/**
 * Convert an UPPER_SNAKE_CASE stage code (e.g. 'ROUND_OF_16') into a
 * human-friendly Title Case label (e.g. 'Round Of 16').
 *
 * @param {string} stage
 * @returns {string}
 */
function humanizeStage(stage) {
  return String(stage)
    .toLowerCase()
    .split('_')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * Build the human-readable matchday/stage label for a given match.
 *
 * - Group stage matches become 'Matchday <n>'.
 * - Knockout stages are humanized (e.g. 'ROUND_OF_16' -> 'Round Of 16').
 * - Falls back to 'Group Stage' when nothing usable is present.
 *
 * @param {object} match
 * @returns {string}
 */
function buildMatchdayLabel(match) {
  if (match.stage === 'GROUP_STAGE') {
    // matchday is the numeric round within the group stage.
    return 'Matchday ' + match.matchday;
  }
  if (match.stage) {
    return humanizeStage(match.stage);
  }
  return 'Group Stage';
}

/**
 * Map a single football-data.org match object into a row for the
 * `matches` table (column names must match supabase/schema.sql).
 *
 * @param {object} match
 * @param {string} nowIso ISO timestamp shared across the batch.
 * @returns {object}
 */
function mapMatchToRow(match, nowIso) {
  const home = match.homeTeam || {};
  const away = match.awayTeam || {};
  const fullTime = (match.score && match.score.fullTime) || {};

  return {
    id: match.id,
    matchday: buildMatchdayLabel(match),
    utc_kickoff: match.utcDate,
    home_team: home.name || 'TBD',
    away_team: away.name || 'TBD',
    home_crest: home.crest || null,
    away_crest: away.crest || null,
    status: match.status,
    // fullTime scores may legitimately be null before/while a match plays.
    home_score: fullTime.home != null ? fullTime.home : null,
    away_score: fullTime.away != null ? fullTime.away : null,
    updated_at: nowIso,
  };
}

/**
 * Read and validate the environment variables this module depends on.
 * Throws a clear error if any are missing so misconfiguration is obvious.
 *
 * @returns {{footballDataToken: string, supabaseUrl: string, supabaseServiceRoleKey: string}}
 */
function readEnv() {
  const footballDataToken = process.env.FOOTBALL_DATA_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing = [];
  if (!footballDataToken) missing.push('FOOTBALL_DATA_TOKEN');
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    throw new Error(
      'Missing required environment variable(s): ' + missing.join(', ')
    );
  }

  return { footballDataToken, supabaseUrl, supabaseServiceRoleKey };
}

/**
 * Sync World Cup matches from football-data.org into Supabase, then grade
 * any predictions whose matches have just finished.
 *
 * @returns {Promise<{matchesUpserted: number, finished: number, graded: number}>}
 */
async function syncAndGrade() {
  const { footballDataToken, supabaseUrl, supabaseServiceRoleKey } = readEnv();

  // --- 1. Fetch matches from football-data.org -------------------------
  // Node 18+ (the Netlify Functions runtime) provides a global fetch().
  const response = await fetch(FOOTBALL_DATA_URL, {
    headers: { 'X-Auth-Token': footballDataToken },
  });

  if (!response.ok) {
    // Surface status + body so 403 (bad token) / 429 (rate limit) are easy
    // to diagnose from the function logs.
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(
      'football-data.org request failed: ' +
        response.status +
        ' ' +
        response.statusText +
        ' — ' +
        body
    );
  }

  const data = await response.json();
  const matches = Array.isArray(data.matches) ? data.matches : [];

  // --- 2. Map matches into table rows ----------------------------------
  const nowIso = new Date().toISOString();
  const rows = matches.map((match) => mapMatchToRow(match, nowIso));

  // Count finished matches for the returned summary.
  const finished = rows.filter((row) => row.status === 'FINISHED').length;

  // --- 3. Upsert into Supabase via the service-role client -------------
  // Service-role key bypasses RLS, which is required to write `matches`.
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  let matchesUpserted = 0;
  if (rows.length > 0) {
    const { error: upsertError } = await supabase
      .from('matches')
      .upsert(rows, { onConflict: 'id' });

    if (upsertError) {
      throw new Error('Supabase upsert failed: ' + upsertError.message);
    }
    matchesUpserted = rows.length;
  }

  // --- 4. Grade predictions for newly-finished matches -----------------
  const { data: gradedCount, error: rpcError } = await supabase.rpc(
    'grade_predictions'
  );

  if (rpcError) {
    throw new Error('grade_predictions RPC failed: ' + rpcError.message);
  }

  // The RPC returns an integer count of predictions graded this run.
  const graded = typeof gradedCount === 'number' ? gradedCount : 0;

  return { matchesUpserted, finished, graded };
}

module.exports = { syncAndGrade };
