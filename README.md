# CompCheck

**Validate your film/TV pitch comps against real audience data.**

Pitch decks pick comparison titles by genre and gut feel. Half the time the "comps" don't share an audience at all, and nobody knows until the film flops. CompCheck is an agent that resolves your comps to Qloo taste-graph entities, measures actual audience overlap, and tells you which comps are true and which are false.

The demo centerpiece: an **"LLM Only" vs "Qloo Grounded" toggle**. LLM-only mode accepts every comp on plausible genre reasoning. Flip to Qloo-grounded and watch the false comps turn red.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/).

## Live demo

Hosted demo: _(deploy URL goes here once published)_

No login. Judges can run the prefilled demo pitch or enter their own.

## How it works (agent loop)

1. **Input** - working title, genre, logline, 2-3 comp titles.
2. **Resolve** - comps resolve to Qloo entities via `GET /search` (entity IDs shown in the trace).
3. **Profile** - audience demographics per comp via `GET /v2/insights`.
4. **Compare** - pairwise audience overlap between comps.
5. **Cross-domain** - what the validated audience also loves: artists, brands, podcasts.
6. **Verdict** - TRUE comps (green) vs FALSE comps (red), plus audience-validated alternative comps to pitch instead.

The full reasoning trace is visible in the UI, step by step.

## How we use Qloo

| Qloo call | What CompCheck does with it |
|---|---|
| `GET /search` | Resolve comp titles to entity IDs (shown in trace) |
| `GET /v2/insights` (demographics) | Audience profile per comp: age, genre affinity, top cities |
| `GET /v2/insights` (compare) | Pairwise audience overlap; TRUE vs FALSE comp verdicts |
| `GET /v2/insights` (cross-domain) | Artists, brands, podcasts the validated audience loves |
| `GET /v2/insights` (suggest) | Alternative comps the real audience actually watches |

Delete the Qloo calls and the product collapses to "an LLM guessing comps" - which is exactly what the LLM Only toggle demonstrates.

## Current status: LIVE on the Qloo API (2026-10-20)

The Qloo hackathon API key landed 2026-10-20 00:59 IST. Kill tests passed: 20/20 demo
titles (incl. Tumbbad, the anchor) resolve via `GET /search`, and the demo beat
reproduces on live data: Tumbbad x The Witch = TRUE COMP (27% taste overlap, shared
Folk horror / Slow burn), Tumbbad x RRR = FALSE COMP (7%, generic tags only).
The app now calls `https://hackathon.api.qloo.com` directly from the page with
the `X-Api-Key` header (hackathon-scoped demo key). Responses are used in-memory
only; **never commit real Qloo responses to this repo**.

Verdict math: pairwise "taste overlap" = Jaccard similarity of the two films'
curated taste-tag profiles (Qloo's genre / subgenre / theme / plot / style
tags). TRUE COMP at >= 20% overlap. Audience profiles, cross-domain
affinities and suggestions come from live `GET /v2/insights` calls.

## Run locally

Any static server works (no build step):

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open http://localhost:8080. (All data is live from the Qloo API, so any static server works.)

## Deploy

Static site - deploy the repo root to GitHub Pages, Vercel, or Netlify as-is.

## License

MIT. See [LICENSE](LICENSE).
