import { mkdir } from "fs/promises";
import { join, basename } from "path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type MemoryConfig, type MemoryEntry } from "./types.js";
import { resolveDataPath, generateId, generateFilename, extractTitle } from "./utils.js";
import { writeEntry, deleteEntry } from "./storage.js";
import { IndexStore } from "./index-store.js";
import { computeStats, loadSearchLog, appendSearchLog } from "./stats.js";

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): MemoryConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<MemoryConfig>),
    memoryPath: resolveDataPath((raw as any).memoryPath, workspaceDir, DEFAULT_CONFIG.memoryPath),
    search: { ...DEFAULT_CONFIG.search, ...((raw as any).search ?? {}) },
    write: { ...DEFAULT_CONFIG.write, ...((raw as any).write ?? {}) },
  };
}

export default definePluginEntry({
  id: "memory",
  name: "Memory",
  description: "Per-turn-lean memory: small core + on-demand BM25 indexed retrieval",

  async register(api: any) {
    const workspaceDir = (api.runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig);
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);
    const indexedDir = join(config.memoryPath, "indexed");
    const searchLogPath = join(config.memoryPath, "_searches.json");
    await mkdir(indexedDir, { recursive: true });

    const store = new IndexStore();
    await store.loadFromDirectory(indexedDir);

    const { watch } = await import("chokidar");
    const watcher = watch(indexedDir, { ignoreInitial: true });
    watcher
      .on("add", async (filePath: string) => {
        const filename = basename(filePath);
        if (!filename.endsWith(".md")) return;
        const { readEntry } = await import("./storage.js");
        store.add(await readEntry(indexedDir, filename));
      })
      .on("change", async (filePath: string) => {
        const filename = basename(filePath);
        if (!filename.endsWith(".md")) return;
        const { readEntry } = await import("./storage.js");
        store.update(await readEntry(indexedDir, filename));
      })
      .on("unlink", (filePath: string) => {
        store.removeByFilename(basename(filePath));
      });

    api.registerTool({
      name: "memory_search",
      description: "Search indexed memory. Returns titles, excerpts, tags. Call memory_get for full content.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search query" },
          tags: { type: "array", items: { type: "string" }, description: "Require ALL of these tags (AND semantics)" },
          limit: { type: "number", description: "Max results to return (default 5, max 20)" },
        },
        required: ["query"],
      },
      async execute(_id: any, params: any) {
        const input = params as { query: string; tags?: string[]; limit?: number };
        const output = store.search(
          input,
          config.search.recencyBoostDays,
          config.search.recencyBoostMax,
          config.search.defaultLimit,
          config.search.maxLimit,
        );
        await appendSearchLog({
          query: input.query,
          tags: input.tags,
          result_count: output.total_matched,
          timestamp: new Date().toISOString(),
        }, searchLogPath);
        return { content: [{ type: "text", text: JSON.stringify(output) }] };
      },
    });

    api.registerTool({
      name: "memory_get",
      description: "Load the full content of a memory entry by id. Updates access metadata.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      async execute(_id: any, params: any) {
        const { id } = params as { id: string };
        const entry = store.getById(id);
        if (!entry) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Entry ${id} not found` }) }] };
        }
        const updated: MemoryEntry = {
          ...entry,
          last_accessed: new Date().toISOString(),
          access_count: entry.access_count + 1,
        };
        await writeEntry(indexedDir, updated);
        store.update(updated);
        return { content: [{ type: "text", text: JSON.stringify({
          id: updated.id, title: updated.title, content: updated.body,
          tags: updated.tags, created: updated.created, updated: updated.updated,
          source: updated.source, size_tier: updated.size_tier,
          last_accessed: updated.last_accessed, access_count: updated.access_count,
        }) }] };
      },
    });

    api.registerTool({
      name: "memory_write",
      description: "Write a new memory entry. Returns the new entry's id.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Markdown body" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for this entry (required)" },
          title: { type: "string", description: "Optional title override; derived from first H1 if absent" },
          source: { type: "string", description: "Origin: session | dreams | manual | import" },
        },
        required: ["content", "tags"],
      },
      async execute(_id: any, params: any) {
        const input = params as { content: string; tags: string[]; title?: string; source?: string };
        if (config.write.requireTags && input.tags.length < config.write.minTags) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `At least ${config.write.minTags} tag required` }) }] };
        }
        if (input.tags.length > config.write.maxTags) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Maximum ${config.write.maxTags} tags allowed` }) }] };
        }
        const now = new Date().toISOString();
        const id = generateId();
        const title = input.title ?? extractTitle(input.content, id);
        const filename = generateFilename(id, title);
        const entry: MemoryEntry = {
          id, created: now, updated: now, tags: input.tags,
          source: (input.source as any) ?? "session",
          score: 0.5, size_tier: "full",
          last_accessed: now, access_count: 0,
          title, body: input.content, filename,
        };
        await writeEntry(indexedDir, entry);
        store.add(entry);
        return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
      },
    });

    api.registerTool({
      name: "memory_supersede",
      description: "Replace an outdated memory entry with new content. Old entry is deleted; reason is appended to new entry.",
      parameters: {
        type: "object",
        properties: {
          old_id: { type: "string" },
          new_content: { type: "string" },
          new_tags: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["old_id", "new_content", "new_tags", "reason"],
      },
      async execute(_id: any, params: any) {
        const input = params as { old_id: string; new_content: string; new_tags: string[]; reason: string };
        const old = store.getById(input.old_id);
        if (!old) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Entry ${input.old_id} not found` }) }] };
        }
        await deleteEntry(indexedDir, old.filename);
        store.removeById(input.old_id);

        const now = new Date().toISOString();
        const id = generateId();
        const body = input.new_content + `\n\n---\n*Supersedes ${input.old_id}: ${input.reason}*`;
        const title = extractTitle(body, id);
        const filename = generateFilename(id, title);
        const entry: MemoryEntry = {
          id, created: now, updated: now, tags: input.new_tags,
          source: "session", score: 0.5, size_tier: "full",
          last_accessed: now, access_count: 0,
          title, body, filename,
        };
        await writeEntry(indexedDir, entry);
        store.add(entry);
        return { content: [{ type: "text", text: JSON.stringify({ new_id: id }) }] };
      },
    });

    api.registerTool({
      name: "memory_stats",
      description: "Return statistics about the memory corpus: entry count, size, top tags, recent activity.",
      parameters: { type: "object", properties: {} },
      async execute(_id: any, _params: any) {
        return { content: [{ type: "text", text: JSON.stringify(computeStats(store.getAll())) }] };
      },
    });

    api.registerTool({
      name: "memory_recent_searches",
      description: "Return recent search queries with result counts, for tuning and gap analysis.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Number of recent searches to return (default 20)" } },
      },
      async execute(_id: any, params: any) {
        const { limit = 20 } = ((params ?? {}) as { limit?: number });
        const log = await loadSearchLog(searchLogPath);
        return { content: [{ type: "text", text: JSON.stringify(log.slice(-limit)) }] };
      },
    });
  },
});
