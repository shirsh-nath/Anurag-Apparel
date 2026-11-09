/**
 * Vercel Cron handler – deletes analytics events older than 90 days.
 * Called daily by Vercel Cron (configured in vercel.json).
 *
 * Protected by CRON_SECRET env var to prevent unauthorised triggers.
 * Vercel automatically injects the Authorization header when calling cron routes.
 */
export default async function handler(req, res) {
  // Only allow GET (Vercel cron) and POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify the Vercel cron secret (set CRON_SECRET in Vercel env vars)
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials not configured' });
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/purge_old_analytics_events`, {
      method: 'POST',
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) return res.status(502).json({ error: 'Analytics cleanup failed.' });
    const deletedCount = await response.json();
    console.log(`purge-analytics: deleted ${deletedCount} events older than 90 days`);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      deleted: deletedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Analytics cleanup is temporarily unavailable.' });
  }
}
