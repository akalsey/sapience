import { readFile } from "fs/promises";

// Whether proposal delivery is actually reaching the user. Passes must read
// this before interpreting user silence: a broken delivery pipe is
// indistinguishable from neglect without an explicit label in context.

export interface DeliveryStatus {
  failures: number;
  lastFailureAt?: string;
  lastReason?: string;
}

// Both the thinking plugin and the sapience router log `delivery_failed` to
// the shared events file; the router logs `item_delivered` on success. A
// success supersedes earlier failures — only unresolved ones count.
export async function readDeliveryStatus(eventsPath: string, sinceMs: number): Promise<DeliveryStatus> {
  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf-8");
  } catch {
    return { failures: 0 };
  }

  const status: DeliveryStatus = { failures: 0 };
  // The events file is tail-rotated by its writers; cap parsing anyway.
  for (const line of raw.trim().split("\n").slice(-2000)) {
    let event: { type?: string; ts?: string; reason?: string };
    try { event = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(event.ts ?? "");
    if (Number.isNaN(ts) || ts < sinceMs) continue;
    if (event.type === "item_delivered") {
      status.failures = 0;
      delete status.lastFailureAt;
      delete status.lastReason;
    } else if (event.type === "delivery_failed") {
      status.failures += 1;
      status.lastFailureAt = event.ts;
      if (typeof event.reason === "string") status.lastReason = event.reason;
    }
  }
  return status;
}

export function formatDeliveryWarning(status: DeliveryStatus): string {
  if (status.failures === 0) return "";
  const reason = status.lastReason ? ` (last error: "${status.lastReason}")` : "";
  const when = status.lastFailureAt ? `, most recently at ${status.lastFailureAt}` : "";
  return [
    `Proposal delivery to the user is FAILING: ${status.failures} delivery attempt(s) could not be sent${when}${reason}.`,
    "The user has NOT seen recent proposals or alerts. Their silence means nothing — it is not disinterest, not a broken oversight loop, and not an emergency.",
    "Do not escalate priorities, re-issue proposals, or propose failsafe measures because of unacknowledged items. The delivery failure is already recorded and surfaced to the user through the sapience doctor.",
  ].join("\n");
}
