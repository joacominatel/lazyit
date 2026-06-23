---
title: IT Terms
tags: [glossary]
status: draft
created: 2026-05-25
updated: 2026-06-23
---

# IT Terms

General IT/operations vocabulary. For lazyit's own domain objects, see
[[entities/_MOC|Entities]].

| Term | Meaning in lazyit's context |
| --- | --- |
| **Asset** | A tracked, individual thing the IT team owns ([[asset]]). Contrast with a consumable. |
| **Consumable** | A stock-counted item, not tracked individually ([[consumable]]). |
| **Access grant** | A user's active access to an application ([[access-grant]]). |
| **Access request** | A pending, approval-gated request for access ([[access-request]]). |
| **Provisioning** | Setting up access/hardware for a user (e.g. on onboarding). |
| **Deprovisioning / offboarding** | Revoking access and reclaiming assets when someone leaves. |
| **Runbook** | A step-by-step operational procedure (for operating lazyit; see [[05-runbooks/_MOC|Runbooks]]). |
| **CMDB** | Configuration Management Database — the inventory of assets and their relationships; lazyit's asset model plays this role. |
| **AD / LDAP** | Active Directory / directory service; an AD group is a kind of [[application]] you can grant access to. |
| **jsonb** | PostgreSQL binary JSON type; used for flexible asset `specs` ([[0007-flexible-asset-specs-jsonb]]). |
| **Soft delete** | Marking a row deleted (`deletedAt`) without removing it, for auditability ([[0006-soft-delete-and-auditing]]). |
| **Append-only** | A table whose rows are only ever inserted, never updated/deleted (history, ledgers). |

> [!note] Grow this as terms come up in tickets, ADRs and runbooks. Keep definitions
> lazyit-specific, not generic dictionary entries.

## Workflow engine vocabulary

Terms for the [[0054-applications-workflow-engine|Applications Workflow Engine]] (shipped) — the
opt-in, per-application provisioning automation on the Access pillar. Entity terms carry a one-line
gloss and link to their note in [[entities/_MOC|Entities]]; the design depth lives in the
[[workflow-engine/_MOC|Workflow Engine vault]].

| Term | Meaning in lazyit's context |
| --- | --- |
| **Applications Workflow Engine** | The opt-in, admin-configurable engine that automates provisioning/deprovisioning in external systems (Jira, Redmine, any REST/webhook target) when access is granted/revoked in lazyit. An app with **no** workflow behaves exactly as before — granting access just records the [[access-grant]] ([[0054-applications-workflow-engine]]). |
| **Workflow** ([[application-workflow]]) | A per-`Application` configuration binding a trigger (`ACCESS_GRANTED` / `ACCESS_REVOKED`) to a versioned DAG of steps. Opt-in; one per app. |
| **Workflow Connection** ([[workflow-connection]]) | A reusable, named external target + credential a step calls (base URL + auth, e.g. a Jira instance). Entered write-only; secrets are never read back. |
| **Workflow Run** ([[workflow-run]]) | One execution of a workflow for a single trigger event. Doubles as the transactional-outbox row and pins the engine ServiceAccount for that run. |
| **Workflow Step Run** ([[workflow-step-run]]) | The append-only execution record of a single step within a run (status, attempts, result) — the data behind the run timeline. |
| **Manual Task** ([[manual-task]]) | A `MANUAL` step (a *human task*) that pauses the run as DB state until a person completes it from the inbox. A provisioning queue, **not** a generic ticketing/approval system. |
| **Workflow Secret** ([[workflow-secret]]) | An AES-256-GCM-encrypted, write-only credential bound to a connection; never returned by the API. The store fails loud at boot without `WORKFLOW_SECRET_KEY`. |
| **Opinionated error-handling DAG** | The workflow shape: typed steps (`REST` / `WEBHOOK_OUT` / `MANUAL`) wired by first-class success/failure edges, each with per-step success criteria + retries — **not** a free-form n8n-style canvas. |
| **Transactional outbox** | The decoupling pattern: the engine fires only *after* the access-grant transaction commits, so a failing external call never blocks or rolls back the grant — the deliberate inverse of the Zitadel write-back. |
| **Deprovision policy** | Per-workflow rule for when an `ACCESS_REVOKED` trigger actually deprovisions, since a user may hold several active grants on one app. Default `LAST_ACTIVE_GRANT` (fire only when the *last* active grant is revoked); `EACH_GRANT` fires on every revoke ([[application-workflow]]). |
| **BullMQ** | The Redis-protocol job/queue library that executes workflow steps and async jobs: "BullMQ executes; PostgreSQL remembers". Runs **sandboxed processors** for memory-heavy/untrusted jobs ([[0053-async-workers-bullmq-valkey]]). |
| **Valkey** | The self-hosted, Redis-compatible (BSD fork) datastore backing BullMQ. Internal-network-only container with AOF persistence; reached via `REDIS_URL` ([[0053-async-workers-bullmq-valkey]]). |
| **Egress guard** | The anti-SSRF outbound-HTTP guard for workflow calls: denies private/loopback/IMDS ranges, pins the resolved socket, re-validates on redirect, https-only ([[0054-applications-workflow-engine]]). |
| **Data mapper** | The logic-less (no `eval`) mapping that shapes a step's request payload from prior-step output / run context — declarative field mapping, never arbitrary code. |
| **Dry-run** | A builder action that previews a step's resolved request payload with **no** side effects (no external call). |
| **Test connection** | A builder action that verifies a Workflow Connection's reachability and credentials before a workflow uses it. |

> [!note] These mirror the [[entities/_MOC|entity notes]] and ADR-0053/0054; keep the
> glosses short and point at the entity note / ADR for depth rather than restating it here.

## Knowledge Base v2 vocabulary

Terms for the [[0059-kb-folders-links-and-import|Knowledge Base v2]] design (folders, aliases,
wiki-links, bulk import — accepted 2026-06-11, **built in #364**, merged `feat/kb-secrets`). Folder-based
access control is [[0060-kb-folder-access-control]].

| Term | Meaning in lazyit's context |
| --- | --- |
| **Folder** ([[folder]]) | The flat [[article-category]] evolved into a self-referential hierarchy (`parentId`). The KB's organizing tree; also the **permission boundary** for access control ([[0060-kb-folder-access-control]]). |
| **Home folder** | An article's **single** owning folder — the evolution of the old required one-category-per-article FK. An article lives in exactly one home folder; everywhere else it appears via an alias. |
| **Alias (symlink, nav-only)** ([[article-alias]]) | A navigational symlink that makes an article appear in a second folder without moving or copying it. Nav-only: it **never** widens access (no-escalation — you can't alias an article you can't access). |
| **Wiki-link** `[[slug]]` ([[article-wiki-link]]) | An inline article→article reference by slug, materialized as an edge on save to power backlinks and fast resolution. An **unresolved** `[[slug]]` is render-time state (tooltip, no clickable target), not a hard FK. |
| **Backlink / References** | The reverse of a wiki-link: the set of articles that link **to** the current one, computed from the materialized `[[slug]]` edges. |
| **Org-unique slug** | An article slug unique across the whole org (not per-folder), so a `[[slug]]` wiki-link resolves to exactly one article regardless of where it lives. |
| **Bulk .zip import** | A batch import that ingests a `.zip` of markdown into folders in one operation (an async, BullMQ-backed job in the spirit of the existing `.docx` import — [[0053-async-workers-bullmq-valkey]]). |

## Secret Manager vocabulary

Terms for the [[0061-secret-manager-zero-knowledge|Secret Manager]] — zero-knowledge vaults beside the
KB (accepted 2026-06-11, **built in #366**, merged `feat/secret-manager`). Distinct from the
server-decryptable [[workflow-secret]] of the Workflow Engine.

| Term | Meaning in lazyit's context |
| --- | --- |
| **Zero-knowledge** | The server never holds a key that decrypts a secret **value** — no server-side reveal, no env master key over values. A deliberate, sharp exception to INV-8 ADMIN-omnipotence (authorization ≠ cryptographic plaintext; INV-10). |
| **Envelope encryption** | The two-layer scheme: a secret value is encrypted under a per-vault **DEK**, and the DEK itself is encrypted (wrapped) under each member's public key — so the value is encrypted once but unlockable by many. |
| **DEK (data encryption key)** | The random, per-vault data encryption key that actually encrypts the [[secret-item]] values. Never stored in clear — only per-member wrapped copies exist, one on each [[vault-membership]] row (never on the [[secret-vault]] itself). |
| **Key-wrapping** | Encrypting one key under another. Here the vault DEK is wrapped to each member's public key (one wrapped copy per [[vault-membership]]); granting access = wrapping the DEK to a new member (no grant-what-you-can't-read). |
| **Vault** ([[secret-vault]]) | A folder-like crypto boundary holding [[secret-item]]s. Server-visible name + member list. The DEK is **never** stored in clear, and the per-member wrapped DEK copies live on its [[vault-membership]] rows — not on the vault itself. |
| **Vault membership** ([[vault-membership]]) | A user's crypto membership of a vault — the row carrying the DEK wrapped to that user's public key. Soft-revoke v1 = drop the row. |
| **Recovery key** | A one-time `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (5 alnum groups) that re-wraps a user's private key, shown **once** and never logged or persisted in clear ([[0031-logging-strategy]]). The escape hatch when a user forgets their vault passphrase. |
| **Vault passphrase** | The per-user secret that unlocks a [[user-keypair]]'s private key (run through Argon2id). Set inside the Secret Manager and captured only by the client — **distinct from the OIDC login password**, which lazyit never receives. |
| **Argon2id** | The memory-hard KDF that derives the key wrapping a [[user-keypair]]'s private key from the user's **vault passphrase**. |
| **Peer-reset** | Recovery path where another vault member re-establishes a user who lost both vault passphrase and recovery key: the keypair is replaced and memberships re-wrapped to the new public key. |
| **Soft-revoke vs hard-revoke** | Soft-revoke (v1) drops the [[vault-membership]] row so the user can no longer unwrap the DEK; hard-revoke additionally **rotates** the DEK (and re-encrypts items) so a leaked old wrapped copy is worthless — a future step. |
| **`{{ lazyit_secret.XXXX }}`** | The reserved token by which a **KB article** (or other surface) inline-references a Secret Manager value by handle; resolved to a **masked chip** at render time — the value never transits the server in clear. Distinct from the Workflow Engine's own server-decryptable [[workflow-secret]] store. |

> [!note] The Secret Manager is a **third** secret store: [[workflow-secret]] (ADR-0054) is
> server-decryptable by design so connectors can authenticate at run time; the Secret Manager is
> zero-knowledge (the server can never decrypt). Different entity, crypto model and threat model — see
> [[0061-secret-manager-zero-knowledge]].

## RBAC vocabulary

Terms for lazyit's authorization model — fixed roles + configurable permissions
([[0046-roles-permissions-v2|Roles & Permissions v2]], building on the original
[[0040-rbac-roles]]). The load-bearing distinction is **capability vs permission**: a permission
is the atomic authorization unit the server actually enforces; a capability is only a human label
in the role-config UI that bundles permissions, and never grants or denies anything by itself.

| Term | Meaning in lazyit's context |
| --- | --- |
| **Role** | The assignable authorization bundle a [[user]] *has* — `enum Role { ADMIN MEMBER VIEWER }`, fixed (not dynamic custom roles). What a role *grants* is its permission set, resolved DB-first from [[role-permission]] rows ([[0040-rbac-roles]]). |
| **Permission** | The **atomic unit of authorization** — a frozen `domain:action` literal (e.g. `asset:write`, `accessGrant:grant`) from a closed catalog-as-code in `@lazyit/shared`. DB-first via [[role-permission]], resolved **server-side**; never read from a token claim (INV-1). The thing `@RequirePermission(...)` actually checks ([[0046-roles-permissions-v2]]). |
| **Capability** | The operator-facing **toggle** in the role-config UI that bundles one or more permissions under a plain-language label ("Add & edit inventory"). **Presentation only** — it never grants or denies anything (INV-1); the wire `PUT` is still a flat `Permission[]`. The fine-tune view still exposes the raw permissions. |
| **Permission tier** | The privilege level of a single permission, independent of its domain — `view` / `edit` / `delete` / `coarse`. Drives the "above-default" escalation warning: a role's seed default never includes `delete` or a `coarse` verb, so granting those to MEMBER/VIEWER is flagged as admin-level (allowed with a strong warning, never client-blocked). |
| **Pillar** | The product-area bucket a permission's domain groups under in the role-config screen — Inventory / Access / Knowledge / Manage / Automation — matching the app's nav mental model rather than the flat domain list. |

> [!note] See [[role-permission]] (the editable role→permission map) and [[permission-audit-log]]
> (the append-only record of every grant/revoke). The human layer (labels/pillars/tiers/capabilities)
> lives beside the catalog in `@lazyit/shared`, guarded by a covering-set test so the wording can never
> drift from the machine catalog ([[0046-roles-permissions-v2]] P7).

## Service account vocabulary

Terms for non-human principals ([[0048-service-accounts|Service Accounts]]).

| Term | Meaning in lazyit's context |
| --- | --- |
| **Service account** ([[service-account]]) | A first-class **non-human principal** for automation/integration access (a CI runner, a nightly script). It is a separate entity, **not** a flag on [[user]]: it authenticates by a **lazyit-native bearer token** (`lzit_sa_…`, NOT OIDC) and is authorized by **direct permission grants** ([[service-account-permission]]) from the same frozen catalog humans use — never a `Role`, never ADMIN. It is fail-closed (no human open-by-default), and is **pinned as the actor** on the domain rows it touches (e.g. a [[workflow-run]]) via its own `serviceAccountId` actor column — honest attribution, never a fake `userId` ([[0048-service-accounts]]). |

## Asset-tag scheme vocabulary

Terms for human-readable asset tags ([[0063-configurable-asset-tag-scheme|configurable asset-tag scheme]]).

| Term | Meaning in lazyit's context |
| --- | --- |
| **Asset-tag scheme** ([[asset-tag-scheme]]) | The **singleton** instance-config that auto-generates human-readable asset tags on [[asset]] create: optional `prefix` + a zero-padded **monotonic counter** + optional `suffix`. **Opt-in** (`enabled = false` by default), **gap-tolerant** (a rolled-back/retried/deleted number is never back-filled), and **estate-aware** — on backfill it skips tags already on a live asset, so an auto-mint never collides with the existing estate ([[0063-configurable-asset-tag-scheme]], [[0068-asset-tag-existing-estate-awareness]]). |

## Migrator vocabulary

Terms for the guided bulk importer ([[0069-migrator-import|Migrator]]).

| Term | Meaning in lazyit's context |
| --- | --- |
| **Migrator (bulk import)** | The guided, field-mapped **bulk importer** for domain data (phase 1: the Asset slice, from JSON + CSV). Its mapping step binds each source field to a target field, an enum value, or an FK resolved by natural key — or to a fixed value via an existing-record picker / constant. A dry-run validates and detects conflicts before any write; the commit replays a frozen plan additively + audited ([[0069-migrator-import]]). Distinct from the KB-specific **Bulk .zip import** (above), which ingests a `.zip` of markdown into KB folders. |
