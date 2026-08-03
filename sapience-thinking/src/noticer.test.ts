import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { TurnWatcher, parseNoticedObservations, buildNoticerPrompt, recordNoticedObservations, isNoticeableSession, installTurnWatcher, resetInstalledTurnWatcher } from "./noticer.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "noticer-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const msg = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });

// A key `isNoticeableSession` actually accepts — four segments, user-facing channel.
const CHANNEL = "agent:main:telegram:direct:123";

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

  // Session key must be a real channel key: `isNoticeableSession` rejects
  // anything under four segments, so a placeholder like "k" would make this
  // pass without ever reaching the length gate it claims to test.
  it("ignores tiny turns", () => {
    const turns: string[] = [];
    const watcher = new TurnWatcher({ minTurnChars: 500, cooldownMs: 60_000, onTurn: (_key, text) => { turns.push(text); } });
    watcher.observe({ sessionKey: CHANNEL, message: msg("user", "hi") });
    watcher.observe({ sessionKey: CHANNEL, message: msg("assistant", "hello!") });
    expect(turns).toHaveLength(0);
  });

  // The former version of this test fed a 12-char turn to minTurnChars:500, so
  // it returned at the length gate and never reached the cooldown at all. The
  // cooldown is the guard that should make a burst of assistant messages
  // produce ONE side-pass; production saw four in 604ms, so it needs a test
  // that actually exercises it.
  it("honors the cooldown across successive substantial turns", () => {
    const turns: string[] = [];
    const watcher = new TurnWatcher({ minTurnChars: 20, cooldownMs: 60_000, onTurn: (_key, text) => { turns.push(text); } });
    const long = "a genuinely substantial assistant reply about the salesforce export";
    for (let i = 0; i < 4; i++) {
      watcher.observe({ sessionKey: CHANNEL, message: msg("user", `question number ${i} with enough text to matter`) });
      watcher.observe({ sessionKey: CHANNEL, message: msg("assistant", `${long} #${i}`) });
    }
    expect(turns).toHaveLength(1);
  });

  // Diagnostic: the `noticed` event reports which watcher produced it, which is
  // how the leak below was confirmed in production.
  it("tags each instance with a distinct id", () => {
    const a = new TurnWatcher({ minTurnChars: 10, cooldownMs: 0, onTurn: () => {} });
    const b = new TurnWatcher({ minTurnChars: 10, cooldownMs: 0, onTurn: () => {} });
    expect(a.instanceId).toBeTruthy();
    expect(a.instanceId).not.toBe(b.instanceId);
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

describe("installTurnWatcher", () => {
  beforeEach(() => { resetInstalledTurnWatcher(); });
  afterEach(() => { resetInstalledTurnWatcher(); });

  // Confirmed in production 2026-08-03: four `noticed` events for one turn
  // carrying four distinct watcher ids and a SINGLE pid (190). register() runs
  // more than once per gateway process and every run subscribed another
  // watcher, so one turn produced one side-pass per accumulated listener —
  // each wording the same remark differently, which is what defeated text
  // dedup downstream.
  it("subscribes once per process no matter how often register runs", () => {
    const listeners: Array<(u: unknown) => void> = [];
    const subscribe = (cb: (u: unknown) => void) => { listeners.push(cb); };
    const turns: string[] = [];
    const opts = { minTurnChars: 20, cooldownMs: 0, onTurn: (_k: string, t: string) => { turns.push(t); } };

    for (let i = 0; i < 4; i++) installTurnWatcher(subscribe, opts);
    expect(listeners).toHaveLength(1);

    listeners[0]!({ sessionKey: CHANNEL, message: msg("user", "a question with plenty of text in it") });
    listeners[0]!({ sessionKey: CHANNEL, message: msg("assistant", "a substantial reply about the export") });
    expect(turns).toHaveLength(1);
  });

  it("returns the same watcher instance on re-registration", () => {
    const subscribe = () => {};
    const opts = { minTurnChars: 10, cooldownMs: 0, onTurn: () => {} };
    expect(installTurnWatcher(subscribe, opts).instanceId)
      .toBe(installTurnWatcher(subscribe, opts).instanceId);
  });

  // Later registrations carry fresher config, so the live watcher must adopt
  // them — otherwise a config change silently keeps running the old settings.
  it("adopts the newest options without adding a listener", () => {
    const listeners: Array<(u: unknown) => void> = [];
    const subscribe = (cb: (u: unknown) => void) => { listeners.push(cb); };
    const first: string[] = [];
    const second: string[] = [];

    installTurnWatcher(subscribe, { minTurnChars: 20, cooldownMs: 0, onTurn: (_k, t) => { first.push(t); } });
    installTurnWatcher(subscribe, { minTurnChars: 20, cooldownMs: 0, onTurn: (_k, t) => { second.push(t); } });

    listeners[0]!({ sessionKey: CHANNEL, message: msg("user", "a question with plenty of text in it") });
    listeners[0]!({ sessionKey: CHANNEL, message: msg("assistant", "a substantial reply about the export") });

    expect(listeners).toHaveLength(1);
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  // If the runtime hands back a disposer, use it: re-subscribing fresh is
  // safer than trusting that a subscription from a torn-down registration is
  // still live, but doing so must not leave the old listener attached.
  it("disposes the previous subscription when the runtime provides one", () => {
    const disposed: number[] = [];
    let n = 0;
    const subscribe = () => { const id = n++; return () => { disposed.push(id); }; };
    const opts = { minTurnChars: 10, cooldownMs: 0, onTurn: () => {} };

    installTurnWatcher(subscribe, opts);
    installTurnWatcher(subscribe, opts);

    expect(disposed).toEqual([0]);
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
