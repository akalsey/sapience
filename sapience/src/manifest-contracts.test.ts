import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// openclaw rejects any registered tool not declared in the manifest's
// contracts.tools — silently, from the plugin's perspective: register()
// succeeds, the tool just never exists in the gateway. Every tool added after
// the manifest was first written shipped in exactly that state (production
// logged "plugin must declare contracts.tools for: <name>" nine times across
// the suite). This pins the manifest to the source so a new registerTool
// without a matching contracts entry fails CI instead of failing in the field.
describe("openclaw.plugin.json contracts", () => {
  it("declares every tool the plugin registers", () => {
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(readFileSync(join(pkgRoot, "openclaw.plugin.json"), "utf-8"));
    const declared: string[] = manifest?.contracts?.tools ?? [];

    const registered = new Set<string>();
    for (const file of readdirSync(join(pkgRoot, "src"))) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(pkgRoot, "src", file), "utf-8");
      for (const m of src.matchAll(/registerTool\(\{\s*name:\s*"([a-z_]+)"/g)) {
        registered.add(m[1]!);
      }
    }

    expect(registered.size).toBeGreaterThan(0);
    for (const name of registered) {
      expect(declared, `contracts.tools is missing "${name}"`).toContain(name);
    }
  });
});
