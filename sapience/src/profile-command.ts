import { loadProfile, saveProfile, decayProfile } from "./calibration.js";
import { loadWatches, renderWatches } from "./watches.js";
import type { CalibrationEntry, CalibrationProfile, Tier } from "./types.js";

// The /sapience chat command: the calibration profile was invisible outside
// raw JSON, so the user couldn't see (or one-line-adjust) what the agent will
// do without asking. Shows the DECAYED view — the confidence routing actually
// uses — with the stored tier as the label.

const TIER_LABELS: Array<{ tier: Tier; label: string }> = [
  { tier: "act", label: "Act without asking" },
  { tier: "propose", label: "Propose first" },
  { tier: "ask", label: "Ask before touching" },
  { tier: "explore", label: "Explore options only" },
];

const VALID_TIERS = new Set(["act", "propose", "ask", "explore"]);

export function renderProfile(profile: CalibrationProfile, now: Date): string {
  if (profile.length === 0) {
    return "No calibration entries yet — the profile builds as proposals get delivered and you react to them.";
  }
  const decayed = decayProfile(profile, now);
  const lines: string[] = ["Autonomy profile (confidence decays without reinforcement):"];
  for (const { tier, label } of TIER_LABELS) {
    const entries = decayed.filter((e) => e.tier === tier);
    if (entries.length === 0) continue;
    lines.push(`\n${label}:`);
    for (const e of entries) {
      lines.push(`  - ${e.domain} / ${e.action_class} — ${(e.confidence * 100).toFixed(0)}% (+${e.confirmed_count}/-${e.corrected_count})`);
    }
  }
  lines.push('\nAdjust with: /sapience set <domain> <action_class> <act|propose|ask|explore>');
  return lines.join("\n");
}

export async function handleProfileCommand(args: string, calibrationPath: string, watchesPath?: string): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);

  if (parts[0] === "watches") {
    return renderWatches(watchesPath ? await loadWatches(watchesPath) : []);
  }

  const profile = await loadProfile(calibrationPath);

  if (parts[0] !== "set") return renderProfile(profile, new Date());

  const [, domain, actionClass, tier] = parts;
  if (!domain || !actionClass || !tier) {
    return "Usage: /sapience set <domain> <action_class> <act|propose|ask|explore>";
  }
  if (!VALID_TIERS.has(tier)) {
    return `Invalid tier "${tier}". Valid tiers: act, propose, ask, explore.`;
  }
  const idx = profile.findIndex((e) => e.domain === domain && e.action_class === actionClass);
  if (idx === -1) {
    return `No calibration entry for ${domain} / ${actionClass}. Existing entries:\n${renderProfile(profile, new Date())}`;
  }
  const updated = profile.map((e, i) => (i === idx
    ? { ...e, tier: tier as CalibrationEntry["tier"], last_calibrated: new Date().toISOString(), notes: `${e.notes ? e.notes + "; " : ""}manual override` }
    : e));
  await saveProfile(updated, calibrationPath);
  return `Set ${domain} / ${actionClass} to "${tier}".`;
}
