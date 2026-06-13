---
title: "ADR-0060: Knowledge Base access control — folders as the permission boundary"
tags: [adr, knowledge-base, kb, authorization, security]
status: accepted
created: 2026-06-11
updated: 2026-06-13
deciders: [Joaquín Minatel]
---

# ADR-0060: Knowledge Base access control — folders as the permission boundary

## Status

accepted

> [!note] Decided and implemented in #365
> Ratified 2026-06-11 in a CTO/CEO design session. **Implemented in #365** (merged on `feat/kb-secrets`): folder-based access control (INV-9) — `FolderAccessService`, the API+DB enforcement, article 404-hiding, and the no-escalation alias gate are all built and shipped.

This ADR builds directly on [[0059-kb-folders-links-and-import]] (which turns the flat
**ArticleCategory** into a hierarchical [[folder]] and gives every article exactly one **home folder**):
the folder is now the natural unit a permission can attach to. It is the **sensitive sibling** of that
structural ADR — it carves a *deliberate, bounded* exception into the per-domain authorization
philosophy that [[0040-rbac-roles]] and [[0046-roles-permissions-v2]] both froze, and it must reconcile
that tension head-on (it does, in [§Reconciling the ADR-0046 "no per-record ACLs" rule](#reconciling-the-adr-0046-no-per-record-acls-rule)).
It adds a new invariant, **INV-9**, to [[INVARIANTS]].

## Context

Today, authorization in lazyit is **per-domain, via a frozen permission catalog**. A privilege decision
asks one question — *"does the actor's role hold permission `X`?"* — resolved DB-first from
`RolePermission` rows by `@RequirePermission` + the `RolesGuard` ([[0046-roles-permissions-v2]];
[[INVARIANTS]] INV-1, INV-8). For the Knowledge Base that permission is **`article:read`**, and it is
seeded to **all three roles** — so KB reads are, in effect, *public-to-any-authenticated-user*
([[0046-roles-permissions-v2]] §4: every `<domain>:read` is granted to all roles, the KB read included).

Both prior RBAC ADRs **explicitly rejected** anything finer. [[0040-rbac-roles]] Option B
(*"per-resource ACL / permission matrix … optionally per-record ownership"*) was **"explicitly
rejected"** as over-engineering for a 5–20-person single-org team. [[0046-roles-permissions-v2]]
re-affirmed it in one breath while introducing fine-grained permissions:

> authorization is per-domain, **NEVER per-record / per-row ACLs — Option B's per-resource matrix stays
> rejected**.

The **only** pre-existing per-row-shaped rule anywhere in the system is KB **draft visibility**
([[0022-draft-visibility-auth-shim]]): a `DRAFT` is private to its author, and a non-author who requests
it gets **404, not 403**, so the server never leaks the *existence* of someone's draft. That existence-
hiding pattern is the precedent this ADR extends.

The driving force: a Knowledge Base is **inherently access-tiered** in a way the rest of the domain is
not. An IT team's KB holds the onboarding playbook everyone should read *and* the incident-response
runbook for the finance app, the offboarding checklist with sensitive steps, the "break-glass" notes for
a critical system. "Every authenticated user reads everything" is the wrong default for those — but the
answer is **not** a per-document ACL matrix (the rejected Option B), and it is **not** a new role per
secrecy level. The CEO ask is the narrowest thing that works: **make a *folder* the place access
attaches**, default everything to today's behaviour (public-to-authenticated), and let a folder *opt
into* a tighter rule expressed entirely from data we already have (roles, [[access-grant]]s,
[[asset-assignment]]s) — no new ownership columns, no per-row matrix.

Constraints carried in:

- **INV-1 / INV-8** — authorization is DB-first; a token claim is never an authZ source. Folder access
  must resolve from **DB rows at read time**, never from anything client-asserted.
- **INV-8 ADMIN-omnipotence** — an ADMIN is always able to see everything (the last-admin / first-admin
  safety net leans on it). Folder restrictions must **never** hide an article from an ADMIN.
- **The catalog stays frozen.** `article:read` is the capability that gates *whether you can act on the
  KB at all*; this ADR adds an orthogonal axis on top of it, it does **not** mint per-article
  permissions into the catalog.
- **No-escalation.** Whatever sharing/aliasing [[0059-kb-folders-links-and-import]] introduces
  ([[article-alias]]), a user must **never** be able to surface an article they cannot themselves read.

## Considered options

- **Option A — The folder is the permission boundary; articles inherit; additive (OR) dynamic rules
  (chosen).** Access attaches to a **[[folder]]** — a bounded, named *set* — not to individual article
  rows. An article inherits its home folder's access. Default is **PUBLIC** (any authenticated holder of
  `article:read`); a folder may opt into a *narrower* set expressed by additive OR rules over existing
  live joins (explicit users, a role, holders of an active [[access-grant]] to an [[application]],
  current assignees of an [[asset]]). Evaluated DB-first at read time; ADMIN sees all; folder-hidden
  articles 404 (extending the [[0022-draft-visibility-auth-shim]] pattern). This is a **new orthogonal
  data-scoping axis**, not a new permission catalog.

- **Option B — Per-article ACLs (a permission row per `(article, subject)`). REJECTED.** This is exactly
  the *"per-record ownership / per-resource matrix"* [[0040-rbac-roles]] Option B and
  [[0046-roles-permissions-v2]] rejected by name. It would mint an ACL table, a policy editor, and an
  unbounded "who can read this one document" maintenance burden — the over-engineering both ADRs ruled
  out for a 5–20-person team. It also scales with *documents* (hundreds), where the folder model scales
  with *folders* (a handful). Rejected; the rejection still stands, and Option A is deliberately the
  *bounded-set* shape that **honours** it (see the reconciliation subsection).

- **Option C — Dynamic custom roles per secrecy tier (a "Finance-confidential" role, etc.). REJECTED.**
  This is the dynamic-custom-roles project [[0046-roles-permissions-v2]] Option B **deferred** ("breaks
  the fixed-role invariants the whole auth stack leans on … over-serves a 5–20-person single-org team").
  It would explode the three-role model the last-admin / first-admin / IdP-mirror invariants depend on,
  and it conflates *what you can do* (a role) with *which documents you can see* (a data scope) — two
  different axes. Rejected; folder access is a data-scoping axis layered **on top of** the unchanged
  three-role catalog, not a multiplication of roles.

- **Option D — Replace the per-domain catalog with a general policy engine (ABAC). REJECTED.** A full
  attribute-based policy engine over every domain is the opposite of "opinionated over configurable" and
  the boring-durable-technology constraint; it would re-litigate the entire auth stack to serve one
  module. Rejected — the carve-out is scoped to the KB, where the access-tiering need is real, and
  nowhere else.

- **Option E — UI-only hiding (the API still returns everything; the web app hides restricted folders).
  REJECTED outright.** A padlock the server doesn't enforce is not access control — any client (curl, a
  service account, a second tab) reads the "hidden" article. Authorization is enforced at the **API and
  DB layer, never UI-only**; the UI padlock + tooltip is *presentation* of a decision the server already
  made. Rejected as a security non-starter; called out explicitly because it is the tempting shortcut.

### Reconciling the ADR-0046 "no per-record ACLs" rule

This is the load-bearing tension, so it gets its own subsection. [[0040-rbac-roles]] and
[[0046-roles-permissions-v2]] reject *per-record / per-row ACLs* — and we are **keeping that rejection**.
The reconciliation rests on one distinction:

> [!info] Access attaches to a **folder** (a bounded, named set) — **never to an individual article row**.
> A folder is a first-class, named, user-managed container with **one** access rule. An article does not
> carry its own ACL; it **inherits** the rule of its home folder. So there is no per-record matrix to
> author or maintain: you set access **once per folder**, and N articles inherit it. This is the
> *"not per-record"* spirit of ADR-0040/0046 preserved — the access subject is a **set**, not a row.

Why the KB earns this carve-out when assets / consumables / tickets do **not**: a Knowledge Base is
**inherently access-tiered**. Documents are *written to be read by some audience and not another* — the
finance-incident runbook, the break-glass notes, the HR-adjacent offboarding steps. An asset row or a
consumable count has no comparable intrinsic secrecy gradient; per-domain `asset:read` / `consumable:read`
is the right granularity for them, and Option B stays rejected there. The KB is the **single** domain
where the *content itself* is tiered, so it is the single, **bounded** place this axis is introduced.

And it is genuinely a *new orthogonal axis*, not a re-opening of the catalog. The role→permission catalog
is **unchanged**: `article:read` still gates *whether you can act on the KB at all* (a VIEWER without it
is simply out). The folder ACL gates **which** articles a holder of `article:read` actually sees. Two
independent questions — *can you act?* (capability, per-domain, frozen) and *what is in scope?* (data
visibility, per-folder, new) — composed, never merged.

## Decision

Adopt **Option A**. The shape, numbered:

### §1. The folder is the permission boundary — a deliberate, bounded carve-out

Access attaches to a **[[folder]]**, the bounded named set introduced by
[[0059-kb-folders-links-and-import]]. An [[article]] **inherits** the access rule of its **home folder**
(the one required `folderId` — the evolved one-category-per-article FK). There is **no per-article ACL**;
the only place a rule is authored is the folder. This is a **new orthogonal data-scoping axis** layered
on the unchanged role→permission catalog: `article:read` (the frozen capability) gates whether you can
act on the KB at all; the **folder ACL** gates **which** articles you see. The two compose; they do not
replace each other.

> [!note] Folder hierarchy and rule inheritance
> [[0059-kb-folders-links-and-import]] gives folders a self-referential `parentId`. **v1 access is
> evaluated on the article's home folder's own rule, with restriction inherited *down* the tree:** a
> child folder is at least as restricted as its nearest restricted ancestor (a child can narrow further,
> never widen past an ancestor's restriction — that would be an escalation, §6). The exact "effective
> rule = own rule intersected with ancestors' restrictions" resolution is specified with the folder
> model in [[0059-kb-folders-links-and-import]]; this ADR fixes the *semantics* (inherit-and-narrow,
> never inherit-and-widen), not the SQL.

### §2. Default = PUBLIC (to authenticated holders of `article:read`)

A folder with **no restriction rule is PUBLIC**: visible to **any authenticated user holding
`article:read`** — never to an anonymous caller (an unauthenticated request is rejected before authZ, as
today). This **preserves current behaviour exactly** ([[0046-roles-permissions-v2]] §4 seeds
`article:read` to all roles), so introducing this axis changes nothing until a folder opts in. Rules only
ever **narrow from public**; a folder cannot grant *more* than the catalog already does — it can only
restrict the audience of an already-`article:read`-holding caller.

### §3. Additive (OR), dynamic rules — modelled from existing live joins, no ownership columns

A restricted folder carries one or more **rules combined with OR** (any rule that matches lets you in).
Every rule is expressible from **data lazyit already has** — no new ownership column on Article or Folder:

a. **Explicit users** — a named set of [[user]]s may read the folder.
b. **A role** — holders of a given `User.role` (e.g. "MEMBER and above") may read it.
c. **Holders of an active [[access-grant]] to an [[application]]** — anyone with a grant whose
   `revokedAt IS NULL` for that app may read the folder (e.g. "whoever has access to the Finance app may
   read its runbooks").
d. **Current assignees of an [[asset]]** — anyone with an [[asset-assignment]] whose `releasedAt IS NULL`
   for that asset may read the folder (e.g. "whoever currently holds the on-call laptop sees its
   break-glass notes").

> [!info] Dynamic by construction
> Rules (c) and (d) reference **live lifecycle joins**, so access **follows automatically**: revoke the
> grant (set `revokedAt`) or release the asset (set `releasedAt`) and KB access disappears on the next
> read — no separate KB-permission to remember to revoke at offboarding. This is why the rules are
> evaluated **DB-first at read time** (via `EXISTS` subqueries against the live joins, honouring the
> soft-delete read filter), never materialised into a cached ACL that could drift. It is the same
> append-only-join-is-the-source-of-truth discipline as [[access-grant]] / [[asset-assignment]]
> ([[0006-soft-delete-and-auditing]]).

The rule set is stored as a small, zod-validated structure on the folder (the
[[0007-flexible-asset-specs-jsonb]] / catalog-as-code discipline — the rule *kinds* are a closed,
reviewable vocabulary, not free-form policy). The concrete column/table shape lands with [[folder]] in
[[0059-kb-folders-links-and-import]]; this ADR fixes the **rule vocabulary and OR semantics**.

### §4. Composition / precedence — most restrictive wins

To **read** an article, **all** of the following must hold (AND):

1. **`article:read`** — the frozen per-domain capability (INV-1/INV-8). Without it you are out, full
   stop.
2. **Folder access** — the home folder is PUBLIC (§2) **OR** at least one of its OR rules (§3) matches
   you **OR** you are an **ADMIN** (§5).
3. **Draft visibility** — the article is `PUBLISHED`, **OR** you are its author. The
   [[0022-draft-visibility-auth-shim]] rule is **unchanged** and composes on top: a published article in
   a folder you can access is visible; your own draft in that folder is visible to you; someone else's
   draft is not.

**Most restrictive wins.** A folder-hidden article (you fail (2)) returns **404, not 403** — extending
the existence-hiding pattern of [[0022-draft-visibility-auth-shim]] so the server never leaks that a
restricted article *exists*. A draft you may not see also 404s (the existing rule). A published article
in a public folder that you lack `article:read` for is a 403 (you can't act on the KB at all) — the
capability failure is the one case that is honestly a 403, because lacking the whole-domain capability is
not an existence leak.

### §5. ADMIN god-mode over the KB

An **ADMIN sees every folder and every article**, consistent with INV-8 (ADMIN is omnipotent over
authorization/visibility; the last-admin / first-admin safety net depends on it). Folder restrictions are
a scoping rule for non-admins; they never hide a document from an administrator.

> [!warning] This is authorization omnipotence, not cryptographic access
> ADMIN god-mode here is over **what a capability can unlock** — and a KB document is plaintext the server
> already holds, so there is nothing cryptographic for the rule to gate. The sibling
> [[0061-secret-manager-zero-knowledge]] draws the **opposite, deliberate** line for *secret values*:
> there an ADMIN is excluded from the plaintext because the server holds **no key** that decrypts it
> (INV-10). The two are consistent: INV-8 omnipotence is over **authorization/visibility**, never over
> cryptographic plaintext. The KB has only the former; the Secret Manager adds the latter.

### §6. No-escalation invariant + enforcement (INV-9)

You can **never alias, share, or otherwise surface an article you cannot yourself read.** This binds the
[[article-alias]] of [[0059-kb-folders-links-and-import]] (an alias is *nav-only* in MVP and **never
widens access** — the aliased article is still gated by its *home* folder's rule, §7) and any future
alias-as-share. Concretely: creating an alias to an article requires that the actor passes §4 for that
article; an alias can never make a hidden article reachable.

**Enforcement is API + DB layer, never UI-only** (Option E rejected). The UI padlock + "restricted"
tooltip is *presentation*; the binding decision is the server's. The discipline is the **belt-and-
suspenders** pattern of [[0048-service-accounts]] / [[0058-user-manager-and-clone-actions]]:

- **Service layer** — the read path evaluates §4 DB-first and 404s a folder-hidden article; the
  alias/share path re-checks the actor's read access to the *target* before writing the [[article-alias]]
  row (no-escalation), exactly as `articles.service.ts` enforces author-only writes today.
- **DB layer** — folder-access rules resolve through `EXISTS` subqueries against the **live** joins (the
  soft-delete read filter applies); a partial-unique / CHECK constraint backstops any
  at-most-one / no-escalation shape the rule storage needs (the ADR-0041 partial-unique / ADR-0048 CHECK
  precedent), so the invariant is enforced at the database, not only the service. No UI-only gate is ever
  the boundary.

> [!info] INV-9 (landed in [[INVARIANTS]])
> **KB folder access is evaluated DB-first at the API layer and enforced at the DB layer — never UI-only**
> (the UI padlock+tooltip is presentation; the API returns 404-not-403 for folder-hidden articles,
> reusing the [[0022-draft-visibility-auth-shim]] existence-hiding pattern). **No-escalation:** you can
> never alias/share an article you cannot yourself access.

### §7. Future: alias-as-share (Phase 2, reserved)

[[0059-kb-folders-links-and-import]]'s [[article-alias]] is **nav-only in MVP** — it is a symlink for
navigation and **carries no access-granting column** (it never widens access; the aliased article remains
gated by its *home* folder's rule). A **Phase-2** evolution is **reserved, not built**: an alias may
optionally grant access to **that one article** (not the whole home folder), still bounded by the
no-escalation rule of §6 (you can only share what you can read). This is the *only* place an article-row-
level grant could ever appear, and it is deliberately deferred — the MVP boundary stays the **folder**.

### §8. Service accounts — fail-closed, not a folder-ACL subject in v1

A [[service-account]] (no `User` row, no `Role` — INV-SA-3) is **not a folder-ACL subject in v1**. The
OR rules in §3 are all `User`-shaped (explicit users, a role, grant/assignment holders keyed on
`userId`), and a service account has none of them. This mirrors `articles.service.ts` already **rejecting
an SA principal** on author-bound KB writes (INV-SA-4): the KB's identity model is human-shaped, so a
service account **fails closed** on restricted folders (it can read a PUBLIC folder iff its direct grants
include `article:read`, per INV-SA-2; it can never satisfy a restriction rule). A future SA-as-folder-
subject is a separate, additive decision — not v1.

## Consequences

- **Positive:**
  - The KB gains real, **dynamic** access tiering with **zero new ownership columns** — access rides
    existing live [[access-grant]] / [[asset-assignment]] joins, so it **follows offboarding
    automatically** (revoke the grant, lose the runbook). No separate KB-permission to revoke by hand.
  - The per-domain catalog and the three-role model are **untouched** (INV-1/INV-8 intact): `article:read`
    still gates *whether you can act*; the folder ACL is a clean orthogonal *what-is-in-scope* axis. No
    dynamic custom roles, no per-article matrix, no ABAC engine.
  - Behaviour is **unchanged until a folder opts in** (§2 default = today's public-to-authenticated), so
    the carve-out ships invisibly and is adopted folder-by-folder.
  - Existence-hiding stays consistent: folder-hidden and draft-hidden articles both 404
    ([[0022-draft-visibility-auth-shim]]), so the server never leaks which restricted documents exist.
  - The no-escalation invariant (INV-9) is enforced **belt-and-suspenders** (service + DB), so an alias
    or share can never widen access — the boundary is never UI-only.

- **Negative / trade-offs (accepted):**
  - **This is the FIRST per-resource scoping axis in lazyit** — a *second authorization axis* (capability
    *and* folder visibility) to design, test and maintain. Accepted as a **deliberate, bounded** carve-out
    confined to the KB (the one domain whose content is intrinsically tiered); Option B stays rejected
    everywhere else.
  - **Read-time rule evaluation has a cost** — every KB read now resolves folder access via `EXISTS`
    subqueries over live joins (plus the existing draft check). Bounded (a handful of OR rules per folder,
    small team) and DB-first by design (no cached ACL to drift), but it is real overhead the
    public-only path did not pay. The PUBLIC fast-path (no rule) keeps the common case to one indexed
    check.
  - **Inheritance semantics add a moving part** — narrow-down-the-tree resolution (§1) is more than a flat
    rule; the exact resolution lands with [[folder]] in [[0059-kb-folders-links-and-import]] and must be
    invariant-tested (a child can never widen past an ancestor).
  - **Service accounts fail closed on restricted folders** (§8) — a bot integration that needs to read a
    restricted runbook has no path in v1; that is the safe default, and SA-as-subject is a separable later
    ADR.

- **Follow-ups:**
  - **INV-9** is landed in [[INVARIANTS]] (between INV-SA-4 and INV-10); the §6 block is the summary — keep the two in sync.
  - The [[folder]] rule-storage shape (the zod rule vocabulary + the partial-unique/CHECK backstop) and the
    inheritance resolution are specified with [[0059-kb-folders-links-and-import]]; this ADR is the policy,
    that ADR is the data model.
  - Implementation (#365): the read-path §4 evaluator (DB-first `EXISTS` over live joins + the existing
    draft check, 404-not-403), the alias/share no-escalation re-check, the per-folder rule editor UI (the
    padlock + tooltip is presentation only), and the invariant tests (folder-hidden → 404, no-escalation
    on alias, ADMIN-sees-all, SA fails-closed, inherit-narrow-never-widen).
  - Phase 2 — **alias-as-share** (§7), reserved.

**Related:** [[0059-kb-folders-links-and-import]] · [[0046-roles-permissions-v2]] · [[0040-rbac-roles]] ·
[[0022-draft-visibility-auth-shim]] · [[0023-access-management-design]] · [[0021-knowledge-base-design]] ·
[[0061-secret-manager-zero-knowledge]] · [[0048-service-accounts]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] · [[access-grant]] ·
[[asset-assignment]] · [[folder]] · [[article]] · [[article-alias]] · [[service-account]] ·
[[INVARIANTS]] (INV-1 / INV-8 / INV-9)
