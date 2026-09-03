import { describe, it, expect } from "vitest";
import { runDeliveryGate, SILENT_OUTPUT, type DeliveryGateEffects } from "./delivery-gate.js";

function makeEffects(overrides: Partial<DeliveryGateEffects> & { pending?: number | null } = {}) {
  const triggered: string[] = [];
  const events: Record<string, unknown>[] = [];
  const effects: DeliveryGateEffects = {
    // `?? 0` would erase the null case this harness exists to exercise.
    readPendingCount: async () => ("pending" in overrides ? overrides.pending! : 0),
    findDeliveryJob: async () => ({ id: "job-1", running: false }),
    triggerJob: async (id) => { triggered.push(id); },
    recordEvent: async (e) => { events.push(e); },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "pending")),
  };
  return { effects, triggered, events };
}

describe("runDeliveryGate", () => {
  it("starts no agent turn when the queue is empty", async () => {
    // ~95% of runs. This is the entire point: no model turn, so no empty turn,
    // so no host placeholder to announce.
    const { effects, triggered, events } = makeEffects({ pending: 0 });
    const result = await runDeliveryGate(effects);
    expect(result).toEqual({ status: "idle", pending: 0 });
    expect(triggered).toEqual([]);
    expect(events).toEqual([]);
  });

  it("triggers the delivery job when something is queued", async () => {
    const { effects, triggered, events } = makeEffects({ pending: 3 });
    const result = await runDeliveryGate(effects);
    expect(result).toEqual({ status: "triggered", pending: 3 });
    expect(triggered).toEqual(["job-1"]);
    expect(events).toEqual([{ plugin: "sapience", type: "delivery_gate_triggered", pending: 3 }]);
  });

  it("does not stack a second turn on top of a running one", async () => {
    const { effects, triggered } = makeEffects({
      pending: 2,
      findDeliveryJob: async () => ({ id: "job-1", running: true }),
    });
    const result = await runDeliveryGate(effects);
    expect(result).toEqual({ status: "already-running", pending: 2 });
    expect(triggered).toEqual([]);
  });

  it("records a blocked event when queued work has no job to carry it", async () => {
    const { effects, triggered, events } = makeEffects({
      pending: 4,
      findDeliveryJob: async () => null,
    });
    const result = await runDeliveryGate(effects);
    expect(result.status).toBe("blocked");
    expect(result.pending).toBe(4);
    expect(triggered).toEqual([]);
    expect(events[0]).toMatchObject({ type: "delivery_gate_blocked", pending: 4 });
  });

  it("reports blocked when the queue location cannot be resolved", async () => {
    const { effects, events } = makeEffects({ pending: null });
    const result = await runDeliveryGate(effects);
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("status artifact");
    expect(events[0]).toMatchObject({ type: "delivery_gate_blocked" });
  });

  it("prints the token before doing any work, and always exits 0", async () => {
    // A command job is recorded as an error on a non-zero exit OR on producing
    // no output for the no-output-timeout window. The non-empty-queue path here
    // boots two nested openclaw CLI processes, so the token has to go out
    // first — and a failure anywhere must still leave a zero exit code, because
    // failures are reported on the events log, not through the job's status.
    const { runDeliverCheckCommand } = await import("./delivery-gate-cli.js");
    const order: string[] = [];
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalExitCode = process.exitCode;
    process.exitCode = 3;
    (process.stdout as any).write = (chunk: string) => { order.push("stdout"); writes.push(String(chunk)); return true; };
    try {
      await runDeliverCheckCommand({
        readPendingCount: async () => { order.push("work"); throw new Error("gateway unreachable"); },
        findDeliveryJob: async () => null,
        triggerJob: async () => {},
        recordEvent: async () => { order.push("event"); },
      });
    } finally {
      (process.stdout as any).write = originalWrite;
    }
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;

    expect(writes.join("")).toBe("NO_REPLY\n");
    expect(order[0]).toBe("stdout");
    expect(order).toContain("event");
    expect(exitCode).toBe(0);
  });

  it("emits openclaw's recognized silent token, not the constant's name", async () => {
    // The host only suppresses the literal NO_REPLY. An earlier generation of
    // these prompts shipped the string "SILENT_REPLY_TOKEN" instead.
    expect(SILENT_OUTPUT).toBe("NO_REPLY");
  });
});
