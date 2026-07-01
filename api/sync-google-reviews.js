export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  const supabaseUrl = trimTrailingSlash(process.env.SUPABASE_URL);
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: "Supabase Edge Function credentials are not configured" });
  }

  try {
    const edgeResponse = await fetch(`${supabaseUrl}/functions/v1/sync-google-reviews`, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        ...(cronSecret ? { "x-cron-secret": cronSecret } : {}),
      },
      body: JSON.stringify({ source: "vercel-api" }),
    });

    const payload = await readJson(edgeResponse);
    res.setHeader("Cache-Control", "no-store");
    return res.status(edgeResponse.status).json(payload || {});
  } catch (error) {
    console.error("sync-google-reviews proxy exception:", error);
    return res.status(500).json({ error: error.message || "Unable to invoke Supabase review sync" });
  }
}

function trimTrailingSlash(value) {
  return value ? String(value).replace(/\/+$/, "") : "";
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
