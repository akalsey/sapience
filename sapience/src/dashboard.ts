import { readFile, writeFile, mkdir, stat, rename } from "fs/promises";
import { dirname, join } from "path";
import { resolvePath } from "./utils.js";
import { loadProfile } from "./calibration.js";
import type { CalibrationProfile, SapienceConfig } from "./types.js";
import type { SapienceEvent } from "./events.js";

const SPARK = "▁▂▃▄▅▆▇█";

function safe(s: unknown): string {
  return String(s).replace(/\|/g, "\\|");
}
const MAX_EVENTS_BYTES = 5 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const SKIP_TYPES = new Set(["pass_skipped", "routing_skipped", "check_skipped"]);

export interface ParsedEvents { events: SapienceEvent[]; malformed: number; }

export function parseEvents(raw: string): ParsedEvents {
  const events: SapienceEvent[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as SapienceEvent;
      if (typeof ev.ts === "string" && typeof ev.type === "string") events.push(ev);
      else malformed++;
    } catch { malformed++; }
  }
  return { events, malformed };
}

export function sparkline(values: number[]): string {
  return values
    .map(v => SPARK[Math.min(7, Math.max(0, Math.round(v * 7)))])
    .join("");
}

export function confidenceTrend(
  events: SapienceEvent[],
  domain: string,
  actionClass: string,
  currentConfidence: number,
  now: Date
): string {
  const cutoff = now.getTime() - 7 * DAY_MS;
  const changes = events
    .filter(e => e.type === "calibration_change" && e.domain === domain && e.action_class === actionClass)
    .filter(e => new Date(e.ts).getTime() >= cutoff)
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (changes.length === 0) return "(no history yet)";

  const series = changes
    .map(e => Number(e.new_confidence))
    .filter(n => !Number.isNaN(n));
  if (series.length === 0) return "(no history yet)";
  const baselineRaw = changes[0]!.old_confidence;
  const baseline = typeof baselineRaw === "number" ? baselineRaw : (series[0] ?? currentConfidence);
  const delta = currentConfidence - baseline;
  const arrow = delta > 0.001 ? "↑" : delta < -0.001 ? "↓" : "→";
  const sign = delta >= 0 ? "+" : "";
  return `${sparkline(series.slice(-10))} ${arrow} ${sign}${delta.toFixed(2)}`;
}

function within(e: SapienceEvent, now: Date, ms: number): boolean {
  const t = new Date(e.ts).getTime();
  return !Number.isNaN(t) && now.getTime() - t <= ms && t <= now.getTime() + 60_000;
}

function fmtTime(ts: string): string {
  return ts.slice(0, 16).replace("T", " ");
}

function expectedRuns(activeHours: { start: string; end: string }): number {
  const [sh, sm] = activeHours.start.split(":").map(Number);
  const [eh, em] = activeHours.end.split(":").map(Number);
  const minutes = ((eh ?? 0) * 60 + (em ?? 0)) - ((sh ?? 0) * 60 + (sm ?? 0));
  if (Number.isNaN(minutes)) return 0;
  return Math.max(0, Math.floor(minutes / 15) + 1);
}

function skipSummary(skips: SapienceEvent[]): string {
  const byReason = new Map<string, number>();
  for (const e of skips) {
    const r = String(e.reason ?? "unknown");
    byReason.set(r, (byReason.get(r) ?? 0) + 1);
  }
  if (byReason.size === 0) return "0";
  return [...byReason.entries()].map(([r, n]) => `${n} ${r}`).join(", ");
}

function lastActivity(events: SapienceEvent[]): string {
  if (events.length === 0) return "—";
  return fmtTime(events.map(e => e.ts).sort().at(-1)!);
}

function describeEvent(e: SapienceEvent): string {
  switch (e.type) {
    case "pass_completed":
      return e.nothing_to_report
        ? `thinking pass ${safe(e.pass_id)}: nothing to report`
        : `thinking pass ${safe(e.pass_id)}: ${e.observations} obs, ${e.actions} actions, ${e.audits} audits, ${e.questions} questions`;
    case "routing_completed":
      return `routed ${e.items} item(s) from ${e.passes} pass(es)`;
    case "calibration_change":
      return `calibration ${safe(e.domain)}/${safe(e.action_class)}: ${e.old_tier ?? "new"}→${e.new_tier} conf ${e.new_confidence}`;
    case "action_logged":
      return `autonomous action (${safe(e.domain)}/${safe(e.action_class)})`;
    case "digest_delivered":
      return "weekly digest delivered";
    case "signal_detected":
      return `${safe(e.signal_type)} captured (${safe(e.domain)}, ${safe(e.source)})`;
    case "signal_orphaned":
      return `${safe(e.signal_type)} matched no calibration entry (${safe(e.domain)})`;
    case "goal_created":
      return `goal created (${safe(e.goal_id)})`;
    case "status_delivered":
      return `goal status delivered (${safe(e.goal_id)})`;
    default:
      return String(e.type);
  }
}

export interface DashboardInput {
  events: SapienceEvent[];
  malformed: number;
  profile: CalibrationProfile;
  goals: Array<{ status?: string }>;
  activeHours: { start: string; end: string; timezone: string };
  now: Date;
}

export function buildDashboard(input: DashboardInput): string {
  const { events, malformed, profile, goals, activeHours, now } = input;
  const d30 = events.filter(e => within(e, now, 30 * DAY_MS));
  const d7 = d30.filter(e => within(e, now, 7 * DAY_MS));
  const d24 = d30.filter(e => within(e, now, DAY_MS));

  const lines: string[] = [];
  lines.push("# Sapience Dashboard", "");
  lines.push(`Generated: ${fmtTime(now.toISOString())} UTC · Period: last 30 days`, "");

  lines.push("## Autonomy progression", "");
  if (profile.length === 0) {
    lines.push("No calibration entries yet.", "");
  } else {
    lines.push("| Domain / class | Tier | Confidence | 7d trend | Confirmed | Corrected |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const e of [...profile].sort((a, b) => b.confidence - a.confidence)) {
      lines.push(
        `| ${safe(e.domain)} / ${safe(e.action_class)} | ${e.tier} | ${e.confidence.toFixed(2)} | ` +
        `${confidenceTrend(d7, e.domain, e.action_class, e.confidence, now)} | ` +
        `${e.confirmed_count} | ${e.corrected_count} |`
      );
    }
    lines.push("");
  }

  const tierChanges = d30.filter(
    e => e.type === "calibration_change" && e.old_tier && e.new_tier && e.old_tier !== e.new_tier
  );
  lines.push(
    `**Tier changes (30d):** ${tierChanges.length === 0 ? "none" : tierChanges
      .map(e => `${e.domain}/${e.action_class} ${e.old_tier}→${e.new_tier} (${String(e.ts).slice(0, 10)})`)
      .join(" · ")}`
  );
  const acted7 = d7.filter(e => e.type === "action_logged").length;
  const acted30 = d30.filter(e => e.type === "action_logged").length;
  lines.push(`**Autonomous actions:** ${acted7} in last 7d · ${acted30} in last 30d`, "");

  lines.push("## Heartbeat", "");
  const exp = expectedRuns(activeHours);
  const of = (plugin: string, types: string[]) =>
    d24.filter(e => e.plugin === plugin && types.includes(String(e.type)));
  lines.push("| Plugin | Runs (24h) | Expected | Skips (24h) | Last activity |");
  lines.push("| --- | --- | --- | --- | --- |");
  lines.push(`| thinking | ${of("thinking", ["pass_completed"]).length} | ~${exp} | ${skipSummary(of("thinking", ["pass_skipped"]))} | ${lastActivity(events.filter(e => e.plugin === "thinking"))} |`);
  lines.push(`| sapience | ${of("sapience", ["routing_completed", "routing_skipped"]).length} | ~${exp} | ${skipSummary(of("sapience", ["routing_skipped"]))} | ${lastActivity(events.filter(e => e.plugin === "sapience"))} |`);
  lines.push(`| feedback | ${of("feedback", ["signal_detected", "signal_orphaned"]).length} signals | — | — | ${lastActivity(events.filter(e => e.plugin === "feedback"))} |`);
  lines.push(`| goals | ${of("goals", ["goal_created", "status_delivered", "check_skipped"]).length} | ~${exp} | ${skipSummary(of("goals", ["check_skipped"]))} | ${lastActivity(events.filter(e => e.plugin === "goals"))} |`);
  const active = goals.filter(g => g.status === "active").length;
  const decomposing = goals.filter(g => g.status === "decomposing").length;
  lines.push("", `**Goals:** ${active} active · ${decomposing} decomposing · ${goals.length} total`, "");

  lines.push("## Recent activity", "");
  const notable = d30
    .filter(e => !SKIP_TYPES.has(String(e.type)))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, 15);
  if (notable.length === 0) lines.push("No event data yet.");
  for (const e of notable) lines.push(`- ${fmtTime(e.ts)} ${describeEvent(e)}`);
  lines.push("");

  if (malformed > 0) lines.push(`_${malformed} malformed event line(s) skipped._`, "");
  return lines.join("\n");
}

// Known benign race: a concurrent appendEvent between stat and rename can lose
// at most one event line. This is acceptable for observability data.
export async function rotateIfNeeded(
  eventsPath: string,
  now: Date,
  maxBytes: number = MAX_EVENTS_BYTES
): Promise<void> {
  try {
    const s = await stat(eventsPath);
    if (s.size > maxBytes) {
      const stamp = now.toISOString().slice(0, 19).replace(/[T:]/g, "-");
      await rename(eventsPath, join(dirname(eventsPath), `events-archive-${stamp}.jsonl`));
    }
  } catch {
    // missing file: nothing to rotate
  }
}

export async function generateDashboard(config: SapienceConfig, now: Date = new Date()): Promise<void> {
  const eventsPath = resolvePath(config.output.eventsPath);
  await rotateIfNeeded(eventsPath, now);

  let raw = "";
  try { raw = await readFile(eventsPath, "utf-8"); } catch { /* no events yet */ }
  const { events, malformed } = parseEvents(raw);

  const profile = await loadProfile(config.output.calibrationPath);

  let goals: Array<{ status?: string }> = [];
  try {
    goals = JSON.parse(await readFile(resolvePath(config.output.goalsPath), "utf-8"));
  } catch { /* no goals file */ }

  const md = buildDashboard({ events, malformed, profile, goals, activeHours: config.activeHours, now });

  const out = resolvePath(config.output.dashboardPath);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out + ".tmp", md, "utf-8");
  await rename(out + ".tmp", out);
}
