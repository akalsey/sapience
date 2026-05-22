import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

export function resolvePath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function resolveDataPath(override: string | undefined, workspaceDir: string, defaultRelative: string): string {
  if (!override) return join(workspaceDir, defaultRelative);
  if (override.startsWith('/') || override.startsWith('~/')) return resolvePath(override);
  return join(workspaceDir, override);
}

export function generateId(date: Date = new Date()): string {
  const dateStr = date.toISOString().slice(0, 10);
  const suffix = randomBytes(4).toString("hex");
  return `mem_${dateStr}_${suffix}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");
}

export function generateFilename(id: string, title: string, date: Date = new Date()): string {
  const dateStr = date.toISOString().slice(0, 10);
  const slug = slugify(title) || "untitled";
  const suffix = id.slice(-8);
  return `${dateStr}-${slug}-${suffix}.md`;
}

export function extractTitle(body: string, fallback: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? fallback;
}

export const MEMORY_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[a-z0-9]{8}\.md$/;
