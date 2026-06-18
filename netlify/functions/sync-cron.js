// =====================================================================
//  sync-cron.js — scheduled function (runs every 15 minutes).
//
//  Uses Netlify's schedule() helper to register a cron expression. The
//  schedule lives in code, so no extra netlify.toml config is required.
//  '*/15 * * * *' = every 15 minutes, so live matches finish and grade
//  promptly instead of lingering as "live" for hours. One API call per
//  run keeps us well under the football-data.org free-tier rate limit.
// =====================================================================

const { schedule } = require('@netlify/functions');
const { syncAndGrade } = require('./lib/sync');

exports.handler = schedule('*/15 * * * *', async () => {
  try {
    const summary = await syncAndGrade();
    console.log('[sync-cron] sync complete:', JSON.stringify(summary));
  } catch (err) {
    // Log and return 200 so a transient upstream failure (e.g. a 429 rate
    // limit) doesn't mark the scheduled invocation as failed; the next run
    // in 15 minutes will retry.
    console.error('[sync-cron] sync failed:', err.message);
  }
  return { statusCode: 200 };
});
