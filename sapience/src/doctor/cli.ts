import { execFile } from "child_process";
import { promisify } from "util";
import { gatherInputs } from "./sources.js";
import { buildSuiteDoctorReport } from "./report.js";
import { renderReport, renderJson } from "./render.js";
import { planFixes, applyFixes, type FixEffectors } from "./fix.js";

const exec = promisify(execFile);

// Cron messages mirror install.sh so --fix registers identical jobs. No --model:
// crons inherit the agent default (a pinned model outside the allowlist fails
// preflight — the very thing the doctor reports).
const CRON_MESSAGES: Record<string, string> = {
  "sapience-thinking":
    "You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with SILENT_REPLY_TOKEN and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output.",
  "sapience-routing":
    "You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply SILENT_REPLY_TOKEN after the tool call.",
  "sapience-goals-check":
    "You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply SILENT_REPLY_TOKEN after the tool call.",
};

function makeEffectors(agentId: string): FixEffectors {
  return {
    async setConfig(path, value) {
      await exec("openclaw", ["config", "set", path, JSON.stringify(value), "--strict-json"]);
    },
    async registerCron(base) {
      const message = CRON_MESSAGES[base];
      if (!message) throw new Error(`no registration template for cron ${base}`);
      await exec("openclaw", [
        "cron", "add",
        "--name", base,
        "--cron", "*/15 * * * *",
        "--session", "isolated",
        "--agent", agentId,
        "--no-deliver",
        "--message", message,
        "--timeout-seconds", "120",
      ]);
    },
  };
}

export function registerSapienceDoctorCli(api: any): void {
  api.registerCli(
    (ctx: any) => {
      const program = ctx.program;
      const config = ctx.config ?? api.config;
      // Create a "sapience" group and nest doctor under it — mirrors how
      // memory-wiki builds `wiki doctor`. Top-level "doctor" collides with openclaw's own.
      const group = program.command("sapience").description("Sapience suite diagnostics");
      const cmd = group.command("doctor").description("Diagnose the sapience suite (crons, paths, memory config)");
      cmd.option("--fix", "apply the safe, auto-fixable findings (memory config, missing crons)");
      cmd.option("--json", "output the report as JSON");
      cmd.action(async (opts: { fix?: boolean; json?: boolean }) => {
        const nowMs = Date.now();
        let report = buildSuiteDoctorReport(await gatherInputs({ api, config, env: process.env, nowMs }));

        if (opts.fix) {
          const actions = planFixes(report);
          if (actions.length === 0) {
            console.log("Nothing to auto-fix.");
          } else {
            const agentId = api?.runtime?.cron?.getDefaultAgentId?.() ?? "main";
            const done = await applyFixes(actions, makeEffectors(agentId));
            console.log("Applied fixes:");
            for (const d of done) console.log(`  • ${d}`);
            console.log("");
            // Re-gather so the printed report reflects the applied fixes.
            report = buildSuiteDoctorReport(await gatherInputs({ api, config, env: process.env, nowMs: Date.now() }));
          }
        }

        console.log(opts.json ? renderJson(report) : renderReport(report));
        process.exitCode = report.exitCode;
      });
    },
    { descriptors: [{ name: "sapience", description: "Sapience suite diagnostics", hasSubcommands: true }] },
  );
}
