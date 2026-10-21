/* CompCheck live test harness.
   Exercises the shipped engine functions from ../app.js against the live
   Qloo hackathon API, reached through the deployed proxy (the API key lives server-side in the proxy, never in this repo);
   this file never sees or prints it.
   Run: node tests/run-tests.mjs   (requires network access to the API) */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const E = require("../app.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("PASS  " + name + (detail ? "  [" + detail + "]" : "")); }
  else { fail++; console.log("FAIL  " + name + (detail ? "  [" + detail + "]" : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- A. Resolution matrix: 20 titles, correct-entity verification ---- */
const MATRIX = [
  ["Tumbbad", 2018], ["The Witch", 2015], ["RRR", 2022], ["Bulbbul", 2020],
  ["Stree", 2018], ["Dangal", 2016], ["Paddington 2", 2017], ["Top Gun: Maverick", 2022],
  ["K.G.F: Chapter 1", 2018], ["Badla", 2019], ["Get Out", 2017], ["Hereditary", 2018],
  ["Parasite", 2019], ["Spirited Away", 2001], ["Mad Max: Fury Road", 2015],
  ["Coco", 2017], ["Andhadhun", 2018], ["Kantara", 2022], ["Amélie", 2001], ["Barbie", 2023]
];
const resolved = {};
for (const [title, year] of MATRIX) {
  const r = await E.resolveTitle(title);
  const ok = r.status === "resolved" && E.normKey(r.entity.name) === E.normKey(title);
  check("resolve " + title, ok, r.status === "resolved"
    ? r.entity.name + " (" + r.entity.year + ")" : r.status);
  if (r.status === "resolved") {
    resolved[title] = r.entity;
    if (year) check("  year " + title, r.entity.year === year, "got " + r.entity.year);
  }
  await sleep(150);
}

/* ---- B. Disambiguation: multiple exact-name candidates ---- */
const witch = await E.resolveTitle("The Witch");
check("disambiguation The Witch -> 2015 film", witch.entity.year === 2015, witch.decision);

/* ---- C. Year hint in the input ---- */
const witch25 = await E.resolveTitle("The Witch (2025)");
check("year hint The Witch (2025)", witch25.status === "resolved" && witch25.entity.year === 2025,
  witch25.status === "resolved" ? witch25.decision : witch25.status);

/* ---- D. Unresolved title is honest (never a fake verdict) ---- */
const nonsense = await E.resolveTitle("Zqxjkvb Nonsense Title 2099");
check("nonsense title UNRESOLVED", nonsense.status === "unresolved", nonsense.decision);

/* ---- E. Error honesty: a failed API call throws, never becomes "unresolved" ---- */
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("simulated outage"); };
let threw = false;
try { await E.resolveTitle("Some Fresh Title Qqq 1234"); } catch (err) { threw = true; }
globalThis.fetch = realFetch;
check("API failure propagates as error", threw);

/* ---- F. Tone calibration bands ---- */
const tone = (a, b) => E.computeTone(resolved[a], resolved[b]).score;
check("tone Tumbbad x Bulbbul >= threshold", tone("Tumbbad", "Bulbbul") >= E.TONE_THRESHOLD,
  (tone("Tumbbad", "Bulbbul") * 100).toFixed(1) + "%");
check("tone Tumbbad x Stree >= threshold", tone("Tumbbad", "Stree") >= E.TONE_THRESHOLD,
  (tone("Tumbbad", "Stree") * 100).toFixed(1) + "%");
check("tone Hereditary x The Witch >= threshold", tone("Hereditary", "The Witch") >= E.TONE_THRESHOLD,
  (tone("Hereditary", "The Witch") * 100).toFixed(1) + "%");
check("tone Get Out x Parasite >= threshold", tone("Get Out", "Parasite") >= E.TONE_THRESHOLD,
  (tone("Get Out", "Parasite") * 100).toFixed(1) + "%");
check("tone Tumbbad x RRR < threshold", tone("Tumbbad", "RRR") < E.TONE_THRESHOLD,
  (tone("Tumbbad", "RRR") * 100).toFixed(1) + "%");
check("tone Tumbbad x Dangal < threshold", tone("Tumbbad", "Dangal") < E.TONE_THRESHOLD,
  (tone("Tumbbad", "Dangal") * 100).toFixed(1) + "%");
check("tone Tumbbad x Coco < threshold", tone("Tumbbad", "Coco") < E.TONE_THRESHOLD,
  (tone("Tumbbad", "Coco") * 100).toFixed(1) + "%");

/* ---- G. Demo deck, end to end through the shipped functions ---- */
const pitch = {
  genre: "Folk Horror",
  logline: "A cursed harvest festival in rural Maharashtra forces a young widow to confront the folk goddess her village has fed for generations."
};
const phrases = E.pitchKeywords(pitch);
const deck = ["Tumbbad", "The Witch", "RRR"].map(t => resolved[t]);
const scored = deck.map(e => ({ e, m: E.referenceScore(e, phrases) }))
  .sort((a, b) => b.m.length - a.m.length || b.e.popularity - a.e.popularity);
console.log("INFO  reference scores: " + scored.map(s => s.e.name + "=" + s.m.length +
  " (" + s.m.map(t => t.name).join(", ") + ")").join(" | "));
check("auto-reference is Tumbbad", scored[0].e.name === "Tumbbad", scored[0].e.name);

const ref = resolved["Tumbbad"];
const controls = [];
for (const ct of E.CONTROL_TITLES) { const r = await E.resolveTitle(ct); if (r.status === "resolved") controls.push(r.entity); }
const targets = [resolved["The Witch"], resolved["RRR"], resolved["Bulbbul"], ...controls];
const aff = await E.audienceBatch(ref, targets);
const baseline = Math.max(...controls.map(c => aff.get(c.entity_id)));
console.log("INFO  affinities vs Tumbbad: " + targets.map(t => t.name + "=" + (aff.get(t.entity_id) * 100).toFixed(1)).join(" | ") +
  " | baseline=" + (baseline * 100).toFixed(1));
function verdict(comp) {
  const t = E.computeTone(ref, comp).score;
  const a = aff.get(comp.entity_id);
  const tp = t >= E.TONE_THRESHOLD, ap = a > baseline;
  return tp && ap ? "TRUE" : tp ? "TONE" : ap ? "MARKET" : "FALSE";
}
check("demo deck: The Witch = TONE", verdict(resolved["The Witch"]) === "TONE",
  "tone " + (tone("Tumbbad", "The Witch") * 100).toFixed(1) + "%, aff " + (aff.get(resolved["The Witch"].entity_id) * 100).toFixed(1));
check("demo deck: RRR = MARKET", verdict(resolved["RRR"]) === "MARKET",
  "tone " + (tone("Tumbbad", "RRR") * 100).toFixed(1) + "%, aff " + (aff.get(resolved["RRR"].entity_id) * 100).toFixed(1));
check("demo deck: Bulbbul = TRUE", verdict(resolved["Bulbbul"]) === "TRUE",
  "tone " + (tone("Tumbbad", "Bulbbul") * 100).toFixed(1) + "%, aff " + (aff.get(resolved["Bulbbul"].entity_id) * 100).toFixed(1));

/* ---- H. Order invariance for a fixed reference ---- */
check("tone is symmetric", Math.abs(tone("Tumbbad", "RRR") - tone("RRR", "Tumbbad")) < 1e-9);

/* ---- I. Alternatives: never a title the engine fails ---- */
const exclude = new Set([...deck, resolved["Bulbbul"], ...controls].map(e => e.entity_id));
const alt = await E.repairAlternatives(ref, [ref], baseline, exclude);
console.log("INFO  alternatives: " + alt.picks.map(p => p.name + " [" + p.verdict +
  " tone " + (p.tone * 100).toFixed(1) + "% aff " + (p.affinity * 100).toFixed(1) + "]").join(" | ") +
  " (pool " + alt.poolCount + ", both-axis " + alt.trueCount + ")");
check("alternatives returned", alt.picks.length > 0);
check("alternatives never FALSE", alt.picks.every(p => p.verdict !== "FALSE"));
check("TRUE alternatives pass both axes", alt.picks.filter(p => p.verdict === "TRUE")
  .every(p => p.tone >= E.TONE_THRESHOLD && p.affinity > baseline));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
