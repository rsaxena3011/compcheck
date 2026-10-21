# Qloo proxy (Cloudflare Worker)

`worker.js` is the server-side proxy for CompCheck's Qloo calls. It:

- accepts only `GET` requests under `/search` and `/v2/` (the exact paths the app uses),
- injects the Qloo API key from the `QLOO_API_KEY` secret (never stored in this repo),
- forwards to `https://hackathon.api.qloo.com`,
- caches successful responses privately for one hour (Cache API + `Cache-Control: private`), so judging traffic does not drain the key's quota,
- returns permissive CORS headers so the static GitHub Pages client can call it.

## Client side

`app.js` calls a configurable base URL:

```js
const QLOO_PROXY = ""; // set to this worker's URL once deployed
```

While `QLOO_PROXY` is empty the client calls the Qloo API directly (the current live-demo configuration). Setting it to the deployed Worker URL routes every call through the proxy and sends no key from the browser.

## Deploy

```bash
cd proxy
npx wrangler secret put QLOO_API_KEY   # paste the hackathon key when prompted
npx wrangler deploy
```

Then set `QLOO_PROXY` in `app.js` to the deployed URL, commit, and let GitHub Pages redeploy. Rotating the key afterwards is a one-command secret update; no client change is needed.

## Note (2026-10-21): Cloudflare blocked, ported to Vercel

The Cloudflare deploy above never happened: it was blocked at Cloudflare's sign-in on 2026-10-21. The same proxy has been ported to a Vercel serverless function instead, in its own repo: [rsaxena3011/compcheck-proxy](https://github.com/rsaxena3011/compcheck-proxy) (same allowlist, same `QLOO_API_KEY` variable, same upstream and caching; the key there is set as a Vercel environment variable in the dashboard). `worker.js` in this folder remains the Cloudflare reference implementation if that route ever unblocks.
