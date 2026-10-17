/* CompCheck - agent loop over mocked Qloo fixtures.
   Swap FIXTURE fetches for live hackathon.api.qloo.com calls (X-Api-Key header)
   when the API key arrives. Server-side cache only; never commit real responses. */

const FIXTURES = {};
const FIXTURE_FILES = ["search","audience-tumbbad","audience-the-witch","audience-rrr",
                       "compare","cross-domain","suggest"];

let mode = "llm"; // 'llm' | 'qloo'
let lastPitch = null;

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => s.toLowerCase().trim();
const audKey = name => "audience-" + norm(name).replace(/\s+/g, "-");

async function loadFixtures() {
  const loads = FIXTURE_FILES.map(async f => {
    const res = await fetch("fixtures/" + f + ".json");
    FIXTURES[f] = await res.json();
  });
  await Promise.all(loads);
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

/* ---------- entity resolution ---------- */
function resolveEntity(title) {
  const results = FIXTURES["search"].results;
  const key = norm(title);
  if (results[key]) return { ...results[key], simulated: false };
  // Unknown title: clearly-labeled simulated entity so any pitch still runs.
  return {
    entity_id: "sim-ent-" + key.replace(/[^a-z0-9]+/g, "-"),
    name: title.trim(),
    year: null,
    popularity: 0.5,
    properties: { genre: ["Unknown"], description: "Simulated entity (not in fixture set)." },
    simulated: true
  };
}

function pairKey(a, b) {
  return [a.entity_id, b.entity_id].sort().join("|");
}
function getOverlap(a, b) {
  const pairs = FIXTURES["compare"].pairs;
  return pairs[pairKey(a, b)] || null;
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

  $("run-btn").disabled = true;
  $("results-card").classList.add("hidden");
  traceStart();

  const entities = pitch.comps.map(resolveEntity);

  if (mode === "llm") {
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
    await sleep(700);
    traceDone(li, entities.map(e => e.name + " - <code>" + e.entity_id + "</code>" +
      (e.simulated ? " (simulated)" : "")).join("<br>"));

    li = traceStep("Fetching audience profiles - GET /v2/insights");
    await sleep(800);
    const audLines = entities.filter(e => !e.simulated && FIXTURES[audKey(e.name)])
      .map(e => {
        const aud = FIXTURES[audKey(e.name)].insights;
        const top = Object.entries(aud.genre_affinity).sort((a,b) => b[1]-a[1])[0];
        return e.name + ": top affinity " + top[0] + " " + Math.round(top[1]*100) + "%";
      });
    traceDone(li, (audLines.join("<br>") || "Simulated profiles only."));

    li = traceStep("Computing pairwise audience overlap");
    await sleep(800);
    const overlaps = [];
    for (let i = 0; i < entities.length; i++)
      for (let j = i + 1; j < entities.length; j++) {
        const ov = getOverlap(entities[i], entities[j]);
        if (ov) overlaps.push(ov.a + " x " + ov.b + ": " + Math.round(ov.audience_overlap * 100) + "%");
      }
    traceDone(li, overlaps.join("<br>") || "No fixture overlap data for these titles.");

    li = traceStep("Mining cross-domain affinities - artists, brands, podcasts");
    await sleep(700);
    const top3 = FIXTURES["cross-domain"].insights.slice(0, 3);
    traceDone(li, top3.map(x => x.name + " (" + x.type.split(":")[2] + ", " +
      Math.round(x.affinity * 100) + "%)").join(" - "));

    li = traceStep("Finding audience-validated alternative comps");
    await sleep(600);
    const sug = FIXTURES["suggest"].recommendations[0];
    traceDone(li, "Top alternative: " + sug.name + " (" + Math.round(sug.audience_overlap * 100) + "% overlap).");

    li = traceStep("Synthesizing verdict");
    await sleep(500);
    traceDone(li, "Comps split by measured audience overlap, not genre tags.");

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
  const comps = entities.map((e, i) => {
    if (e.simulated)
      return { entity: e, verdict: "UNVERIFIED", reason: "Not in the fixture set - simulated. Run the kill tests against live Qloo before trusting this.", score: null };
    if (i === 0)
      return { entity: e, verdict: "ANCHOR", reason: "Reference comp. Audience horror affinity 92% - this is the room your pitch must play in.", score: 1 };
    const ov = getOverlap(anchor, e);
    if (!ov) return { entity: e, verdict: "UNVERIFIED", reason: "No overlap fixture for this pair.", score: null };
    const pct = Math.round(ov.audience_overlap * 100);
    if (ov.verdict === "TRUE_COMP")
      return { entity: e, verdict: "TRUE COMP", score: ov.audience_overlap,
               reason: pct + "% audience overlap with " + anchor.name + ". Shared: " + (ov.shared_affinities || []).join(", ") + "." };
    return { entity: e, verdict: "FALSE COMP", score: ov.audience_overlap,
             reason: "Only " + pct + "% audience overlap. " + (ov.divergence || "") };
  });
  const falses = comps.filter(c => c.verdict === "FALSE COMP");
  return {
    mode: "qloo",
    comps,
    summary: falses.length
      ? falses.map(c => c.entity.name).join(", ") + " " +
        (falses.length > 1 ? "are" : "is") +
        " a FALSE COMP. The audience data splits your deck: " +
        comps.filter(c => c.verdict === "TRUE COMP" || c.verdict === "ANCHOR").map(c => c.entity.name).join(" and ") +
        " share a real audience; " + falses.map(c => c.entity.name).join(", ") + " does not."
      : "All comps validated against audience overlap data.",
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
        ? '<div class="score">Audience overlap: ' + Math.round(c.score * 100) + "%</div>" : "") +
      (c.entity.simulated ? '<div class="score">Simulated entity</div>' : "") +
      "</div>";
  }).join("");

  // overlap bars
  let rows = "";
  for (let i = 0; i < entities.length; i++)
    for (let j = i + 1; j < entities.length; j++) {
      const ov = getOverlap(entities[i], entities[j]);
      if (!ov) continue;
      const pct = Math.round(ov.audience_overlap * 100);
      const good = ov.verdict === "TRUE_COMP";
      rows += '<div class="overlap-row"><div class="names">' + esc(ov.a) + " x " + esc(ov.b) +
        ' <span class="pct">- ' + pct + "% shared audience</span></div>" +
        '<div class="bar"><div class="' + (good ? "hi" : "lo") + '" style="width:' + pct + '%"></div></div></div>';
    }
  $("overlap").innerHTML = rows ||
    '<p class="fineprint">No overlap fixtures for these titles in Qloo mode. LLM mode shows no overlap data by design.</p>';

  // cross-domain + suggest only meaningful in qloo mode
  const qloo = verdict.mode === "qloo";
  $("insights-block").classList.toggle("qloo-off", !qloo);
  $("suggest-block").classList.toggle("qloo-off", !qloo);

  $("insights").innerHTML = qloo
    ? FIXTURES["cross-domain"].insights.map(x =>
        '<div class="insight"><div class="kind">' + x.type.split(":")[2] + "</div>" +
        "<strong>" + esc(x.name) + "</strong>" +
        '<div class="aff">' + Math.round(x.affinity * 100) + "% affinity</div>" +
        '<div class="note">' + esc(x.note) + "</div></div>").join("")
    : '<p class="fineprint">Switch to Qloo Grounded to see what the audience actually loves.</p>';

  $("suggest").innerHTML = qloo
    ? FIXTURES["suggest"].recommendations.map(s =>
        '<div class="suggest-item"><div><strong>' + esc(s.name) + "</strong>" +
        '<div class="why">' + esc(s.why) + "</div></div>" +
        '<div class="ov">' + Math.round(s.audience_overlap * 100) + "%</div></div>").join("")
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
    : "Qloo taste-graph data (mock fixtures). Watch the false comps turn red.";
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

loadFixtures().catch(err => {
  $("trace-card").classList.remove("hidden");
  $("trace").innerHTML = "<li>Failed to load fixtures: " + esc(err.message) + "</li>";
});
