const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-admin-session",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const GOOGLE_MAPS_REVIEWS_URL = "https://maps.app.goo.gl/6uggTtXDuTrEZQDY8";
const APIFY_GOOGLE_REVIEWS_ACTOR = "compass~google-maps-reviews-scraper";
const REVIEW_SYNC_MAX_REVIEWS = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret);

  const apifyToken = Deno.env.get("APIFY_API_KEY");
  const supabaseUrl = trimTrailingSlash(Deno.env.get("SUPABASE_URL"));
  const supabaseKey = getSupabaseServiceKey();

  if (!apifyToken) {
    return json({ error: "APIFY_API_KEY secret is not configured" }, 500);
  }

  if (!supabaseUrl || !supabaseKey) {
    return json({ error: "Supabase service credentials are not configured" }, 500);
  }

  try {
    if (!isCron) {
      const adminToken = req.headers.get("x-admin-session") || "";
      if (!/^[a-f0-9]{64}$/i.test(adminToken)) return json({ error: "Admin sign-in is required." }, 401);
      const verification = await fetch(`${supabaseUrl}/rest/v1/rpc/commerce_validate_admin_token`, {
        method: "POST",
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input_token: adminToken }),
        signal: AbortSignal.timeout(15000),
      });
      if (!verification.ok || await verification.json() !== true) return json({ error: "Your admin session has expired." }, 401);
      const readiness = await fetch(`${supabaseUrl}/rest/v1/rpc/commerce_get_settings`, {
        method: "POST",
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input_public: false }),
        signal: AbortSignal.timeout(15000),
      });
      if (!readiness.ok || !(await readiness.json())?.admin_password_ready) return json({ error: "Change the administrator password before refreshing reviews." }, 403);
    }
    const rawReviews = await fetchApifyReviews(apifyToken);
    const scrapedAt = new Date().toISOString();
    const reviews = rawReviews
      .map((review) => normalizeReview(review, scrapedAt))
      .filter(Boolean)
      .slice(0, REVIEW_SYNC_MAX_REVIEWS);

    if (!reviews.length) {
      return json({
        ok: true,
        fetched: rawReviews.length,
        upserted: 0,
        message: "Apify returned no usable Google reviews.",
        timestamp: new Date().toISOString(),
      });
    }

    const upserted = await upsertReviews({ supabaseUrl, supabaseKey, reviews });
    const deleted = await deleteStaleReviews({ supabaseUrl, supabaseKey, scrapedAt });

    return json({
      ok: true,
      fetched: rawReviews.length,
      normalized: reviews.length,
      upserted,
      deleted,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("sync-google-reviews exception:", error);
    return json({ error: error instanceof Error ? error.message : "Unable to sync Google reviews" }, 500);
  }
});

async function fetchApifyReviews(apifyToken: string) {
  const actorPath = encodeURIComponent(APIFY_GOOGLE_REVIEWS_ACTOR).replace(/%7E/g, "~");
  const endpoint = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apifyToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      startUrls: [{ url: GOOGLE_MAPS_REVIEWS_URL }],
      maxReviews: REVIEW_SYNC_MAX_REVIEWS,
      reviewsSort: "newest",
    }),
  });

  const payload = await readJson(response);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Apify request failed with ${response.status}`;
    throw new Error(message);
  }

  return flattenItems(payload);
}

async function upsertReviews(input: { supabaseUrl: string; supabaseKey: string; reviews: GoogleReviewRow[] }) {
  let upserted = 0;
  const endpoint = `${input.supabaseUrl}/rest/v1/google_reviews?on_conflict=google_review_id`;

  for (let index = 0; index < input.reviews.length; index += 25) {
    const chunk = input.reviews.slice(index, index + 25);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...supabaseRestHeaders(input.supabaseKey),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation,missing=default",
      },
      body: JSON.stringify(chunk),
    });

    const payload = await readJson(response);
    if (!response.ok) {
      const message = payload?.message || payload?.error || `Supabase upsert failed with ${response.status}`;
      throw new Error(message);
    }

    upserted += Array.isArray(payload) ? payload.length : chunk.length;
  }

  return upserted;
}

async function deleteStaleReviews(input: { supabaseUrl: string; supabaseKey: string; scrapedAt: string }) {
  const endpoint = `${input.supabaseUrl}/rest/v1/google_reviews?scraped_at=neq.${encodeURIComponent(input.scrapedAt)}`;
  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      ...supabaseRestHeaders(input.supabaseKey),
      Prefer: "return=representation",
    },
  });

  const payload = await readJson(response);
  if (!response.ok) {
    const message = payload?.message || payload?.error || `Supabase stale review delete failed with ${response.status}`;
    throw new Error(message);
  }

  return Array.isArray(payload) ? payload.length : 0;
}

function normalizeReview(review: unknown, scrapedAt: string): GoogleReviewRow | null {
  if (!review || typeof review !== "object") {
    return null;
  }

  const source = review as Record<string, unknown>;
  const reviewText = stringValue(firstValue(source, ["textTranslated", "text", "reviewText", "comment"]));
  const authorName = stringValue(firstValue(source, ["name", "authorName", "reviewerName"]));
  const googleReviewId = stringValue(firstValue(source, ["reviewId", "review_id", "id", "placeReviewId"]))
    || stableReviewId(source, authorName, reviewText);
  const rating = numberValue(firstValue(source, ["stars", "rating", "score"]));

  if (!googleReviewId || (!authorName && !reviewText) || !Number.isFinite(rating)) {
    return null;
  }

  return {
    google_review_id: googleReviewId,
    author_name: authorName,
    author_photo_url: stringValue(firstValue(source, ["reviewerPhotoUrl", "authorPhotoUrl", "profilePhotoUrl"])),
    rating: Math.max(0, Math.min(5, rating)),
    review_text: reviewText,
    review_url: stringValue(firstValue(source, ["reviewUrl", "url"])),
    language: stringValue(firstValue(source, ["originalLanguage", "language", "translatedLanguage"])),
    relative_time_description: stringValue(firstValue(source, ["publishAt", "publishedAt", "relativeDate", "reviewDateText"])),
    reviewed_at: dateOrNull(firstValue(source, ["publishedAtDate", "reviewDate", "date"])),
    scraped_at: scrapedAt,
    raw: source,
  };
}

function flattenItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(flattenItems);
  }

  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;

    if (Array.isArray(source.items)) {
      return flattenItems(source.items);
    }

    if (Array.isArray(source.data)) {
      return flattenItems(source.data);
    }

    const nestedData = source.data;
    if (nestedData && typeof nestedData === "object" && Array.isArray((nestedData as Record<string, unknown>).items)) {
      return flattenItems((nestedData as Record<string, unknown>).items);
    }

    return [source];
  }

  return [];
}

function firstValue(source: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = source[name];
    const normalized = scalarValue(value);
    if (normalized !== null && normalized !== undefined && normalized !== "") {
      return normalized;
    }
  }

  return null;
}

function scalarValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = scalarValue(item);
      if (normalized !== null && normalized !== undefined && normalized !== "") {
        return normalized;
      }
    }
    return null;
  }

  return value;
}

function stringValue(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return NaN;
  }

  if (typeof value === "number") {
    return value;
  }

  const match = String(value).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function dateOrNull(value: unknown) {
  const text = stringValue(value);
  if (!text) {
    return null;
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function stableReviewId(review: Record<string, unknown>, authorName: string, reviewText: string) {
  const parts = [
    firstValue(review, ["reviewerId", "reviewerUrl"]),
    firstValue(review, ["publishedAtDate", "publishAt", "reviewDate"]),
    authorName,
    reviewText,
  ].map(stringValue).filter(Boolean);

  return parts.join("|").slice(0, 500);
}

function trimTrailingSlash(value: unknown) {
  return value ? String(value).replace(/\/+$/, "") : "";
}

function getSupabaseServiceKey() {
  const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyServiceRoleKey) {
    return legacyServiceRoleKey;
  }

  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeysJson) {
    return "";
  }

  try {
    const secretKeys = JSON.parse(secretKeysJson) as Record<string, string>;
    return secretKeys.default || "";
  } catch {
    return "";
  }
}

function supabaseRestHeaders(key: string) {
  const headers: Record<string, string> = { apikey: key };

  if (!key.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${key}`;
  }

  return headers;
}

async function readJson(response: Response): Promise<any> {
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

type GoogleReviewRow = {
  google_review_id: string;
  author_name: string;
  author_photo_url: string;
  rating: number;
  review_text: string;
  review_url: string;
  language: string;
  relative_time_description: string;
  reviewed_at: string | null;
  scraped_at: string;
  raw: Record<string, unknown>;
};
