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

  // Without cliCommands, an external plugin falls into openclaw's legacy path
  // (src/plugins/cli-root-descriptors.ts) and the host LOADS the plugin runtime
  // to collect CLI registrars. That load is the "cli-metadata" registration in
  // which reading api.runtime throws — which failed the whole plugin and took
  // `openclaw sapience doctor` down with it. Declaring the command here means
  // the host never executes plugin code to learn the CLI surface.
  it("declares its root CLI command so the host never loads plugin code for CLI metadata", () => {
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(readFileSync(join(pkgRoot, "openclaw.plugin.json"), "utf-8"));
    const cliCommands: Array<Record<string, unknown>> = manifest?.cliCommands ?? [];

    expect(cliCommands.length).toBeGreaterThan(0);
    for (const row of cliCommands) {
      // The host requires all three fields on every row.
      expect(typeof row.name).toBe("string");
      expect(typeof row.description).toBe("string");
      expect(typeof row.hasSubcommands).toBe("boolean");
    }

    // The manifest and the runtime registrar must name the same root command,
    // or `openclaw --help` advertises one the plugin does not actually add.
    const cliSrc = readFileSync(join(pkgRoot, "src", "doctor", "cli.ts"), "utf-8");
    const registrarRoots = [...cliSrc.matchAll(/program\.command\("([a-z-]+)"\)/g)].map((m) => m[1]!);
    expect(registrarRoots.length).toBeGreaterThan(0);
    for (const root of registrarRoots) {
      expect(cliCommands.map((c) => c.name), `cliCommands is missing "${root}"`).toContain(root);
    }
  });
});
