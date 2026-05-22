import { homedir } from "os";
import { join } from "path";
import type { SapienceConfig } from "./types.js";

export function resolvePath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function resolveDataPath(override: string | undefined, workspaceDir: string, defaultRelative: string): string {
  if (!override) return join(workspaceDir, defaultRelative);
  if (override.startsWith('/') || override.startsWith('~/')) return resolvePath(override);
  return join(workspaceDir, override);
}

export function isWithinActiveHours(config: SapienceConfig): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: config.activeHours.timezone,
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const [hours, minutes] = formatter.format(new Date()).split(":").map(Number);
  const now = (hours ?? 0) * 60 + (minutes ?? 0);
  const [sh, sm] = config.activeHours.start.split(":").map(Number);
  const [eh, em] = config.activeHours.end.split(":").map(Number);
  return now >= (sh ?? 0) * 60 + (sm ?? 0) && now <= (eh ?? 0) * 60 + (em ?? 0);
}
