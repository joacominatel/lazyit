# Feature ideation — Knowledge base + cross-cutting (tickets, notifications, dashboard, reporting, webhooks)

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Product / Features**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The Knowledge pillar is a body-blind, version-less, island wiki and every cross-cutting capability (dashboard/notifications/feed/tickets/export/webhooks) is unbuilt — but the audit data and Meili already exist, so the high-value backend wins are additive, not redesigns.

## Findings (10)

### 1. Article full-text search excludes content; the search box silently can't find body text

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | small | high |

- **Location:** `apps/api/src/search/search.documents.ts:64-72 and apps/api/src/articles/articles.service.ts:67-74`
- **Why it matters:** FACT: the list q filter is title/excerpt-only (articles.service.ts:67-74) and projectArticle indexes only slug,title,excerpt,status — never content (search.documents.ts:64-72); ADR-0021 made this explicit. The KB is where runbooks live and the operator's most common query (a command/error string buried in a runbook step) returns nothing. Findability under load is the whole value of a runbook KB for the generalist team (vision.md:19-22).
- **Recommendation:** Add content (or a length-capped body excerpt) to projectArticle and re-run reindex:all. Non-destructive change to ADR-0035's index, not ADR-0021's data shape. Highest value-per-line change in the report; it's a quick win.

### 2. No article versioning: an edit silently destroys the prior runbook body (ArticleVersion deferred + doc drift)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | medium | high |

- **Location:** `apps/api/src/articles/articles.service.ts:134-153; schema.prisma:269-303; docs/02-domain/entities/article-version.md`
- **Why it matters:** FACT: update() overwrites content in place with no snapshot (articles.service.ts:134-153); no ArticleVersion model exists in schema.prisma (only a draft entity note). This violates the stated principle 'Auditability by default. Nothing is hard-deleted' (vision.md:49-50) — the one mutable-content pillar that hard-deletes its own history. The CTO system-map wrongly claims ArticleVersion exists (doc drift to flag).
- **Recommendation:** Execute ADR-0021's deferred non-destructive plan: append-only ArticleVersion table (autoincrement, createdAt only, FK to Article, snapshot title/content/excerpt + editor), written transactionally in update()/publish() like AssetHistory. Expose read-only GET /articles/:id/versions. Restore = new version, never mutate history.

### 3. No way to link an article to an asset/application: cross-pillar glue is missing

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | medium | high |

- **Location:** `apps/api/prisma/schema.prisma:269-303`
- **Why it matters:** FACT: Article has only categoryId + author FKs (schema.prisma:280-289); no relation to the Asset/Application a runbook documents. This is the feature that makes the KB IT-native vs a generic wiki (positioning, vision.md:27-30) and strengthens all three pillars at once by connecting them — open an asset, see the runbooks referencing it.
- **Recommendation:** Add a polymorphic ArticleLink join (articleId + targetType enum {ASSET,APPLICATION,ASSET_MODEL,LOCATION} + targetId). Surface GET /assets/:id/articles, GET /applications/:id/articles, GET /articles/:id/links. Documentation-to-object linking, not monitoring or ticket routing — safely inside the Knowledge pillar.

### 4. Operational dashboard has no backend: the screen is a hardcoded placeholder advertising a non-existent pillar

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | medium | high |

- **Location:** `apps/web/app/(app)/dashboard/page.tsx:9-34`
- **Why it matters:** FACT: dashboard renders three static cards with literal '—'/'No data yet.' and no stats endpoint exists (dashboard/page.tsx:9-34; no metrics module in app.module.ts). It even shows an 'Open tickets' card for a pillar that isn't built, misleading the operator. The dashboard is the landing page and at-a-glance estate health for the generalist-under-load user (vision.md:19-22).
- **Recommendation:** Add read-only GET /dashboard/stats: assets-by-status (indexed), active assignments, active vs expiring-soon grants, consumables at/below minStock, published vs draft articles, recent activity. Remove the 'Open tickets' card until tickets exist. These are inventory/access/knowledge facts, NOT device telemetry — not monitoring.

### 5. No unified activity feed: rich audit data (history/grants/movements) is siloed per entity

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | high |

- **Location:** `apps/api/src/asset-history/asset-history.service.ts:52-62 and schema.prisma:210-230,368-399,454-474`
- **Why it matters:** FACT: four append-only sources record who-did-what-when (AssetHistory schema.prisma:210-230, AccessGrant 368-399, ConsumableMovement 454-474, AssetAssignment 176-205) each with actor FKs, but there is no cross-entity read — asset history is only per-asset (asset-history.service.ts:52-62) and grants/movements have no activity view at all. 'Auditability by default' is a principle that isn't surfaced; the feed is the substrate for the dashboard and notifications.
- **Recommendation:** Add read-only GET /activity?entities&since&before&limit merging the four sources into a normalized cursor-paginated stream; adopt the ADR-0030 page envelope from day one. Surfacing existing audit records of operator actions on IT objects — not employee surveillance.

### 6. No notifications/digest: actionable signals (expiring grants, low stock, stale runbooks) are inert in the data

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | large | medium |

- **Location:** `apps/api/prisma/schema.prisma:383,437,291-296`
- **Why it matters:** FACT: AccessGrant.expiresAt exists with an explicit comment that nothing acts on it (schema.prisma:383), Consumable.minStock is a reorder threshold with no alert (437), Article timestamps could drive staleness — all modeled but inert. A weekly digest turns passive records into IT workflow (the CEO's 'optimize all workflows in one app' goal).
- **Recommendation:** Phase it: (a) in-app Notification feed first, fed by the same signals as the activity feed (no infra); (b) scheduled digest later via BullMQ+Redis (sanctioned worker stack) to optional opt-in SMTP, no telemetry. Digest of IT operational facts, not device-metric alerting (not monitoring) and not HR reminders.

### 7. Lightweight tickets: frame as a thin, asset/access-anchored work tracker — NOT a ticketing system

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | large | medium |

- **Location:** `docs/02-domain/entities/ticket.md and ticket-comment.md (no Prisma model; not in app.module.ts)`
- **Why it matters:** FACT: Ticket/TicketComment have domain notes (state workflow, priority, asset/user refs) but no model and no module; the dashboard already shows an 'Open tickets' card ahead of any backend. This is the single highest scope-creep risk against the explicit anti-goal 'NOT a ticketing system' — it is safe ONLY if anchored to a pillar object and kept thin (no SLAs/queues/portal/email gateway).
- **Recommendation:** Gate: do not build until KB depth + activity feed land and CEO/CTO explicitly green-light. If built: minimal Ticket (status/priority, optional assetId/applicationId/userId, soft-delete) + soft-deletable comments; emit an AssetHistory event when asset-linked so it shows in the timeline. ADR must hard-bar SLA engine, queues/routing, public portal, email-to-ticket. Resolve AccessRequest-vs-ticket overlap at the same time.

### 8. Reporting/export missing: 'everything exportable' is promised but no export endpoints exist

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | low | medium | high |

- **Location:** `docs/03-decisions/0021-knowledge-base-design.md:75 (open question); no export endpoints in controllers`
- **Why it matters:** FACT: no CSV/JSON export and no article-download endpoint in any controller; ADR-0021 lists article export (md/pdf) as an open question. Exportability is a trust/anti-lock-in feature for self-hosted buyers and the backend half of reporting.
- **Recommendation:** Start with GET /articles/:id/export.md returning the stored markdown (near-zero effort, closes an ADR-0021 open question, quick win). Then CSV export for assets/access-grants/consumables as read-only endpoints. Plain export, not a BI engine.

### 9. KB attachments/images: runbooks are markdown-only with no place for diagrams or screenshots

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | large | medium |

- **Location:** `apps/api/prisma/schema.prisma:272-274; docs/02-domain/entities/article.md:40-41`
- **Why it matters:** FACT: Article.content is plain markdown text (schema.prisma:272-274), the importer discards images/source file (article.md:40-41), and there is no file-storage module anywhere. Real IT runbooks need topology diagrams and error screenshots — a genuine gap, but it pulls in a new storage dependency that collides with one-command self-hosted setup.
- **Recommendation:** Defer pending a storage ADR. When built: local-disk volume by default (self-hosted simplicity), Attachment table (article FK, content-type, size, checksum), strict type/size limits reusing the SEC-002 decompression lesson, and NO cloud-storage hard dependency (no vendor lock-in).

### 10. Outbound webhooks: the right self-hosted integration primitive, but needs a security ADR first

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | low | large | medium |

- **Location:** `apps/api/src/search/search.service.ts:77-105 (pattern reference); no integration module in app.module.ts`
- **Why it matters:** FACT: no webhook/integration module; the proven fire-and-forget fail-soft pattern (search.service.ts:77-105) is the natural dispatcher shape. Outbound webhooks on key events feed the team's existing channels (Slack/SIEM) — the opinionated integration story for a self-hosted tool — but carry SSRF, secret-signing, and retry/poisoning weight.
- **Recommendation:** Gate: defer until the activity-event model exists (webhooks fire on those events). Requires a Sentinel-reviewed security ADR (SSRF allowlist, HMAC signing, BullMQ retry+dead-letter, no secret leakage). Operator-configured and optional, so it does not violate the no-phone-home stance — confirm that reading with the CTO.

## Quick wins

- Index article content in Meilisearch: add content (or a capped body excerpt) to projectArticle in apps/api/src/search/search.documents.ts:64-72 and re-run reindex:all. Single highest value-per-line change — makes runbook bodies findable. Stays inside ADR-0035, untouched ADR-0021 data shape.
- Remove the misleading 'Open tickets' dashboard card at apps/web/app/(app)/dashboard/page.tsx:9 — it advertises a pillar that does not exist; drop it or wire it to a real count once GET /dashboard/stats lands.
- Article export to .md: GET /articles/:id/export.md returning the stored markdown with a download header — closes an ADR-0021 open question and delivers the KB exportability promise with near-zero code.
- Add an isStale flag to the GET /articles response (PUBLISHED + updatedAt older than N days) — pure read, no new infra, seeds the staleness-reminder story toward notifications.
- Fix doc drift: the CTO system-map claims ArticleVersion exists but schema.prisma has no such model — correct the note so planning isn't built on a false premise (docs-only).

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
