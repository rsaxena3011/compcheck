/**
 * CompCheck Qloo proxy (Cloudflare Worker).
 *
 * Why this exists: the static client must not ship the Qloo API key.
 * This worker accepts the same GET paths the app uses (/search, /v2/...),
 * injects the key from the QLOO_API_KEY secret on the server side,
 * forwards to the Qloo hackathon API, and caches successful responses
 * privately (Cache API + Cache-Control: private) so repeat judge traffic
 * does not burn the key's quota.
 *
 * Deploy (separate step, not done by the rebuild):
 *   wrangler secret put QLOO_API_KEY     # paste the hackathon key
 *   wrangler deploy
 * Then set QLOO_PROXY in app.js to this worker's URL and redeploy Pages.
 * The key never appears in this file or in the client bundle after that.
 */

const UPSTREAM = "https://hackathon.api.qloo.com";
const ALLOWED_PREFIXES = ["/search", "/v2/"];
const CACHE_TTL_SECONDS = 3600;

function cors(response) {
  const res = new Response(response.body, response);
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    if (request.method !== "GET" ||
        !ALLOWED_PREFIXES.some(p => url.pathname.startsWith(p))) {
      return cors(new Response("Not found", { status: 404 }));
    }
    const target = UPSTREAM + url.pathname + url.search;

    const cache = caches.default;
    const cacheKey = new Request(target, { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cors(cached);

    const upstream = await fetch(target, {
      headers: { "X-Api-Key": env.QLOO_API_KEY }
    });
    const res = new Response(upstream.body, upstream);
    if (upstream.ok) {
      res.headers.set("Cache-Control", "private, max-age=" + CACHE_TTL_SECONDS);
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    return cors(res);
  }
};
