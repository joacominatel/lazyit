---
id: SEC-061
title: /search returns the full article markdown body in every hit (response amplification + undocumented field)
severity: low
status: open
cwe: CWE-770
discovered: 2026-06-06
module: search
tags: [dos, resource-exhaustion, info-exposure, search, meilisearch]
---

# SEC-061 — /search returns full article `content` per hit (unbounded response amplification)

## Summary

`GET /search` never sets `attributesToRetrieve`, so Meilisearch returns every indexed attribute —
including the full markdown **`content`** of each matched PUBLISHED article. A single cheap query can
return up to `limit` (max 50) complete article bodies per call, far larger than the documented hit
shape.

## Description

The `articles` index stores the whole markdown body (`projectArticle` includes `content`,
`search.documents.ts:68-78`; ADR-0035/0042 index it so runbook bodies are findable). The query path
passes only `indexUid`, `q` and `limit` to `multiSearch` and returns `result.hits` **verbatim**
(`search.service.ts:126-145`):

```ts
const params: MultiSearchParams = {
  queries: requested.map((indexUid) => ({ indexUid, q, limit })),
};
// ...
results[index] = { hits: result.hits, total: ... };
```

With no `attributesToRetrieve`, Meili returns the full stored document for every hit, so each article
hit carries its entire `content`. Two consequences:

- **Response amplification.** `limit` is clamped to ≤50 (`search.controller.ts` `parseLimit`), but
  the *per-hit size is unbounded*: article `content` can be multi-MB (the import path accepts up to
  `MAX_IMPORT_SIZE_MB`, ~5 MB, and a `.docx` can expand larger still — SEC-002). A query matching 50
  large articles can serialize hundreds of MB into one response, repeatable on a cheap unauthenticated
  -by-shim GET. This is the same "no bound on the result payload" class as SEC-007, but per-hit rather
  than per-row-count.
- **Contract drift / over-exposure.** The shared `ArticleHitSchema` (the documented wire shape)
  deliberately omits `content` (`packages/shared/src/schemas/search.ts:37-43`), but the API ships it
  anyway. No confidentiality breach — only PUBLISHED articles are indexed (draft privacy holds,
  ADR-0022/0035) and PUBLISHED content is team-visible to any `article:read`/`search:read` caller —
  but the endpoint returns more than its own schema declares.

## Impact

Availability / bandwidth: a low-effort `GET /search?q=<common-term>` can pull a large multi-article
payload, and the per-hit size is uncapped. Dev-only posture (forgeable shim) limits *exposure*, but a
legitimate caller can trigger heavy responses by accident as the KB grows. No confidentiality impact
(PUBLISHED-only). Rated Low (resource/defense-in-depth), tracked alongside SEC-007 and SEC-002.

## Proof of concept

Reasoned from the code, **not executed** (the API is not run during review):

```sh
# returns up to 50 article hits, each carrying the FULL markdown body (no attributesToRetrieve cap)
curl 'http://localhost:3001/search?q=server&entities=articles&limit=50' -H 'X-User-Id: <uuid>'
# the `content` field is present on every article hit even though ArticleHitSchema omits it
```

## Affected

- `apps/api/src/search/search.service.ts:126-145` — `multiSearch` query built without
  `attributesToRetrieve`; `result.hits` returned verbatim.
- `apps/api/src/search/search.documents.ts:68-78` — `projectArticle` indexes the full `content`.
- `packages/shared/src/schemas/search.ts:37-43` — `ArticleHitSchema` (documented shape) omits
  `content`, so the runtime response diverges from the contract.

## Recommendation

Constrain what search returns to exactly the documented hit fields, per index. With Meili, set
`attributesToRetrieve` on each query so `content` is searchable (indexed) but never *returned*:

```ts
const RETRIEVE: Record<SearchIndex, string[]> = {
  assets: ['id', 'name', 'serial', 'assetTag', 'status', 'notes'],
  articles: ['id', 'slug', 'title', 'excerpt', 'status'], // content indexed, not returned
  users: ['id', 'firstName', 'lastName', 'email'],
  locations: ['id', 'name', 'type', 'address', 'floor'],
  applications: ['id', 'name', 'vendor', 'description'],
};
queries: requested.map((indexUid) => ({
  indexUid, q, limit, attributesToRetrieve: RETRIEVE[indexUid],
}));
```

This caps the per-hit payload, makes the response match `ArticleHitSchema`, and keeps full-text
matching over `content` intact (retrieval ≠ searchability in Meili). Optionally return a short
highlighted snippet via `attributesToCrop`/`cropLength` instead of the body.

## Prevention

Make "search returns only the projected hit fields, never large blobs" a rule: the indexed document
(searchable surface) and the returned hit (wire surface) are different contracts — pin the returned
attributes to the shared `*HitSchema` and keep large/searchable-only fields out of retrieval. A test
asserting an article hit has no `content` key would lock it in.

## References

- CWE-770: Allocation of Resources Without Limits or Throttling. CWE-213 (intended information
  exposure).
- Meilisearch `attributesToRetrieve` / `attributesToCrop`. ADR-0035 (search architecture) ·
  ADR-0042 (article content indexed) · SEC-007 (unbounded list responses) · SEC-002 (large `.docx`
  content).
