// "This is the same finding again", for the hypothesis ledger and the
// pending-delivery queue.
//
// sapience-thinking's `dedup.ts` carries the same thresholds for proposal
// dedup — separate npm packages can't share a module. They are NOT
// interchangeable: the tokenizer here also folds trailing "s", deliberately,
// and that one takes an overridable threshold. Changing one does not change
// the other.
//
// Jaccard alone under-matches a restatement that adds detail: the extra tokens
// land in the union and sink the score. Two production hypotheses describing
// the same over-broad-scopes finding scored 0.528 and opened as separate cases.
// Containment (shared / smaller side) catches "B restates A with more detail",
// but on its own it merges anything short into anything long — a six-token
// hunch shares half its tokens with unrelated prose — so it needs a floor.

const SIMILARITY_THRESHOLD = 0.6;
const CONTAINMENT_THRESHOLD = 0.65;
const CONTAINMENT_MIN_TOKENS = 8;

export function tokens(text: string): Set<string> {
  // Light plural/verb-form folding ("decays" ≈ "decay") — case matching should
  // be slightly looser than proposal dedup.
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .map((w) => w.replace(/s$/, ""))
  );
}

export function isNearDuplicate(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  if (intersection / (ta.size + tb.size - intersection) >= SIMILARITY_THRESHOLD) return true;
  const smaller = Math.min(ta.size, tb.size);
  return smaller >= CONTAINMENT_MIN_TOKENS && intersection / smaller >= CONTAINMENT_THRESHOLD;
}
