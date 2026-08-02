// src/service.ts
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type RoutedItem, type SapienceConfig } from "./types.js";
import { resolveDataPath } from "./utils.js";
import { validateActiveHours, isWithinActiveHours } from "./active-hours.js";
import { loadProfile, saveProfile, upsertEntry, addMissingEntries, decayProfile } from "./calibration.js";
import { routeItem } from "./autonomy.js";
import { readUnprocessedPasses, proposalSetToItems } from "./proposal-adapter.js";
import { loadProcessedPasses, markPassProcessed, bootstrapProcessedPasses } from "./processed-passes.js";
import { deliverItems } from "./delivery.js";
import { dedupeDelivered } from "./delivered-ledger.js";
import { addPendingDelivery, drainPendingDeliveries } from "./pending-deliveries.js";
import { digestDue, buildDigestPrompt } from "./weekly-digest.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import { acquireLock, releaseLock, clearLock } from "./lock.js";
import { rotateKeepingTail } from "./rotate.js";
import { logSkipOnce, clearSkipState } from "./skip-log.js";
import { appendEvent } from "./events.js";
import { loadHypotheses, resolveByText } from "./hypotheses.js";
import { generateDashboard } from "./dashboard.js";
import { writeStatusArtifact, resolvePluginVersion } from "./status-artifact.js";
import { enqueueMainSessionInjection } from "./main-session.js";
import { requestChannelPush } from "./push.js";
import { investigateHunches } from "./investigation.js";
import { executeActItems } from "./act-executor.js";
import { checkDueWatches } from "./watch-checker.js";
import { addWatch, removeWatch, loadWatches, renderWatches, type DeltaPolicy } from "./watches.js";
import { upsertProposal, updateProposalStatus, loadProposals, renderProposalsList, type SkillProposalStatus } from "./skill-proposals.js";
import { resolveSkillDirs, discoverInstalledSkills, checkAgainstInstalledSkills, renderInstalledSkills } from "./installed-skills.js";
import { compileExtraDomains } from "./domains.js";
import { handleProfileCommand } from "./profile-command.js";
import { registerSapienceDoctorCli } from "./doctor/cli.js";

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): SapienceConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<SapienceConfig>),
    activeHours: { ...DEFAULT_CONFIG.activeHours, ...((raw.activeHours as object) ?? {}) },
    proactiveThinking: {
      ...DEFAULT_CONFIG.proactiveThinking,
      ...((raw.proactiveThinking as object) ?? {}),
      proposalsPath: resolveDataPath((raw as any).proactiveThinking?.proposalsPath, workspaceDir, DEFAULT_CONFIG.proactiveThinking.proposalsPath),
    },
    learning: { ...DEFAULT_CONFIG.learning, ...((raw.learning as object) ?? {}) },
    autonomy: { ...DEFAULT_CONFIG.autonomy, ...((raw.autonomy as object) ?? {}) },
    digest: { ...DEFAULT_CONFIG.digest, ...((raw.digest as object) ?? {}) },
    delivery: { ...DEFAULT_CONFIG.delivery, ...((raw.delivery as object) ?? {}) },
    push: { ...DEFAULT_CONFIG.push, ...((raw.push as object) ?? {}) },
    investigation: { ...DEFAULT_CONFIG.investigation, ...((raw.investigation as object) ?? {}) },
    act: { ...DEFAULT_CONFIG.act, ...((raw.act as object) ?? {}) },
    watch: { ...DEFAULT_CONFIG.watch, ...((raw.watch as object) ?? {}) },
    skillsDirs: (Array.isArray(raw.skillsDirs) ? (raw.skillsDirs as string[]) : DEFAULT_CONFIG.skillsDirs)
      .filter((d): d is string => typeof d === "string" && d.trim() !== "")
      .map((d) => resolveDataPath(d, workspaceDir, d)),
    output: {
      ...DEFAULT_CONFIG.output,
      ...((raw.output as object) ?? {}),
      calibrationPath: resolveDataPath((raw as any).output?.calibrationPath, workspaceDir, DEFAULT_CONFIG.output.calibrationPath),
      actionLogPath: resolveDataPath((raw as any).output?.actionLogPath, workspaceDir, DEFAULT_CONFIG.output.actionLogPath),
      processedPassesPath: resolveDataPath((raw as any).output?.processedPassesPath, workspaceDir, DEFAULT_CONFIG.output.processedPassesPath),
      eventsPath: resolveDataPath((raw as any).output?.eventsPath, workspaceDir, DEFAULT_CONFIG.output.eventsPath),
      dashboardPath: resolveDataPath((raw as any).output?.dashboardPath, workspaceDir, DEFAULT_CONFIG.output.dashboardPath),
      goalsPath: resolveDataPath((raw as any).output?.goalsPath, workspaceDir, DEFAULT_CONFIG.output.goalsPath),
      pushStatePath: resolveDataPath((raw as any).output?.pushStatePath, workspaceDir, DEFAULT_CONFIG.output.pushStatePath),
      investigationStatePath: resolveDataPath((raw as any).output?.investigationStatePath, workspaceDir, DEFAULT_CONFIG.output.investigationStatePath),
      hypothesesPath: resolveDataPath((raw as any).output?.hypothesesPath, workspaceDir, DEFAULT_CONFIG.output.hypothesesPath),
      watchesPath: resolveDataPath((raw as any).output?.watchesPath, workspaceDir, DEFAULT_CONFIG.output.watchesPath),
      pendingDeliveriesPath: resolveDataPath((raw as any).output?.pendingDeliveriesPath, workspaceDir, DEFAULT_CONFIG.output.pendingDeliveriesPath),
      deliveredLedgerPath: resolveDataPath((raw as any).output?.deliveredLedgerPath, workspaceDir, DEFAULT_CONFIG.output.deliveredLedgerPath),
      skillProposalsPath: resolveDataPath((raw as any).output?.skillProposalsPath, workspaceDir, DEFAULT_CONFIG.output.skillProposalsPath),
      skillProposalsDocPath: resolveDataPath((raw as any).output?.skillProposalsDocPath, workspaceDir, DEFAULT_CONFIG.output.skillProposalsDocPath),
    },
  };
}

export default definePluginEntry({
  id: "sapience",
  name: "Sapience",
  description: "Autonomy layer: routes sapience-thinking proposals through tier function, calibrates to human preferences, delivers weekly digest",

  register(api: any) {
    // Register the CLI before the workspace guard below: OpenClaw collects CLI
    // registrars by calling register() with an empty runtime, so the guard throws
    // and bails there. CLI registration needs no workspace.
    if (typeof api.registerCli === "function") registerSapienceDoctorCli(api);

    let workspaceDir: string;
    try {
      workspaceDir = (api.runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig);
    } catch (err) {
      // In CLI-collection context the runtime is empty and this bail is
      // expected — stay silent. In a REAL gateway runtime a failure here is
      // exactly the silent death that left a plugin "vunknown" for 9 days;
      // record it so the doctor can say why.
      if (api?.runtime?.agent) {
        void writeStatusArtifact({
          pluginId: "sapience",
          version: resolvePluginVersion(),
          agentId: "unknown",
          resolvedWorkspaceDir: "",
          outputPaths: {},
          initError: String(err),
          initAt: new Date().toISOString(),
        }).catch(() => {});
      }
      return;
    }
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);

    // Invalid activeHours used to disable the plugin silently (NaN comparisons)
    // or throw on every run (bad timezone). Fall back to defaults, loudly.
    const hoursCheck = validateActiveHours(config.activeHours, DEFAULT_CONFIG.activeHours);
    config.activeHours = hoursCheck.hours;
    if (hoursCheck.errors.length > 0) {
      void appendEvent(config.output.eventsPath, {
        plugin: "sapience", type: "config_invalid", field: "activeHours", errors: hoursCheck.errors, using: "defaults",
      }).catch(() => {});
    }

    const extraDomains = compileExtraDomains((api.pluginConfig as Record<string, unknown>)?.domains);

    // Roots scanned for skills that already exist, so skill_proposal can refuse
    // to log a second copy of one. Resolved once; the scan itself happens per
    // call, since skills get installed while the gateway is up.
    const skillDirs = resolveSkillDirs(api, workspaceDir, config.skillsDirs);

    // Write presence marker synchronously so sapience-thinking's .present check is race-free.
    // It is refreshed on every routing run; thinking treats a stale marker as "router gone".
    const markerDir = join(workspaceDir, "sapience");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, ".present"), "", "utf-8");
    const lockFile = join(markerDir, ".routing.lock");
    const digestStatePath = join(markerDir, "digest-state.json");
    const skipStatePath = join(markerDir, ".skip-state.json");
    void clearLock(lockFile).catch(() => {});

    // Record what this plugin actually resolved, so `openclaw sapience doctor` can
    // report production reality (not a recomputation). Refreshed each routing
    // run as a liveness heartbeat (see sapience-thinking for why).
    const touchArtifact = () => writeStatusArtifact({
      pluginId: "sapience",
      version: resolvePluginVersion(),
      agentId: ((api.config as Record<string, unknown>)?.agent as Record<string, unknown>)?.id as string ?? "default",
      resolvedWorkspaceDir: workspaceDir,
      outputPaths: config.output as unknown as Record<string, string>,
      initAt: new Date().toISOString(),
    }).catch(() => {});
    void touchArtifact();

    if (typeof api.registerCommand === "function") {
      api.registerCommand({
        name: "sapience",
        description: "Show or adjust the autonomy calibration profile. Usage: /sapience [set <domain> <action_class> <tier>]",
        acceptsArgs: true,
        handler: async (ctx: { args?: string }) => ({
          text: await handleProfileCommand(ctx.args ?? "", config.output.calibrationPath, config.output.watchesPath),
        }),
      });
    }

    api.registerTool({
      name: "watch_metric",
      description: "Start watching a metric: the suite checks it on a cadence and surfaces notable moves (deltas vs baseline, or threshold crossings). Use when the user says 'keep an eye on X' or repeatedly asks for the same number.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short metric name, e.g. 'daily signups'" },
          query_hint: { type: "string", description: "Where/how to fetch the current value" },
          cadence_hours: { type: "number", description: "How often to check (default 24)" },
          policy: { type: "string", enum: ["percent", "above", "below", "always"], description: "When to notify (default percent)" },
          threshold: { type: "number", description: "Percent delta or absolute threshold (default 20 for percent)" },
        },
        required: ["name", "query_hint"],
      },
      async execute(_id: any, params: any) {
        try {
          const name = typeof params?.name === "string" ? params.name.trim() : "";
          const queryHint = typeof params?.query_hint === "string" ? params.query_hint.trim() : "";
          if (!name || !queryHint) return { content: [{ type: "text", text: "watch_metric requires name and query_hint." }] };
          const kind = ["percent", "above", "below", "always"].includes(params?.policy) ? params.policy : "percent";
          const threshold = typeof params?.threshold === "number" ? params.threshold : 20;
          const delta_policy = (kind === "always" ? { kind } : { kind, threshold }) as DeltaPolicy;
          const watch = await addWatch(config.output.watchesPath, {
            name, query_hint: queryHint,
            cadence_hours: typeof params?.cadence_hours === "number" && params.cadence_hours > 0 ? params.cadence_hours : 24,
            delta_policy,
          });
          await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "watch_added", watch: watch.name });
          return { content: [{ type: "text", text: `Watching "${watch.name}" every ${watch.cadence_hours}h.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] watch_metric error: ${String(err)}` }] };
        }
      },
    });

    api.registerTool({
      name: "watch_remove",
      description: "Stop watching a metric (by name or id).",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The watch name or id" } },
        required: ["name"],
      },
      async execute(_id: any, params: any) {
        try {
          const name = typeof params?.name === "string" ? params.name.trim() : "";
          if (!name) return { content: [{ type: "text", text: "watch_remove requires a name." }] };
          const list = await loadWatches(config.output.watchesPath);
          const match = list.find((w) => w.id === name || w.name.toLowerCase() === name.toLowerCase());
          const removed = match ? await removeWatch(config.output.watchesPath, match.id) : false;
          if (removed) await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "watch_removed", watch: match!.name });
          return { content: [{ type: "text", text: removed ? `Stopped watching "${match!.name}".` : `No watch named "${name}".\n${renderWatches(list)}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] watch_remove error: ${String(err)}` }] };
        }
      },
    });

    api.registerTool({
      name: "get_pending_deliveries",
      description: "Drain notifications that could not be delivered through the main-session path. Called by the sapience-delivery cron; the caller composes one message to the user from the returned items.",
      parameters: { type: "object", properties: {} },
      async execute(_id: any, _params: any) {
        try {
          if (!isWithinActiveHours(config.activeHours)) {
            return { content: [{ type: "text", text: "NOTHING_PENDING" }] };
          }
          const pending = await drainPendingDeliveries(config.output.pendingDeliveriesPath);
          if (pending.length === 0) {
            return { content: [{ type: "text", text: "NOTHING_PENDING" }] };
          }
          await appendEvent(config.output.eventsPath, {
            plugin: "sapience", type: "pending_deliveries_drained", count: pending.length,
          });
          const body = pending
            .map((p, i) => `--- pending ${i + 1}/${pending.length} (${p.kind}, queued ${p.queued_at}) ---\n${p.prompt}`)
            .join("\n\n");
          return { content: [{ type: "text", text: body }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] get_pending_deliveries error: ${String(err)}` }] };
        }
      },
    });

    api.registerTool({
      name: "skill_proposal",
      description: "Log (or add evidence to) a skill proposal. Call this whenever you notice you've done the same multi-step task more than once — querying a data warehouse, pulling a CRM report, refreshing a recurring slide. Check the installed skills first: this is for work nothing already does, and a proposal that duplicates an existing skill is rejected. Include the concrete queries, scripts, and examples you used: the entry doubles as the spec for building the skill. Never build or install the skill yourself; this surfaces the pattern to the human.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short skill name, e.g. 'weekly-usage-divergence-analysis'" },
          summary: { type: "string", description: "One line: what the skill would do" },
          spec_markdown: { type: "string", description: "Markdown spec detail: what it would do, what triggered this, queries/scripts/examples used, cadence, output shape, dependencies" },
          not_covered_by: { type: "string", description: "Only when an installed skill looks close: name the nearest existing skill and say what it can't do. Required to log a proposal that overlaps one." },
        },
        required: ["name", "summary", "spec_markdown"],
      },
      async execute(_id: any, params: any) {
        try {
          const name = typeof params?.name === "string" ? params.name.trim() : "";
          const summary = typeof params?.summary === "string" ? params.summary.trim() : "";
          const spec = typeof params?.spec_markdown === "string" ? params.spec_markdown.trim() : "";
          const notCoveredBy = typeof params?.not_covered_by === "string" ? params.not_covered_by.trim() : "";
          if (!name || !summary || !spec) {
            return { content: [{ type: "text", text: "skill_proposal requires name, summary, and spec_markdown." }] };
          }

          // Nothing checked this until a production pass proposed a skill the
          // install already had. Thinking passes run in isolated cron sessions
          // with no skill context, so the check has to live at the ledger's
          // door — it's the one point every path goes through.
          const installed = await discoverInstalledSkills(skillDirs);
          const verdict = checkAgainstInstalledSkills(installed, name, summary, notCoveredBy || undefined);
          if (verdict.blocked) {
            await appendEvent(config.output.eventsPath, {
              plugin: "sapience", type: "skill_proposal_duplicate_blocked",
              proposed_name: name, existing_skill: verdict.matched.name, reason: verdict.reason,
            });
            return { content: [{ type: "text", text: verdict.message }] };
          }

          const { created, proposal } = await upsertProposal(
            config.output.skillProposalsPath, config.output.skillProposalsDocPath,
            {
              name, summary,
              // The overlap ruling belongs in the spec: the human reading it
              // deserves to see which installed skill was nearly this one, and
              // the reason the agent gave for logging it anyway.
              spec_markdown: notCoveredBy && verdict.overlaps.length > 0
                ? [
                    spec,
                    `**Not covered by existing skills:** ${notCoveredBy}`,
                    `**Closest installed skills:**\n${renderInstalledSkills(verdict.overlaps.map((o) => o.skill))}`,
                  ].join("\n\n")
                : spec,
            }
          );
          await appendEvent(config.output.eventsPath, {
            plugin: "sapience",
            type: created ? "skill_proposal_created" : "skill_proposal_evidence",
            proposal_id: proposal.id,
            evidence_count: proposal.evidence_count,
          });
          if (created) {
            // The operator hears about new proposals through the normal
            // delivery path; evidence appends stay quiet (the digest covers
            // drift). A failed injection degrades to the pending queue.
            const note = `[SAPIENCE: SKILL PROPOSAL] The assistant logged a new skill proposal: "${proposal.name}" — ${proposal.summary}\n\nMention this briefly to the user: the spec is in skill-proposals.md, and nothing gets built unless they ask.`;
            const result = await enqueueMainSessionInjection(api, note);
            if (!result.enqueued) {
              await addPendingDelivery(config.output.pendingDeliveriesPath, {
                id: `skill-proposal-${proposal.id}`, kind: "item", prompt: note,
              }).catch(() => {});
            }
          }
          return {
            content: [{
              type: "text",
              text: created
                ? `Logged skill proposal "${proposal.name}" [${proposal.id}]. Spec appended to skill-proposals.md; the user will be notified.`
                : `Added evidence to "${proposal.name}" [${proposal.id}] (×${proposal.evidence_count}).`,
            }],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] skill_proposal error: ${String(err)}` }] };
        }
      },
    });

    api.registerTool({
      name: "skill_proposal_update",
      description: "Update a skill proposal's status after the human decides: 'building' (they asked for it), 'installed' (it exists now), or 'declined'.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "The proposal id or exact name" },
          status: { type: "string", enum: ["proposed", "building", "installed", "declined"] },
        },
        required: ["ref", "status"],
      },
      async execute(_id: any, params: any) {
        try {
          const ref = typeof params?.ref === "string" ? params.ref.trim() : "";
          const status = params?.status as SkillProposalStatus;
          if (!ref || !["proposed", "building", "installed", "declined"].includes(status)) {
            return { content: [{ type: "text", text: "skill_proposal_update requires ref and a valid status." }] };
          }
          const updated = await updateProposalStatus(
            config.output.skillProposalsPath, config.output.skillProposalsDocPath, ref, status
          );
          if (!updated) {
            const list = await loadProposals(config.output.skillProposalsPath);
            return { content: [{ type: "text", text: `No skill proposal matching "${ref}".\n${renderProposalsList(list)}` }] };
          }
          await appendEvent(config.output.eventsPath, {
            plugin: "sapience", type: "skill_proposal_updated", proposal_id: updated.id, status,
          });
          return { content: [{ type: "text", text: `"${updated.name}" → ${status}.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] skill_proposal_update error: ${String(err)}` }] };
        }
      },
    });

    api.registerTool({
      name: "skill_proposal_list",
      description: "List skill proposals with ids, status, and evidence counts.",
      parameters: { type: "object", properties: {} },
      async execute(_id: any, _params: any) {
        try {
          const list = await loadProposals(config.output.skillProposalsPath);
          return { content: [{ type: "text", text: renderProposalsList(list) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] skill_proposal_list error: ${String(err)}` }] };
        }
      },
    });

    // The correction path. Thinking passes write hunches into the ledger and
    // read them back as context, but until these tools existed nothing could
    // settle one from a conversation: recordVerdict had a single caller, the
    // internal investigation subagent. When a user said "you should have no
    // active issues with google auth" the agent verified it, replied that the
    // hypothesis was resolved, and wrote that to MEMORY.md — while all eight
    // ledger fragments stayed open and drove four more days of escalation.
    api.registerTool({
      name: "hypothesis_list",
      description:
        "List the open hypotheses sapience is tracking, with ids. These are unsettled guesses from background thinking passes, not established facts — check them against what you actually know.",
      parameters: { type: "object", properties: {} },
      async execute(_id: any, _params: any) {
        try {
          const list = await loadHypotheses(config.output.hypothesesPath);
          const live = list.filter((h) => h.status !== "refuted");
          if (live.length === 0) return { content: [{ type: "text", text: "No open hypotheses." }] };
          const text = live
            .map((h) => `- [${h.id}] (${h.status}, seen ${h.sightings}x) ${h.text}`)
            .join("\n");
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] hypothesis_list error: ${String(err)}` }] };
        }
      },
    });

    api.registerTool({
      name: "hypothesis_resolve",
      description:
        "Settle tracked hypotheses once you have real evidence — especially when the user tells you a supposed problem isn't real, or you verify first-hand that it is or isn't. Describe the subject in a few words (e.g. 'google auth') and every matching case is closed, so one correction clears the whole cluster. Use verdict 'refuted' when it is not true, 'supported' when confirmed. Record it as soon as you know; an unsettled hypothesis keeps feeding background passes.",
      parameters: {
        type: "object",
        properties: {
          match: { type: "string", description: "A few words describing the hypotheses to settle, e.g. 'google auth'." },
          verdict: { type: "string", enum: ["refuted", "supported", "inconclusive"] },
          note: { type: "string", description: "The evidence — what you checked, what the user said, what you observed." },
        },
        required: ["match", "verdict", "note"],
      },
      async execute(_id: any, params: any) {
        try {
          const closed = await resolveByText(
            config.output.hypothesesPath,
            String(params?.match ?? ""),
            params?.verdict as "refuted" | "supported" | "inconclusive",
            String(params?.note ?? "")
          );
          await appendEvent(config.output.eventsPath, {
            plugin: "sapience",
            type: "hypotheses_resolved",
            match: String(params?.match ?? ""),
            verdict: String(params?.verdict ?? ""),
            count: closed.length,
          });
          if (closed.length === 0) {
            return { content: [{ type: "text", text: `No open hypotheses matched "${params?.match}". Nothing to settle.` }] };
          }
          return {
            content: [{
              type: "text",
              text: `Settled ${closed.length} hypothes${closed.length === 1 ? "is" : "es"} as ${params?.verdict}:\n` +
                closed.map((h) => `- ${h.text}`).join("\n"),
            }],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] hypothesis_resolve error: ${String(err)}` }] };
        }
      },
    });

    api.registerTool({
      name: "process_proposals",
      description: "Process new proposals from the sapience-thinking log and route them through the autonomy tier function. Called by the sapience cron.",
      parameters: { type: "object", properties: {} },
      async execute(_id: any, _params: any) {
        try {
          void touchArtifact();
          if (!isWithinActiveHours(config.activeHours)) {
            await logSkipOnce(skipStatePath, "outside_hours", () =>
              appendEvent(config.output.eventsPath, { plugin: "sapience", type: "routing_skipped", reason: "outside_hours" }));
            await generateDashboard(config).catch(() => {});
            return { content: [{ type: "text", text: "NO_REPLY" }] };
          }

          // Overlapping routing runs double-deliver and clobber each other's
          // calibration writes; skip if another run holds the lock.
          const acquired = await acquireLock(lockFile);
          if (!acquired) {
            await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "routing_skipped", reason: "already_running" });
            return { content: [{ type: "text", text: "NO_REPLY" }] };
          }

          try {
            // Refresh the presence marker: sapience-thinking treats a marker
            // older than 2h as "router gone" and falls back to self-delivery.
            writeFileSync(join(markerDir, ".present"), "", "utf-8");

            let processed = await loadProcessedPasses(config.output.processedPassesPath);
            const profile = await loadProfile(config.output.calibrationPath);

            // On first run, mark all existing passes as processed to avoid re-delivering stale proposals
            if (processed.size === 0) {
              processed = await bootstrapProcessedPasses(
                config.proactiveThinking.proposalsPath,
                config.output.processedPassesPath,
              );
            }

            const newPasses = await readUnprocessedPasses(
              config.proactiveThinking.proposalsPath,
              processed
            );

            let updatedProcessed = processed;
            // Routing only ever ADDS calibration entries. Collect them and merge
            // against a freshly loaded profile at the end — saving the profile
            // snapshot from the top of the run silently reverted any confidence
            // change sapience-feedback applied while this run was in flight.
            let workingProfile = profile;
            const newEntries: typeof profile = [];
            let totalItems = 0;
            const byTier: Record<string, number> = {};
            // Delivery is per RUN, not per pass. This loop used to call
            // deliverItems once per pass, so delivery.maxPerCycle was really
            // "per pass" and a run that drained a backlog injected the cap
            // times the backlog depth — 6 passes became 15 separate notes on
            // the user's next turn, and the 19-pass morning drain was worse.
            const toDeliver: RoutedItem[] = [];

            for (const pass of newPasses) {
              const allItems = proposalSetToItems(pass, extraDomains);
              // The thinking model can re-emit the same proposal under a fresh
              // uuid every pass; pass-id dedupe never catches that. Suppress
              // items whose text was already delivered within the window.
              const { fresh: items, duplicates } = await dedupeDelivered(
                config.output.deliveredLedgerPath, allItems, config.delivery.dedupeWindowHours);
              for (const dup of duplicates) {
                await appendEvent(config.output.eventsPath, {
                  plugin: "sapience", type: "item_suppressed", proposal_id: dup.id,
                  domain: dup.domain, reason: "recently_delivered",
                });
              }
              // Route against the DECAYED view: trust earned months ago and
              // never reinforced should not still authorize autonomy.
              const routed = items.map(item => routeItem(item, decayProfile(workingProfile), config));
              const investigated = await investigateHunches(routed, api, config,
                (item) => routeItem(item, decayProfile(workingProfile), config));

              // Act items execute in isolated subagent sessions; everything
              // else is delivered as next-turn context.
              const acts = config.act.execute ? investigated.filter((i) => i.tier === "act") : [];
              const rest = config.act.execute ? investigated.filter((i) => i.tier !== "act") : investigated;
              toDeliver.push(...rest);
              if (acts.length > 0) await executeActItems(acts, api, config);
              updatedProcessed = await markPassProcessed(pass.pass_id, config.output.processedPassesPath, updatedProcessed);

              for (const item of investigated) {
                totalItems++;
                byTier[item.tier] = (byTier[item.tier] ?? 0) + 1;
                const exists = workingProfile.find(e => e.domain === item.domain && e.action_class === item.action_class);
                if (!exists) {
                  workingProfile = upsertEntry(workingProfile, item.domain, item.action_class, {
                    tier: config.autonomy.defaultTier,
                    confidence: 0,
                  });
                  newEntries.push(workingProfile.find(e => e.domain === item.domain && e.action_class === item.action_class)!);
                  await appendEvent(config.output.eventsPath, {
                    plugin: "sapience",
                    type: "calibration_change",
                    domain: item.domain,
                    action_class: item.action_class,
                    old_confidence: null,
                    new_confidence: 0,
                    old_tier: null,
                    new_tier: config.autonomy.defaultTier,
                    source: "new_entry",
                  });
                }
              }
            }

            if (toDeliver.length > 0) await deliverItems(toDeliver, api, config);

            if (newEntries.length > 0) {
              const fresh = await loadProfile(config.output.calibrationPath);
              await saveProfile(addMissingEntries(fresh, newEntries), config.output.calibrationPath);
            }

            if (newPasses.length === 0) {
              await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "routing_skipped", reason: "no_new_passes" });
            } else {
              await appendEvent(config.output.eventsPath, {
                plugin: "sapience",
                type: "routing_completed",
                passes: newPasses.length,
                items: totalItems,
                by_tier: byTier,
              });
            }

            if (config.digest.enabled) {
              const digestState = await readJsonSafe<{ lastSentDate: string | null }>(digestStatePath, { lastSentDate: null });
              const { due, localDate } = digestDue(config, digestState.lastSentDate);
              if (due) {
                const prompt = await buildDigestPrompt(config);
                const digestResult = await enqueueMainSessionInjection(api, prompt);
                if (digestResult.enqueued) {
                  await writeJsonAtomic(digestStatePath, { lastSentDate: localDate });
                  // The digest is weekly — always worth initiating contact for.
                  requestChannelPush(api, "sapience weekly digest");
                  await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "digest_delivered" });
                } else {
                  // Hand off to the sapience-delivery cron. Marking the date
                  // stops the every-pass retry; the id keeps the handoff
                  // idempotent even if the state write races.
                  const queued = await addPendingDelivery(config.output.pendingDeliveriesPath, {
                    id: `digest-${localDate}`,
                    kind: "digest",
                    prompt,
                  }).catch(() => false);
                  if (queued) await writeJsonAtomic(digestStatePath, { lastSentDate: localDate });
                  await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "delivery_failed", what: "digest", reason: digestResult.reason, queued });
                }
              }
            }

            // Due metric watches get their bounded read-only check each pass.
            await checkDueWatches(api, config).catch(() => {});

            await generateDashboard(config).catch(() => {});
            await clearSkipState(skipStatePath).catch(() => {});
            // Bound the action log; events.jsonl is rotated by generateDashboard.
            await rotateKeepingTail(config.output.actionLogPath).catch(() => {});
          } finally {
            await releaseLock(lockFile);
          }

          return { content: [{ type: "text", text: "NO_REPLY" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] process_proposals error: ${String(err)}` }] };
        }
      },
    });

  },
});
