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

export function buildAuditCronArgs(name: string, auditText: string, agentId: string): string[] {
  return [
    "cron", "add",
    "--name", name,
    "--cron", "0 9 * * 1",
    "--session", "isolated",
    "--agent", agentId,
    "--no-deliver",
    "--message",
    `You are running a recurring audit the user accepted: ${auditText}. Perform the audit with your available tools (read-only where possible), then report findings — or a clean bill — to the user. If nothing needs attention, keep it to one line.`,
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
  agentId: string,
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
