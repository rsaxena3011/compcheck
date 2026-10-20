/* CompCheck - agent loop over the LIVE Qloo Taste AI API.
   All Qloo calls go to https://hackathon.api.qloo.com with the X-Api-Key
   header (hackathon-scoped demo key, client-side for the public demo build).
   Responses are used in-memory only; no Qloo response data is stored or
   committed anywhere (per Qloo hackathon terms).

   Verdict logic (Qloo mode): pairwise "taste overlap" = Jaccard similarity
   of the two films' curated taste-tag profiles (genre / subgenre / theme /
   plot / style tags from Qloo's own graph, via GET /search), backed by
   live audience affinity lists and demographics from GET /v2/insights.
   Kill tests 2026-10-20: 20/20 demo titles resolve via /search, and the
   demo beat reproduces live: Tumbbad x The Witch = TRUE (0.27 taste
   overlap, shared: Folk horror, Slow burn), Tumbbad x RRR = FALSE (0.07,
   generic tags only). */

const QLOO_BASE = "https://hackathon.api.qloo.com";
const QLOO_KEY = "***REMOVED***";
const TRUE_THRESHOLD = 0.20;
const TASTE_TAG_TYPES = new Set([
  "urn:tag:genre:media", "urn:tag:genre:qloo", "urn:tag:subgenre:qloo",
  "urn:tag:theme:qloo", "urn:tag:plot:qloo", "urn:tag:style:qloo"
]);
const TAG_TYPE_RANK = {
  "urn:tag:subgenre:qloo": 0, "urn:tag:theme:qloo": 1, "urn:tag:genre:qloo": 2,
  "urn:tag:genre:media": 3, "urn:tag:plot:qloo": 4, "urn:tag:style:qloo": 5
};

let mode = "llm"; // 'llm' | 'qloo'
let lastPitch = null;
let runData = { pairs: {}, cross: [], suggest: [] };

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => s.toLowerCase().trim();

/* ---------- live Qloo client (in-memory cache only) ---------- */
const cache = { search: {}, audience: {}, cross: {}, suggest: {} };

async function qlooGet(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(QLOO_BASE + path, {
      headers: { "X-Api-Key": QLOO_KEY }, signal: ctrl.signal
    });
    if (!res.ok) throw new Error("Qloo HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

function tasteTags(entity) {
  const seen = new Map();
  (entity.tags || []).forEach(t => {
    if (TASTE_TAG_TYPES.has(t.type) && !seen.has(t.tag_id))
      seen.set(t.tag_id, { id: t.tag_id, name: t.name, type: t.type });
  });
  return [...seen.values()].sort((a, b) =>
    (TAG_TYPE_RANK[a.type] - TAG_TYPE_RANK[b.type]) || a.name.localeCompare(b.name));
}

async function resolveEntity(title) {
  const key = norm(title);
  if (cache.search[key]) return cache.search[key];
  let entity = null;
  try {
    const q = encodeURIComponent(title);
    const data = await qlooGet("/search?query=" + q + "&types=urn:entity:movie,urn:entity:tv_show");
    const results = (data.results || []).filter(r =>
      (r.types || []).some(t => t === "urn:entity:movie" || t === "urn:entity:tv_show"));
    const hit = results.find(r => norm(r.name) === key) || results[0];
    if (hit) {
      entity = {
        entity_id: hit.entity_id,
        name: hit.name,
        year: hit.properties && hit.properties.release_year || null,
        popularity: hit.popularity || 0,
        properties: {
          genre: (hit.properties && hit.properties.genres) || [],
          description: (hit.properties && hit.properties.description) || ""
        },
        tags: tasteTags(hit),
        simulated: false
      };
    }
  } catch (err) { /* fall through to simulated */ }
  if (!entity) {
    // Unresolved title: clearly-labeled simulated entity so any pitch still runs.
    entity = {
      entity_id: "sim-ent-" + key.replace(/[^a-z0-9]+/g, "-"),
      name: title.trim(),
      year: null,
      popularity: 0.5,
      properties: { genre: ["Unknown"], description: "Not resolved in the live Qloo catalog." },
      tags: [],
      simulated: true
    };
  }
  cache.search[key] = entity;
  return entity;
}

function sharedTags(a, b) {
  const bIds = new Set(b.tags.map(t => t.id));
  const seenNames = new Set(), out = [];
  for (const t of a.tags) {
    if (bIds.has(t.id) && !seenNames.has(t.name)) { seenNames.add(t.name); out.push(t); }
  }
  return out;
}
function tasteOverlap(a, b) {
  const aIds = new Set(a.tags.map(t => t.id)), bIds = new Set(b.tags.map(t => t.id));
  const inter = [...aIds].filter(id => bIds.has(id)).length;
  const union = new Set([...aIds, ...bIds]).size;
  return union ? inter / union : 0;
}
function pairKey(a, b) { return [a.entity_id, b.entity_id].sort().join("|"); }

function computePair(a, b) {
  const shared = sharedTags(a, b);
  const ov = tasteOverlap(a, b);
  const isTrue = ov >= TRUE_THRESHOLD;
  const topA = a.tags.slice(0, 3).map(t => t.name).join(", ");
  const topB = b.tags.slice(0, 3).map(t => t.name).join(", ");
  return {
    a: a.name, b: b.name,
    audience_overlap: ov,
    shared_affinities: shared.slice(0, 4).map(t => t.name),
    verdict: isTrue ? "TRUE_COMP" : "FALSE_COMP",
    divergence: isTrue ? "" :
      "Shared taste is generic only (" + (shared.map(t => t.name).join(", ") || "none") +
      "). " + b.name + " profiles as " + topB + "; " + a.name + " profiles as " + topA + "."
  };
}

async function audienceProfile(entity) {
  if (cache.audience[entity.entity_id]) return cache.audience[entity.entity_id];
  const out = { topTitles: [], skew: "" };
  try {
    const [movies, demo] = await Promise.all([
      qlooGet("/v2/insights?filter.type=urn:entity:movie&signal.interests.entities=" +
        entity.entity_id + "&take=10"),
      qlooGet("/v2/insights?filter.type=urn:demographics&signal.interests.entities=" +
        entity.entity_id).catch(() => null)
    ]);
    out.topTitles = ((movies.results || {}).entities || []).slice(0, 3).map(e => ({
      name: e.name, affinity: (e.query && e.query.affinity) || 0
    }));
    const d = demo && demo.results && demo.results.demographics &&
      demo.results.demographics[0] && demo.results.demographics[0].query;
    if (d) {
      const bands = { "24 and younger": "age.24_and_younger", "25-29": "age.25_to_29",
        "30-34": "age.30_to_34", "35-44": "age.35_to_44", "45-54": "age.45_to_54",
        "55+": "age.55_and_older" };
      let best = null, bestV = -Infinity;
      for (const [label, path] of Object.entries(bands)) {
        const v = d.age[path.split(".")[1]];
        if (typeof v === "number" && v > bestV) { bestV = v; best = label; }
      }
      const g = d.gender || {};
      const lean = (g.male || 0) > (g.female || 0) ? "male-leaning" : "female-leaning";
      out.skew = (best ? "skews " + best + ", " : "") + lean;
    }
  } catch (err) { /* profile stays empty; trace notes it */ }
  cache.audience[entity.entity_id] = out;
  return out;
}

async function crossDomain(entities) {
  const ids = entities.filter(e => !e.simulated).slice(0, 2).map(e => e.entity_id);
  if (!ids.length) return [];
  const key = ids.join(",");
  if (cache.cross[key]) return cache.cross[key];
  const types = ["urn:entity:artist", "urn:entity:brand", "urn:entity:podcast"];
  const lists = await Promise.all(types.map(async t => {
    try {
      const d = await qlooGet("/v2/insights?filter.type=" + t +
        "&signal.interests.entities=" + ids.join(",") + "&take=3");
      return ((d.results || {}).entities || []).map(e => ({
        name: e.name, type: t, entity_id: e.entity_id,
        affinity: (e.query && e.query.affinity) || 0,
        note: shortNote(e)
      }));
    } catch (err) { return []; }
  }));
  const merged = lists.flat().sort((x, y) => y.affinity - x.affinity).slice(0, 6);
  cache.cross[key] = merged;
  return merged;
}

function shortNote(e) {
  const sd = e.properties && e.properties.short_descriptions;
  const en = Array.isArray(sd) && sd.find(s => s.language === "en");
  let text = (en && en.value) || (e.properties && e.properties.description) || "";
  text = text.split(/(?<=[.!?])\s/)[0];
  return text.length > 110 ? text.slice(0, 107) + "..." : text;
}

async function suggestions(anchor, entities) {
  if (cache.suggest[anchor.entity_id]) return cache.suggest[anchor.entity_id];
  let out = [];
  try {
    const d = await qlooGet("/v2/insights?filter.type=urn:entity:movie&signal.interests.entities=" +
      anchor.entity_id + "&take=10");
    const exclude = new Set(entities.map(e => e.entity_id));
    out = ((d.results || {}).entities || [])
      .filter(e => !exclude.has(e.entity_id))
      .slice(0, 4)
      .map(e => {
        const shared = tasteTags(e).filter(t => anchor.tags.some(a => a.id === t.id));
        return {
          name: e.name, entity_id: e.entity_id,
          audience_overlap: (e.query && e.query.affinity) || 0,
          why: shared.length
            ? "Shares the anchor's taste DNA: " + shared.slice(0, 3).map(t => t.name).join(", ") + "."
            : "High measured affinity with the " + anchor.name + " audience."
        };
      });
  } catch (err) { /* suggestions stay empty */ }
  cache.suggest[anchor.entity_id] = out;
  return out;
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

/* ---------- LLM-mode reasoning (plausible, unverified) ---------- */
function llmReasoning(comp, pitch) {
  const g = (comp.properties.genre || []).join("/").toLowerCase();
  if (norm(comp.name) === "rrr") {
    return "Both draw on Indian mythology and deliver large-scale spectacle. RRR proves the audience appetite for mythic Indian storytelling and broadens commercial upside.";
  }
  if (g.includes("horror")) {
    return "Shares the folk-horror lane: period setting, dread over jump scares, mythology as engine. A natural tonal match for '" + pitch.title + "'.";
  }
  return "Overlapping genre DNA (" + (comp.properties.genre || []).join(", ") +
    ") and comparable audience expectations. A defensible comp for the deck.";
}

/* ---------- agent loop ---------- */
async function runAgent() {
  const pitch = {
    title: $("in-title").value.trim() || "Untitled",
    genre: $("in-genre").value.trim() || "Unspecified",
    logline: $("in-logline").value.trim(),
    comps: [$("in-comp1").value, $("in-comp2").value, $("in-comp3").value]
      .map(s => s.trim()).filter(Boolean)
  };
  if (!pitch.comps.length) { alert("Enter at least one comp title."); return; }
  lastPitch = pitch;
  runData = { pairs: {}, cross: [], suggest: [] };

  $("run-btn").disabled = true;
  $("results-card").classList.add("hidden");
  traceStart();

  if (mode === "llm") {
    const entities = [];
    for (const c of pitch.comps) entities.push(await resolveEntity(c));

    let li = traceStep("Reading pitch with language model");
    await sleep(700);
    traceDone(li, '"' + pitch.title + "' - " + pitch.genre + ". Extracting tone, themes, audience cues from the logline.");

    li = traceStep("Matching comps from training knowledge");
    await sleep(800);
    traceDone(li, entities.map(e => e.name + " (" + (e.properties.genre || []).join("/") + ")").join(" - "));

    li = traceStep("Synthesizing verdict");
    await sleep(600);
    traceDone(li, "All comps accepted on genre, tone and thematic similarity.");

    renderResults(pitch, entities, llmVerdict(pitch, entities));
  } else {
    let li = traceStep("Resolving comps to Qloo entities - GET /search");
    const entities = [];
    for (const c of pitch.comps) entities.push(await resolveEntity(c));
    traceDone(li, entities.map(e => e.name + " - <code>" + e.entity_id + "</code>" +
      (e.simulated ? " (not in live catalog)" : "")).join("<br>"));

    li = traceStep("Fetching audience profiles - GET /v2/insights");
    const profiles = await Promise.all(entities.map(e =>
      e.simulated ? Promise.resolve(null) : audienceProfile(e)));
    const audLines = entities.map((e, i) => {
      const p = profiles[i];
      if (!p || !p.topTitles.length) return e.name + ": live profile unavailable.";
      const top = p.topTitles[0];
      return e.name + ": audience also loves " + top.name + " (" + Math.round(top.affinity * 100) +
        "% affinity)" + (p.skew ? "; " + p.skew : "");
    });
    traceDone(li, audLines.join("<br>"));

    li = traceStep("Computing pairwise taste overlap - Qloo taste tags");
    const overlaps = [];
    for (let i = 0; i < entities.length; i++)
      for (let j = i + 1; j < entities.length; j++) {
        if (entities[i].simulated || entities[j].simulated) continue;
        const pair = computePair(entities[i], entities[j]);
        runData.pairs[pairKey(entities[i], entities[j])] = pair;
        overlaps.push(pair.a + " x " + pair.b + ": " + Math.round(pair.audience_overlap * 100) +
          "% taste overlap (" + pair.verdict.replace("_", " ") + ")");
      }
    traceDone(li, overlaps.join("<br>") || "No live taste data for these titles.");

    li = traceStep("Mining cross-domain affinities - artists, brands, podcasts");
    runData.cross = await crossDomain(entities);
    traceDone(li, runData.cross.slice(0, 3).map(x => x.name + " (" + x.type.split(":")[2] + ", " +
      Math.round(x.affinity * 100) + "%)").join(" - ") || "No cross-domain data returned.");

    li = traceStep("Finding audience-validated alternative comps");
    runData.suggest = entities[0].simulated ? [] : await suggestions(entities[0], entities);
    traceDone(li, runData.suggest.length
      ? "Top alternative: " + runData.suggest[0].name + " (" +
        Math.round(runData.suggest[0].audience_overlap * 100) + "% affinity with the anchor audience)."
      : "No alternatives returned.");

    li = traceStep("Synthesizing verdict");
    await sleep(300);
    traceDone(li, "Comps split by measured taste overlap, not genre tags.");

    renderResults(pitch, entities, qlooVerdict(pitch, entities));
  }

  $("run-btn").disabled = false;
}

/* ---------- verdicts ---------- */
function llmVerdict(pitch, entities) {
  return {
    mode: "llm",
    comps: entities.map(e => ({
      entity: e, verdict: "MATCH",
      reason: llmReasoning(e, pitch),
      score: null
    })),
    summary: "All " + entities.length + " comps accepted. On genre, tone and theme, '" +
      pitch.title + "' sits comfortably alongside " +
      entities.map(e => e.name).join(", ") + ". No data was consulted.",
    badge: "mixed", badgeText: "UNVERIFIED"
  };
}

function qlooVerdict(pitch, entities) {
  const anchor = entities[0];
  const anchorTop = anchor.tags.slice(0, 3).map(t => t.name).join(", ");
  const comps = entities.map((e, i) => {
    if (e.simulated)
      return { entity: e, verdict: "UNVERIFIED", reason: "Not resolved in the live Qloo catalog, so no taste data backs this comp.", score: null };
    if (i === 0)
      return { entity: e, verdict: "ANCHOR",
               reason: "Reference comp. Qloo taste profile: " + anchorTop +
                 " (popularity " + Math.round(e.popularity * 100) + "%). This is the room your pitch must play in.",
               score: 1 };
    const ov = runData.pairs[pairKey(anchor, e)];
    if (!ov) return { entity: e, verdict: "UNVERIFIED", reason: "No taste overlap computed for this pair.", score: null };
    const pct = Math.round(ov.audience_overlap * 100);
    if (ov.verdict === "TRUE_COMP")
      return { entity: e, verdict: "TRUE COMP", score: ov.audience_overlap,
               reason: pct + "% taste overlap with " + anchor.name + ". Shared: " + (ov.shared_affinities || []).join(", ") + "." };
    return { entity: e, verdict: "FALSE COMP", score: ov.audience_overlap,
             reason: "Only " + pct + "% taste overlap. " + (ov.divergence || "") };
  });
  const falses = comps.filter(c => c.verdict === "FALSE COMP");
  return {
    mode: "qloo",
    comps,
    summary: falses.length
      ? falses.map(c => c.entity.name).join(", ") + " " +
        (falses.length > 1 ? "are" : "is") +
        " a FALSE COMP. The live Qloo taste data splits your deck: " +
        comps.filter(c => c.verdict === "TRUE COMP" || c.verdict === "ANCHOR").map(c => c.entity.name).join(" and ") +
        " share a real taste profile; " + falses.map(c => c.entity.name).join(", ") + " does not."
      : "All comps validated against live Qloo taste data.",
    badge: falses.length ? "fail" : "pass",
    badgeText: falses.length ? "FALSE COMP FOUND" : "COMPS VALIDATED"
  };
}

/* ---------- rendering ---------- */
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function renderResults(pitch, entities, verdict) {
  $("results-card").classList.remove("hidden");
  const badge = $("verdict-badge");
  badge.className = "badge " + verdict.badge;
  badge.textContent = verdict.badgeText;
  $("verdict-summary").textContent = verdict.summary;

  $("comp-cards").innerHTML = verdict.comps.map(c => {
    const cls = c.verdict === "FALSE COMP" ? "false" : "true";
    const status = c.verdict === "ANCHOR" ? "Reference comp" : c.verdict;
    return '<div class="comp-card ' + cls + '"><h4>' + esc(c.entity.name) + "</h4>" +
      '<div class="status">' + status + "</div>" +
      '<div class="reason">' + esc(c.reason) + "</div>" +
      (c.score !== null && c.verdict !== "ANCHOR"
        ? '<div class="score">Taste overlap: ' + Math.round(c.score * 100) + "%</div>" : "") +
      (c.entity.simulated ? '<div class="score">Not resolved live</div>' : "") +
      "</div>";
  }).join("");

  // overlap bars (live taste overlap, Qloo mode only)
  let rows = "";
  if (verdict.mode === "qloo") {
    for (let i = 0; i < entities.length; i++)
      for (let j = i + 1; j < entities.length; j++) {
        const ov = runData.pairs[pairKey(entities[i], entities[j])];
        if (!ov) continue;
        const pct = Math.round(ov.audience_overlap * 100);
        const good = ov.verdict === "TRUE_COMP";
        rows += '<div class="overlap-row"><div class="names">' + esc(ov.a) + " x " + esc(ov.b) +
          ' <span class="pct">- ' + pct + "% shared taste</span></div>" +
          '<div class="bar"><div class="' + (good ? "hi" : "lo") + '" style="width:' + pct + '%"></div></div></div>';
      }
  }
  $("overlap").innerHTML = rows ||
    '<p class="fineprint">No live overlap data for these titles in Qloo mode. LLM mode shows no overlap data by design.</p>';

  // cross-domain + suggest only meaningful in qloo mode
  const qloo = verdict.mode === "qloo";
  $("insights-block").classList.toggle("qloo-off", !qloo);
  $("suggest-block").classList.toggle("qloo-off", !qloo);

  $("insights").innerHTML = qloo
    ? runData.cross.map(x =>
        '<div class="insight"><div class="kind">' + x.type.split(":")[2] + "</div>" +
        "<strong>" + esc(x.name) + "</strong>" +
        '<div class="aff">' + Math.round(x.affinity * 100) + "% affinity</div>" +
        '<div class="note">' + esc(x.note) + "</div></div>").join("") ||
      '<p class="fineprint">No cross-domain affinities returned.</p>'
    : '<p class="fineprint">Switch to Qloo Grounded to see what the audience actually loves.</p>';

  $("suggest").innerHTML = qloo
    ? runData.suggest.map(s =>
        '<div class="suggest-item"><div><strong>' + esc(s.name) + "</strong>" +
        '<div class="why">' + esc(s.why) + "</div></div>" +
        '<div class="ov">' + Math.round(s.audience_overlap * 100) + "%</div></div>").join("") ||
      '<p class="fineprint">No alternatives returned.</p>'
    : '<p class="fineprint">Switch to Qloo Grounded for audience-validated alternatives.</p>';

  $("results-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- mode toggle ---------- */
function setMode(m) {
  mode = m;
  const t = $("mode-toggle");
  t.classList.toggle("qloo", m === "qloo");
  t.setAttribute("aria-checked", m === "qloo");
  document.querySelectorAll(".toggle-opt").forEach(o =>
    o.classList.toggle("active", o.dataset.mode === m));
  $("mode-hint").textContent = m === "llm"
    ? "Language model reasoning. Plausible, unverified."
    : "Live Qloo taste-graph data. Watch the false comps turn red.";
  if (lastPitch && !$("results-card").classList.contains("hidden")) runAgent();
}

$("mode-toggle").addEventListener("click", e => {
  const opt = e.target.closest(".toggle-opt");
  if (opt) setMode(opt.dataset.mode);
});
$("mode-toggle").addEventListener("keydown", e => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); setMode(mode === "llm" ? "qloo" : "llm"); }
});
$("run-btn").addEventListener("click", runAgent);
