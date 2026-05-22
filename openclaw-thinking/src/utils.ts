import { homedir } from "os";
import { join } from "path";

export function resolvePath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// Rough estimate: ~4 chars per token on average; intentionally imprecise
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
