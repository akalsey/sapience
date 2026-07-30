import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { buildContextFromDirs, resolveContextDirs, buildGoalsContext, buildHypothesesContext, getLastThreePasses } from "./context-builder.js";
import type { PluginConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

let tmpDir: string;

const config: PluginConfig = {
  ...DEFAULT_CONFIG,
  context: { lookbackHours: 24, maxContextTokens: 8000 },
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ctx-builder-test-"));
});

afterEach(async () => { await rm(tmpDir, { recursive: true }); });

// Real OpenClaw session transcript line: role/content nested under `message`,
// content as text-block arrays. The original parser expected {role, content}
// at top level and silently matched nothing on production.
function transcriptLine(role: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id: "m1",
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }], timestamp: new Date().toISOString() },
  });
}

describe("buildContextFromDirs", () => {
  it("returns empty context when session dir does not exist", async () => {
    const bundle = await buildContextFromDirs(config, join(tmpDir, "sessions"), [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("No recent session activity");
  });

  it("extracts user/assistant messages from the real transcript schema", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"), [
      JSON.stringify({ type: "session", id: "s", version: 1 }),
      transcriptLine("user", "What is the plan?"),
      JSON.stringify({ type: "model_change", id: "mc" }),
      transcriptLine("assistant", "Ship the doctor release."),
    ].join("\n") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("What is the plan?");
    expect(bundle.recentActivity).toContain("Ship the doctor release.");
    expect(bundle.recentActivity).not.toContain("model_change");
  });

  it("still accepts legacy top-level {role, content} lines and string content", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"),
      JSON.stringify({ role: "user", content: "legacy shape" }) + "\n" +
      JSON.stringify({ type: "message", message: { role: "user", content: "plain string content" } }) + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("legacy shape");
    expect(bundle.recentActivity).toContain("plain string content");
  });

  it("ignores trajectory sidecar files even though they end in .jsonl", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.trajectory.jsonl"),
      JSON.stringify({ type: "message", data: {}, message: { role: "user", content: "trajectory noise" } }) + "\n");
    await writeFile(join(sessionDir, "abc.jsonl"), transcriptLine("user", "real message") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("real message");
    expect(bundle.recentActivity).not.toContain("trajectory noise");
  });

  it("skips malformed JSONL lines without crashing", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"), "not-json\n" + transcriptLine("user", "hello") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("hello");
  });

  it("trims content to stay within maxContextTokens", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"), transcriptLine("user", "x".repeat(100000)) + "\n");

    const smallConfig = { ...config, context: { lookbackHours: 24, maxContextTokens: 100 } };
    const bundle = await buildContextFromDirs(smallConfig, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.tokenEstimate).toBeLessThanOrEqual(150);
  });

  it("reads memory from multiple dirs (wiki vault first), newest files first", async () => {
    const sessionDir = join(tmpDir, "sessions");
    const wikiDir = join(tmpDir, "wiki");
    const legacyDir = join(tmpDir, "memory");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(wikiDir, { recursive: true });
    await mkdir(legacyDir, { recursive: true });
    const { utimes } = await import("fs/promises");
    await writeFile(join(wikiDir, "old-note.md"), "Old wiki note.\n");
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await utimes(join(wikiDir, "old-note.md"), old, old);
    await writeFile(join(wikiDir, "fresh-note.md"), "Voice minutes spiked for one customer.\n");
    await writeFile(join(legacyDir, "fact.md"), "User is a data scientist.\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [wikiDir, legacyDir]);
    expect(bundle.recentActivity).toContain("Voice minutes spiked");
    expect(bundle.recentActivity).toContain("data scientist");
    // Newest-first ordering: the fresh note appears before the 90-day-old one.
    expect(bundle.recentActivity.indexOf("Voice minutes spiked"))
      .toBeLessThan(bundle.recentActivity.indexOf("Old wiki note"));
  });

  it("excludes sessions opened by a heartbeat poll (gateway main session)", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "heartbeat-session.jsonl"), [
      JSON.stringify({ type: "session", id: "s", version: 1 }),
      transcriptLine("user", "[OpenClaw heartbeat poll]"),
      transcriptLine("assistant", "I am experiencing critical and widespread tool failures."),
    ].join("\n") + "\n");
    await writeFile(join(sessionDir, "human.jsonl"), transcriptLine("user", "how was the demo received?") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("how was the demo received?");
    expect(bundle.recentActivity).not.toContain("widespread tool failures");
  });

  it("skips heartbeat poll messages inside otherwise human sessions", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "mixed.jsonl"), [
      transcriptLine("user", "what's on my calendar today?"),
      transcriptLine("assistant", "Two meetings and a dentist appointment."),
      transcriptLine("user", "[OpenClaw heartbeat poll]"),
    ].join("\n") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("dentist appointment");
    expect(bundle.recentActivity).not.toContain("heartbeat poll");
  });

  it("collapses repeated identical messages so a stuck session cannot dominate context", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const stuck = "I am still experiencing critical tool failures and cannot perform any tasks.";
    const lines = [transcriptLine("user", "let's review the quarterly numbers together")];
    for (let i = 0; i < 20; i++) lines.push(transcriptLine("assistant", stuck));
    await writeFile(join(sessionDir, "stuck.jsonl"), lines.join("\n") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    const occurrences = bundle.recentActivity.split("critical tool failures").length - 1;
    expect(occurrences).toBe(1);
    expect(bundle.recentActivity).toContain("quarterly numbers");
  });

  it("tolerates missing memory dirs", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"), transcriptLine("user", "hi there friend") + "\n");
    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "nope"), join(tmpDir, "also-nope")]);
    expect(bundle.recentActivity).toContain("hi there friend");
  });
});

describe("resolveContextDirs", () => {
  it("uses runtime resolvers and the configured wiki vault", () => {
    const api = {
      config: { plugins: { entries: { "memory-wiki": { config: { vault: { path: "/data/wiki/main" } } } } } },
      runtime: {
        state: { resolveStateDir: () => "/state" },
        agent: { resolveAgentDir: () => "/state/agents/main" },
      },
    };
    const dirs = resolveContextDirs(api, "main");
    expect(dirs.sessionsDir).toBe("/state/agents/main/sessions");
    expect(dirs.memoryDirs[0]).toBe("/data/wiki/main");
    expect(dirs.memoryDirs).toContain("/state/agents/main/memory");
  });

  it("falls back to state-dir conventions when resolvers are absent", () => {
    const dirs = resolveContextDirs({ config: {}, runtime: { state: { resolveStateDir: () => "/state" } } }, "main");
    expect(dirs.sessionsDir).toBe("/state/agents/main/sessions");
    expect(dirs.memoryDirs).toContain("/state/wiki/main");
  });
});

describe("getLastThreePasses", () => {
  it("returns empty string when log file does not exist", async () => {
    const result = await getLastThreePasses(join(tmpDir, "nonexistent.md"));
    expect(result).toBe("");
  });

  it("returns last 3 pass sections from log", async () => {
    const logPath = join(tmpDir, "log.md");
    const content = [
      "## 2026-05-20T08:00:00Z — Pass pass-1\n\n**Summary:** One.\n\n---\n",
      "## 2026-05-20T08:15:00Z — Pass pass-2\n\n**Summary:** Two.\n\n---\n",
      "## 2026-05-20T08:30:00Z — Pass pass-3\n\n**Summary:** Three.\n\n---\n",
      "## 2026-05-20T08:45:00Z — Pass pass-4\n\n**Summary:** Four.\n\n---\n",
    ].join("\n");
    await writeFile(logPath, content);

    const result = await getLastThreePasses(logPath);
    expect(result).not.toContain("pass-1");
    expect(result).toContain("pass-2");
    expect(result).toContain("pass-3");
    expect(result).toContain("pass-4");
  });
});

describe("buildGoalsContext", () => {
  it("summarizes active and decomposing goals with approach, blockers, and latest progress", async () => {
    const goalsPath = join(tmpDir, "goals", "goals.json");
    await mkdir(join(tmpDir, "goals"), { recursive: true });
    await writeFile(goalsPath, JSON.stringify([
      {
        id: "g1", description: "Reduce churn in SMB segment", status: "active",
        active_approach: "monthly usage-drop outreach",
        progress_notes: [
          { timestamp: "2026-06-01T00:00:00Z", summary: "built the usage query", actions_taken: [], what_changed: "" },
          { timestamp: "2026-07-01T00:00:00Z", summary: "first outreach batch sent", actions_taken: [], what_changed: "" },
        ],
        blockers: [{ description: "no churn-reason field in CRM", since: "2026-06-15T00:00:00Z", waiting_on: "salesforce admin" }],
      },
      { id: "g2", description: "Ship usage dashboards", status: "decomposing", active_approach: "", progress_notes: [], blockers: [] },
      { id: "g3", description: "Old thing", status: "completed", active_approach: "", progress_notes: [], blockers: [] },
    ]));
    const text = await buildGoalsContext(goalsPath);
    expect(text).toContain("Reduce churn in SMB segment");
    expect(text).toContain("monthly usage-drop outreach");
    expect(text).toContain("first outreach batch sent");
    expect(text).toContain("salesforce admin");
    expect(text).toContain("Ship usage dashboards");
    expect(text).not.toContain("Old thing"); // completed goals are noise
  });

  it("returns empty for a missing or empty goals file", async () => {
    expect(await buildGoalsContext(join(tmpDir, "nope.json"))).toBe("");
    const goalsPath = join(tmpDir, "goals.json");
    await writeFile(goalsPath, "[]");
    expect(await buildGoalsContext(goalsPath)).toBe("");
  });
});

describe("goal-aware bundle", () => {
  it("includes goals in the context bundle when a workspace goals file exists", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(join(tmpDir, "goals"), { recursive: true });
    await writeFile(join(tmpDir, "goals", "goals.json"), JSON.stringify([
      { id: "g1", description: "Reduce churn", status: "active", active_approach: "outreach", progress_notes: [], blockers: [] },
    ]));
    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")], join(tmpDir, "goals", "goals.json"));
    expect(bundle.activeGoals).toContain("Reduce churn");
  });
});

describe("goal todos in context", () => {
  it("renders a goal's open todos so passes work the checklist", async () => {
    const path = join(tmpDir, "goals.json");
    await writeFile(path, JSON.stringify([{
      description: "learn what drives the numbers", status: "active",
      active_approach: "watch metric questions",
      todos: [
        { id: "t1", text: "baseline the weekly numbers", status: "open" },
        { id: "t2", text: "already finished", status: "done" },
      ],
      progress_notes: [], blockers: [],
    }]));
    const text = await buildGoalsContext(path);
    expect(text).toContain("baseline the weekly numbers");
    expect(text).not.toContain("already finished");
  });
});

describe("buildHypothesesContext", () => {
  it("summarizes open and supported hypotheses with their evidence trail", async () => {
    const path = join(tmpDir, "hypotheses.json");
    await writeFile(path, JSON.stringify([
      { id: "h1", text: "spend velocity decays before churn", domain: "posthog", status: "open", sightings: 3, evidence: [{ at: "2026-07-01T00:00:00Z", verdict: "inconclusive", note: "not enough data" }], first_seen: "2026-06-01T00:00:00Z", last_seen: "2026-07-01T00:00:00Z" },
      { id: "h2", text: "voice spike is one dialer customer", domain: "voice", status: "supported", sightings: 2, evidence: [{ at: "2026-07-02T00:00:00Z", verdict: "supported", note: "confirmed, customer X" }], first_seen: "2026-06-20T00:00:00Z", last_seen: "2026-07-02T00:00:00Z" },
      { id: "h3", text: "dead idea", domain: "general", status: "refuted", sightings: 1, evidence: [], first_seen: "2026-06-01T00:00:00Z", last_seen: "2026-06-01T00:00:00Z" },
    ]));
    const text = await buildHypothesesContext(path);
    expect(text).toContain("spend velocity decays");
    expect(text).toContain("seen 3x");
    expect(text).toContain("voice spike");
    expect(text).not.toContain("dead idea");
  });

  it("returns empty when the ledger is missing or empty", async () => {
    expect(await buildHypothesesContext(join(tmpDir, "nope.json"))).toBe("");
  });

  // One real Google auth failure fragmented into 8 ledger entries, and passes
  // read that pile as 8 independent corroborations — grading the resulting
  // observation "replicated" and citing the Open Hypotheses section itself as
  // the evidence. Restatements of one suspicion must render as ONE case.
  it("collapses restatements of one suspicion into a single line with a count", async () => {
    const path = join(tmpDir, "hypotheses.json");
    const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const entry = (id: string, text: string, hours: number) => ({
      id, text, domain: "general", status: "open", sightings: 1,
      evidence: [], first_seen: at(hours), last_seen: at(hours),
    });
    await writeFile(path, JSON.stringify([
      entry("g1", "The agent is requesting an unusually broad set of Google API scopes, including full access to Drive, Calendar, Gmail, Chat, Contacts, and other services, potentially indicating an over-privileged application or a very broad, undefined purpose.", 5),
      entry("g2", "The agent is requesting an unusually broad set of Google API scopes, including full read/write access to Drive, Calendar, Gmail, Sheets, Contacts, Presentations, Documents, Chat, and Google Apps Script, among others.", 4),
      entry("g3", "The agent is requesting an unusually large number and broad range of Google API scopes, suggesting it might be trying to cover many potential future tasks at once rather than a specific need.", 3),
      entry("v", "Voice minutes spiked because of a single dialer customer", 2),
    ]));
    const text = await buildHypothesesContext(path);
    const lines = text.split("\n").filter((l) => l.trim().startsWith("-"));
    // g1+g2 are lexical restatements and collapse. g3 says the same thing in
    // different words (0.36 containment against both) and does NOT — token
    // overlap catches restatement, not paraphrase, and the threshold that
    // would catch g3 would merge unrelated cases. The shorter un-corroborated
    // expiry and the prompt's evidence rules are what stop a paraphrase pile
    // from reading as corroboration; this only stops the cheapest form.
    expect(lines).toHaveLength(3);
    // The collapsed line has to say it stands for a restatement, so volume is
    // visible as redundancy rather than as corroboration.
    expect(text).toMatch(/1 more restatement of this same case/i);
    expect(text).toContain("Voice minutes spiked");
  });

  it("leaves genuinely distinct hypotheses as separate lines", async () => {
    const path = join(tmpDir, "hypotheses.json");
    await writeFile(path, JSON.stringify([
      { id: "a", text: "spend velocity decays before churn across customers", domain: "posthog", status: "open", sightings: 1, evidence: [], first_seen: "2026-07-01T00:00:00Z", last_seen: "2026-07-01T00:00:00Z" },
      { id: "b", text: "voice minutes spike is one dialer customer", domain: "voice", status: "open", sightings: 1, evidence: [], first_seen: "2026-07-02T00:00:00Z", last_seen: "2026-07-02T00:00:00Z" },
    ]));
    const lines = (await buildHypothesesContext(path)).split("\n").filter((l) => l.trim().startsWith("-"));
    expect(lines).toHaveLength(2);
  });

  it("caps the rendered list at the 10 most recently seen so a hoarded ledger cannot flood the pass", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      text: `hypothesis number ${i}`, status: "open", sightings: 1,
      last_seen: new Date(Date.now() - (30 - i) * 60_000).toISOString(),
    }));
    const path = join(tmpDir, "hyp.json");
    await writeFile(path, JSON.stringify(many));
    const text = await buildHypothesesContext(path);
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(text).toContain("hypothesis number 29");
    expect(text).not.toContain("hypothesis number 0");
  });
});

describe("buildSkillProposalsContext", () => {
  it("summarizes open proposals and drops settled ones", async () => {
    const path = join(tmpDir, "skill-proposals.json");
    await writeFile(path, JSON.stringify([
      { id: "s1", name: "weekly-usage-divergence", summary: "WoW usage attribution", status: "proposed", evidence_count: 2, created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-25T00:00:00Z" },
      { id: "s2", name: "sunday-slide-prep", summary: "prep the review deck", status: "installed", evidence_count: 1, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-02T00:00:00Z" },
    ]));
    const { buildSkillProposalsContext } = await import("./context-builder.js");
    const text = await buildSkillProposalsContext(path);
    expect(text).toContain("weekly-usage-divergence");
    expect(text).toContain("evidence ×2");
    expect(text).not.toContain("sunday-slide-prep");
  });

  it("returns empty when the ledger is missing", async () => {
    const { buildSkillProposalsContext } = await import("./context-builder.js");
    expect(await buildSkillProposalsContext(join(tmpDir, "nope.json"))).toBe("");
  });
});

describe("machine-session exclusion", () => {
  // Production incident: with little human activity in the lookback window,
  // thinking-pass context was dominated by the suite's own cron session
  // transcripts — so passes diagnosed their own 15-minute cadence as a P5
  // defect and escalated it for four consecutive passes. The suite observing
  // itself is noise, never signal.
  it("excludes sessions whose first user message is a suite cron prompt", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "cron.jsonl"), [
      transcriptLine("user", "You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions."),
      transcriptLine("assistant", "The sapience-thinking cron fires every 15 minutes, which seems critically misconfigured."),
    ].join("\n") + "\n");
    await writeFile(join(sessionDir, "human.jsonl"),
      transcriptLine("user", "can you pull the churn report for me") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("churn report");
    expect(bundle.recentActivity).not.toContain("critically misconfigured");
  });

  it("excludes routing, goals, investigation, act, and watch sessions", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const machineOpeners = [
      "You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals.",
      "You are the goals tracking agent. Call check_goals() to process new goals.",
      "You are running a bounded, READ-ONLY investigation of a hypothesis a thinking pass produced.",
      "You are executing a pre-approved autonomous action (the user's calibration profile authorizes this domain at the act tier).",
      "You are performing a READ-ONLY metric check. Do not modify anything.",
    ];
    for (const [i, opener] of machineOpeners.entries()) {
      await writeFile(join(sessionDir, `m${i}.jsonl`),
        transcriptLine("user", opener) + "\n" + transcriptLine("assistant", `machine chatter ${i}`) + "\n");
    }
    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("No recent session activity");
  });

  it("keeps a human session that RECEIVED an injected sapience tier prompt", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "main.jsonl"), [
      transcriptLine("user", "morning, what's on deck today"),
      transcriptLine("user", "[SAPIENCE: PROPOSE] A thinking pass identified this as worth doing."),
      transcriptLine("assistant", "A proposal came in about the salesforce duplicates."),
    ].join("\n") + "\n");
    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("salesforce duplicates");
  });
});
