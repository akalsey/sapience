# OpenClaw Memory Setup for Sapience

Sapience does not build its own memory corpus. It relies on OpenClaw's native memory system plus two bundled plugins — `memory-core` and `memory-wiki` — configured correctly. This document describes the required configuration and the reasoning behind each piece.

---

## The principle

OpenClaw already writes memory. Sapience's job is to feed into that system and read from it — not to maintain a parallel store. Running two corpora that don't know about each other produces contradictions and splits recall, which is exactly the failure mode sapience is designed to prevent.

The practical consequence: sapience must not maintain its own indexed directory, its own BM25 index, or any other store that duplicates what `memory-core` and `memory-wiki` already manage.

---

## Required plugins

### memory-core (bundled, default)

`memory-core` is OpenClaw's default memory plugin. It is enabled by default and provides:

- `memory_search` — semantic search over the indexed memory corpus
- `memory_get` — read specific memory files or line ranges
- Dreaming — background consolidation that promotes short-term signals to `MEMORY.md`

**Required configuration:**

```json
{
  "plugins": {
    "memory-core": {
      "dreaming": {
        "enabled": true
      }
    }
  }
}
```

Dreaming is disabled by default. Enable it. Without dreaming, behavioral corrections and observations accumulate in daily notes but never get promoted to `MEMORY.md`, so they decay out of the search index as daily notes age. Sapience depends on corrections surviving across sessions.

### memory-wiki (bundled, optional — enable it)

`memory-wiki` compiles durable knowledge into a wiki vault with structured claims, contradiction tracking, provenance, and freshness semantics. In `bridge` mode it reads from OpenClaw's native memory artifacts — daily notes, dream reports, event logs — rather than operating as a standalone store.

This is the correct mode for sapience. Bridge mode means `memory-wiki` enhances the native corpus rather than replacing or duplicating it.

**Required configuration:**

```json
{
  "plugins": {
    "memory-wiki": {
      "vaultMode": "bridge",
      "bridge": {
        "enabled": true,
        "readMemoryArtifacts": true
      },
      "search": {
        "corpus": "all"
      }
    }
  }
}
```

`corpus: "all"` makes `memory_search` span both the active memory corpus and the wiki vault. Without this, `wiki_search` and `memory_search` are separate queries with separate result sets.

---

## How OpenClaw memory works (the layers sapience depends on)

| Layer | File | Loaded how |
|-------|------|------------|
| Long-term durable facts | `MEMORY.md` | Injected into every session bootstrap |
| Daily working context | `memory/YYYY-MM-DD.md` | Indexed; available on demand via `memory_search` / `memory_get`, not bootstrapped |
| Dream diary | `DREAMS.md` | Human-readable summary of dreaming consolidation |
| Wiki vault | `{vault}/` | Available via `wiki_search` and `wiki_get` |

**Important constraint:** `MEMORY.md` has a bootstrap budget. If it grows past the budget, OpenClaw truncates the injected copy. Keep `MEMORY.md` high-signal and compact. This is what dreaming enforces — it gates promotion so only qualified items reach `MEMORY.md`, while the daily notes layer holds the rest for on-demand retrieval.

---

## What sapience writes and where it lands

`sapience-feedback` is the only sapience plugin that writes to memory. When it detects a behavioral correction, it calls `api.memory?.add()` with the meta-pointer and tags:

```json
{
  "content": "Before working on {domain} / {action_class}: check feedback log — correction recorded: \"...\"",
  "metadata": {
    "tags": ["feedback", "behavioral-correction", "{domain}"],
    "source": "feedback"
  }
}
```

This goes into the native memory system via `memory-core`. Dreaming then evaluates the entry against its promotion criteria. If promoted, it lands in `MEMORY.md` and bootstraps every session. If not promoted, it remains in the daily notes layer and is retrievable on demand.

`memory-wiki` in bridge mode picks up these entries as memory artifacts and can compile them into structured claims, enabling contradiction detection if two corrections conflict.

---

## Known gaps

Two capabilities are not covered by the native system or `memory-wiki` as documented:

**Tag-filtered retrieval.** `memory_search` is semantic. `wiki_search` ranks by claim status and confidence. Neither supports structured tag-AND queries: "all behavioral corrections for the github domain." The `metadata.tags` written by `sapience-feedback` are stored but there is no documented query interface for filtering by them. This is the one retrieval capability that may require sapience to implement something.

**Programmatic write API for other plugins.** `api.memory?.add()` exists and works (sapience-feedback uses it). The optional chaining (`?.`) means it silently no-ops if the memory API is not available. Whether `memory-core` must be explicitly configured to accept plugin writes, or whether it's always available in session context, is not documented. In practice, sapience-feedback has worked. If other sapience plugins need to write to memory in the future, the same `api.memory?.add()` pattern applies.

---

## Summary: what to configure, what not to build

| Requirement | Covered by | Action |
|-------------|-----------|--------|
| Structured retrievable entries | `memory-wiki` structured claims | Enable memory-wiki in bridge mode |
| Contradiction / supersede semantics | `memory-wiki` claim status tracking | Included in bridge mode |
| On-demand retrieval, no context flooding | daily notes architecture in `memory-core` | Already how it works; keep MEMORY.md lean |
| Index over what OpenClaw writes | `memory-wiki` bridge mode | Enable bridge + readMemoryArtifacts |
| Dreaming / consolidation | `memory-core` dreaming | Enable dreaming explicitly |
| Tag-filtered retrieval | **Not covered** | Potential future sapience contribution |
| Programmatic write from sapience plugins | `api.memory?.add()` | Already implemented in sapience-feedback |

Sapience does not need a private indexed directory, a custom BM25 index, or any storage layer for memory. The configuration above is the complete setup.
