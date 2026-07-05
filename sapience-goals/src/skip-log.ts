import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

// Log a skip event only on the transition into a skip reason, not on every
// repeat: an overnight install used to write an outside_hours event every 15
// minutes, all night — pure noise that trained readers to ignore the stream.
export async function logSkipOnce(statePath: string, reason: string, log: () => Promise<void>): Promise<void> {
  const state = await readJsonSafe<{ last: string }>(statePath, { last: "" });
  if (state.last === reason) return;
  await log();
  await writeJsonAtomic(statePath, { last: reason });
}

// Call on a successful (non-skipped) run so the next skip logs again.
export async function clearSkipState(statePath: string): Promise<void> {
  const state = await readJsonSafe<{ last: string }>(statePath, { last: "" });
  if (state.last !== "") await writeJsonAtomic(statePath, { last: "" });
}
