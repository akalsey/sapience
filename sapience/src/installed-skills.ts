import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

// The inventory of skills this install ALREADY has.
//
// Nothing in the suite used to look at it. The skill-proposal ledger deduped
// only against its own earlier entries, and thinking passes — the usual source
// of "you keep doing this by hand, make it a skill" — run in isolated cron
// sessions with no skill context at all. So the pass proposed skills that were
// already installed, the main session dutifully logged them, and the operator
// got told about a skill they already had.
//
// Reading the skill files is the whole trick: an OpenClaw skill is a directory
// holding a SKILL.md whose frontmatter carries `name` and `description`.

export interface InstalledSkill {
  name: string;
  description: string;
  path: string;
}

// Bounds. A skills root is normally a handful of directories; these exist so a
// pathological tree (a node_modules symlinked in, a skills dir someone pointed
// at their home directory) can't turn every proposal into a filesystem walk.
const MAX_DEPTH = 2;
const MAX_SKILLS = 250;

function unquote(value: string): string {
  const v = value.trim().replace(/^[>|][-+]?\s*/, "");
  const m = /^(['"])([\s\S]*)\1$/.exec(v);
  return (m ? m[2]! : v).trim();
}

// Enough YAML for `name:` and `description:`, including the folded/indented
// continuation lines long descriptions use. Not a YAML parser and not trying
// to be one — a skill whose frontmatter is exotic degrades to its directory
// name, which is still a usable duplicate signal.
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
    return; // root absent — a standalone install simply has no skills there
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
      // Bundled packs nest one level: skills/<pack>/<skill>/SKILL.md
      await scanSkillDir(child, depth + 1, out);
    }
  }
}

// Where skills live. The workspace dir is where goal skills and hand-written
// workspace skills go; the state dir is the global install. Absent roots are
// not an error — most installs have only one.
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

export async function discoverInstalledSkills(dirs: string[]): Promise<InstalledSkill[]> {
  const found: InstalledSkill[] = [];
  for (const dir of dirs) await scanSkillDir(dir, 1, found);
  // The same skill can be visible through two roots (a workspace symlink into
  // the global dir). First sighting wins.
  const seen = new Set<string>();
  return found.filter((s) => {
    const key = skillSlug(s.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function skillSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Token overlap, same shape as the hypothesis ledger's near-duplicate rule
// (see hypotheses.ts) but scored rather than boolean: a proposal's one-line
// summary is much shorter than a skill's description, so jaccard sinks and
// containment-on-the-smaller-side is the only measure that sees "these two
// are about the same job".
function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
      .map((w) => w.replace(/s$/, ""))
  );
}

// Without this, every proposal "overlaps" every skill through the shared
// scaffolding of skill prose ("use this skill when the user asks…").
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "when", "use", "user", "asks", "ask", "skill",
  "skills", "should", "from", "into", "them", "they", "their", "would", "what", "which", "each",
  "any", "all", "one", "two", "not", "but", "its", "it's", "you", "your", "are", "was", "were",
  "has", "have", "had", "can", "will", "also", "than", "then", "there", "here", "how", "why",
]);

const OVERLAP_MIN_TOKENS = 6;
const OVERLAP_THRESHOLD = 0.34;

export function overlapScore(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const smaller = Math.min(ta.size, tb.size);
  if (smaller < OVERLAP_MIN_TOKENS) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / smaller;
}

export interface SkillOverlap {
  skill: InstalledSkill;
  score: number;
  // True when the proposed name IS the installed skill's name. Not a judgement
  // call — the same slug is the same skill.
  sameName: boolean;
}

// sapience-goals compiles each active goal into `skills/goal-<id>/SKILL.md`.
// Those are that plugin's own temporary artifacts, retired when the goal
// completes — a proposal that touches the same subject as a live goal is not a
// duplicate of anything, so they never block one. Thinking's renderer leaves
// them out of the pass prompt for the same reason.
function isTemporaryGoalSkill(skill: InstalledSkill): boolean {
  return /^goal-/.test(skill.name);
}

export function findOverlappingSkills(
  skills: InstalledSkill[],
  name: string,
  summary: string
): SkillOverlap[] {
  const proposal = `${name} ${summary}`;
  const hits: SkillOverlap[] = [];
  for (const skill of skills) {
    if (isTemporaryGoalSkill(skill)) continue;
    const sameName = skillSlug(skill.name) === skillSlug(name);
    const score = sameName ? 1 : overlapScore(proposal, `${skill.name} ${skill.description}`);
    if (sameName || score >= OVERLAP_THRESHOLD) hits.push({ skill, score, sameName });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 3);
}

function describe(skill: InstalledSkill): string {
  const desc = skill.description.length > 240 ? `${skill.description.slice(0, 240)}…` : skill.description;
  return `- ${skill.name}${desc ? ` — ${desc}` : ""} (${skill.path})`;
}

export function renderInstalledSkills(skills: InstalledSkill[]): string {
  return skills.map(describe).join("\n");
}

export type DuplicateVerdict =
  | { blocked: false; overlaps: SkillOverlap[] }
  | { blocked: true; reason: "same_name" | "unjustified_overlap"; matched: InstalledSkill; message: string };

// The guard the skill_proposal tool runs before it writes anything.
//
// A same-named skill is refused outright — there is nothing to justify, the
// skill exists. A weaker overlap is refused ONCE, with the overlapping skills
// named, and the caller may proceed by re-calling with `not_covered_by`
// explaining what the existing skill doesn't do. The cost is a single extra
// round trip, and only when something on disk already looks like the proposal.
export function checkAgainstInstalledSkills(
  skills: InstalledSkill[],
  name: string,
  summary: string,
  notCoveredBy?: string
): DuplicateVerdict {
  const overlaps = findOverlappingSkills(skills, name, summary);
  if (overlaps.length === 0) return { blocked: false, overlaps };

  const sameName = overlaps.find((o) => o.sameName);
  if (sameName) {
    return {
      blocked: true,
      reason: "same_name",
      matched: sameName.skill,
      message: [
        `A skill named "${sameName.skill.name}" is already installed — nothing was logged.`,
        describe(sameName.skill),
        "",
        "Use it. If it doesn't do what you need, the right move is to improve that skill (or propose a change to it under a name that says what's different), not to log a second copy.",
      ].join("\n"),
    };
  }

  if (!notCoveredBy) {
    return {
      blocked: true,
      reason: "unjustified_overlap",
      matched: overlaps[0]!.skill,
      message: [
        `Nothing was logged: ${overlaps.length === 1 ? "an installed skill already covers" : "installed skills already cover"} similar ground.`,
        renderInstalledSkills(overlaps.map((o) => o.skill)),
        "",
        "Read the skill(s) above before proposing. If one of them does the job, use it and don't log a proposal. If the work genuinely isn't covered, call skill_proposal again with not_covered_by set to a sentence naming the closest existing skill and what it can't do.",
      ].join("\n"),
    };
  }

  return { blocked: false, overlaps };
}
