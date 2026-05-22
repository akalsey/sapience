import { loadAllEntries } from "./storage.js";
import { buildCorpus } from "./bm25.js";
import { searchEntries } from "./search.js";
import type { MemoryEntry, MemorySearchInput, MemorySearchOutput } from "./types.js";
import type { BM25Corpus } from "./bm25.js";

export class IndexStore {
  private entries: Map<string, MemoryEntry> = new Map();
  private corpus: BM25Corpus = { docs: new Map(), df: new Map(), N: 0, avgdl: 0 };

  async loadFromDirectory(indexedDir: string): Promise<void> {
    const all = await loadAllEntries(indexedDir);
    this.entries.clear();
    for (const entry of all) this.entries.set(entry.id, entry);
    this.rebuildCorpus();
  }

  private rebuildCorpus(): void {
    const docs = [...this.entries.values()].map(e => ({
      id: e.id,
      text: `${e.title} ${e.title} ${e.tags.join(" ")} ${e.tags.join(" ")} ${e.body}`,
    }));
    this.corpus = buildCorpus(docs);
  }

  add(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry);
    this.rebuildCorpus();
  }

  update(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry);
    this.rebuildCorpus();
  }

  removeById(id: string): void {
    this.entries.delete(id);
    this.rebuildCorpus();
  }

  removeByFilename(filename: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.filename === filename) { this.entries.delete(id); break; }
    }
    this.rebuildCorpus();
  }

  getAll(): MemoryEntry[] {
    return [...this.entries.values()];
  }

  getById(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  getCorpus(): BM25Corpus {
    return this.corpus;
  }

  size(): number {
    return this.entries.size;
  }

  search(input: MemorySearchInput, recencyBoostDays: number, recencyBoostMax: number, defaultLimit: number, maxLimit: number): MemorySearchOutput {
    return searchEntries(this.getAll(), this.corpus, input, recencyBoostDays, recencyBoostMax, defaultLimit, maxLimit);
  }
}
