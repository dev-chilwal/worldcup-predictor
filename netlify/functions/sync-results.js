// =====================================================================
//  sync-results.js — on-demand HTTP function.
//
//  Backs the frontend "Refresh results" button. A GET request triggers a
//  sync + grade run and returns the summary as JSON. CORS is permissive so
//  the static site can call it directly from the browser.
// =====================================================================

const { syncAndGrade } = require('./lib/sync');

// Permissive CORS headers (GET + OPTIONS preflight).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  // Answer CORS preflight requests immediately.
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    const summary = await syncAndGrade();
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: true, ...summary }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
