// Changesets bumps each workspace's package.json; openclaw reads the version
// from openclaw.plugin.json. Keep the two in lockstep — run after
// `changeset version` (wired into the root "version" script).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).workspaces;

for (const ws of workspaces) {
  const pkgPath = join(root, ws, "package.json");
  const pluginPath = join(root, ws, "openclaw.plugin.json");
  if (!existsSync(pluginPath)) continue;
  const { version } = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const plugin = JSON.parse(readFileSync(pluginPath, "utf-8"));
  if (plugin.version === version) continue;
  plugin.version = version;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
  console.log(`${ws}: openclaw.plugin.json ${version}`);
}
