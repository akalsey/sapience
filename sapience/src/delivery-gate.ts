// Gate for the delivery agent turn.
//
// The delivery job's queue is empty roughly 95% of the time, so 95% of its runs
// existed only to discover there was nothing to do. That was tolerable while an
// empty turn was silent. It stopped being tolerable at openclaw 2026.8.1, which
// substitutes a placeholder sentence ("The tool run finished, but no final
// summary was produced…") whenever a model ends a tool-only turn without text —
// and an `announce` job delivers that placeholder to the operator's chat. On a
// stock install that is ninety-six messages a day.
//
// So the queue check moves out of the agent turn and into plugin code. A cheap
// command-payload job (no model, no context, no delivery route) runs this on the
// schedule and triggers the real agent job only when there is something to send.
// Command payloads are deliberately used over openclaw's `--trigger-script`
// gate: trigger scripts require `cron.triggers.enabled`, which grants headless
// exec with the owning agent's full tool policy. Gating a queue read is not
// worth asking an operator to turn that on.
//
// This process must NEVER write to stderr. Cron derives a command job's
// delivered text from its output: stdout wins alone, but when stdout AND stderr
// are both non-empty it delivers a combined `stdout:`/`stderr:` block — so a
// stray diagnostic on stderr would announce itself, which is the whole defect
// being fixed here. Diagnostics go to the events log instead.

export const SILENT_OUTPUT = "NO_REPLY";

export interface DeliveryGateEffects {
  // Number of queued deliveries, or null when the queue location could not be
  // resolved at all (no status artifact — the plugin never initialized).
  readPendingCount(): Promise<number | null>;
  // Gateway job id for the delivery agent job, or null when it isn't registered.
  findDeliveryJob(): Promise<{ id: string; running: boolean } | null>;
  triggerJob(id: string): Promise<void>;
  recordEvent(event: Record<string, unknown>): Promise<void>;
}

export type DeliveryGateStatus = "triggered" | "idle" | "already-running" | "blocked";

export interface DeliveryGateResult {
  status: DeliveryGateStatus;
  pending: number;
  reason?: string;
}

export async function runDeliveryGate(effects: DeliveryGateEffects): Promise<DeliveryGateResult> {
  const pending = await effects.readPendingCount();

  if (pending === null) {
    const reason = "could not resolve the pending-deliveries queue (no sapience status artifact)";
    await effects.recordEvent({ plugin: "sapience", type: "delivery_gate_blocked", reason });
    return { status: "blocked", pending: 0, reason };
  }

  if (pending === 0) {
    return { status: "idle", pending: 0 };
  }

  const job = await effects.findDeliveryJob();
  if (!job) {
    // Queued work with nowhere to send it. Worth recording: it means the
    // install is half-registered and deliveries are silently piling up.
    const reason = "the sapience-delivery job is not registered, so queued deliveries cannot be sent";
    await effects.recordEvent({ plugin: "sapience", type: "delivery_gate_blocked", pending, reason });
    return { status: "blocked", pending, reason };
  }

  // A delivery turn that overruns the poll interval must not be started twice.
  // The queue drains on read, so a second run would find nothing anyway — but
  // it would still be a model turn, and on a slow model a pile of them.
  if (job.running) {
    return { status: "already-running", pending };
  }

  await effects.triggerJob(job.id);
  await effects.recordEvent({ plugin: "sapience", type: "delivery_gate_triggered", pending });
  return { status: "triggered", pending };
}
