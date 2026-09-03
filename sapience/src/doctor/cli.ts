import { stat } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { gatherInputs, parseCronListJson, resolveCronJobIds } from "./sources.js";
import { buildSuiteDoctorReport } from "./report.js";
import { renderReport, renderJson } from "./render.js";
import { planFixes, applyFixes, patchConfigForAppliedFixes, type FixEffectors } from "./fix.js";
import { cronRegisterArgs, deliveryPollRegisterArgs, type DeliveryTarget } from "./cron-args.js";
import { DELIVERY_POLL_CRON_BASE } from "./inventory.js";
import { makeDeliveryGateEffects, runDeliverCheckCommand } from "../delivery-gate-cli.js";
import { runThinkingProbe, type ProbeEffects } from "./probe.js";
import { readStatusArtifacts } from "../status-artifact.js";
import { validateActiveHours, isWithinActiveHours } from "../active-hours.js";

const exec = promisify(execFile);

function makeProbeEffects(): ProbeEffects {
  return {
    async listCronJobs() {
      try {
        const { stdout } = await exec("openclaw", ["cron", "list", "--all", "--json"]);
        return parseCronListJson(stdout);
      } catch { return []; }
    },
    async runCronJob(id, timeoutSec) {
      // The CLI exits 1 whenever the awaited run's status is not ok, but it
      // still prints the run JSON — parse stdout from success OR failure so
      // "ran and errored" is distinguishable from "never started".
      const parse = (stdout: string) => {
        try {
          const res = JSON.parse(stdout);
          if (res && typeof res === "object" && "completed" in res) {
            return {
              completed: Boolean(res.completed),
              runStatus: typeof res.status === "string" ? res.status : undefined,
              error: typeof res.run?.error === "string" ? res.run.error : undefined,
            };
          }
        } catch { /* not JSON */ }
        return null;
      };
      try {
        const { stdout } = await exec("openclaw", ["cron", "run", id, "--wait", "--wait-timeout", `${timeoutSec}s`],
          { timeout: (timeoutSec + 30) * 1000 });
        return parse(stdout) ?? { completed: true, runStatus: "ok" };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const parsed = e.stdout ? parse(e.stdout) : null;
        if (parsed) return parsed;
        const detail = [e.stderr?.trim(), e.stdout?.trim(), e.message].filter(Boolean).join(" | ").slice(0, 500);
        return { completed: false, error: detail || String(err) };
      }
    },
    async statMtime(path) {
      try { return (await stat(path)).mtimeMs; } catch { return null; }
    },
    readArtifacts: () => readStatusArtifacts(process.env),
  };
}

function thinkingWithinHours(config: any): boolean {
  const raw = config?.plugins?.entries?.["sapience-thinking"]?.config?.activeHours ?? {};
  const fallback = { start: "08:00", end: "20:00", timezone: "America/Los_Angeles" };
  const { hours } = validateActiveHours({ ...fallback, ...raw }, fallback);
  return isWithinActiveHours(hours);
}

// Registration args live in cron-args.ts and mirror install.sh so --fix
// registers identical jobs. The suite never sets --model: it has no basis for
// an opinion about a user's model preferences.
export { cronRegisterArgs, deliveryPollRegisterArgs } from "./cron-args.js";

// The same env contract install.sh uses. On installs where DMs are scoped to
// per-peer sessions, announce's "last active channel" resolution never finds a
// route from the machine-only main session, so the operator pins one — and a
// pinned target is also what lets the delivery job drop its announce route and
// fail silently instead of announcing the host's empty-turn placeholder.
export function deliveryTargetFromEnv(env: NodeJS.ProcessEnv): DeliveryTarget | undefined {
  const to = env.SAPIENCE_DELIVERY_TO?.trim();
  if (!to) return undefined;
  return { channel: env.SAPIENCE_DELIVERY_CHANNEL?.trim() || "telegram", to };
}

// An absolute path to the openclaw binary. The Gateway runs command payloads
// through `sh -lc`, which on Debian/Ubuntu is dash and does not read the shell
// profile that puts an npm-global bin directory on PATH — so a bare "openclaw"
// exits 127. `command -v` in the doctor's own shell is the best answer;
// node + this process's entry script is the guaranteed fallback, since it is
// literally how this process was started.
async function resolveOpenclawBin(): Promise<string> {
  try {
    const { stdout } = await exec("sh", ["-c", "command -v openclaw"]);
    const resolved = stdout.trim();
    if (resolved.startsWith("/")) return resolved;
  } catch { /* fall through */ }
  const entry = process.argv[1];
  return entry ? `${process.execPath} ${entry}` : "openclaw";
}

function makeEffectors(agentId: string | undefined, env: NodeJS.ProcessEnv): FixEffectors {
  const opts = { ...(agentId ? { agentId } : {}), ...(deliveryTargetFromEnv(env) ? { deliveryTarget: deliveryTargetFromEnv(env)! } : {}) };
  return {
    async setConfig(path, value) {
      await exec("openclaw", ["config", "set", path, JSON.stringify(value), "--strict-json"]);
    },
    async registerCron(base, registerOpts) {
      // An explicitly configured SAPIENCE_DELIVERY_TO wins; otherwise reuse the
      // route the job being replaced already had. Falling through to neither
      // means announce/last, which is the configuration that announces the
      // host's empty-turn placeholder.
      const target = opts.deliveryTarget ?? registerOpts?.deliveryTarget;
      const withTarget = target ? { ...opts, deliveryTarget: target } : opts;
      if (base === DELIVERY_POLL_CRON_BASE) {
        await exec("openclaw", deliveryPollRegisterArgs({ ...opts, openclawBin: await resolveOpenclawBin() }));
        return;
      }
      await exec("openclaw", cronRegisterArgs(base, withTarget));
    },
    async deleteCron(name) {
      // `cron rm` takes an id positionally — there is no --name option on it,
      // and the gateway rejects a non-id with "id not found". Resolve the name
      // to every job carrying it (names are not unique, and duplicates are the
      // thing being cleaned up), then delete each by id.
      const { stdout } = await exec("openclaw", ["cron", "list", "--all", "--json"]);
      const ids = resolveCronJobIds(parseCronListJson(stdout), name);
      if (ids.length === 0) {
        throw new Error(`no cron job named ${name} to delete`);
      }
      for (const id of ids) {
        await exec("openclaw", ["cron", "rm", id]);
      }
    },
    async updatePlugin(pluginId) {
      await exec("openclaw", ["plugins", "update", pluginId]);
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

      // Run by the sapience-poll-delivery cron every 15 minutes. It reads the
      // pending-delivery queue and starts the delivery agent turn only when
      // there is something to send — see delivery-gate.ts for why that check
      // moved out of the agent turn. Always prints exactly NO_REPLY and exits 0.
      group
        .command("deliver-check")
        .description("Start the delivery agent turn only if deliveries are queued (used by the sapience-poll-delivery cron)")
        .action(async () => {
          const eventsPath = (await readStatusArtifacts(process.env))["sapience"]?.outputPaths?.eventsPath;
          await runDeliverCheckCommand(makeDeliveryGateEffects(eventsPath));
        });

      const cmd = group.command("doctor").description("Diagnose the sapience suite (crons, paths, memory config)");
      cmd.option("--fix", "apply the safe, auto-fixable findings (memory config, missing crons)");
      cmd.option("--only <id>", "with --fix, apply only the finding with this id (e.g. tools:goal-collision)");
      cmd.option("--json", "output the report as JSON");
      cmd.option("--probe", "trigger one real thinking pass end-to-end and verify it writes output");
      cmd.action(async (opts: { fix?: boolean; only?: string; json?: boolean; probe?: boolean }) => {
        if (opts.probe) {
          console.log("Probing: triggering one sapience-thinking cron run and watching for writes (up to ~3 minutes)...");
          const result = await runThinkingProbe(makeProbeEffects(), { withinHours: thinkingWithinHours(config) });
          const mark = result.verdict === "pass" ? "✓" : result.verdict === "inconclusive" ? "?" : "✗";
          console.log(`${mark} probe ${result.verdict}: ${result.message}`);
          if (result.detail) console.log(`  ${result.detail}`);
          process.exitCode = result.verdict === "pass" || result.verdict === "inconclusive" ? 0 : 1;
          return;
        }
        const nowMs = Date.now();
        let report = buildSuiteDoctorReport(await gatherInputs({ api, config, env: process.env, nowMs }));

        if (opts.fix) {
          // --only lets a caller (install.sh) apply one finding without also
          // applying fixes the user was separately asked about and declined.
          const actions = planFixes(report).filter((a) => !opts.only || a.finding?.id === opts.only);
          if (actions.length === 0) {
            console.log("Nothing to auto-fix.");
          } else {
            // Undefined rather than a guessed literal: with --agent omitted the
            // scheduler resolves the configured default itself, which is always
            // right. Registering with a name the install does not have produces
            // a job that fails every run with "cron job agent is unavailable".
            const agentId: string | undefined = api?.runtime?.cron?.getDefaultAgentId?.();
            const done = await applyFixes(actions, makeEffectors(agentId, process.env));
            console.log("Applied fixes:");
            for (const d of done) console.log(`  • ${d}`);
            if (actions.some((a) => a.kind === "plugin-update")) {
              console.log("\n  Restart the gateway (`openclaw gateway restart`) for updated plugins to take effect.");
            }
            console.log("");
            // Re-gather so the printed report reflects the applied fixes. The
            // config writes went to disk via `openclaw config set`; mirror them
            // onto the loaded config object or the re-report re-asserts the
            // pre-fix findings.
            patchConfigForAppliedFixes(config, actions);
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
