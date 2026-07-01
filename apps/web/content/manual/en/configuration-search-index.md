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
- **Self-heal on startup.** When the app starts, it checks each index and automatically rebuilds any
  that is missing or empty. This is a no-op when the indexes already have data, so it is safe on a
  large estate.
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
- **Genuinely empty results, especially right after deploy.** A freshly deployed or freshly seeded
  instance can start with empty indexes. The startup self-heal covers a wholly empty index, but the
  reliable fix is a full reindex.

## Reindexing

A **full reindex** rebuilds every index from the database. It is the deterministic repair for any
drift and the expected step after a first deploy. Run it from the API service:

```
bun run reindex:all
```

Run this once on first deploy to backfill the index, and any time you suspect search is stale (for
example after restoring a backup or after an extended search-engine outage). The rebuild is
zero-downtime — search keeps serving the old index until the new one is swapped in.

> Reindexing reads from your existing database and writes only to the search index; it never changes
> your records. It is always safe to run.

## Index health, at a glance

- New and changed records appear in search within moments — if not, the engine may be down.
- After a deploy, restore, or long outage, run `reindex:all` to guarantee a complete index.
- "Search unavailable" means the engine, not your data — your records are intact and writes still
  work.

For running and monitoring the search service itself, see
[Services](/help/deployment-operations-services) and
[Troubleshooting](/help/deployment-operations-troubleshooting).
