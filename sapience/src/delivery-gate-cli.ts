import { execFile } from "child_process";
import { promisify } from "util";
import { readJsonSafe } from "./safe-json.js";
import { appendEvent } from "./events.js";
import { readStatusArtifacts } from "./status-artifact.js";
import { parseCronListJson } from "./doctor/sources.js";
import { DELIVERY_CRON_BASE, DELIVERY_DECLARATION_KEY } from "./doctor/inventory.js";
import { runDeliveryGate, SILENT_OUTPUT, type DeliveryGateEffects } from "./delivery-gate.js";

const exec = promisify(execFile);

// The delivery job carries a stable declaration key, so identity does not
// depend on its name. That matters here: on a multi-agent install the job is
// named "sapience-delivery-<agent>", and a prefix match would be ambiguous.
function matchesDeliveryJob(job: any): boolean {
  if (typeof job?.declarationKey === "string") {
    return job.declarationKey === DELIVERY_DECLARATION_KEY ||
      job.declarationKey.startsWith(`${DELIVERY_DECLARATION_KEY}:`);
  }
  const name = typeof job?.name === "string" ? job.name : "";
  return name === DELIVERY_CRON_BASE || name.startsWith(`${DELIVERY_CRON_BASE}-`);
}

// openclaw has reported in-flight runs under a few different state fields
// across versions. Treat any of them as "running" — a false positive costs one
// skipped poll (the next is fifteen minutes away), a false negative stacks
// model turns.
function isRunning(job: any): boolean {
  const st = job?.state ?? {};
  return Boolean(st.running ?? st.activeRunId ?? st.currentRunId) ||
    st.lastRunStatus === "running";
}

export function makeDeliveryGateEffects(eventsPath?: string): DeliveryGateEffects {
  return {
    async readPendingCount() {
      const artifact = (await readStatusArtifacts(process.env))["sapience"];
      const path = artifact?.outputPaths?.pendingDeliveriesPath;
      if (!path) return null;
      const queue = await readJsonSafe<unknown[]>(path, []);
      return Array.isArray(queue) ? queue.length : 0;
    },
    async findDeliveryJob() {
      const { stdout } = await exec("openclaw", ["cron", "list", "--all", "--json"]);
      const job = parseCronListJson(stdout).find(matchesDeliveryJob);
      if (!job || typeof job.id !== "string") return null;
      return { id: job.id, running: isRunning(job) };
    },
    async triggerJob(id) {
      // Deliberately not --wait: the poll job's own timeout must not bound the
      // delivery turn, and its stdout must stay exactly the silent token.
      await exec("openclaw", ["cron", "run", id]);
    },
    async recordEvent(event) {
      if (!eventsPath) return;
      await appendEvent(eventsPath, event).catch(() => {});
    },
  };
}

// Always exits 0 and prints exactly the silent token. A command job's delivered
// text is its output: a non-zero exit records an error (and can fire failure
// alerts), and anything on stderr alongside stdout is delivered as a combined
// block. Both would reintroduce the noise this command exists to remove, so
// every outcome — including failure — is reported through the events log.
export async function runDeliverCheckCommand(effects: DeliveryGateEffects): Promise<void> {
  // Emit the token BEFORE doing any work. A command job is killed and recorded
  // as an error when it produces no output for the no-output-timeout window,
  // and the non-empty-queue path here shells out to `openclaw cron list` and
  // `openclaw cron run` — two full CLI boots. The token is the same whatever
  // the outcome, so there is nothing to gain by waiting to print it, and
  // printing first means the run can never look stalled.
  process.stdout.write(`${SILENT_OUTPUT}\n`);
  try {
    await runDeliveryGate(effects);
  } catch (err) {
    await effects.recordEvent({
      plugin: "sapience",
      type: "delivery_gate_blocked",
      reason: String(err).slice(0, 500),
    }).catch(() => {});
  }
  // Claim success explicitly. A command job's exit code decides whether the run
  // is recorded ok or error, and an error can fire failure alerts — so a queue
  // check that found nothing to do must not leave a non-zero code behind for
  // any reason, including one set by an unrelated part of the CLI before this
  // action ran. Every real failure is already on the events log above.
  process.exitCode = 0;
}
