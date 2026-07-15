// Proactive channel push. Next-turn injection alone means the agent can never
// initiate contact — proposals sit queued until the user happens to message.
// For items worth interrupting for, we request a heartbeat targeting the last
// active channel (the same override the cron service uses); the heartbeat turn
// picks up the queued injection and the agent delivers it as a real outbound
// message. Budgeted, because an agent that pings all day gets muted.

export interface PushPolicy {
  enabled: boolean;
  maxPerDay: number;
  minPriority: number;
}

export const DEFAULT_PUSH_POLICY: PushPolicy = {
  enabled: true,
  maxPerDay: 6,
  minPriority: 4,
};

export interface PushState {
  date: string;
  count: number;
}


export function localDateIn(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Priority gates the push, not tier: on a young install everything routes to
// the learning tier (no calibration yet), and a tier-based rule silently
// exempted exactly the P5 "needs human attention today" items from the
// channel — the human heard nothing while passes escalated about being
// ignored. The daily budget is the noise control.
export function shouldPush(
  item: { tier: string; priority: number },
  policy: PushPolicy,
  state: PushState,
  localDate: string
): boolean {
  if (!policy.enabled) return false;
  if (item.priority < policy.minPriority) return false;
  const spentToday = state.date === localDate ? state.count : 0;
  return spentToday < policy.maxPerDay;
}

export function notePush(state: PushState, localDate: string): PushState {
  return state.date === localDate
    ? { date: localDate, count: state.count + 1 }
    : { date: localDate, count: 1 };
}

// Fire-and-forget wake request; coalesces if several pushes land together.
export function requestChannelPush(api: any, reason: string): boolean {
  const request = api?.runtime?.system?.requestHeartbeat;
  if (typeof request !== "function") return false;
  try {
    request({
      source: "other",
      intent: "event",
      reason,
      heartbeat: { target: "last" },
    });
    return true;
  } catch {
    return false;
  }
}
