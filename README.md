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

## Current status: mock fixtures

The Qloo hackathon API key is pending (requested 2026-10-17, issued manually). Until it arrives, the app runs against **8 mock fixtures** in `fixtures/` that simulate Qloo API shapes:

- `search.json` - entity resolution (8 titles)
- `audience-tumbbad.json`, `audience-the-witch.json`, `audience-rrr.json` - demographics
- `compare.json` - pairwise audience overlap (the TRUE/FALSE comp verdicts)
- `cross-domain.json` - artists, brands, podcasts affinities
- `suggest.json` - validated alternative comps

Every fixture is labeled `_mock`. When the key lands: run the kill tests (resolve 20 titles; check cross-domain non-obviousness; check compare signal), then swap `fetch("fixtures/...")` for live `hackathon.api.qloo.com` calls with the `X-Api-Key` header. **Never commit real Qloo responses to this repo** - server-side cache only.

## Run locally

Any static server works (no build step):

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open http://localhost:8080. (Note: `file://` won't load fixtures; use a server.)

## Deploy

Static site - deploy the repo root to GitHub Pages, Vercel, or Netlify as-is.

## License

MIT. See [LICENSE](LICENSE).
