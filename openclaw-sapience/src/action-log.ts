import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { resolvePath } from "./utils.js";
import type { RoutedItem } from "./types.js";

export async function appendAction(item: RoutedItem, note: string, logPath: string): Promise<void> {
  const resolved = resolvePath(logPath);
  await mkdir(dirname(resolved), { recursive: true });
  const ts = new Date().toISOString();
  const entry = [
    `## ${ts}`,
    ``,
    `**Action:** ${item.text}`,
    `**Domain/class:** ${item.domain} / ${item.action_class}`,
    `**Tier:** Act (confidence ${item.confidence.toFixed(2)})`,
    `**Note:** ${note}`,
    ``,
    `---`,
    ``,
  ].join("\n");
  await appendFile(resolved, entry, "utf-8");
}
