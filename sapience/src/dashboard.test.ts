import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { tmpdir } from "os";
import {
  parseEvents, sparkline, confidenceTrend, buildDashboard,
  rotateIfNeeded, generateDashboard,
} from "./dashboard.js";
import type { SapienceEvent } from "./events.js";
import type { SapienceConfig, CalibrationProfile } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

const NOW = new Date("2026-06-09T18:00:00.000Z");

function ev(partial: Partial<SapienceEvent> & { type: string }, hoursAgo = 1): SapienceEvent {
  return {
    ts: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
    plugin: "sapience",
    ...partial,
  } as SapienceEvent;
}

const PROFILE: CalibrationProfile = [
  { domain: "github", action_class: "action", tier: "act", confidence: 0.85, confirmed_count: 12, corrected_count: 1, last_calibrated: "2026-06-08T00:00:00Z", notes: "" },
];

describe("parseEvents", () => {
  it("parses valid lines and counts malformed ones", () => {
    const raw = [
      JSON.stringify({ ts: "2026-06-09T10:00:00Z", plugin: "sapience", type: "routing_completed" }),
      "not json at all",
      JSON.stringify({ missing: "fields" }),
      "",
    ].join("\n");
    const { events, malformed } = parseEvents(raw);
    expect(events).toHaveLength(1);
    expect(malformed).toBe(2);
  });
});

describe("sparkline", () => {
  it("maps 0..1 to glyphs", () => {
    expect(sparkline([0, 0.5, 1])).toBe("▁▅█");
  });
  it("returns empty string for no values", () => {
    expect(sparkline([])).toBe("");
  });
});

describe("confidenceTrend", () => {
  it("reports no history when there are no calibration_change events", () => {
    expect(confidenceTrend([], "github", "action", 0.85, NOW)).toBe("(no history yet)");
  });

  it("renders sparkline, arrow, and delta from change history", () => {
    const events = [
      ev({ type: "calibration_change", domain: "github", action_class: "action", old_confidence: 0.2, new_confidence: 0.3 }, 48),
      ev({ type: "calibration_change", domain: "github", action_class: "action", old_confidence: 0.3, new_confidence: 0.5 }, 24),
    ];
    const out = confidenceTrend(events, "github", "action", 0.5, NOW);
    expect(out).toContain("↑");
    expect(out).toContain("+0.30");
  });

  it("ignores other domains", () => {
    const events = [
      ev({ type: "calibration_change", domain: "slack", action_class: "action", old_confidence: 0.2, new_confidence: 0.3 }, 24),
    ];
    expect(confidenceTrend(events, "github", "action", 0.85, NOW)).toBe("(no history yet)");
  });
});

describe("buildDashboard", () => {
  const base = {
    malformed: 0,
    profile: PROFILE,
    goals: [{ status: "active" }, { status: "decomposing" }],
    activeHours: DEFAULT_CONFIG.activeHours,
    now: NOW,
  };

  it("renders the autonomy table from the calibration profile", () => {
    const md = buildDashboard({ ...base, events: [] });
    expect(md).toContain("## Autonomy progression");
    expect(md).toContain("| github / action | act | 0.85 |");
    expect(md).toContain("| 12 | 1 |");
  });

  it("lists tier changes and autonomous action counts", () => {
    const events = [
      ev({ type: "calibration_change", domain: "github", action_class: "action", old_tier: "propose", new_tier: "act", old_confidence: 0.5, new_confidence: 0.6 }, 24),
      ev({ type: "action_logged", domain: "github", action_class: "action", confidence: 0.85 }, 2),
    ];
    const md = buildDashboard({ ...base, events });
    expect(md).toContain("github/action propose→act");
    expect(md).toContain("**Autonomous actions:** 1 in last 7d · 1 in last 30d");
  });

  it("renders heartbeat counts and goal totals", () => {
    const events = [
      ev({ type: "pass_completed", plugin: "thinking", pass_id: "p1", observations: 2, actions: 1, audits: 0, questions: 0, nothing_to_report: false }, 1),
      ev({ type: "pass_skipped", plugin: "thinking", reason: "outside_hours" }, 2),
      ev({ type: "routing_completed", passes: 1, items: 3, by_tier: { propose: 3 } }, 1),
      ev({ type: "check_skipped", plugin: "goals", reason: "nothing_due" }, 1),
    ];
    const md = buildDashboard({ ...base, events });
    expect(md).toContain("## Heartbeat");
    expect(md).toContain("1 outside_hours");
    expect(md).toContain("**Goals:** 1 active · 1 decomposing · 2 total");
  });

  it("shows recent activity excluding skip events, newest first", () => {
    const events = [
      ev({ type: "routing_skipped", reason: "no_new_passes" }, 1),
      ev({ type: "signal_detected", plugin: "feedback", signal_type: "correction", domain: "github", action_class: "action", source: "llm" }, 3),
    ];
    const md = buildDashboard({ ...base, events });
    const recent = md.split("## Recent activity")[1]!;
    expect(recent).toContain("correction captured (github, llm)");
    expect(recent).not.toContain("no_new_passes"); // skips are aggregated in Heartbeat, not listed here
  });

  it("renders placeholders when there is no data", () => {
    const md = buildDashboard({ ...base, profile: [], goals: [], events: [] });
    expect(md).toContain("No calibration entries yet.");
    expect(md).toContain("No event data yet.");
  });

  it("footnotes malformed lines", () => {
    const md = buildDashboard({ ...base, events: [], malformed: 3 });
    expect(md).toContain("3 malformed event line(s) skipped");
  });
});

describe("rotateIfNeeded", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "rotate-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("renames the file when it exceeds maxBytes", async () => {
    const path = join(dir, "events.jsonl");
    await writeFile(path, "x".repeat(100), "utf-8");
    await rotateIfNeeded(path, NOW, 50);
    const archived = await readFile(join(dir, "events-archive-2026-06-09.jsonl"), "utf-8");
    expect(archived).toHaveLength(100);
    await expect(readFile(path, "utf-8")).rejects.toThrow();
  });

  it("leaves a small file alone and tolerates a missing file", async () => {
    const path = join(dir, "events.jsonl");
    await writeFile(path, "small", "utf-8");
    await rotateIfNeeded(path, NOW, 50);
    expect(await readFile(path, "utf-8")).toBe("small");
    await expect(rotateIfNeeded(join(dir, "missing.jsonl"), NOW, 50)).resolves.toBeUndefined();
  });
});

describe("generateDashboard", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "dash-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function makeConfig(): SapienceConfig {
    return {
      ...DEFAULT_CONFIG,
      output: {
        calibrationPath: join(dir, "calibration.json"),
        actionLogPath: join(dir, "action-log.md"),
        processedPassesPath: join(dir, "processed.json"),
        eventsPath: join(dir, "events.jsonl"),
        dashboardPath: join(dir, "dashboard.md"),
        goalsPath: join(dir, "goals.json"),
      },
    };
  }

  it("writes a dashboard from real files", async () => {
    const config = makeConfig();
    await writeFile(config.output.calibrationPath, JSON.stringify(PROFILE), "utf-8");
    await writeFile(config.output.goalsPath, JSON.stringify([{ status: "active" }]), "utf-8");
    await writeFile(config.output.eventsPath,
      JSON.stringify({ ts: new Date().toISOString(), plugin: "sapience", type: "routing_completed", passes: 1, items: 2, by_tier: {} }) + "\n",
      "utf-8");
    await generateDashboard(config);
    const md = await readFile(config.output.dashboardPath, "utf-8");
    expect(md).toContain("# Sapience Dashboard");
    expect(md).toContain("github / action");
    await expect(readFile(config.output.dashboardPath + ".tmp", "utf-8")).rejects.toThrow();
  });

  it("degrades gracefully with no input files at all", async () => {
    const config = makeConfig();
    await generateDashboard(config);
    const md = await readFile(config.output.dashboardPath, "utf-8");
    expect(md).toContain("No event data yet.");
  });
});
