import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { TurnWatcher, parseNoticedObservations, buildNoticerPrompt, recordNoticedObservations, isNoticeableSession } from "./noticer.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "noticer-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const msg = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });

describe("TurnWatcher", () => {
  it("emits a completed turn when the assistant replies after substantial work", () => {
    const turns: string[] = [];
    const watcher = new TurnWatcher({ minTurnChars: 50, cooldownMs: 0, onTurn: (_key, text) => { turns.push(text); } });
    watcher.observe({ sessionKey: "agent:main:telegram:direct:123", message: msg("user", "pull the salesforce report and summarize it for me please") });
    watcher.observe({ sessionKey: "agent:main:telegram:direct:123", message: msg("assistant", "Here is the report: 42 accounts, 3 of which look like duplicates of Apple Inc.") });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("salesforce report");
    expect(turns[0]).toContain("duplicates of Apple");
  });

  it("ignores tiny turns and honors the cooldown", () => {
    const turns: string[] = [];
    const watcher = new TurnWatcher({ minTurnChars: 500, cooldownMs: 60_000, onTurn: (_key, text) => { turns.push(text); } });
    watcher.observe({ sessionKey: "k", message: msg("user", "hi") });
    watcher.observe({ sessionKey: "k", message: msg("assistant", "hello!") });
    expect(turns).toHaveLength(0);
  });

  it("never watches sapience's own sessions (no recursion)", () => {
    const turns: string[] = [];
    const watcher = new TurnWatcher({ minTurnChars: 10, cooldownMs: 0, onTurn: (_key, text) => { turns.push(text); } });
    watcher.observe({ sessionKey: "sapience-investigation-x", message: msg("user", "test the hypothesis about churn and spend velocity") });
    watcher.observe({ sessionKey: "sapience-investigation-x", message: msg("assistant", "tested it thoroughly with three queries") });
    expect(turns).toHaveLength(0);
  });

  it("never watches machine sessions (cron, subagent, main, custom labels like dreaming)", () => {
    const turns: string[] = [];
    const watcher = new TurnWatcher({ minTurnChars: 10, cooldownMs: 0, onTurn: (_key, text) => { turns.push(text); } });
    const machineKeys = [
      "agent:main:main",
      "agent:main:current",
      "agent:main:cron:87af3c9d-a097-45b2-8f1b-7c8b8a23dcb5",
      "agent:main:subagent:dc03e530-05b6-4949-9e90-43c824b69cfd",
      "agent:main:dreaming-narrative-rem-31d09f63cdf6",
    ];
    for (const key of machineKeys) {
      watcher.observe({ sessionKey: key, message: msg("user", "review the memory files and summarize what happened this week") });
      watcher.observe({ sessionKey: key, message: msg("assistant", "Today high 91°F. Tomorrow high 94°F. Heartbeat checks complete.") });
    }
    expect(turns).toHaveLength(0);
  });
});

describe("isNoticeableSession", () => {
  it("accepts sessions bound to a user-facing channel", () => {
    expect(isNoticeableSession("agent:main:telegram:direct:8728003761")).toBe(true);
    expect(isNoticeableSession("agent:main:slack:channel:C012345")).toBe(true);
  });

  it("rejects machine and non-channel sessions", () => {
    expect(isNoticeableSession("agent:main:main")).toBe(false);
    expect(isNoticeableSession("agent:main:current")).toBe(false);
    expect(isNoticeableSession("agent:main:cron:87af3c9d")).toBe(false);
    expect(isNoticeableSession("agent:main:subagent:dc03e530")).toBe(false);
    expect(isNoticeableSession("agent:main:dreaming-narrative-rem-31d09f63cdf6")).toBe(false);
    expect(isNoticeableSession("sapience-investigation-x")).toBe(false);
    expect(isNoticeableSession("global")).toBe(false);
    expect(isNoticeableSession("")).toBe(false);
  });
});

describe("parseNoticedObservations", () => {
  it("parses an observations array from the side-pass output", () => {
    const obs = parseNoticedObservations('noted.\n[{"text":"three duplicate Apple accounts in Salesforce","evidence":"seen while pulling the account report","priority":3}]');
    expect(obs).toHaveLength(1);
    expect(obs[0]!.text).toContain("duplicate Apple");
    expect(obs[0]!.priority).toBe(3);
  });

  it("returns empty for garbage, empty arrays, or invalid entries", () => {
    expect(parseNoticedObservations("nothing to report")).toEqual([]);
    expect(parseNoticedObservations("[]")).toEqual([]);
    expect(parseNoticedObservations('[{"no_text":true}]')).toEqual([]);
  });

  it("caps priority into range and truncates runaway text", () => {
    const obs = parseNoticedObservations(`[{"text":"${"x".repeat(2000)}","evidence":"e","priority":9}]`);
    expect(obs[0]!.priority).toBe(5);
    expect(obs[0]!.text.length).toBeLessThanOrEqual(500);
  });
});

describe("buildNoticerPrompt", () => {
  it("asks for incidental anomalies, not the task's own subject", () => {
    const prompt = buildNoticerPrompt("[user]: pull the report\n[assistant]: done");
    expect(prompt.toLowerCase()).toContain("incidental");
    expect(prompt.toLowerCase()).toContain("not the subject");
    expect(prompt).toContain("pull the report");
  });
});

describe("recordNoticedObservations", () => {
  it("appends a noticing pass to proposals.jsonl with provenance", async () => {
    const proposalsPath = join(dir, "proposals.jsonl");
    const trackerPath = join(dir, "outcomes.json");
    await recordNoticedObservations(
      [{ text: "three duplicate Apple accounts", evidence: "while pulling the account report", priority: 3 }],
      { proposalsPath, trackerPath, sessionKey: "agent:main:main" }
    );
    const line = JSON.parse((await readFile(proposalsPath, "utf-8")).trim());
    expect(line.pass_id).toContain("notice-");
    expect(line.observations).toHaveLength(1);
    expect(line.observations[0].evidence_grade).toBe("hunch");
    expect(line.summary).toContain("agent:main:main");
    const outcomes = JSON.parse(await readFile(trackerPath, "utf-8"));
    expect(Object.keys(outcomes)).toHaveLength(1);
  });
});
