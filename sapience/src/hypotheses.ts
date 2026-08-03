import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import { tokens, isNearDuplicate } from "./text-match.js";

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
  const existing = list.find((h) => h.status !== "refuted" && isNearDuplicate(h.text, hunch.text));
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

// A verdict settles a case, except `inconclusive`, which leaves it where it
// was — an investigation that reached no answer has not changed anything.
function nextStatus(current: Hypothesis["status"], verdict: HypothesisEvidence["verdict"]): Hypothesis["status"] {
  if (verdict === "refuted") return "refuted";
  if (verdict === "supported") return "supported";
  return current;
}

// Does every meaningful word of `query` appear in `text`? Deliberately NOT
// isNearDuplicate(): that metric compares two full hypothesis statements, and
// a real correction is short ("google auth", "the scopes thing"). Two tokens
// sit below the containment floor and score near zero on Jaccard, so it
// would reject exactly the phrasing a human actually uses.
function matchesQuery(query: string, text: string): boolean {
  const q = [...tokens(query)];
  if (q.length === 0) return false;
  const t = tokens(text);
  return q.every((w) => t.has(w));
}

// Settle every case matching a free-text description, and return what was
// closed. This is the correction path: without it recordVerdict was reachable
// only by the internal investigation subagent, so a user telling the agent
// "you should have no active issues with google auth" had nowhere to land —
// the agent said it had noted the resolution and the ledger kept all eight
// fragments open, feeding them back into passes for four more days.
//
// Every fragment of a cluster is closed, not just the best match: one
// correction has to clear the whole pile, or the user is made to repeat
// themselves once per restatement.
export async function resolveByText(
  path: string,
  query: string,
  verdict: HypothesisEvidence["verdict"],
  note: string
): Promise<Hypothesis[]> {
  const list = await loadHypotheses(path);
  const hits = list.filter((h) => h.status !== "refuted" && matchesQuery(query, h.text));
  if (hits.length === 0) return [];
  const now = new Date().toISOString();
  const ids = new Set(hits.map((h) => h.id));
  const updated = list.map((h) =>
    ids.has(h.id)
      ? {
          ...h,
          status: nextStatus(h.status, verdict),
          last_tested: now,
          evidence: [...h.evidence, { at: now, verdict, note }],
        }
      : h
  );
  await writeJsonAtomic(path, updated);
  return updated.filter((h) => ids.has(h.id));
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
  const updated: Hypothesis = {
    ...h,
    status: nextStatus(h.status, verdict),
    last_tested: now,
    evidence: [...h.evidence, { at: now, verdict, note }],
  };
  await writeJsonAtomic(path, list.map((x, i) => (i === idx ? updated : x)));
}
