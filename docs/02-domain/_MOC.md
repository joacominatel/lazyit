---
title: Domain — MOC
tags: [moc, domain]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Domain — Map of Content

What lazyit models and the rules that govern it.

- [[asset-centric]] — the core design philosophy: the **Asset** is the first-class citizen.
- [[conventions]] — technical conventions for the data model (naming, IDs, timestamps,
  soft delete, flexible specs).
- [[entities/_MOC|Entities]] — one conceptual note per entity.

## Domain shape

```mermaid
erDiagram
    AssetCategory ||--o{ AssetModel : classifies
    AssetModel ||--o{ Asset : "is instance of"
    Location ||--o{ Asset : holds
    Asset ||--o{ AssetAssignment : has
    User ||--o{ AssetAssignment : "owns via"
    Asset ||--o{ AssetHistory : "changes logged in"
    Asset ||--o{ Ticket : "referenced by"
    User ||--o{ Ticket : "referenced by"
    Ticket ||--o{ TicketComment : has
    ApplicationCategory ||--o{ Application : classifies
    Application ||--o{ AccessGrant : "granted via"
    User ||--o{ AccessGrant : has
    Application ||--o{ AccessRequest : "requested for"
    User ||--o{ AccessRequest : raises
    Consumable ||--o{ ConsumableMovement : tracks
    ArticleCategory ||--o{ Article : groups
    Article ||--o{ ArticleVersion : versioned-by
    Article ||--o{ ArticleLink : links
    Asset ||--o{ ArticleLink : "documented by"
    Application ||--o{ ArticleLink : "documented by"
    Application ||--o{ ApplicationWorkflow : "automates via"
    Application ||--o{ WorkflowConnection : "connects via"
    ApplicationWorkflow ||--o{ WorkflowVersion : "versioned-by"
    ApplicationWorkflow ||--o{ WorkflowRun : "executed as"
    AccessGrant ||--o{ WorkflowRun : fires
    WorkflowRun ||--o{ WorkflowStepRun : logs
    WorkflowRun ||--o{ ManualTask : "pauses on"
    WorkflowConnection ||--o{ WorkflowSecret : "authenticates with"
    Folder ||--o{ Folder : "nests (parentId)"
    Folder ||--o{ Article : "home folder of"
    Folder ||--o{ ArticleAlias : "holds symlinks"
    Article ||--o{ ArticleAlias : "aliased as"
    Article ||--o{ ArticleWikiLink : "links out via"
    SecretVault ||--o{ SecretItem : holds
    SecretVault ||--o{ VaultMembership : "scoped to"
    User ||--o{ VaultMembership : "is crypto member via"
    User ||--|| UserKeypair : "has keypair"
```

> [!note] Conceptual ERD. Relationships only — no fields. `Asset ↔ User` via
> `AssetAssignment` is **concurrent many-to-many** (multiple active owners allowed; see
> [[asset-assignment]]). Field definitions arrive when entities land in Prisma.

## Bounded areas

The model is organized in loosely-coupled areas:

1. **Assets (core)** — [[asset]], [[asset-model]], [[asset-category]], [[location]],
   [[asset-assignment]], [[asset-history]].
2. **People** — [[user]] (central to access, peripheral to assets).
3. **Tickets** — [[ticket]], [[ticket-comment]] (cross-cutting).
4. **Access** — [[application]], [[application-category]], [[access-grant]], [[access-request]].
5. **Consumables** — [[consumable]], [[consumable-movement]].
6. **Knowledge base** — [[article]], [[article-category]], [[article-version]], [[article-link]].
7. **Workflow engine** — [[application-workflow]], [[workflow-connection]], [[workflow-version]],
   [[workflow-run]], [[workflow-step-run]], [[manual-task]], [[workflow-secret]] (an opt-in extension
   of **Access** — [[0054-applications-workflow-engine]]).
8. **Knowledge Base v2** — [[folder]] (the flat [[article-category]] evolved into a hierarchy + one home
   folder per article), [[article-alias]] (nav-only symlinks), [[article-wiki-link]] (materialized
   article↔article `[[slug]]` edges → backlinks); the **folder** is also the KB permission boundary
   ([[0059-kb-folders-links-and-import]], [[0060-kb-folder-access-control]]).
9. **Secret Manager** — [[secret-vault]], [[secret-item]], [[vault-membership]], [[user-keypair]]: a
   zero-knowledge vault store beside the KB, the server never decrypting a secret value
   ([[0061-secret-manager-zero-knowledge]]).

## Implementation order

The model is built atomic-first (see each entity note for status):

1. [[user]] + [[location]] — no dependencies.
2. [[asset-model]] + [[asset-category]] + [[asset]] — the core.
3. [[asset-assignment]] + [[asset-history]] — traceability.
4. [[ticket]] + [[ticket-comment]].
5. [[application]] + [[application-category]] + [[access-grant]] + [[access-request]].
6. [[consumable]] + [[consumable-movement]].
7. [[article]] + [[article-category]] + [[article-version]] + [[article-link]].
8. **Workflow engine** (opt-in, after Access) — [[application-workflow]] + [[workflow-connection]] +
   [[workflow-version]] + [[workflow-run]] + [[workflow-step-run]] + [[manual-task]] +
   [[workflow-secret]] ([[0054-applications-workflow-engine]], epic #248).
9. **Knowledge Base v2** (evolves the KB area) — [[folder]] + [[article-alias]] + [[article-wiki-link]],
   then folder-based access control ([[0059-kb-folders-links-and-import]] / [[0060-kb-folder-access-control]],
   #364/#365). *Design only — not yet built.*
10. **Secret Manager** (beside the KB) — [[user-keypair]] first, then [[secret-vault]] +
    [[vault-membership]] + [[secret-item]] ([[0061-secret-manager-zero-knowledge]], #366).
    *Design only — not yet built.*

Why asset-centric? → [[0004-asset-centric-design]].
