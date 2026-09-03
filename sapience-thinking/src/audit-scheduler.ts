import { execFile } from "child_process";
import { promisify } from "util";

const defaultExec = async (cmd: string, args: string[]): Promise<void> => {
  await promisify(execFile)(cmd, args);
};

// An accepted audit proposal becomes recurring coverage instead of a one-off:
// the whole point of proposed_audits is "this domain has no scheduled checks",
// so acceptance registers the check. Jobs are tagged with the sapience-audit-
// prefix so they're identifiable (and retirable) as suite-created.

export function auditCronName(text: string): string {
  const full = text.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let slug = full.slice(0, 40);
  // Don't end on a truncated word: cut back to the last complete one.
  if (full.length > 40 && slug.includes("-")) slug = slug.slice(0, slug.lastIndexOf("-"));
  return `sapience-audit-${slug.replace(/-+$/, "")}`;
}

// Stable identity for the job, independent of its name. openclaw matches an
// existing job by declaration key and updates it in place, so re-accepting the
// same audit (or shipping a renamed template) converges instead of stacking a
// second copy. The `heartbeat:`, `heartbeat-task:` and `skill-collection-review:`
// namespaces are reserved for the gateway; `sapience:` is ours.
export function auditDeclarationKey(name: string): string {
  return `sapience:audit:${name}`;
}

export function buildAuditCronArgs(
  name: string,
  auditText: string,
  agentId: string | undefined
): string[] {
  return [
    "cron", "add",
    "--name", name,
    "--declaration-key", auditDeclarationKey(name),
    "--cron", "0 9 * * 1",
    "--session", "isolated",
    // Omitted when unknown: openclaw resolves the configured default agent
    // itself, whereas a guessed id fails the job's every run with
    // "cron job agent is unavailable: <id>".
    ...(agentId ? ["--agent", agentId] : []),
    "--no-deliver",
    // A single-purpose audit has no use for the operator's agent instructions,
    // memory file, or persona documents — it gets its task from this prompt.
    "--light-context",
    "--message",
    `You are running a recurring audit the user accepted: ${auditText}. Perform the audit with your available tools (read-only where possible). If anything needs attention, report the findings to the user. If nothing does, reply NO_REPLY and stop — do not send a clean-bill message.`,
    "--timeout-seconds", "300",
  ];
}

export interface ScheduleAuditResult {
  ok: boolean;
  name: string;
  error?: string;
}

export async function scheduleAudit(
  auditText: string,
  agentId: string | undefined,
  exec: (cmd: string, args: string[]) => Promise<void> = defaultExec
): Promise<ScheduleAuditResult> {
  const name = auditCronName(auditText);
  try {
    await exec("openclaw", buildAuditCronArgs(name, auditText, agentId));
    return { ok: true, name };
  } catch (err) {
    return { ok: false, name, error: String(err) };
  }
}
