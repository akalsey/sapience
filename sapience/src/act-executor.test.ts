import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseActResult, executeActItems } from "./act-executor.js";
import type { RoutedItem } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "act-exec-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const actItem: RoutedItem = {
  id: "a1", type: "action", text: "Archive the three duplicate Apple accounts in Salesforce",
  domain: "salesforce", action_class: "salesforce/action", priority: 4,
  pass_id: "p1", pass_timestamp: "t", tier: "act", confidence: 0.9, reversible: true,
};

function makeApi(finalText: string, waitStatus: "ok" | "error" | "timeout" = "ok") {
  const calls: any[] = [];
  const injections: string[] = [];
  return {
    calls, injections,
    config: {},
    session: {
      workflow: {
        enqueueNextTurnInjection: async (inj: { sessionKey: string; text: string }) => {
          injections.push(inj.text);
          return { enqueued: true, id: "1", sessionKey: inj.sessionKey };
        },
      },
    },
    runtime: {
      subagent: {
        run: async (params: any) => { calls.push(["run", params]); return { runId: "r1" }; },
        waitForRun: async () => ({ status: waitStatus }),
        getSessionMessages: async () => ({
          messages: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: finalText }] } }],
        }),
        deleteSession: async () => { calls.push(["delete"]); },
      },
    },
  };
}

function config() {
  return {
    ...DEFAULT_CONFIG,
    push: { ...DEFAULT_CONFIG.push, enabled: false },
    output: {
      ...DEFAULT_CONFIG.output,
      actionLogPath: join(dir, "action-log.md"),
      eventsPath: join(dir, "events.jsonl"),
    },
  } as any;
}

describe("parseActResult", () => {
  it("extracts the result object", () => {
    const r = parseActResult('done.\n{"status":"done","report":"archived 3 accounts","undo":"restore from recycle bin"}');
    expect(r.status).toBe("done");
    expect(r.undo).toContain("recycle bin");
  });

  it("treats garbage as failure", () => {
    expect(parseActResult("no json").status).toBe("failed");
  });
});

describe("executeActItems", () => {
  it("executes via subagent, journals the result, and reports to the main session", async () => {
    const api = makeApi('{"status":"done","report":"archived 3 duplicate accounts","undo":"restore from recycle bin"}');
    await executeActItems([actItem], api, config());

    const run = api.calls.find((c) => c[0] === "run")![1];
    expect(run.message).toContain("Archive the three duplicate");
    expect(run.deliver).toBe(false);

    const journal = await readFile(join(dir, "action-log.md"), "utf-8");
    expect(journal).toContain("archived 3 duplicate accounts");
    expect(journal.toLowerCase()).toContain("undo");

    expect(api.injections).toHaveLength(1);
    expect(api.injections[0]).toContain("archived 3 duplicate accounts");
    expect(api.injections[0]).toContain("record_outcome");

    const events = (await readFile(join(dir, "events.jsonl"), "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "act_executed")).toBe(true);
  });

  it("reports failures without journal success entries", async () => {
    const api = makeApi('{"status":"failed","report":"insufficient permissions"}');
    await executeActItems([actItem], api, config());
    expect(api.injections[0]).toContain("insufficient permissions");
    const events = (await readFile(join(dir, "events.jsonl"), "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "act_failed")).toBe(true);
  });

  it("falls back to the legacy act injection when the subagent runtime is missing", async () => {
    const injections: string[] = [];
    const api = {
      config: {},
      session: { workflow: { enqueueNextTurnInjection: async (inj: any) => { injections.push(inj.text); return { enqueued: true, id: "1", sessionKey: inj.sessionKey }; } } },
    };
    await executeActItems([actItem], api, config());
    expect(injections).toHaveLength(1);
    expect(injections[0]).toContain("[SAPIENCE: ACT]");
  });
});
