/* CompCheck - a verification agent over the LIVE Qloo Taste AI API.
   Two-axis verdict engine:
   - TONE axis: Jaccard similarity of two films' Qloo taste-tag profiles
     (subgenre / theme / plot / style tags from GET /search). Duplicate tag
     names are merged across urn types and broad genre labels (genre:media,
     genre:qloo) are excluded from the score: they measure filing, not tone.
   - AUDIENCE axis: affinity from GET /v2/insights
     (signal.interests.entities = the reference comp,
      filter.results.entities = the comp + three unrelated control films,
      scored in one batch). A comp passes only if its affinity beats the
     strongest control: popularity alone is not evidence.
   Four verdicts: TRUE (both axes), TONE (tone only), MARKET (audience
   only), FALSE (neither). Plus honest non-verdicts: UNRESOLVED (title not
   in the catalog) and ERROR (the API failed; an error is never evidence).
   Responses are used in-memory only; no Qloo response data is stored.

   All calls route through the deployed proxy
   (https://compcheck-proxy.vercel.app), which injects the API key
   server-side from a Vercel environment variable. The key is never
   present in this client. */

const QLOO_PROXY = "https://compcheck-proxy.vercel.app";
const TONE_THRESHOLD = 0.10; // calibrated: see README "Calibration"
const CONTROL_TITLES = ["Dangal", "Paddington 2", "Top Gun: Maverick"];
const TASTE_TAG_TYPES = new Set([
  "urn:tag:genre:media", "urn:tag:genre:qloo", "urn:tag:subgenre:qloo",
  "urn:tag:theme:qloo", "urn:tag:plot:qloo", "urn:tag:style:qloo"
]);
const GENRE_TAG_TYPES = new Set(["urn:tag:genre:media", "urn:tag:genre:qloo"]);
const TAG_TYPE_RANK = {
  "urn:tag:subgenre:qloo": 0, "urn:tag:theme:qloo": 1, "urn:tag:genre:qloo": 2,
  "urn:tag:genre:media": 3, "urn:tag:plot:qloo": 4, "urn:tag:style:qloo": 5
};
/* Logline/genre keyword -> Qloo tag-name expansions. Used ONLY to
   auto-select the reference comp; every match is shown in the trace. */
const KEYWORD_EXPANSIONS = {
  folk: ["folk horror", "folklore"], horror: ["horror", "folk horror"],
  curse: ["curse", "cursed", "supernatural"], cursed: ["curse", "supernatural"],
  goddess: ["goddess", "deity", "mythology", "folklore"],
  god: ["deity", "mythology"], mythology: ["mythology", "mythological", "folklore"],
  mythological: ["mythology", "folklore"], village: ["village", "rural"],
  rural: ["rural", "village"], harvest: ["harvest", "farming", "agriculture"],
  festival: ["festival", "celebration"], widow: ["widow", "grief"],
  witch: ["witch", "witchcraft", "occult"], demon: ["demon", "occult", "supernatural"],
  ghost: ["ghost", "haunted", "supernatural"], haunted: ["haunted", "ghost"],
  forest: ["forest", "woods"], wedding: ["wedding", "marriage"],
  heist: ["heist", "robbery"], space: ["space", "sci-fi", "outer space"],
  war: ["war", "battle"], love: ["romance", "love"], revenge: ["revenge", "vengeance"]
};

let mode = "baseline"; // 'baseline' | 'qloo'
let lastPitch = null;

/* ---------- small utils ---------- */
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s || "").toLowerCase().trim();
const normKey = s => norm(s).replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
const pct1 = x => (x * 100).toFixed(1) + "%";
const aff1 = x => (x * 100).toFixed(1);

/* ---------- Qloo client (in-memory cache; errors are never cached) ---------- */
const cache = { resolve: {}, cross: {}, demo: {} };

async function qlooGet(path) {
  const url = QLOO_PROXY + path;
  const headers = {};
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (!res.ok) throw new Error("Qloo HTTP " + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await sleep(1000);
    } finally { clearTimeout(timer); }
  }
  throw new Error("Qloo API request failed (" + (lastErr && lastErr.message || "network") + ")");
}

async function searchMovies(title) {
  const q = encodeURIComponent(title);
  const data = await qlooGet("/search?query=" + q + "&types=urn:entity:movie,urn:entity:tv_show");
  return (data.results || []).filter(r =>
    (r.types || []).some(t => t === "urn:entity:movie" || t === "urn:entity:tv_show"));
}

function toEntity(hit) {
  const allNames = new Map(); // normKey(name) -> {name, type}
  const toneNames = new Map(); // taste tags minus broad genre labels
  for (const t of hit.tags || []) {
    if (!TASTE_TAG_TYPES.has(t.type)) continue;
    const k = normKey(t.name);
    if (!allNames.has(k)) allNames.set(k, { name: t.name, type: t.type });
    if (!GENRE_TAG_TYPES.has(t.type) && !toneNames.has(k))
      toneNames.set(k, { name: t.name, type: t.type });
  }
  const byRank = (a, b) => (TAG_TYPE_RANK[a.type] - TAG_TYPE_RANK[b.type]) || a.name.localeCompare(b.name);
  return {
    entity_id: hit.entity_id,
    name: hit.name,
    year: (hit.properties && hit.properties.release_year) || null,
    popularity: hit.popularity || 0,
    description: (hit.properties && hit.properties.description) || "",
    genreNames: [...allNames.values()].filter(t => GENRE_TAG_TYPES.has(t.type)).map(t => t.name),
    allTagNames: [...allNames.values()].sort(byRank),
    toneTags: toneNames // Map normKey -> {name, type}
  };
}

function parseTitleInput(raw) {
  const m = String(raw).match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (m) return { title: m[1].trim(), year: parseInt(m[2], 10) };
  return { title: String(raw).trim(), year: null };
}

/* Resolution is strict: a title counts as resolved only on a normalized
   exact-name match. Anything else is UNRESOLVED, with the nearest
   resolvable alternative proposed (never silently substituted). */
async function resolveTitle(raw) {
  const { title, year } = parseTitleInput(raw);
  const ck = normKey(title) + "|" + (year || "");
  if (cache.resolve[ck]) return cache.resolve[ck];
  const results = await searchMovies(title); // throws on API failure
  const exact = results.filter(r => normKey(r.name) === normKey(title));
  let out;
  if (exact.length) {
    let chosen = null, decision = "";
    if (year) {
      chosen = exact.find(r => r.properties && r.properties.release_year === year) || null;
      if (chosen) decision = "exact title + year match (" + year + ")";
    }
    if (!chosen) {
      chosen = exact.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
      decision = exact.length > 1
        ? exact.length + " titles share this exact name; chose " + chosen.name +
          " (" + (chosen.properties && chosen.properties.release_year || "year n/a") +
          "), the most prominent (popularity " + pct1(chosen.popularity || 0) + ")"
        : "exact title match";
      if (year) decision += "; no exact-title candidate matched the year " + year;
    }
    out = { status: "resolved", entity: toEntity(chosen), decision };
  } else {
    const proposal = await findProposal(title);
    out = { status: "unresolved", title, proposal,
            decision: "no catalog title matches this name exactly" };
  }
  cache.resolve[ck] = out;
  return out;
}

async function findProposal(title) {
  const words = title.replace(/[:\-]/g, " ").split(/\s+/).filter(Boolean);
  const tries = [];
  if (title.includes(":")) tries.push(title.split(":")[0].trim());
  if (words.length > 3) tries.push(words.slice(0, 3).join(" "));
  if (words.length > 2) tries.push(words.slice(0, 2).join(" "));
  if (words.length > 1) tries.push(words[0]);
  for (const q of [...new Set(tries)].slice(0, 3)) {
    if (normKey(q) === normKey(title)) continue;
    try {
      const results = await searchMovies(q);
      const hit = results.find(r => normKey(r.name) === normKey(q)) ||
                  results.find(r => normKey(r.name).startsWith(normKey(q)));
      if (hit) return toEntity(hit);
    } catch (err) { /* proposal search is best-effort */ }
  }
  return null;
}

/* ---------- tone axis ---------- */
function computeTone(a, b) {
  const aKeys = new Set(a.toneTags.keys()), bKeys = new Set(b.toneTags.keys());
  const shared = [...aKeys].filter(k => bKeys.has(k)).map(k => a.toneTags.get(k));
  const onlyA = [...aKeys].filter(k => !bKeys.has(k)).map(k => a.toneTags.get(k));
  const onlyB = [...bKeys].filter(k => !aKeys.has(k)).map(k => b.toneTags.get(k));
  const rank = t => TAG_TYPE_RANK[t.type];
  shared.sort((x, y) => rank(x) - rank(y));
  onlyA.sort((x, y) => rank(x) - rank(y));
  onlyB.sort((x, y) => rank(x) - rank(y));
  const union = new Set([...aKeys, ...bKeys]).size;
  return {
    score: union ? shared.length / union : 0,
    shared: shared.map(t => t.name),
    onlyA: onlyA.map(t => t.name),
    onlyB: onlyB.map(t => t.name),
    aCount: aKeys.size, bCount: bKeys.size
  };
}

/* ---------- audience axis ---------- */
async function audienceBatch(reference, targets) {
  const ids = targets.map(e => e.entity_id);
  const data = await qlooGet("/v2/insights?filter.type=urn:entity:movie&signal.interests.entities=" +
    reference.entity_id + "&filter.results.entities=" + ids.join(","));
  const map = new Map();
  for (const e of (data.results || {}).entities || [])
    if (e.query && typeof e.query.affinity === "number") map.set(e.entity_id, e.query.affinity);
  return map;
}

async function demographics(entity) {
  if (cache.demo[entity.entity_id]) return cache.demo[entity.entity_id];
  let out = { line: "", available: false };
  try {
    const d = await qlooGet("/v2/insights?filter.type=urn:demographics&signal.interests.entities=" + entity.entity_id);
    const q = d.results && d.results.demographics && d.results.demographics[0] &&
              d.results.demographics[0].query;
    if (q) {
      const bands = { "24 and younger": "24_and_younger", "25-29": "25_to_29",
        "30-34": "30_to_34", "35-44": "35_to_44", "45-54": "45_to_54", "55+": "55_and_older" };
      let best = null, bestV = 0;
      for (const [label, key] of Object.entries(bands)) {
        const v = q.age && q.age[key];
        if (typeof v === "number" && v > bestV) { bestV = v; best = label; }
      }
      const g = q.gender || {};
      let lean = "";
      if (typeof g.male === "number" && g.male >= 0.05) lean = "male-leaning";
      else if (typeof g.female === "number" && g.female >= 0.05) lean = "female-leaning";
      const parts = [];
      if (best) parts.push("core age band " + best);
      if (lean) parts.push(lean);
      if (parts.length) { out = { line: parts.join(", "), available: true }; }
    }
  } catch (err) { /* demographics stay unavailable; never guessed */ }
  cache.demo[entity.entity_id] = out;
  return out;
}

/* ---------- reference auto-selection (logline genuinely used) ---------- */
function pitchKeywords(pitch) {
  const words = (pitch.genre + " " + pitch.logline).toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length >= 3);
  const phrases = new Set();
  for (const w of new Set(words)) {
    phrases.add(normKey(w));
    for (const exp of KEYWORD_EXPANSIONS[w] || []) phrases.add(normKey(exp));
  }
  return phrases;
}
function referenceScore(entity, phrases) {
  const matched = entity.allTagNames.filter(t => {
    const k = normKey(t.name);
    for (const p of phrases) if (k.includes(p) || p.includes(k)) return true;
    return false;
  });
  return matched;
}

/* ---------- cross-domain (validated audience, per category) ---------- */
const CROSS_CATEGORIES = [
  { type: "urn:entity:artist", label: "Artists", use: "Soundtrack and temp-score direction" },
  { type: "urn:entity:podcast", label: "Podcasts", use: "Press-tour and trailer promotion channels" },
  { type: "urn:entity:brand", label: "Brands", use: "Co-marketing and festival partners" }
];
function shortNote(e) {
  const sd = e.properties && e.properties.short_descriptions;
  const en = Array.isArray(sd) && sd.find(s => s.language === "en");
  let text = (en && en.value) || (e.properties && e.properties.description) || "";
  text = text.split(/(?<=[.!?])\s/)[0];
  return text.length > 110 ? text.slice(0, 107) + "..." : text;
}
async function crossDomain(entities) {
  const ids = entities.map(e => e.entity_id);
  const key = ids.join(",");
  if (cache.cross[key]) return cache.cross[key];
  const groups = await Promise.all(CROSS_CATEGORIES.map(async c => {
    try {
      const d = await qlooGet("/v2/insights?filter.type=" + c.type +
        "&signal.interests.entities=" + ids.join(",") + "&take=8&filter.popularity.max=0.99");
      const items = ((d.results || {}).entities || [])
        .filter(e => e.query && typeof e.query.affinity === "number")
        .sort((x, y) => y.query.affinity - x.query.affinity).slice(0, 3)
        .map(e => ({ name: e.name, affinity: e.query.affinity, note: shortNote(e) }));
      return { ...c, items };
    } catch (err) { return { ...c, items: [] }; }
  }));
  cache.cross[key] = groups;
  return groups;
}

/* ---------- Verify-Prune-Repair: alternatives ---------- */
async function repairAlternatives(reference, validated, baseline, excludeIds) {
  const signalIds = validated.map(e => e.entity_id);
  const d = await qlooGet("/v2/insights?filter.type=urn:entity:movie&signal.interests.entities=" +
    signalIds.join(",") + "&take=30&filter.release_year.min=1990");
  const pool = (d.results || {}).entities || [];
  const scored = [];
  for (const cand of pool) {
    if (excludeIds.has(cand.entity_id)) continue;
    if (!cand.query || typeof cand.query.affinity !== "number") continue;
    const ent = toEntity(cand);
    if (!ent.toneTags.size) continue; // cannot verify its tone: filtered out
    const tone = computeTone(reference, ent);
    const tonePass = tone.score >= TONE_THRESHOLD;
    const audPass = cand.query.affinity > baseline;
    if (!tonePass && !audPass) continue; // never recommend a title the engine fails
    scored.push({
      name: ent.name, year: ent.year, affinity: cand.query.affinity,
      tone: tone.score, shared: tone.shared,
      verdict: tonePass && audPass ? "TRUE" : tonePass ? "TONE" : "MARKET",
      combined: 0.5 * Math.min(tone.score / 0.25, 1) + 0.5 * cand.query.affinity
    });
  }
  scored.sort((a, b) => (b.verdict === "TRUE") - (a.verdict === "TRUE") || b.combined - a.combined);
  return { picks: scored.slice(0, 3), poolCount: pool.length,
           trueCount: scored.filter(s => s.verdict === "TRUE").length };
}

/* ---------- trace ---------- */
function traceStart() {
  $("trace-card").classList.remove("hidden");
  $("trace").innerHTML = "";
}
function traceStep(label) {
  const li = document.createElement("li");
  li.className = "running";
  li.innerHTML = '<span class="spinner"></span>' + label;
  $("trace").appendChild(li);
  return li;
}
function traceDone(li, detail) {
  li.className = "done";
  li.innerHTML = "&#10003; " + li.textContent.replace(/^\s*/, "") +
    (detail ? '<span class="detail">' + detail + "</span>" : "");
}
function traceError(li, detail) {
  li.className = "error";
  li.innerHTML = "&#10007; " + li.textContent.replace(/^\s*/, "") +
    (detail ? '<span class="detail">' + detail + "</span>" : "");
}

/* ---------- Plausibility Baseline (scripted illustration, no model) ---------- */
function plausibilityReasoning(compTitle, pitch) {
  const g = pitch.genre || "its genre";
  return "Genre logic accepts \"" + compTitle + "\" at face value: it sits in the same " +
    g + " conversation as the pitch, nothing on the surface contradicts it, and no " +
    "audience data is consulted. This is how pitch rooms wave comps through, and how " +
    "shared market, era and language cues get misread as closeness (Cultural & Lexical " +
    "Proximity Bias). Scripted illustration: no model ran to produce this verdict.";
}

/* ---------- agent loop ---------- */
function readPitch() {
  return {
    title: $("in-title").value.trim() || "Untitled",
    genre: $("in-genre").value.trim() || "Unspecified",
    logline: $("in-logline").value.trim(),
    comps: [$("in-comp1").value, $("in-comp2").value, $("in-comp3").value]
      .map(s => s.trim()).filter(Boolean),
    refChoice: $("in-ref").value // 'auto' | '0' | '1' | '2'
  };
}

async function runAgent() {
  const pitch = readPitch();
  if (!pitch.comps.length) { alert("Enter at least one comp title."); return; }
  lastPitch = pitch;
  $("run-btn").disabled = true;
  $("results-card").classList.add("hidden");
  traceStart();
  try {
    if (mode === "baseline") runBaseline(pitch);
    else await runQloo(pitch);
  } finally {
    $("run-btn").disabled = false;
  }
}

function runBaseline(pitch) {
  let li = traceStep("Reading the pitch (scripted baseline)");
  traceDone(li, "\"" + pitch.title + "\" - " + pitch.genre +
    ". This baseline works from the typed labels only.");
  li = traceStep("Applying genre logic (scripted illustration)");
  traceDone(li, "No model is run and no data is consulted in this mode. " +
    "It demonstrates, deliberately, how a comp gets accepted on plausibility alone.");
  li = traceStep("Verdict");
  traceDone(li, "All comps accepted. Switch to Qloo Grounded to test them.");
  renderResults({
    mode: "baseline",
    banner: { kind: "note", text: "Plausibility Baseline: a scripted illustration of genre-logic " +
      "reasoning. No language model was run and no data was consulted; every comp below is " +
      "accepted unverified, on purpose, so the Qloo Grounded contrast is honest." },
    comps: pitch.comps.map(t => ({
      name: t, status: "PLAUSIBLE", reason: plausibilityReasoning(t, pitch)
    })),
    summary: "Genre logic accepts all " + pitch.comps.length + " comps for \"" + pitch.title +
      "\". Nothing was measured. That is the failure mode CompCheck exists to catch.",
    badge: "mixed", badgeText: "UNVERIFIED - SCRIPTED BASELINE"
  });
}

async function runQloo(pitch) {
  const result = { mode: "qloo", comps: [], banner: null };

  /* 1. Resolve (agent decision point: disambiguation with reasons) */
  let li = traceStep("Resolving comps to Qloo entities - GET /search");
  const resolutions = [];
  for (const t of pitch.comps) {
    try { resolutions.push(await resolveTitle(t)); }
    catch (err) { resolutions.push({ status: "error", title: t, error: err.message }); }
  }
  const resLines = resolutions.map((r, i) => {
    if (r.status === "resolved")
      return pitch.comps[i] + " -&gt; " + r.entity.name + " (" + (r.entity.year || "n/a") +
        ") <code>" + r.entity.entity_id + "</code> - " + r.decision;
    if (r.status === "unresolved")
      return pitch.comps[i] + " -&gt; UNRESOLVED - " + r.decision +
        (r.proposal ? "; nearest resolvable alternative: " + r.proposal.name +
          " (" + (r.proposal.year || "n/a") + ")" : "");
    return pitch.comps[i] + " -&gt; ERROR - " + r.error;
  });
  traceDone(li, resLines.join("<br>"));

  const resolvedIdx = resolutions.map((r, i) => r.status === "resolved" ? i : -1).filter(i => i >= 0);
  if (!resolvedIdx.length) {
    result.banner = { kind: "error", text: "No comp could be resolved against the live Qloo " +
      "catalog, so no verdicts were issued. An unresolved title is not evidence against it." };
    result.comps = resolutions.map((r, i) => ({
      name: pitch.comps[i],
      status: r.status === "error" ? "ERROR" : "UNRESOLVED",
      reason: r.status === "error" ? r.error
        : "Not found in the Qloo catalog under this exact name." +
          (r.proposal ? " Nearest resolvable alternative: " + r.proposal.name +
            " (" + (r.proposal.year || "n/a") + "). Add it as a comp to test it." : "")
    }));
    result.summary = "No verdicts: nothing resolved.";
    result.badge = "fail"; result.badgeText = "NO VERDICTS";
    renderResults(result);
    return;
  }

  /* 2. Reference selection (explicit; logline drives Auto) */
  li = traceStep("Selecting the reference comp");
  let refIdx;
  if (pitch.refChoice !== "auto" && resolutions[+pitch.refChoice] &&
      resolutions[+pitch.refChoice].status === "resolved") {
    refIdx = +pitch.refChoice;
    traceDone(li, "Reference: " + resolutions[refIdx].entity.name + " - chosen by you. " +
      "Every verdict below is measured against it, so results do not depend on typing order.");
  } else {
    const phrases = pitchKeywords(pitch);
    const scored = resolvedIdx.map(i => ({
      i, matched: referenceScore(resolutions[i].entity, phrases)
    })).sort((a, b) => b.matched.length - a.matched.length ||
      (resolutions[b.i].entity.popularity - resolutions[a.i].entity.popularity));
    refIdx = scored[0].i;
    traceDone(li, "Reference: " + resolutions[refIdx].entity.name +
      " - auto-selected: its Qloo tag profile matches the most pitch keywords (" +
      (scored[0].matched.map(t => t.name).join(", ") || "none") + "). Scores: " +
      scored.map(s => resolutions[s.i].entity.name + " " + s.matched.length).join(", ") +
      ". You can override this above; verdicts are always against the labelled reference.");
  }
  const reference = resolutions[refIdx].entity;
  result.reference = { entity: reference };

  /* comp result skeletons */
  const compResults = resolutions.map((r, i) => {
    if (i === refIdx) return { entity: r.entity, status: "REFERENCE",
      reason: "Reference comp. Tone profile: " +
        [...reference.toneTags.values()].slice(0, 5).map(t => t.name).join(", ") +
        " (popularity " + pct1(reference.popularity) + ")." };
    if (r.status === "unresolved") return { name: pitch.comps[i], status: "UNRESOLVED",
      reason: "Not found in the Qloo catalog under this exact name, so no verdict is issued." +
        (r.proposal ? " Nearest resolvable alternative: " + r.proposal.name +
          " (" + (r.proposal.year || "n/a") + ")." : "") };
    if (r.status === "error") return { name: pitch.comps[i], status: "ERROR", reason: r.error };
    return { entity: r.entity, status: "PENDING" };
  });

  /* 3. Tone axis */
  li = traceStep("Tone axis - taste-tag overlap (genre labels excluded)");
  const toneByIdx = {};
  for (const i of resolvedIdx) {
    if (i === refIdx) continue;
    toneByIdx[i] = computeTone(reference, resolutions[i].entity);
  }
  traceDone(li, resolvedIdx.filter(i => i !== refIdx).map(i => {
    const t = toneByIdx[i];
    return resolutions[i].entity.name + ": " + pct1(t.score) + " (" + t.shared.length +
      " shared tone tags of " + (t.aCount + t.bCount - t.shared.length) + " combined" +
      (t.shared.length ? "; shared: " + t.shared.slice(0, 5).join(", ") : "") + ")";
  }).join("<br>") || "Only one comp resolved; no pair to score.");

  /* 4. Audience axis (comps + controls in one batch) */
  li = traceStep("Audience axis - GET /v2/insights affinity vs unrelated controls");
  let affMap = new Map(), controls = [], baseline = null, audError = null;
  try {
    const controlRes = [];
    for (const ct of CONTROL_TITLES) {
      try { controlRes.push(await resolveTitle(ct)); } catch (err) { /* control optional */ }
    }
    controls = controlRes.filter(r => r.status === "resolved" && r.entity.entity_id !== reference.entity_id)
      .map(r => r.entity);
    const targets = [...resolvedIdx.filter(i => i !== refIdx).map(i => resolutions[i].entity),
                     ...controls];
    if (targets.length) {
      affMap = await audienceBatch(reference, targets);
      const cAff = controls.map(c => affMap.get(c.entity_id)).filter(v => typeof v === "number");
      baseline = cAff.length ? Math.max(...cAff) : null;
    }
  } catch (err) { audError = err.message; }
  if (audError) {
    traceError(li, audError + " - audience axis unavailable; no audience verdicts issued.");
  } else if (baseline === null) {
    traceError(li, "No control films could be scored; audience axis unavailable.");
  } else {
    traceDone(li, "Control baseline (strongest unrelated film): " + aff1(baseline) + " - " +
      controls.map(c => c.name + " " + aff1(affMap.get(c.entity_id) || 0)).join(", ") + ".<br>" +
      resolvedIdx.filter(i => i !== refIdx).map(i =>
        resolutions[i].entity.name + ": affinity " +
        (affMap.has(resolutions[i].entity.entity_id)
          ? aff1(affMap.get(resolutions[i].entity.entity_id)) : "not scored")).join("<br>"));
  }

  /* 5. Verdicts */
  li = traceStep("Verdicts - tone x audience");
  for (const i of resolvedIdx) {
    if (i === refIdx) continue;
    const cr = compResults[i], tone = toneByIdx[i];
    const aff = affMap.has(cr.entity.entity_id) ? affMap.get(cr.entity.entity_id) : null;
    cr.tone = tone; cr.affinity = aff; cr.baseline = baseline;
    if (!tone.aCount || !tone.bCount) {
      cr.status = "UNMEASURED";
      cr.reason = "One side of this pair has no taste tags in its Qloo profile, so the tone axis cannot be measured and no verdict is issued.";
      continue;
    }
    if (audError || baseline === null || aff === null) {
      cr.status = "UNMEASURED";
      cr.reason = "Tone measured at " + pct1(tone.score) + ", but the audience axis could not be scored, so no verdict is issued.";
      continue;
    }
    const tonePass = tone.score >= TONE_THRESHOLD;
    const audPass = aff > baseline;
    cr.status = tonePass && audPass ? "TRUE" : tonePass ? "TONE" : audPass ? "MARKET" : "FALSE";
    const sharedTxt = tone.shared.length ? tone.shared.slice(0, 4).join(", ") : "none";
    if (cr.status === "TRUE")
      cr.reason = "Both axes pass. Tone " + pct1(tone.score) + " (shared: " + sharedTxt +
        ") and audience affinity " + aff1(aff) + ", above the control baseline " + aff1(baseline) + ".";
    else if (cr.status === "TONE")
      cr.reason = "Tone passes at " + pct1(tone.score) + " (shared: " + sharedTxt +
        "), but audience affinity " + aff1(aff) + " does not beat unrelated controls (baseline " +
        aff1(baseline) + "). Same kind of film; not the same audience.";
    else if (cr.status === "MARKET")
      cr.reason = "Audience affinity " + aff1(aff) + " beats the control baseline " +
        aff1(baseline) + ", but tone overlap is only " + pct1(tone.score) + " (shared: " +
        sharedTxt + "). The audience travels; the tone does not.";
    else
      cr.reason = "Neither axis supports this comp: tone " + pct1(tone.score) +
        " (shared: " + sharedTxt + ") and audience affinity " + aff1(aff) +
        ", at or below the control baseline " + aff1(baseline) + ".";
  }
  traceDone(li, compResults.filter(c => c.status && c.status !== "REFERENCE" && c.status !== "PENDING")
    .map(c => (c.entity ? c.entity.name : c.name) + ": " + c.status).join(" - ") || "No verdicts.");

  const verdicts = compResults.filter(c => ["TRUE", "TONE", "MARKET", "FALSE"].includes(c.status));
  const incomplete = compResults.some(c => ["UNRESOLVED", "ERROR", "UNMEASURED"].includes(c.status));
  if (!verdicts.length) {
    result.badge = "fail"; result.badgeText = "NO VERDICTS";
    result.summary = "No comp received a two-axis verdict.";
  } else if (verdicts.every(c => c.status === "TRUE") && !incomplete) {
    result.badge = "pass"; result.badgeText = "ALL COMPS TRUE";
    result.summary = "Every comp passes both axes against " + reference.name + ".";
  } else {
    result.badge = "mixed";
    result.badgeText = verdicts.map(c => c.entity.name + ": " + c.status).join(" · ").toUpperCase();
    const parts = verdicts.map(c => c.entity.name + " is a " + c.status + " comp");
    result.summary = "Against " + reference.name + ": " + parts.join("; ") + "." +
      (incomplete ? " Some comps could not be fully measured (see cards)." : "");
  }
  result.comps = compResults;

  /* 6. Verify-Prune-Repair */
  li = traceStep("Verify-Prune-Repair - alternatives from the validated cluster");
  const pruned = compResults.filter(c => c.status === "FALSE");
  const validated = [reference, ...compResults.filter(c => c.status === "TRUE").map(c => c.entity)];
  if (baseline === null) {
    traceError(li, "Skipped: no control baseline, so alternatives cannot be held to the same standard.");
    result.alternatives = null;
  } else {
    try {
      const exclude = new Set([...resolutions.filter(r => r.status === "resolved").map(r => r.entity.entity_id),
                               ...controls.map(c => c.entity_id)]);
      const alt = await repairAlternatives(reference, validated, baseline, exclude);
      result.alternatives = alt;
      traceDone(li, (pruned.length
        ? "Pruned " + pruned.map(c => c.entity.name).join(", ") + " (FALSE) from the repair signal. "
        : "Nothing to prune. ") +
        "Seeded with the validated cluster (" + validated.map(e => e.name).join(", ") + "); scored " +
        alt.poolCount + " candidates on both axes; " + alt.trueCount + " pass both.");
    } catch (err) {
      traceError(li, "Alternatives query failed: " + err.message);
      result.alternatives = null;
    }
  }

  /* 7. Cross-domain + demographics on the validated cluster */
  li = traceStep("Cross-domain - what the validated audience loves");
  try {
    result.cross = await crossDomain(validated);
    result.demo = await demographics(reference);
    traceDone(li, result.cross.map(g => g.label + ": " +
      (g.items.map(x => x.name).join(", ") || "none returned")).join(" - ") +
      (result.demo.available ? "<br>" + reference.name + " audience: " + result.demo.line + "." : ""));
  } catch (err) {
    traceError(li, err.message);
    result.cross = null;
  }

  renderResults(result);
}

/* ---------- rendering ---------- */
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function renderResults(r) {
  $("results-card").classList.remove("hidden");
  const badge = $("verdict-badge");
  badge.className = "badge " + r.badge;
  badge.textContent = r.badgeText;
  $("verdict-summary").textContent = r.summary;

  const banner = $("run-banner");
  if (r.banner) {
    banner.className = "banner " + r.banner.kind;
    banner.textContent = r.banner.text;
    banner.classList.remove("hidden");
  } else banner.classList.add("hidden");

  const cardCls = s => ({ TRUE: "true", FALSE: "false", TONE: "tone", MARKET: "market",
    REFERENCE: "anchor", PLAUSIBLE: "market" }[s] || "unresolved");
  $("comp-cards").innerHTML = r.comps.map(c => {
    const name = c.entity ? c.entity.name + (c.entity.year ? " (" + c.entity.year + ")" : "") : c.name;
    return '<div class="comp-card ' + cardCls(c.status) + '"><h4>' + esc(name) + "</h4>" +
      '<div class="status">' + (c.status === "REFERENCE" ? "Reference comp" : c.status) + "</div>" +
      '<div class="reason">' + esc(c.reason || "") + "</div>" +
      (c.tone ? '<div class="score">Tone: ' + pct1(c.tone.score) +
        " (threshold " + pct1(TONE_THRESHOLD) + ")</div>" : "") +
      (typeof c.affinity === "number" ? '<div class="score">Audience affinity: ' + aff1(c.affinity) +
        " vs control baseline " + aff1(c.baseline) + "</div>" : "") +
      "</div>";
  }).join("");

  /* two-axis table (Qloo mode only) */
  let rows = "";
  if (r.mode === "qloo") {
    for (const c of r.comps) {
      if (!c.tone) continue;
      const tpct = Math.round(c.tone.score * 100);
      rows += '<div class="overlap-row"><div class="names">' + esc(r.reference.entity.name) +
        " x " + esc(c.entity.name) + ' <span class="pct">- tone ' + pct1(c.tone.score) +
        (typeof c.affinity === "number"
          ? "; audience " + aff1(c.affinity) + " (controls up to " + aff1(c.baseline) + ")" : "") +
        " - " + c.status + "</span></div>" +
        '<div class="bar"><div class="' + (c.tone.score >= TONE_THRESHOLD ? "hi" : "lo") +
        '" style="width:' + Math.min(tpct, 100) + '%"></div></div></div>';
    }
  }
  $("overlap").innerHTML = rows ||
    '<p class="fineprint">No two-axis data in this mode. The Plausibility Baseline measures nothing, by design.</p>';

  const qloo = r.mode === "qloo";
  $("insights-block").classList.toggle("qloo-off", !qloo);
  $("suggest-block").classList.toggle("qloo-off", !qloo);

  $("insights").innerHTML = qloo
    ? (r.demo && r.demo.available
        ? '<div class="insight"><div class="kind">Audience</div><strong>' +
          esc(r.reference.entity.name) + "</strong>" + '<div class="aff">' + esc(r.demo.line) +
          '</div><div class="note">Buyer quadrant for sales agents and streamers.</div></div>' : "") +
      (r.cross || []).map(g => g.items.map(x =>
        '<div class="insight"><div class="kind">' + g.label + "</div>" +
        "<strong>" + esc(x.name) + "</strong>" +
        '<div class="aff">' + aff1(x.affinity) + " affinity</div>" +
        '<div class="note">' + esc(x.note || g.use) + "</div>" +
        '<div class="note"><em>' + g.use + ".</em></div></div>").join("")).join("") ||
      '<p class="fineprint">No cross-domain affinities returned.</p>'
    : '<p class="fineprint">Switch to Qloo Grounded to see what the validated audience actually loves.</p>';

  $("suggest").innerHTML = qloo
    ? (r.alternatives && r.alternatives.picks.length
        ? r.alternatives.picks.map(s =>
          '<div class="suggest-item"><div><strong>' + esc(s.name) +
          (s.year ? " (" + s.year + ")" : "") + "</strong>" +
          ' <span class="chip ' + s.verdict.toLowerCase() + '">' + s.verdict + "</span>" +
          '<div class="why">Passes the same two-axis test against ' + esc(r.reference.entity.name) +
          ": tone " + pct1(s.tone) + ", audience " + aff1(s.affinity) +
          (s.shared.length ? ". Shared tone: " + esc(s.shared.slice(0, 3).join(", ")) : "") +
          ".</div></div>" +
          '<div class="ov">' + aff1(s.affinity) + "</div></div>").join("")
        : '<p class="fineprint">No alternative in the pool passed the two-axis test this run.</p>')
    : '<p class="fineprint">Switch to Qloo Grounded for alternatives that pass the same test.</p>';

  $("results-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- mode toggle + wiring (browser only) ---------- */
function setMode(m) {
  mode = m;
  const t = $("mode-toggle");
  t.classList.toggle("qloo", m === "qloo");
  t.setAttribute("aria-checked", m === "qloo");
  document.querySelectorAll(".toggle-opt").forEach(o =>
    o.classList.toggle("active", o.dataset.mode === m));
  $("mode-hint").textContent = m === "baseline"
    ? "A scripted illustration of genre-logic reasoning. No model runs, no data is consulted."
    : "Live Qloo taste-graph data: two axes, four verdicts, controls included.";
  if (lastPitch && !$("results-card").classList.contains("hidden")) runAgent();
}

if (typeof document !== "undefined") {
  $("mode-toggle").addEventListener("click", e => {
    const opt = e.target.closest(".toggle-opt");
    if (opt) setMode(opt.dataset.mode);
  });
  $("mode-toggle").addEventListener("keydown", e => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); setMode(mode === "baseline" ? "qloo" : "baseline"); }
  });
  $("run-btn").addEventListener("click", runAgent);
}

/* Node export for the test harness (ignored by browsers). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { resolveTitle, computeTone, audienceBatch, demographics,
    repairAlternatives, crossDomain, pitchKeywords, referenceScore, parseTitleInput,
    normKey, TONE_THRESHOLD, CONTROL_TITLES };
}
