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

export function generateId(): string {
  return `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
