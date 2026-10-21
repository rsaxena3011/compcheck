# CompCheck

**Comps sell two things: a tone and an audience. CompCheck tests both against Qloo's taste graph, before a buyer does.**

Every film/TV pitch deck leans on comparison titles chosen by genre, era and gut feel. Two different claims hide inside a comp: that the films share a *tone*, and that they share an *audience*. CompCheck is an agent that tests the two claims separately, live, against Qloo's Taste AI API, and returns one of four verdicts per comp: **TRUE** (both axes pass), **TONE** (tone only), **MARKET** (audience only), **FALSE** (neither).

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/).

## Live demo

Hosted demo: https://rsaxena3011.github.io/compcheck/

No login. Run the prefilled demo pitch or enter your own. The app also has a **Plausibility Baseline** mode: a scripted illustration of genre-logic reasoning (the way a pitch room accepts comps). It is labelled as scripted in the UI; no model runs in that mode and no data is consulted. All live claims in this README apply to **Qloo Grounded** mode.

## Run locally

Any static server works (no build step):

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open http://localhost:8080. Qloo Grounded mode needs network access to the Qloo API.

## The two-axis method

Pick a **reference comp** (the UI labels it; "Auto" selects the comp whose Qloo tag profile matches the most keywords from your logline and genre, and the trace shows the scores). Every other comp is measured against that fixed reference, so verdicts never depend on the order titles were typed.

**Tone axis** (content similarity). From `GET /search`, take each film's Qloo taste tags of types subgenre, theme, plot and style. Duplicate tag names are merged across urn types, and broad genre labels (`urn:tag:genre:media`, `urn:tag:genre:qloo`) are **excluded** from the score: they measure filing, not tone.

```
tone(A, B) = |toneTags(A) ∩ toneTags(B)| / |toneTags(A) ∪ toneTags(B)|     (Jaccard)
tone pass  = tone(A, B) >= 0.10
```

**Audience axis** (measured affinity). One batched `GET /v2/insights` call with `signal.interests.entities = <reference>` and `filter.results.entities = <the comp + three control films>` returns each film's affinity toward the reference's audience. The controls are unrelated films (Dangal, Paddington 2, Top Gun: Maverick) included in the same batch.

```
audience pass = affinity(comp) > max(affinity(controls))
```

A comp that is merely popular scores high against everything; beating the strongest unrelated control is the evidence that the affinity is specific.

**Verdicts**: TRUE = tone pass + audience pass; TONE = tone only; MARKET = audience only; FALSE = neither. A title that does not resolve to a catalog entity is **UNRESOLVED** (no verdict), and a failed API call produces an **ERROR** state (never a verdict, never cached as "not in catalog").

## What the agent decides (visible in the trace)

- **Disambiguation**: titles resolve only on a normalized exact-name match. When several films share a name (three films are called *The Witch*), the agent picks the most prominent and states why; a `(year)` typed in the input overrides it. When nothing matches exactly, the title is UNRESOLVED and the nearest resolvable alternative is proposed, never silently substituted.
- **Reference selection**: with Auto, the logline and genre genuinely drive the choice (keyword to tag-profile matching, scores shown in the trace).
- **Verify-Prune-Repair**: comps that verdict FALSE are pruned from the signal before the alternatives query, which is seeded with the validated cluster only (reference + TRUE comps). Alternatives are then held to the same two-axis test: the app never recommends a title it itself fails, and each suggestion shows its own tone score, affinity and shared tone tags.

## Demo deck (measured live, 2026-10-21)

Prefilled pitch: folk-horror, comps Tumbbad / The Witch / RRR. Reference: Tumbbad (auto-selected, 8 logline-keyword tag matches vs 6 for The Witch, 2 for RRR). Control baseline: **81.1** (Dangal 81.1, Paddington 2 73.1, Top Gun: Maverick 71.6).

| Comp | Tone | Audience | Verdict |
|---|---|---|---|
| The Witch (2015) | 16.7% (shared: Folk horror, Dark, Suspenseful, Atmospheric, Slow burn, +4 more) | 77.1 | **TONE** |
| RRR (2022) | 5.2% (shared: Atmospheric, Character driven, Cinematic) | 86.5 | **MARKET** |
| Bulbbul (2020), if added | 14.5% (shared: Folk horror, Folklore, Slow burn, Moody, +4 more) | 92.0 | **TRUE** |

The Witch is the same *kind* of film as Tumbbad but does not beat an unrelated control for its audience. RRR's audience travels; its tone does not. Both facts are invisible to a single-score tool.

## Calibration

The 10% tone threshold is not a guess. Measured on the live API (2026-10-21), known tone-kin pairs and known non-kin pairs separate cleanly, and the threshold sits in the empty band between them:

- Tone-kin: Tumbbad x Bulbbul 14.5%, Tumbbad x Stree 18.2%, Tumbbad x Kantara 14.5%, Tumbbad x Hereditary 12.7%, Tumbbad x Pari 11.5%, Hereditary x The Witch 25.0%, Get Out x Parasite 27.1%.
- Non-kin: Tumbbad x RRR 5.2%, Tumbbad x Dangal 3.8%, Tumbbad x Paddington 2 5.3%, Tumbbad x Coco 7.0%, The Witch x Top Gun: Maverick 5.1%, Hereditary x Coco 5.0%.

Tag-set Jaccard over Qloo's granular taxonomy is naturally sparse (a pair's combined tone profile runs to 50-60 tags), which is why the separating band sits near 10% rather than at a rounder number.

## How we use Qloo

| Qloo call | What CompCheck does with it |
|---|---|
| `GET /search` | Resolve comp titles to entities (strict exact-name matching, disambiguation with stated reasons); source of the taste-tag profiles |
| `GET /v2/insights` with `filter.results.entities` | Audience axis: affinities of each comp and the three control films toward the reference's audience, in one batch |
| `GET /v2/insights` (movies, validated-cluster signal, `take=30`, `filter.release_year.min=1990`) | The repair pool for alternative comps, each re-scored on both axes |
| `GET /v2/insights` (artist / podcast / brand, `filter.popularity.max=0.99`) | Cross-domain affinities of the validated audience, top 3 per category, mapped to producer decisions (soundtrack direction, promotion channels, brand partners) |
| `GET /v2/insights` (demographics) | Reference audience age band and gender lean, shown only when the data carries a signal; otherwise shown as unavailable |

A note on `/v2/analysis/compare`: it exists on the hackathon host (verified 2026-10-21; it takes `a.signal.interests.entities` and `b.signal.interests.entities` and returns a per-tag comparison with scores). CompCheck's verdicts are deliberately computed from the `/search` tag profiles and `/v2/insights` affinities instead, so that every number on screen traces to inputs the UI displays. The compare endpoint is not in the verdict path.

## Tests

`tests/run-tests.mjs` exercises the shipped engine functions (`app.js` exports them for Node) against the live API:

```bash
node tests/run-tests.mjs
```

59 checks, all passing on 2026-10-21, including:

- **Resolution matrix**: 20 titles (Tumbbad, The Witch, RRR, Bulbbul, Stree, Dangal, Paddington 2, Top Gun: Maverick, K.G.F: Chapter 1, Badla, Get Out, Hereditary, Parasite, Spirited Away, Mad Max: Fury Road, Coco, Andhadhun, Kantara, Amélie, Barbie), each verified to resolve to the *correct* entity (name and release year).
- **Disambiguation**: "The Witch" resolves to the 2015 film with the reason recorded; "The Witch (2025)" resolves to the 2025 film.
- **Honesty paths**: a nonsense title returns UNRESOLVED; a simulated API outage propagates as an error, never as "not in catalog".
- **Calibration bands and the demo deck**: The Witch = TONE, RRR = MARKET, Bulbbul = TRUE, computed end to end.
- **Alternatives**: every suggested title passes at least one axis; TRUE suggestions pass both.

## Architecture and the API key

Zero-infrastructure static site (HTML, CSS, vanilla JS, no build step); every Qloo request and its result is inspectable in the agent trace. All API calls route through a small proxy deployed on Vercel (source: https://github.com/rsaxena3011/compcheck-proxy, live at https://compcheck-proxy.vercel.app), which injects the API key from a server-side environment variable and allowlists the two endpoint families the app uses. The key is not present in this repo, in its git history, or in the client; rotating it needs no client change. An earlier Cloudflare Worker variant of the same proxy is kept in [`proxy/`](proxy/README.md) for reference.

## Limitations

- Affinity is Qloo's modelled audience signal, not box-office truth; the control baseline guards against popularity, not against every modelling quirk.
- The tone threshold is calibrated on the pair set above, not on a large labelled corpus; it is a transparent decision rule, not an industry standard.
- Resolution is deliberately strict: a misspelled title returns UNRESOLVED (with a proposed alternative) rather than a confident wrong match.
- CompCheck is decision support for asking better questions in the pitch room, not a machine that decides which films get greenlit.

## Deploy

Static site: deploy the repo root to GitHub Pages, Vercel, or Netlify as-is.

## License

MIT. See [LICENSE](LICENSE).
