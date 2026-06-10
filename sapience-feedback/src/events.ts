import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";

export interface SapienceEvent {
  ts: string;                       // ISO-8601, set by appendEvent if absent
  plugin: "thinking" | "sapience" | "feedback" | "goals";
  type: string;
  [key: string]: unknown;
}

export async function appendEvent(
  eventsPath: string,
  event: Omit<SapienceEvent, "ts"> & { ts?: string }
): Promise<void> {
  try {
    const full = { ...event, ts: event.ts ?? new Date().toISOString() };
    await mkdir(dirname(eventsPath), { recursive: true });
    await appendFile(eventsPath, JSON.stringify(full) + "\n", "utf-8");
  } catch {
    // Observability must never break the host plugin.
  }
}
