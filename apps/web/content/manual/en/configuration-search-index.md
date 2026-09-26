---
title: Search index
category: configuration
subcategory: search-index
order: 6
---

# Search index

lazyit's global search (the **⌘K** command palette in the top bar) is powered by a dedicated search
engine that keeps a separate, typo-tolerant **index** of your data. The index spans assets, articles,
users, locations and applications. This page covers how the index stays in sync and what to do when it
drifts.

## How the index stays current

You normally don't have to think about the index — lazyit keeps it up to date for you:

- **Live sync.** When a record is created, updated or removed, lazyit updates the index in the
  background. This is intentionally **fail-soft**: if the search engine is briefly unavailable, your
  write still succeeds — search just lags until the index catches up.
- **Self-heal on startup.** When the app starts, it waits for the search engine to be reachable, checks
  each index and automatically rebuilds any that is missing or empty, in the background. This covers a
  first deploy and a search-engine upgrade (which starts on a fresh, empty index) with no manual step.
  It is a no-op when the indexes already have data, so it is safe on a large estate.
- **Periodic reconcile.** A background sweeper periodically rebuilds the indexes from the database to
  repair any drift from a dropped background update. The cadence defaults to hourly and can be tuned
  by an operator.

> Only **published** knowledge-base articles are ever indexed, so a draft's content can't surface in
> search. Soft-deleted records are removed from the index, so they never appear in results.

## When search returns nothing

If global search shows no results, distinguish two cases:

- **"Search unavailable."** The engine is down or unreachable. Search degrades gracefully and tells
  you so rather than pretending there are no matches. This usually resolves on its own once the engine
  is back; if it persists, check that the search service is running. See
  [Services](/help/deployment-operations-services).
- **Incomplete results right after a deploy or upgrade.** A freshly deployed instance, or one whose
  search engine was just upgraded, starts with empty indexes. The startup self-heal rebuilds them in the
  background — give it a few minutes. If results are still missing after that, run a full reindex.

## Reindexing

A **full reindex** rebuilds every index from the database. It is the deterministic repair for any
drift. You do not need it after a first deploy or an upgrade — the startup self-heal does that. Run it
from the API service:

```
bun run reindex:all
```

Run it any time you suspect search is stale (for example after restoring a backup or after an extended search-engine outage). The rebuild is
zero-downtime — search keeps serving the old index until the new one is swapped in.

> Reindexing reads from your existing database and writes only to the search index; it never changes
> your records. It is always safe to run.

## Index health, at a glance

- New and changed records appear in search within moments — if not, the engine may be down.
- After a deploy or upgrade, search fills itself in within a few minutes. After a restore or a long
  outage, run `reindex:all` to guarantee a complete index.
- "Search unavailable" means the engine, not your data — your records are intact and writes still
  work.

For running and monitoring the search service itself, see
[Services](/help/deployment-operations-services) and
[Troubleshooting](/help/deployment-operations-troubleshooting).
