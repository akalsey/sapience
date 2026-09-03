// The exact `openclaw cron add` invocations the suite registers.
//
// Single source of truth for the doctor's --fix registrar. install.sh builds the
// same commands in bash and must be changed in lockstep — cron-args.test.ts
// asserts the shapes both sides depend on.

import {
  SUITE_CRONS,
  SUITE_CRON_SCHEDULE,
  DELIVERY_POLL_CRON,
  deliveryPollArgv,
  qualifyDeclarationKey,
  type SuiteCronSpec,
} from "./inventory.js";

export interface DeliveryTarget {
  channel: string;
  to: string;
}

export interface CronRegistrationOptions {
  // Omitted entirely when unknown: openclaw's scheduler resolves the configured
  // default agent, whereas a guessed id fails the job's every run with
  // "cron job agent is unavailable: <id>".
  agentId?: string;
  // Multi-agent installs register one copy per agent, named "<base>-<agent>".
  name?: string;
  // When the operator has pinned a delivery destination, the delivery job can
  // send through the `message` tool instead of the runner's announce fallback.
  // That is the quieter arrangement: with no announce route, an empty turn or a
  // malformed tool call delivers nothing at all, rather than the host's
  // placeholder sentence. Without a pinned target we keep announce, because its
  // "last active channel" resolution is the only route an unpinned install has.
  deliveryTarget?: DeliveryTarget;
  // Absolute path to the openclaw binary, for the poll job's argv payload.
  openclawBin?: string;
}

// Qualify a declaration key by agent ONLY when the job name is itself
// agent-scoped. install.sh suffixes both name and key on a multi-agent install
// and neither on a single-agent one; the doctor registers base names and used
// to suffix the key anyway whenever it could resolve an agent id. The two then
// disagreed — `sapience:delivery` versus `sapience:delivery:main` — so an
// installer run could not match a doctor-registered job and minted a duplicate
// beside it. Deriving the qualifier from the name makes them agree by
// construction.
function declarationKeyFor(spec: { base: string; declarationKey: string }, opts: CronRegistrationOptions): string {
  const name = opts.name ?? spec.base;
  return qualifyDeclarationKey(spec.declarationKey, name === spec.base ? undefined : opts.agentId);
}

const TIMEOUT_SECONDS = "120";

function deliveryToolMessage(target: DeliveryTarget): string {
  return (
    "You are the sapience delivery agent. Call get_pending_deliveries() to fetch notifications that could not reach the user through the normal path. " +
    "If it returns NOTHING_PENDING, reply NO_REPLY and stop. " +
    "Otherwise compose ONE concise message to the user covering every pending item — lead with the most important, keep it brief, and write as the assistant speaking directly to the user. " +
    `Send it with the message tool to channel "${target.channel}", target "${target.to}". After the message tool reports success, reply NO_REPLY and stop. ` +
    "If the tool is not available, reply NO_REPLY and stop."
  );
}

function deliveryArgs(spec: SuiteCronSpec, opts: CronRegistrationOptions): string[] {
  if (!spec.announce) return ["--no-deliver"];
  const target = opts.deliveryTarget;
  if (!target) return ["--announce"];
  return ["--no-deliver", "--channel", target.channel, "--to", target.to];
}

function toolsFor(spec: SuiteCronSpec, opts: CronRegistrationOptions): string[] {
  const usesMessageTool = spec.announce === true && Boolean(opts.deliveryTarget);
  return usesMessageTool ? [...spec.tools, "message"] : [...spec.tools];
}

function messageFor(spec: SuiteCronSpec, opts: CronRegistrationOptions): string {
  return spec.announce === true && opts.deliveryTarget
    ? deliveryToolMessage(opts.deliveryTarget)
    : spec.message;
}

export function cronRegisterArgs(base: string, opts: CronRegistrationOptions = {}): string[] {
  const spec = SUITE_CRONS.find((c) => c.base === base);
  if (!spec) throw new Error(`no registration template for cron ${base}`);
  return [
    "cron", "add",
    "--name", opts.name ?? spec.base,
    "--declaration-key", declarationKeyFor(spec, opts),
    "--cron", SUITE_CRON_SCHEDULE,
    "--session", "isolated",
    ...(opts.agentId ? ["--agent", opts.agentId] : []),
    // On-demand jobs keep a sane schedule expression for anyone who enables
    // them by hand, but ship disabled so only the poll job starts them.
    ...(spec.onDemand ? ["--disabled"] : []),
    ...deliveryArgs(spec, opts),
    // A single-tool job has no use for the operator's agent instructions,
    // long-term memory file, or persona documents. Injecting them cost roughly
    // 15k input tokens per run to make one tool call.
    // Deliberately no --model, ever. The suite has no basis for an opinion
    // about a user's model preferences, so it never sets one — not even to
    // carry across a value it found on an existing job. A replacement that
    // drops an operator's pin says so instead (install.sh warns; the doctor
    // names it in the finding), leaving the choice with them.
    "--light-context",
    "--tools", toolsFor(spec, opts).join(","),
    "--message", messageFor(spec, opts),
    "--timeout-seconds", TIMEOUT_SECONDS,
  ];
}

// The command-payload poll job. No --tools, --message, --light-context or
// --model: none apply to a command payload, which never starts an agent turn.
export function deliveryPollRegisterArgs(opts: CronRegistrationOptions = {}): string[] {
  return [
    "cron", "add",
    "--name", opts.name ?? DELIVERY_POLL_CRON.base,
    "--declaration-key", declarationKeyFor(DELIVERY_POLL_CRON, opts),
    "--cron", SUITE_CRON_SCHEDULE,
    "--session", "isolated",
    ...(opts.agentId ? ["--agent", opts.agentId] : []),
    "--no-deliver",
    "--command-argv", JSON.stringify(deliveryPollArgv(opts.openclawBin ?? "openclaw")),
    "--timeout-seconds", TIMEOUT_SECONDS,
  ];
}
