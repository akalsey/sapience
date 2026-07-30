// Regression: `delivery.maxPerCycle` was enforced inside deliverItems, which
// service.ts calls once per PASS. The cap was therefore per-pass, not per
// cycle, and a routing run that drained a backlog injected maxPerCycle × N
// notes. Production, 2026-07-26T19:45:07Z: one run logged
// `routing_completed passes=6 items=21` and put 15 separate CALIBRATE notes
// in front of the user's next message; the 07-20 15:00Z run — the first after
// active hours resumed — drained 19 passes at once. This exercises the real
// register()/process_proposals path so the cap can't drift back per-pass.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import service from "./service.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "routing-delivery-"));
  await mkdir(join(dir, "proactive-thinking"), { recursive: true });
  await mkdir(join(dir, "sapience"), { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function pass(n: number) {
  return JSON.stringify({
    pass_id: `pass-${n}`,
    timestamp: "2026-07-26T19:00:00Z",
    nothing_to_report: false,
    summary: `pass ${n}`,
    observations: [{ id: `o-${n}`, text: `observation number ${n} about the deploy pipeline`, evidence: "e", priority: 3 }],
    proposed_actions: [{ id: `a-${n}`, text: `action number ${n}: restart the stuck worker`, rationale: "r", estimated_effort: "small", priority: 3 }],
    proposed_audits: [],
    open_questions: [],
  });
}

async function runRouting(passCount: number, pluginConfig: Record<string, unknown> = {}) {
  await writeFile(
    join(dir, "proactive-thinking", "proposals.jsonl"),
    Array.from({ length: passCount }, (_, i) => pass(i + 1)).join("\n") + "\n",
    "utf-8"
  );
  // A non-empty processed set skips the first-run bootstrap, which would
  // otherwise mark every existing pass as already handled.
  await writeFile(join(dir, "sapience", "processed-passes.json"), JSON.stringify({ pass_ids: ["seed"] }), "utf-8");

  const injections: string[] = [];
  const tools: Record<string, (id: unknown, params: unknown) => Promise<unknown>> = {};
  const api: any = {
    runtime: { agent: { resolveAgentWorkspaceDir: () => dir } },
    config: {},
    pluginConfig: {
      activeHours: { start: "00:00", end: "23:59", timezone: "UTC" },
      digest: { enabled: false },
      push: { enabled: false },
      investigation: { enabled: false },
      ...pluginConfig,
    },
    registerTool: (t: any) => { tools[t.name] = t.execute; },
    session: {
      workflow: {
        enqueueNextTurnInjection: async (inj: { sessionKey: string; text: string }) => {
          injections.push(inj.text);
          return { enqueued: true, id: String(injections.length), sessionKey: inj.sessionKey };
        },
      },
    },
  };

  service.register(api);
  await tools.process_proposals!(null, {});
  return injections;
}

describe("process_proposals delivery volume", () => {
  it("injects one note for the whole routing run, however many passes it drains", async () => {
    const injections = await runRouting(6);
    expect(injections).toHaveLength(1);
    expect(injections[0]!.match(/user's message takes priority/g)).toHaveLength(1);
  });

  it("honours maxPerCycle across the run, not per pass", async () => {
    // 6 passes × 2 items = 12 routable items. Per-pass enforcement produced
    // 6 injections of 2 items; per-run enforcement produces 1 note of 2.
    const injections = await runRouting(6, { delivery: { maxPerCycle: 2 } });
    expect(injections).toHaveLength(1);
    expect(injections[0]!.match(/\[SAPIENCE: /g)).toHaveLength(2);
  });

  it("still delivers when there is only one pass", async () => {
    const injections = await runRouting(1);
    expect(injections).toHaveLength(1);
    expect(injections[0]).toContain("observation number 1");
  });
});
