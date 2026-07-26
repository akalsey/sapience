import { readFile } from "fs/promises";
import { resolvePath } from "./utils.js";
import type { SapienceConfig } from "./types.js";
import { loadProposals, renderProposalsList } from "./skill-proposals.js";

// Whether the digest should fire now. The caller persists localDate after a
// successful send and passes it back as lastSentDate — that's what prevents
// double delivery on a 15-minute cron (the old window check fired twice) and
// lets a missed slot catch up later the same day. Minutes are honored, so
// "17:45" fires at 17:45, not during the whole 17:00 hour.
export function digestDue(
  config: SapienceConfig,
  lastSentDate: string | null,
  now: Date = new Date()
): { due: boolean; localDate: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.activeHours.timezone,
    weekday: "long", hour: "2-digit", minute: "2-digit",
    year: "numeric", month: "2-digit", day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";

  const localDate = `${get("year")}-${get("month")}-${get("day")}`;
  const weekday = get("weekday").toLowerCase();
  const minutesNow = parseInt(get("hour") || "0") * 60 + parseInt(get("minute") || "0");
  const [digestHour, digestMinute] = config.digest.time.split(":").map(Number);
  const target = (digestHour ?? 17) * 60 + (digestMinute ?? 0);

  const due = weekday === config.digest.day.toLowerCase()
    && minutesNow >= target
    && lastSentDate !== localDate;
  return { due, localDate };
}

export async function buildDigestPrompt(config: SapienceConfig): Promise<string> {
  let actionLog = "No actions logged this week.";
  try {
    const raw = await readFile(resolvePath(config.output.actionLogPath), "utf-8");
    actionLog = raw.length > 3000
      ? "...(earlier entries omitted)\n\n" + raw.slice(-3000)
      : raw;
  } catch { /* file absent is fine */ }

  // Open skill proposals resurface weekly so a logged pattern the user never
  // reacted to doesn't rot silently in the ledger.
  const open = (await loadProposals(config.output.skillProposalsPath))
    .filter((p) => p.status === "proposed" || p.status === "building");
  const skillsSection = open.length === 0 ? "" : `
## Skill proposals awaiting your decision
${renderProposalsList(open)}
`;

  return `[SAPIENCE: WEEKLY DIGEST] Build and deliver a weekly summary to the user.

## Action log from this week
${actionLog}
${skillsSection}
## Instructions

Deliver a brief weekly summary with these sections:

**What I did this week:** List actions actually taken (from the action log above). If nothing was logged, say so.

**Pending your review:** Any proposals from this week that are still waiting on human input.

**What I plan next week:** Based on any active goals or pending work you're aware of.

Keep it concise. This is a status ping, not a report. Omit sections you have nothing meaningful to say about.

End with ONE calibration question drawn from the action log above — pick the domain where you acted autonomously most often and ask whether to keep that setting (e.g. "I did X without asking 4 times this week — keep it that way, or check in first?"). Skip the question if nothing ran autonomously.`;
}
