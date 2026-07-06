import type { StatusArtifact } from "./types.js";

// End-to-end probe: trigger the real sapience-thinking cron job once and watch
// whether the tool handlers actually write. The static doctor checks infer;
// this proves. It exists because the toolsAllow outage produced weeks of green
// cron runs with zero output — the exact contradiction a probe catches in one
// command, whatever the cause turns out to be.

export interface ProbeRunOutcome {
  // Whether the CLI reported a completed (awaited) run — regardless of the
  // run's own status. `openclaw cron run --wait` exits 1 for any non-ok run
  // status, so exit codes alone cannot distinguish "never started" from
  // "ran and errored".
  completed: boolean;
  runStatus?: string;
  error?: string;
}

export interface ProbeEffects {
  listCronJobs(): Promise<any[]>;
  runCronJob(id: string, timeoutSec: number): Promise<ProbeRunOutcome>;
  statMtime(path: string): Promise<number | null>;
  readArtifacts(): Promise<Record<string, StatusArtifact>>;
}

export interface ProbeResult {
  verdict: "pass" | "fail" | "inconclusive" | "blocked";
  message: string;
  detail?: string;
}

export interface ProbeOptions {
  withinHours: boolean;
  timeoutSec?: number;
}

export async function runThinkingProbe(effects: ProbeEffects, opts: ProbeOptions): Promise<ProbeResult> {
  const artifacts = await effects.readArtifacts();
  const artifact = artifacts["sapience-thinking"];
  if (!artifact) {
    return { verdict: "blocked", message: "sapience-thinking has no status artifact — the plugin never initialized. Fix that first (openclaw sapience doctor)." };
  }

  const jobs = await effects.listCronJobs();
  const job = jobs.find((j) => j?.name === "sapience-thinking");
  if (!job) {
    return { verdict: "blocked", message: "the sapience-thinking cron job is not registered — nothing to probe. Run install.sh or `openclaw sapience doctor --fix`." };
  }

  const watchPaths = [artifact.outputPaths.logPath, artifact.outputPaths.proposalsPath].filter(Boolean) as string[];
  const before = await Promise.all(watchPaths.map((p) => effects.statMtime(p)));

  const run = await effects.runCronJob(job.id, opts.timeoutSec ?? 180);

  const after = await Promise.all(watchPaths.map((p) => effects.statMtime(p)));
  const wrote = watchPaths.some((_, i) => (after[i] ?? 0) > (before[i] ?? 0));

  // File writes are the ground truth: if the tool handlers wrote, the
  // pipeline works, whatever the CLI's exit code said.
  if (wrote) {
    return {
      verdict: "pass",
      message: "end-to-end pass completed and wrote output — tool exposure, prompts, and the pipeline path all work.",
      detail: run.runStatus && run.runStatus !== "ok" ? `Note: the run reported status "${run.runStatus}"${run.error ? ` (${run.error})` : ""} after writing.` : undefined,
    };
  }

  if (!run.completed) {
    return { verdict: "fail", message: "the probe could not trigger or await the run — the gateway may be unreachable.", detail: run.error };
  }
  if (run.runStatus && run.runStatus !== "ok") {
    return {
      verdict: "fail",
      message: `the pass ran but errored (run status: ${run.runStatus}) and wrote nothing.`,
      detail: run.error ?? "Inspect the run with `openclaw cron list --json` / gateway logs.",
    };
  }
  if (!opts.withinHours) {
    return { verdict: "inconclusive", message: "the run completed but writes are suppressed outside active hours — re-run the probe within the configured window for a definitive verdict." };
  }
  return {
    verdict: "fail",
    message: "the cron run completed but the tool handlers never executed — no output was written.",
    detail: "Classic signature of plugin tools not reaching the cron session. Check the job's payload.toolsAllow and tools.profile/alsoAllow (see docs/troubleshooting.md).",
  };
}
