import type { StatusArtifact } from "./types.js";

// End-to-end probe: trigger the real sapience-thinking cron job once and watch
// whether the tool handlers actually write. The static doctor checks infer;
// this proves. It exists because the toolsAllow outage produced weeks of green
// cron runs with zero output — the exact contradiction a probe catches in one
// command, whatever the cause turns out to be.

export interface ProbeEffects {
  listCronJobs(): Promise<any[]>;
  runCronJob(id: string, timeoutSec: number): Promise<{ ok: boolean; error?: string }>;
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
  if (!run.ok) {
    return { verdict: "fail", message: "the probe run itself failed before the pass could execute.", detail: run.error };
  }

  const after = await Promise.all(watchPaths.map((p) => effects.statMtime(p)));
  const wrote = watchPaths.some((_, i) => (after[i] ?? 0) > (before[i] ?? 0));

  if (wrote) {
    return { verdict: "pass", message: "end-to-end pass completed and wrote output — tool exposure, prompts, and the pipeline path all work." };
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
