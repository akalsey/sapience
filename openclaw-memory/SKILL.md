# Using openclaw-memory

You have two layers of memory:

**Core memory** — always loaded, broad strokes. Entries may include pointers like "Indexed memory has detailed notes on X." These pointers are your cue to search.

**Indexed memory** — searchable, detail-rich, not loaded by default. Six tools:

- `memory_search(query, tags?, limit?)` — BM25 search, returns excerpts
- `memory_get(id)` — load full content of one entry
- `memory_write(content, tags, title?, source?)` — create a new entry, returns id
- `memory_supersede(old_id, new_content, new_tags, reason)` — replace outdated entry
- `memory_stats()` — corpus statistics
- `memory_recent_searches(limit?)` — recent queries and their result counts

## When to search

- Core memory has a pointer to indexed memory on this topic → search before answering
- Task requires procedural specifics, code, or prior investigation details → search first
- User asks "what do you know about X?" → search before falling back to training data
- You're about to do something and you know past sessions touched this domain → search for prior notes

## When to write

- You learn something procedural or specific that will be useful in a future session
- An investigation produced findings that shouldn't be re-run from scratch
- A decision was made with non-obvious reasoning that future sessions should know
- A correction was made that reveals a domain-specific rule

**Tag generously.** Use terms you'd plausibly type in a future search. Domain names (posthog, github, salesforce), topic words (billing, funnel, merge, deploy), project names, people's names.

## How to query

Write queries as natural phrases, not keyword lists. "PostHog billing spike investigation" works better than "posthog billing." Include terms from the likely entry body, not just the likely title.

## The contradiction rule

If you retrieve a memory that contradicts a newer source or your current knowledge, use `memory_supersede` rather than leaving conflicting entries in the corpus. The reason field is logged; be specific about what changed and why.

## When not to search

- Simple factual questions well-covered by training data
- Quick conversational exchanges
- Questions where core memory already gives you what you need
