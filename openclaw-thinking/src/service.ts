import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

import { buildContext, getLastThreePasses } from "./context-builder.js";
import { buildPrompt } from "./prompt-builder.js";
import { parseProposals, ParseError } from "./output-parser.js";
import { appendPass, appendError, appendSkipped, appendStructuredProposals } from "./log-writer.js";
import { loadOutcomes, saveOutcomes, addProposals, expireOldProposals } from "./outcome-tracker.js";
import { computeSignal } from "./signal-analyzer.js";
import { maybeDeliver } from "./delivery.js";
import { DEFAULT_CONFIG, type PluginConfig } from "./types.js";
import { resolveDataPath } from "./utils.js";

interface LockData {
  pid: number;
  started_at: string;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireLock(lockDir: string, lockFile: string): Promise<boolean> {
  await mkdir(lockDir, { recursive: true });
  try {
    const lock = JSON.parse(await readFile(lockFile, "utf-8")) as LockData;
    const ageHours = (Date.now() - new Date(lock.started_at).getTime()) / (1000 * 60 * 60);

    if (isProcessAlive(lock.pid)) {
      if (ageHours < 2) return false;
      // > 2 hours old with live PID: stuck process; kill and take the lock
      try { process.kill(lock.pid, "SIGTERM"); } catch {}
      await new Promise((r) => setTimeout(r, 1000));
      if (isProcessAlive(lock.pid)) { try { process.kill(lock.pid, "SIGKILL"); } catch {} }
    }
  } catch { /* no lock file */ }

  await writeFile(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), "utf-8");
  return true;
}

async function releaseLock(lockFile: string): Promise<void> {
  try { await unlink(lockFile); } catch {}
}

function isWithinActiveHours(config: PluginConfig): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: config.activeHours.timezone,
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const [hours, minutes] = formatter.format(new Date()).split(":").map(Number);
  const now = (hours ?? 0) * 60 + (minutes ?? 0);
  const [sh, sm] = config.activeHours.start.split(":").map(Number);
  const [eh, em] = config.activeHours.end.split(":").map(Number);
  return now >= (sh ?? 0) * 60 + (sm ?? 0) && now <= (eh ?? 0) * 60 + (em ?? 0);
}

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<PluginConfig>),
    activeHours: { ...DEFAULT_CONFIG.activeHours, ...((raw.activeHours as object) ?? {}) },
    context: { ...DEFAULT_CONFIG.context, ...((raw.context as object) ?? {}) },
    output: {
      ...DEFAULT_CONFIG.output,
      ...((raw.output as object) ?? {}),
      logPath: resolveDataPath((raw as any).output?.logPath, workspaceDir, DEFAULT_CONFIG.output.logPath),
      trackerPath: resolveDataPath((raw as any).output?.trackerPath, workspaceDir, DEFAULT_CONFIG.output.trackerPath),
    },
    delivery: { ...DEFAULT_CONFIG.delivery, ...((raw.delivery as object) ?? {}) },
    learning: { ...DEFAULT_CONFIG.learning, ...((raw.learning as object) ?? {}) },
  };
}

const ISOLATED_SYSTEM_PROMPT = `You are running a scheduled thinking pass.

1. Call get_thinking_context() to receive your context and instructions.
2. If it returns { "status": "skip" }, reply with SILENT_REPLY_TOKEN and stop.
3. Otherwise, review the context carefully, then call record_thinking_output() with your proposals.

Do not produce any other output.`;

export default definePluginEntry({
  id: "sapience-thinking",
  name: "Sapience Thinking",
  description: "Periodic isolated thinking passes that produce structured proposals",

  register(api: any) {
    const workspaceDir = (api.runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig);
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);
    const lockDir = join(workspaceDir, "proactive-thinking");
    const lockFile = join(lockDir, ".pass.lock");
    const agentId: string = ((api.config as Record<string, unknown>)?.agent as Record<string, unknown>)?.id as string ?? "default";

    api.registerTool({
      name: "get_thinking_context",
      description: "Fetch context bundle and thinking instructions. Call this first in every thinking pass.",
      parameters: Type.Object({}),
      async execute(_id: any, _params: any) {
        if (!isWithinActiveHours(config)) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "skip", reason: "outside_active_hours" }) }] };
        }
        const acquired = await acquireLock(lockDir, lockFile);
        if (!acquired) {
          await appendSkipped("pass_already_running", config.output.logPath);
          return { content: [{ type: "text", text: JSON.stringify({ status: "skip", reason: "pass_already_running" }) }] };
        }
        try {
          const [bundle, recentPasses, outcomes] = await Promise.all([
            buildContext(config, agentId),
            getLastThreePasses(config.output.logPath),
            loadOutcomes(config.output.trackerPath),
          ]);
          bundle.recentPasses = recentPasses;
          const signal = config.learning.adjustPromptBasedOnSignal ? computeSignal(outcomes, config) : null;
          const prompt = await buildPrompt(bundle, signal);
          return { content: [{ type: "text", text: prompt }] };
        } catch (err) {
          await releaseLock(lockFile);
          throw err;
        }
      },
    });

    api.registerTool({
      name: "record_thinking_output",
      description: "Record structured thinking proposals from this pass. Call after get_thinking_context.",
      parameters: Type.Object({ proposals: Type.Unknown() }),
      async execute(_id: any, params: any) {
        try {
          const proposals = parseProposals(params.proposals);
          await appendPass(proposals, config.output.logPath);
          await appendStructuredProposals(proposals, config.output.logPath);
          if (config.learning.trackOutcomes) {
            let outcomes = await loadOutcomes(config.output.trackerPath);
            outcomes = addProposals(outcomes, proposals);
            outcomes = expireOldProposals(outcomes);
            await saveOutcomes(outcomes, config.output.trackerPath);
          }
          await maybeDeliver(proposals, api, config);
        } catch (err) {
          const passId = (params.proposals as Record<string, unknown>)?.pass_id as string ?? "unknown";
          await appendError(passId, err instanceof ParseError ? err.message : String(err), config.output.logPath);
        } finally {
          await releaseLock(lockFile);
        }
        return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
      },
    });

    // NOTE: exact scheduleSessionTurn signature may need adjustment based on installed SDK version.
    // Refer to: https://docs.openclaw.ai/plugins/sdk-overview
    (api.session.workflow as any).scheduleSessionTurn({
      schedule: { cron: config.schedule },
      sessionTarget: "isolated",
      tag: "sapience-thinking-pass",
      systemPrompt: ISOLATED_SYSTEM_PROMPT,
      maxTurns: 3,
    });
  },
});
