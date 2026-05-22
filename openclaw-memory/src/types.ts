export type SizeTier = "full" | "summary" | "tag-only";
export type MemorySource = "session" | "dreams" | "manual" | "import";

export interface MemoryEntryFrontmatter {
  id: string;
  created: string;
  updated: string;
  tags: string[];
  source: MemorySource;
  score: number;
  size_tier: SizeTier;
  last_accessed: string;
  access_count: number;
}

export interface MemoryEntry extends MemoryEntryFrontmatter {
  title: string;
  body: string;
  filename: string;
}

export interface MemorySearchInput {
  query: string;
  tags?: string[];
  limit?: number;
}

export interface MemorySearchResult {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  created: string;
  score: number;
  size_tier: SizeTier;
}

export interface MemorySearchOutput {
  results: MemorySearchResult[];
  total_matched: number;
}

export interface MemoryGetOutput {
  id: string;
  title: string;
  content: string;
  tags: string[];
  created: string;
  updated: string;
  source: MemorySource;
  size_tier: SizeTier;
  last_accessed: string;
  access_count: number;
}

export interface MemoryWriteInput {
  content: string;
  tags: string[];
  title?: string;
  source?: MemorySource;
}

export interface MemorySupersedeInput {
  old_id: string;
  new_content: string;
  new_tags: string[];
  reason: string;
}

export interface MemoryStatsOutput {
  total_entries: number;
  total_size_bytes: number;
  avg_tokens_per_entry: number;
  top_tags: Array<{ tag: string; count: number }>;
  created_last_7_days: number;
  accessed_last_7_days: number;
}

export interface SearchLogEntry {
  query: string;
  tags?: string[];
  result_count: number;
  timestamp: string;
}

export interface MemoryConfig {
  memoryPath: string;
  search: {
    defaultLimit: number;
    maxLimit: number;
    recencyBoostDays: number;
    recencyBoostMax: number;
  };
  write: {
    requireTags: boolean;
    minTags: number;
    maxTags: number;
  };
}

export const DEFAULT_CONFIG: MemoryConfig = {
  memoryPath: "~/.openclaw/memory",
  search: {
    defaultLimit: 5,
    maxLimit: 20,
    recencyBoostDays: 30,
    recencyBoostMax: 1.2,
  },
  write: {
    requireTags: true,
    minTags: 1,
    maxTags: 12,
  },
};
