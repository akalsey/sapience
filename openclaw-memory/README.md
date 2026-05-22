# openclaw-memory

A per-turn-lean memory plugin. Small always-loaded core, explicit on-demand retrieval. Memory is markdown files on disk, search is BM25, and the corpus stays manageable through deliberate writes rather than passive capture.

---

## Setup

### Install

```bash
openclaw plugins install npm:@akalsey/openclaw-memory
```

### Configuration

```json
{
  "plugins": {
    "sapience-memory": {
      "memoryPath": "~/.openclaw/memory",
      "search": {
        "defaultLimit": 5,
        "maxLimit": 20,
        "recencyBoostDays": 30,
        "recencyBoostMax": 1.2
      },
      "write": {
        "requireTags": true,
        "minTags": 1,
        "maxTags": 12
      }
    }
  }
}
```

All settings are optional — defaults above are used if omitted.

### Storage layout

```
~/.openclaw/memory/
├── indexed/
│   ├── 2026-05-20-posthog-billing-a3f9b2c1.md
│   └── ...
└── _searches.json
```

Memories are plain markdown files. You can read, edit, and grep them in any editor. External edits are picked up automatically via filesystem watching.

---

## Memory entry format

```markdown
---
id: mem_2026-05-20_a3f9b2c1
created: 2026-05-20T14:30:00Z
updated: 2026-05-20T14:30:00Z
tags: [posthog, billing, group-identify]
source: session
score: 0.7
size_tier: full
last_accessed: 2026-05-20T14:30:00Z
access_count: 3
---

# PostHog group identify billing investigation

PostHog charges separately for groupIdentify events under the data warehouse
SKU. Our May 2026 spike traced to a deploy that called groupIdentify on every
page view. Fix: call it once per session, cache client-side.
```

---

## Tools

| Tool | What it does |
|------|-------------|
| `memory_search(query, tags?, limit?)` | BM25 search, returns excerpts + metadata |
| `memory_get(id)` | Full content of one entry; updates access metadata |
| `memory_write(content, tags)` | Creates new entry, returns id |
| `memory_supersede(old_id, new_content, new_tags, reason)` | Replaces outdated entry |
| `memory_stats()` | Corpus stats: count, size, top tags, recent activity |
| `memory_recent_searches(limit?)` | Last N searches with result counts |

---

## Using it effectively

The agent learns when to search from the SKILL.md that ships with the plugin. Key behaviors to reinforce:

- When core memory has a pointer to indexed memory → agent searches before answering
- After an investigation produces findings → agent writes a memory entry
- When a memory contradicts current knowledge → agent supersedes rather than leaving conflicts

**Tags are the most important thing you control.** The agent writes them at creation time. Good tags are terms you'd type in a future search: domain names, topic words, project names. Sparse tags make recall worse; there's no downside to 8 tags if they're all relevant.

---

## Inspecting memory

```bash
# How many entries, top tags
openclaw memory stats

# Recent searches and their result counts
openclaw memory recent-searches

# Browse entries directly
ls ~/.openclaw/memory/indexed/
grep -l "billing" ~/.openclaw/memory/indexed/
cat ~/.openclaw/memory/indexed/2026-05-20-posthog-billing-a3f9b2c1.md
```

---

## Troubleshooting

**Agent answers from training data instead of memory**
The agent didn't search. Check the SKILL.md is loading (visible in session start). Add explicit pointers in core memory: "Indexed memory has notes on [topic]." This gives the agent a concrete cue to search.

**Search returns nothing for a topic you know exists**
Try different query terms — BM25 is lexical, not semantic. If the entry uses different vocabulary than your query, it won't match. Check what terms are in the actual entry with `grep`. Add more tags when you write entries.

**Index out of sync after external edits**
The chokidar watcher picks up external file changes in real time. If it seems stale, restart the OpenClaw session to force a full reload.

**Corpus growing too large**
v1 has no automatic decay. Prune manually by deleting files from `~/.openclaw/memory/indexed/` or using `memory_supersede` to replace bulky entries with summaries. Semantic search + decay-as-pruning is planned for v2.

**Duplicate or contradictory entries**
Use `memory_supersede`. It deletes the old entry and creates a new one, appending the reason for traceability. Nothing in v1 detects contradictions automatically — the agent notices during retrieval and resolves them on encountering them.
