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

// Rough estimate: ~4 chars per token on average; intentionally imprecise
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// OpenClaw session transcript line: role/content nested under `message`, with
// content as a string or an array of {type:"text", text} blocks. Legacy
// top-level {role, content} is accepted too. Everything else (session,
// model_change, custom, trajectory records) is ignored.
interface TranscriptLine {
  role?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
}

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join(" ");
  }
  return "";
}

export function extractTranscriptMessage(line: unknown): { role: string; text: string } | null {
  const l = line as TranscriptLine | undefined;
  if (!l || typeof l !== "object") return null;
  const src = l.message && typeof l.message === "object" ? l.message : l;
  const role = src.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = extractContent(src.content);
  return text ? { role, text } : null;
}
