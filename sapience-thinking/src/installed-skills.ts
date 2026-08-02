import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

// The skills this install already has, rendered into the pass prompt.
//
// A thinking pass runs in an isolated cron session: no workspace files in
// context, no skill loading, nothing but what get_thinking_context hands it.
// So when the activity showed a task done twice, the pass proposed codifying
// it as a skill with no way of knowing one already existed — and a duplicate
// proposal reached the operator.
//
// The scan mirrors sapience's installed-skills.ts (thinking reads sapience's
// world but never depends on its package). Keep the two in lockstep: they
// exist as two copies to hold the package boundary, not to drift.

export interface InstalledSkill {
  name: string;
  description: string;
  path: string;
}

const MAX_DEPTH = 2;
const MAX_SKILLS = 250;

function unquote(value: string): string {
  const v = value.trim().replace(/^[>|][-+]?\s*/, "");
  const m = /^(['"])([\s\S]*)\1$/.exec(v);
  return (m ? m[2]! : v).trim();
}

export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (m) {
      key = m[1]!.toLowerCase();
      fields[key] = m[2]!.trim();
      continue;
    }
    if (key && /^\s+\S/.test(line)) fields[key] = `${fields[key] ?? ""} ${line.trim()}`.trim();
  }
  const name = fields.name !== undefined ? unquote(fields.name) : undefined;
  const description = fields.description !== undefined ? unquote(fields.description) : undefined;
  return { name: name || undefined, description: description || undefined };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function scanSkillDir(dir: string, depth: number, out: InstalledSkill[]): Promise<void> {
  if (out.length >= MAX_SKILLS) return;
  let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // root absent — nothing installed there
  }
  for (const entry of entries) {
    if (out.length >= MAX_SKILLS) return;
    if (entry.name.startsWith(".")) continue;
    const child = join(dir, entry.name);
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDir(child)))) continue;

    const skillFile = join(child, "SKILL.md");
    let text: string | null = null;
    try { text = await readFile(skillFile, "utf-8"); } catch { /* not a skill dir */ }
    if (text !== null) {
      const fm = parseSkillFrontmatter(text);
      out.push({ name: fm.name ?? entry.name, description: fm.description ?? "", path: skillFile });
    } else if (depth < MAX_DEPTH) {
      await scanSkillDir(child, depth + 1, out);
    }
  }
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export async function discoverInstalledSkills(dirs: string[]): Promise<InstalledSkill[]> {
  const found: InstalledSkill[] = [];
  for (const dir of dirs) await scanSkillDir(dir, 1, found);
  const seen = new Set<string>();
  return found.filter((s) => {
    const key = slug(s.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Workspace skills, the global install, and whatever extra roots the operator
// configured. Absent roots are normal — most installs have one.
export function resolveSkillDirs(api: any, workspaceDir: string, extra: string[] = []): string[] {
  let stateDir: string;
  try {
    stateDir = api?.runtime?.state?.resolveStateDir?.() ?? join(homedir(), ".openclaw");
  } catch {
    stateDir = join(homedir(), ".openclaw");
  }
  return [...new Set([
    join(workspaceDir, "skills"),
    join(stateDir, "skills"),
    join(homedir(), ".openclaw", "skills"),
    ...extra,
  ])];
}

// Rendered for the prompt. Descriptions are trimmed hard — the pass needs
// enough to recognize "that job is already covered", not the whole skill.
const DESC_LIMIT = 180;
// A big install must not eat the context budget; goal skills are excluded
// separately (they're sapience-goals' own temporary artifacts, not candidates
// a proposal could duplicate).
const RENDER_LIMIT = 60;

export function buildInstalledSkillsContext(skills: InstalledSkill[]): string {
  const listed = skills.filter((s) => !/^goal-/.test(s.name)).slice(0, RENDER_LIMIT);
  if (listed.length === 0) return "";
  const lines = listed.map((s) => {
    const desc = s.description.length > DESC_LIMIT ? `${s.description.slice(0, DESC_LIMIT)}…` : s.description;
    return `- ${s.name}${desc ? ` — ${desc}` : ""}`;
  });
  return lines.join("\n");
}
