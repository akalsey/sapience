import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { resolvePath } from "./utils.js";
import type { FeedbackEntry } from "./types.js";

export async function appendFeedback(entry: FeedbackEntry, logPath: string): Promise<void> {
  const resolved = resolvePath(logPath);
  await mkdir(dirname(resolved), { recursive: true });

  const lines = [
    `## ${entry.detected_at}`,
    ``,
    `**Signal type:** ${entry.signal.type}`,
    `**Domain:** ${entry.signal.domain} / ${entry.signal.action_class}`,
    `**Message:** "${entry.signal.message}"`,
  ];

  if (entry.signal.suggested_tier) {
    lines.push(`**Tier adjustment:** → ${entry.signal.suggested_tier}`);
  }
  if (entry.meta_pointer) {
    lines.push(`**Meta-pointer written:** ${entry.meta_pointer}`);
  }

  lines.push(``, `---`, ``);
  await appendFile(resolved, lines.join("\n") + "\n", "utf-8");
}
