import { readFile } from "fs/promises";
import { resolvePath } from "./utils.js";
import type { SapienceConfig } from "./types.js";

export function isDigestDay(config: SapienceConfig): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.activeHours.timezone,
    weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);

  const weekday = parts.find(p => p.type === "weekday")?.value?.toLowerCase() ?? "";
  const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "0");
  const minute = parseInt(parts.find(p => p.type === "minute")?.value ?? "0");
  const [digestHour, digestMinute] = config.digest.time.split(":").map(Number);

  return weekday === config.digest.day.toLowerCase()
    && hour === (digestHour ?? 17)
    && minute < 30;
}

export async function buildDigestPrompt(config: SapienceConfig): Promise<string> {
  let actionLog = "No actions logged this week.";
  try {
    const raw = await readFile(resolvePath(config.output.actionLogPath), "utf-8");
    actionLog = raw.length > 3000
      ? "...(earlier entries omitted)\n\n" + raw.slice(-3000)
      : raw;
  } catch { /* file absent is fine */ }

  return `[SAPIENCE: WEEKLY DIGEST] Build and deliver a weekly summary to the user.

## Action log from this week
${actionLog}

## Instructions

Deliver a brief weekly summary with these sections:

**What I did this week:** List actions actually taken (from the action log above). If nothing was logged, say so.

**Pending your review:** Any proposals from this week that are still waiting on human input.

**What I plan next week:** Based on any active goals or pending work you're aware of.

Keep it concise. This is a status ping, not a report. Omit sections you have nothing meaningful to say about.`;
}
