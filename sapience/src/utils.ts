import { homedir } from "os";
import { join } from "path";

export function resolvePath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function resolveDataPath(override: string | undefined, workspaceDir: string, defaultRelative: string): string {
  if (!override) return join(workspaceDir, defaultRelative);
  if (override.startsWith('/') || override.startsWith('~/')) return resolvePath(override);
  return join(workspaceDir, override);
}

// ── shared subagent plumbing ────────────────────────────────────────────────
// investigation, act execution, and watch checks all run the same loop: spin
// up a subagent, wait, read its transcript, delete the session. Kept here so
// the three callers can't drift.

export function extractAssistantText(messages: unknown[]): string {
  const texts: string[] = [];
  for (const raw of messages) {
    const line = raw as { message?: { role?: string; content?: unknown }; role?: string; content?: unknown };
    const src = line.message && typeof line.message === "object" ? line.message : line;
    if (src.role !== "assistant") continue;
    if (typeof src.content === "string") texts.push(src.content);
    else if (Array.isArray(src.content)) {
      for (const c of src.content) {
        if (c && typeof c === "object" && (c as { type?: string }).type === "text") texts.push((c as { text?: string }).text ?? "");
      }
    }
  }
  return texts.join("\n");
}

export type SubagentTextResult =
  | { status: "ok"; text: string }
  | { status: "error" | "timeout"; error?: string }
  | null; // subagent runtime unavailable

export async function runSubagentForText(
  api: any,
  sessionKey: string,
  runOpts: { message: string; extraSystemPrompt?: string; lightContext?: boolean },
  timeoutMs: number,
  messageLimit: number
): Promise<SubagentTextResult> {
  const subagent = api?.runtime?.subagent;
  if (!subagent || typeof subagent.run !== "function") return null;
  try {
    const { runId } = await subagent.run({ sessionKey, deliver: false, ...runOpts });
    const wait = await subagent.waitForRun({ runId, timeoutMs });
    if (wait.status !== "ok") return { status: wait.status as "error" | "timeout", error: wait.error };
    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: messageLimit });
    return { status: "ok", text: extractAssistantText(messages ?? []) };
  } catch (err) {
    return { status: "error", error: String(err) };
  } finally {
    try { await subagent.deleteSession({ sessionKey }); } catch { /* best effort */ }
  }
}
