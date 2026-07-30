import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

// The hypothesis ledger: hunches that don't clear the evidence bar persist as
// open cases instead of evaporating, get re-tested opportunistically (thinking
// passes see the open ones), and accumulate evidence over time. A recurring
// suspicion is one evolving case file, not a fresh alert every sighting.

export interface HypothesisEvidence {
  at: string;
  verdict: "supported" | "refuted" | "inconclusive";
  note: string;
}

export interface Hypothesis {
  id: string;
  text: string;
  domain: string;
  status: "open" | "supported" | "refuted";
  sightings: number;
  evidence: HypothesisEvidence[];
  first_seen: string;
  last_seen: string;
  last_tested?: string;
}

const SIMILARITY_THRESHOLD = 0.6;
// Jaccard alone under-merges a restatement that adds detail: the extra tokens
// land in the union and sink the score. Two production entries describing the
// same over-broad-scopes finding scored 0.528 and opened as separate cases.
// Containment (shared / smaller side) catches "B restates A with more detail",
// but on its own it merges anything short into anything long — a six-token
// hunch shares half its tokens with unrelated prose — so it needs a floor.
const CONTAINMENT_THRESHOLD = 0.65;
const CONTAINMENT_MIN_TOKENS = 8;

// Ledger bounds. Without them a production ledger reached 185 live hypotheses
// — every stale crisis-era suspicion fed every subsequent thinking pass, which
// kept the crisis narrative alive long after the underlying problems were
// fixed. A hunch nobody has re-sighted in two weeks is noise, not a case.
const LIVE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const REFUTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// A hunch nothing has corroborated is a guess, and a guess must not present
// itself as a live case for two weeks. Production carried 20 such entries —
// every one sightings:1 with last_seen == first_seen — and because thinking
// passes read the ledger as a body of evidence, that pile sustained a
// multi-day phantom-failure narrative built from a single real incident.
const UNCORROBORATED_EXPIRY_MS = 72 * 60 * 60 * 1000;
// Sightings merged inside one burst aren't independent confirmation. Only a
// re-sighting in a genuinely later pass counts.
const RESIGHT_GAP_MS = 60 * 60 * 1000;
const MAX_LIVE = 25;

// Has anything beyond the original guess backed this up? An `inconclusive`
// verdict does not count: every one in the production ledger reported that the
// investigator could not reach the data at all ("unable to access internal
// configuration files", "the available tools do not provide information"),
// which is no more informative than never having tested.
function isCorroborated(h: Hypothesis): boolean {
  if (h.evidence.some((e) => e.verdict === "supported" || e.verdict === "refuted")) return true;
  const spanMs = Date.parse(h.last_seen) - Date.parse(h.first_seen);
  return h.sightings > 1 && spanMs >= RESIGHT_GAP_MS;
}

function pruneHypotheses(list: Hypothesis[], nowMs: number): Hypothesis[] {
  const kept = list.filter((h) => {
    const lastMs = Date.parse(h.last_tested ?? h.last_seen) || 0;
    if (h.status === "refuted") return nowMs - lastMs <= REFUTED_RETENTION_MS;
    const age = nowMs - lastMs;
    if (!isCorroborated(h)) return age <= UNCORROBORATED_EXPIRY_MS;
    return age <= LIVE_EXPIRY_MS;
  });
  const live = kept.filter((h) => h.status !== "refuted");
  if (live.length <= MAX_LIVE) return kept;
  const cutoff = new Set(
    [...live]
      .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))
      .slice(MAX_LIVE)
      .map((h) => h.id)
  );
  return kept.filter((h) => !cutoff.has(h.id));
}

function tokens(text: string): Set<string> {
  // Light plural/verb-form folding ("decays" ≈ "decay") — case matching should
  // be slightly looser than proposal dedup.
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .map((w) => w.replace(/s$/, ""))
  );
}

function similar(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  if (intersection / (ta.size + tb.size - intersection) >= SIMILARITY_THRESHOLD) return true;
  const smaller = Math.min(ta.size, tb.size);
  return smaller >= CONTAINMENT_MIN_TOKENS && intersection / smaller >= CONTAINMENT_THRESHOLD;
}

export async function loadHypotheses(path: string): Promise<Hypothesis[]> {
  const list = await readJsonSafe<Hypothesis[]>(path, []);
  return Array.isArray(list) ? list : [];
}

// Record that a hunch was sighted: merge into an existing non-refuted case
// when the text is near-identical, otherwise open a new one.
export async function noteSighting(
  path: string,
  hunch: { id: string; text: string; domain: string }
): Promise<Hypothesis> {
  const list = pruneHypotheses(await loadHypotheses(path), Date.now());
  const now = new Date().toISOString();
  const existing = list.find((h) => h.status !== "refuted" && similar(h.text, hunch.text));
  if (existing) {
    const updated: Hypothesis = { ...existing, sightings: existing.sightings + 1, last_seen: now };
    await writeJsonAtomic(path, list.map((h) => (h.id === existing.id ? updated : h)));
    return updated;
  }
  const fresh: Hypothesis = {
    id: hunch.id,
    text: hunch.text,
    domain: hunch.domain,
    status: "open",
    sightings: 1,
    evidence: [],
    first_seen: now,
    last_seen: now,
  };
  await writeJsonAtomic(path, pruneHypotheses([...list, fresh], Date.now()));
  return fresh;
}

export async function recordVerdict(
  path: string,
  id: string,
  verdict: HypothesisEvidence["verdict"],
  note: string
): Promise<void> {
  const list = await loadHypotheses(path);
  const idx = list.findIndex((h) => h.id === id);
  if (idx === -1) return;
  const h = list[idx]!;
  const now = new Date().toISOString();
  const status: Hypothesis["status"] =
    verdict === "refuted" ? "refuted" : verdict === "supported" ? "supported" : h.status;
  const updated: Hypothesis = {
    ...h,
    status,
    last_tested: now,
    evidence: [...h.evidence, { at: now, verdict, note }],
  };
  await writeJsonAtomic(path, list.map((x, i) => (i === idx ? updated : x)));
}
