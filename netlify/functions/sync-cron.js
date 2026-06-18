// =====================================================================
//  sync-cron.js — scheduled function (runs every 3 hours).
//
//  Uses Netlify's schedule() helper to register a cron expression. The
//  schedule lives in code, so no extra netlify.toml config is required.
//  '0 */3 * * *' = at minute 0, every 3rd hour.
// =====================================================================

const { schedule } = require('@netlify/functions');
const { syncAndGrade } = require('./lib/sync');

exports.handler = schedule('0 */3 * * *', async () => {
  try {
    const summary = await syncAndGrade();
    console.log('[sync-cron] sync complete:', JSON.stringify(summary));
  } catch (err) {
    // Log and return 200 so a transient upstream failure (e.g. a 429 rate
    // limit) doesn't mark the scheduled invocation as failed; the next run
    // in 3 hours will retry.
    console.error('[sync-cron] sync failed:', err.message);
  }
  return { statusCode: 200 };
});
