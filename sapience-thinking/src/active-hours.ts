// Active-hours parsing and checking, shared (copied) across the suite's
// plugins. Validation exists because invalid config used to fail silently in
// the worst way: "8am" parsed to NaN, every comparison returned false, and the
// plugin skipped every run forever; a bad timezone made Intl throw on every
// tool call instead.

export interface ActiveHours {
  start: string;
  end: string;
  timezone: string;
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function parseMinutes(value: string): number | null {
  const m = TIME_RE.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function timezoneValid(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Returns the input when valid, otherwise the fallback plus the reasons —
// callers keep running on defaults and surface the errors loudly.
export function validateActiveHours(raw: ActiveHours, fallback: ActiveHours): { hours: ActiveHours; errors: string[] } {
  const errors: string[] = [];
  if (parseMinutes(raw.start) === null) errors.push(`activeHours.start "${raw.start}" is not HH:MM`);
  if (parseMinutes(raw.end) === null) errors.push(`activeHours.end "${raw.end}" is not HH:MM`);
  if (!timezoneValid(raw.timezone)) errors.push(`activeHours.timezone "${raw.timezone}" is not a valid IANA timezone`);
  return errors.length === 0 ? { hours: raw, errors } : { hours: fallback, errors };
}

export function isWithinActiveHours(hours: ActiveHours, now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timezone,
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? "0");
  const current = get("hour") * 60 + get("minute");

  const start = parseMinutes(hours.start) ?? 0;
  const end = parseMinutes(hours.end) ?? 24 * 60 - 1;

  // start > end means the window crosses midnight.
  return start <= end
    ? current >= start && current <= end
    : current >= start || current <= end;
}
