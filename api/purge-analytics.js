import { createClient } from '@supabase/supabase-js';

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
  if (cronSecret) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorised' });
    }
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials not configured' });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase.rpc('purge_old_analytics_events_rpc');

    if (error) {
      console.error('purge-analytics error:', error);
      return res.status(500).json({ error: error.message });
    }

    const deletedCount = data ?? 0;
    console.log(`purge-analytics: deleted ${deletedCount} events older than 90 days`);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      deleted: deletedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('purge-analytics exception:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
