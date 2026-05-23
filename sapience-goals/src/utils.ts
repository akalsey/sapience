import { homedir } from "os";
import { join } from "path";
import type { GoalsConfig } from "./types.js";

export function resolvePath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function resolveDataPath(override: string | undefined, workspaceDir: string, defaultRelative: string): string {
  if (!override) return join(workspaceDir, defaultRelative);
  if (override.startsWith('/') || override.startsWith('~/')) return resolvePath(override);
  return join(workspaceDir, override);
}

export function generateId(): string {
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isWithinActiveHours(config: GoalsConfig): boolean {
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

export function nextWeeklyDate(day: string, time: string, timezone: string): string {
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const targetDay = dayNames.indexOf(day.toLowerCase());
  const now = new Date();

  const weekdayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" });
  const currentDay = dayNames.indexOf(weekdayFormatter.format(now).toLowerCase());
  const daysUntil = ((targetDay - currentDay) + 7) % 7 || 7;

  // Get the calendar date for the target day in the target timezone
  const approxTarget = new Date(now.getTime() + daysUntil * 24 * 60 * 60 * 1000);
  const localDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(approxTarget); // "YYYY-MM-DD"

  const [h, m] = time.split(":").map(Number);
  const targetH = h ?? 9;
  const targetM = m ?? 0;

  // UTC midnight for the target calendar date
  const midnightUtc = new Date(`${localDateStr}T00:00:00Z`);

  // Compute the UTC offset for the target timezone at this date:
  // offsetMs = (UTC wall-clock parsed as local) - (TZ wall-clock parsed as local)
  // = how many ms ahead of UTC midnight the target timezone's midnight falls
  const utcRepr = new Date(midnightUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const tzRepr = new Date(midnightUtc.toLocaleString("en-US", { timeZone: timezone }));
  const offsetMs = utcRepr.getTime() - tzRepr.getTime();

  return new Date(midnightUtc.getTime() + offsetMs + targetH * 3_600_000 + targetM * 60_000).toISOString();
}
