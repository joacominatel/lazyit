---
title: "Workflow Engine — Frontend / Admin Builder UX design"
tags: [design, frontend, web, workflow-engine, access, ux, builder]
status: proposed
created: 2026-06-07
---

# Workflow Engine — Frontend / Admin Builder UX

> Scope: the **admin-facing web UX** for the Applications workflow engine — the per-application
> Workflows surface, the workflow builder, connection/secret entry, the data-mapping editor, the
> manual-task inbox, run observability, dry-run/test affordances, permission gating, and the API
> contracts the frontend needs. This is a *design* document — **no code, no schema, no migrations.**
> It is one of several area docs under `docs/workflow-engine/`; it owns the web lane only and flags
> dependencies on the backend/devops/security lanes.

This builds on the established frontend conventions and design direction:

- **Data layer** — `docs/03-decisions/0020-frontend-data-layer.md` (endpoints → hooks → components,
  query-key factories, react-hook-form + shared zod, `<ResourceTable>` / `<DeleteConfirmDialog>` /
  `notifyError` / `RequestIdNote`).
- **Design system** — `docs/03-decisions/0049-activated-restraint-ux-direction.md` (Activated
  Restraint: warm-bone + indigo, the per-pillar colour map where **Access = `--chart-1` indigo**,
  the AA rules, motion vocabulary), on top of `docs/03-decisions/0011-tailwind-styling.md` and
  heroicons (`docs/03-decisions/0045-icon-library-heroicons.md`).
- **Permission gating** — `docs/03-decisions/0046-roles-permissions-v2.md` + the live `can()` infra in
  `apps/web/lib/hooks/use-permissions.ts` (`useCan('domain:action')`, fails closed).
- **The trigger source** — `docs/03-decisions/0023-access-management-design.md` (Application +
  AccessGrant; grant/revoke are the v1 triggers) and the live surfaces in
  `apps/web/app/(app)/applications/[id]/page.tsx`.
- **Reusables we depend on** — the one-time secret reveal in
  `apps/web/app/(app)/settings/service-accounts/_components/secret-reveal.tsx`
  (`docs/03-decisions/0048-service-accounts.md`), the ADR-0052 Settings/Notifications/SystemSecret/SSE
  stack (summarized in `.claude/skills/lazyit-cto/references/decision-history.md`, on branch
  `feat/settings_notifications_smtp`, **not yet on `dev`**), and the async substrate in
  `docs/03-decisions/0053-async-workers-bullmq-valkey.md`.

---

## 1. The product shape the UX must express

Restated from the brief so the UX is anchored to it:

- A workflow is **opt-in per Application**. If an application has no workflow, granting access behaves
  **exactly as today** — `POST /access-grants` records the grant and nothing else fires
  (`docs/02-domain/entities/access-grant.md`). The UX must never imply automation where none is
  configured.
- v1 triggers are **(1) access granted** and **(2) access revoked**. Timer/scheduled triggers are
  later (ride the ADR-0053 repeatable-job capability; the UI reserves a trigger slot for them but
  does not build them now).
- A workflow is **a connection + an ordered list of steps**. Each step does something against the
  external app (REST call, webhook, MCP/SDK call later, or a **manual human task**) and **maps lazyit
  data into the payload**.
- A failing external provisioning call **must not roll back or block the local AccessGrant**. This is
  the deliberate **contrast** with the Zitadel write-back (`docs/03-decisions/0043-zitadel-source-of-truth.md`
  / `docs/06-security/INVARIANTS.md` INV-5, which rolls back + 503s on failure). The grant is the
  source of truth; provisioning is a best-effort, observable side effect. **This single rule is the
  spine of the whole frontend model** — the grant UI stays instant and the run is a separate,
  asynchronous, observable object.

### Load-bearing UX consequence

Because provisioning is async and non-blocking, **the grant action and the run are decoupled in the
UI**. Granting access returns immediately (as today) and *additionally* spawns a **Run** the operator
can watch. The web never waits on the external system inside a mutation. This is the same shape as the
ADR-0053 article-import pilot (`POST` returns `202 { jobId }`, the client watches status) — and it is
why the substrate question, from the frontend, reduces to **"how does run status arrive?"** (§11).

---

## 2. Information architecture — where the UX lives

Two entry points, one shared component set. This mirrors how RBAC v2 is both an admin hub area and a
per-call-site concern, and how access-grants live both on the application detail and as a domain.

### 2a. Per-application "Workflows" tab (primary, discovery-first)

The application detail page (`apps/web/app/(app)/applications/[id]/page.tsx`) is today a stack of
`<DetailPanel>`s (Details, Active access, Related articles, History). Add a **Workflows** surface
scoped to that application. Recommendation: a **tabbed application detail** (Overview / Workflows /
Activity) rather than yet another stacked panel, because the workflow surface is substantial (builder,
runs, connection) and competes with the access list for attention.

The Workflows tab shows, for that application:

- **A connection card** — is a connection configured? which integration type? a `Test connection`
  button and last-test result. Empty state: "No automation configured — grants are recorded only."
- **The workflows list** — one row per (trigger) workflow: trigger badge (Granted / Revoked), enabled
  toggle, step count, last-run status, `Edit` / `Run history`. Most apps have **0–2** workflows (one
  per trigger), so this is a short list, not a paginated table — but it reuses `<ResourceTable>` for
  consistency (`apps/web/components/resource-table.tsx`).
- **Recent runs** — the last few runs for this app with status pills, linking to the run timeline (§9).

This keeps the feature **inside the Access pillar** and discoverable exactly where an admin already
manages grants — no hunting in a settings menu.

### 2b. Global hub under Settings (cross-app management)

There is already an empty `apps/web/app/(app)/settings/integrations/` route (with a `_components`
folder) — this is the natural home for the **cross-application** view: every connection, every
workflow, all runs, and the **manual-task inbox** aggregated across apps. The Settings index
(`apps/web/app/(app)/settings/page.tsx`) is a card grid behind `AdminGate`; add an **Integrations /
Workflows** card there alongside Service accounts and Roles.

The hub is for the IT lead who wants "show me everything that's automated and everything that needs a
human right now," independent of which app. It re-uses the same list/table/timeline components as the
per-app tab; only the scope filter differs (`?applicationId=` vs all).

> **IA decision to confirm with the CEO:** primary home = the per-application tab (discovery), with the
> Settings hub as the cross-cutting console. This matches the precedent that access-grants are managed
> per-application but the *engine configuration* is admin-gated. (Open question Q1.)

---

## 3. The builder — trigger, then steps

### 3a. Recommendation: a form/list step editor, NOT a node-graph canvas (v1)

**Strong recommendation: v1 is a vertical, ordered list of step cards inside a form — not a
drag-on-canvas node graph (no React Flow / xyflow).** Justification, weighted to this product:

1. **The v1 trigger model is linear.** A grant/revoke trigger fires **one** sequence of steps. There
   are no branches, no fan-in, no human-drawn edges to express in v1. A node graph's entire value is
   non-linear topology we do not have. A list *is* the data model.
2. **Operator profile** (`.claude/skills/lazyit-cto/references/product-vision-tech.md`): an IT
   generalist who "edits a `.env` file." A node canvas is a power-user tool with its own interaction
   language (pan/zoom/connect/auto-layout), accessibility cost (keyboard/AT support for a canvas is
   hard), and mobile failure mode. A list of cards is keyboard-native, screen-reader-friendly, and
   degrades to a stacked card view exactly like every other lazyit list (ADR-0020 responsive
   `<ResourceTable>` / `<ResourceCard>`).
3. **It reuses everything we have.** Step cards are `react-hook-form` field arrays validated by shared
   zod (ADR-0020 forms convention); the page is a `<DetailPanel>`/`<PageHeader>` composition; reorder
   is an up/down control (and later a dnd handle) on each card. A canvas would pull in a heavy runtime
   dep and a bespoke rendering layer that the Activated Restraint token system (ADR-0049) does not
   cover — we would be hand-styling nodes/edges outside the design system.
4. **It avoids becoming n8n.** A canvas invites "build any flow" scope; the list keeps the feature
   honestly scoped to **access provisioning/deprovisioning** (the anti-goal guardrail in the brief).
5. **Migration path is open.** The persisted shape (an ordered `steps[]` array, ADR-0007 jsonb-style
   flexible config validated by zod — `docs/03-decisions/0007-flexible-asset-specs-jsonb.md`) is
   canvas-renderable later *without* a data migration if real branching ever lands. Choosing the list
   now does not foreclose a graph later; choosing a graph now over-commits.

So: **list now, graph never until branching is a real, validated need** — and even then, reconsider.

### 3b. Builder layout

A full-page route, not a dialog, because it is multi-section and the user will iterate:
`/applications/[id]/workflows/[workflowId]/edit` (and `/new`), mirroring how Assets/Applications use
page-route forms for the heavy create/edit (ADR-0020 "Page-route forms").

```
PageHeader: "Jira — provisioning on access granted"   [Disabled ▢→enabled]  [Save]
─────────────────────────────────────────────────────────────────────────────
1. Trigger          ── a small fixed section: choose Granted | Revoked (radio cards).
                       (later: + a Timer trigger card, disabled with a "coming soon" hint)
─────────────────────────────────────────────────────────────────────────────
2. Connection       ── "Uses the Jira connection"  [Edit connection] [Test]
                       (or: pick/create a connection if none — §5)
─────────────────────────────────────────────────────────────────────────────
3. Steps  [+ Add step ▾]   (REST call · Webhook · Manual task · …)
   ┌───────────────────────────────────────────────────────────┐
   │ ⋮⋮  ① Create Jira user        [REST] [POST /rest/api/.../user]  ▸ │
   │     ↳ when expanded: method/url, headers, data-mapping (§6)      │
   ├───────────────────────────────────────────────────────────┤
   │ ⋮⋮  ② Assign to team          [Manual] needs a human         ▸ │
   └───────────────────────────────────────────────────────────┘
─────────────────────────────────────────────────────────────────────────────
[ Test run (dry-run) ]                                  [ Discard ] [ Save ]
```

- **Steps are collapsible cards** in a `react-hook-form` `useFieldArray`. Collapsed shows
  type-icon + name + a one-line summary + status of validation; expanded shows the per-type editor.
- **Add step** is a dropdown of integration types (§4). Each type renders a different editor body —
  a discriminated union in the shared zod schema drives both the form and validation.
- **Reorder** = up/down buttons in v1 (keyboard-accessible, no dep); a drag handle (`⋮⋮`) is a
  fast-follow if the dnd cost is justified.
- **Enable/disable** is a top-level switch (a disabled workflow never fires — same affordance the
  Service-accounts `isActive` toggle uses).

### 3c. Step types in the "Add step" menu (the integration-diversity surface)

Each integration type the brief lists maps to a **step-type card with its own config body**. v1 ships
the two that cover the most ground plus the manual escape hatch; the rest are slotted but later:

| Step type | v1? | Config body (frontend form fields) |
| --- | --- | --- |
| **REST / HTTP call** | ✅ v1 | method, URL (relative to the connection base), headers (kv), body template + **data mapping** (§6), expected-success codes |
| **Manual task** | ✅ v1 | title, instructions (markdown), the fields a human must fill (with optional suggestions by role/team — §7), assignee policy |
| **Outbound webhook** | ✅ v1 (a REST POST with a signature toggle) | URL, signing secret (write-only, §5), payload mapping |
| **Inbound webhook / callback** | later | the engine exposes a callback URL; UI shows it + a "waiting for callback" step state |
| **Vendor SDK / prebuilt connector** | later | a connector picker (Jira/GitHub/…) with a typed form instead of raw REST |
| **MCP server call** | later | server URL + tool picker + arg mapping |
| **"Build the API ourselves" / self-hosted** | later | same REST card pointed at the internal host |

This is **opinionated-where-it-helps, configurable-where-it-must** — the brief's explicit carve-out
from "opinionated over configurable." The discriminated-union step schema means a later type is an
additive variant, not a rewrite — the same way the access-level combobox keeps suggestions in `web`
while the schema stays free-form (`apps/web/components/access-level-combobox.tsx`).

---

## 4. Connection & secret entry UX

A **Connection** is the per-app "how do we reach this system + with what credentials" object, separate
from the workflows that use it (one connection, N workflows). This is where per-app auth lives.

### 4a. Connection form

A dialog or sub-page with:

- **Integration type** (REST/HTTP, Webhook, …) — drives the rest of the form.
- **Base URL / host** — reuse the lenient-but-safe URL handling from Application.url
  (`isSafeApplicationUrl`, scheme-less internal hosts allowed, dangerous schemes rejected — SEC-008,
  `docs/02-domain/entities/application.md`).
- **Auth method** — None / API token / Basic / Bearer / OAuth2 (later). Selecting one reveals the
  matching secret fields.

### 4b. Secrets are **write-only** — reuse two established patterns

Per `docs/06-security/INVARIANTS.md` INV-6 (secrets never logged/leaked) and the ADR-0052
`SystemSecret` encrypted-at-rest store (the brief says reuse it), credential entry must be **write-only
from the UI**:

- A configured secret renders as a **masked, non-refetchable field** — `••••••••` with a `Replace`
  button, exactly like the SMTP-password field shipped under ADR-0052 (the API returns
  `hasSecret: true` / a redacted prefix, **never** the cleartext). The frontend never holds a stored
  secret in cache. This is the inverse direction of the **one-time reveal** in
  `apps/web/app/(app)/settings/service-accounts/_components/secret-reveal.tsx`: there we show a
  *generated* secret once; here we *accept* a secret once and never read it back.
- If the engine ever **mints** a credential to hand to the external system (rare), reuse `SecretReveal`
  verbatim (the one-time panel with copy + "I've saved it" acknowledgement).
- **Never echo a secret into a step's data-mapping preview, a dry-run log, or the run timeline.** The
  mapping/preview UI substitutes `‹secret:apiToken›` placeholders; redaction is enforced server-side
  (INV-6 / ADR-0031 bodies-never-logged) and mirrored in the UI so a screenshot is safe.

### 4c. Test connection

A `Test connection` button on the connection card calls a backend `POST .../test-connection` that does
a single bounded probe (auth handshake / a HEAD/GET) and returns `{ ok, status, message, requestId }`.
The UI shows a success/failure inline result with the **request id** surfaced via the existing
`RequestIdNote` (`apps/web/lib/api/notify-error.ts`, ADR-0031). Test is **read-only** and must never
provision anything. (Backend contract C3, §11.)

---

## 5. Data-mapping UX — lazyit fields → external payload

Each REST/webhook/manual step needs to turn the run context (the grantee user, the application, and
fixed context) into the outbound payload. This is the **per-step data mapping** editor.

### 5a. The mapper

A two-column, repeatable key→value editor inside the step card:

```
External field                Value source
─────────────────            ─────────────────────────────────────
email                  ←      {{ grantee.email }}            [token ▾]
firstName              ←      {{ grantee.firstName }}        [token ▾]
lastName               ←      {{ grantee.lastName }}         [token ▾]
organization           ←      "Acme Inc"  (literal)          [token ▾]
team                   ←      ✋ ask a human  (manual)        [token ▾]
```

- The **value source** for each field is one of: a **context token** (a value from the run context),
  a **literal**, or **ask-a-human-at-runtime** (which promotes a field into a manual sub-task — §7).
- The token picker is a **combobox/`<datalist>`** seeded from the available context tokens for the
  current trigger — the same lightweight suggestion pattern as
  `apps/web/components/access-level-combobox.tsx` (suggestions live in `web`, the schema stays
  free-form). For v1 the token catalog is small and **flat**:

  | Token group | Examples (v1) |
  | --- | --- |
  | `grantee.*` | `email`, `firstName`, `lastName`, `id` |
  | `application.*` | `name`, `vendor`, `url` |
  | `grant.*` | `accessLevel`, `grantedAt`, `expiresAt` |
  | `context.*` | `actor` (who granted), `now` |

- **Validation & preview.** The form validates that required external fields are mapped; a **Preview**
  toggle renders the resolved payload using a **sample/last grant** (secrets shown as placeholders).
  This makes the abstract mapping concrete for the operator without a live call.

### 5b. Identity-field scope creep — flag it now

The brief notes future richer identity fields (role, team, manager, boss, AD integration). **These do
not exist in the lazyit model today** (`docs/02-domain/entities/user.md` has no manager/team). The
token picker for v1 therefore **only offers fields that exist** — name/email/id, application, grant.
Offering `grantee.manager` or `grantee.team` would either dangle (no data) or pressure us to grow the
User model into an HR/Identity-Governance graph — the explicit anti-goal
(`.claude/skills/lazyit-cto/references/product-vision-tech.md` "Not an HR system"). The **manual-task**
path is the v1 answer for "which team?" — a human supplies it, optionally with role-based suggestions —
**without** modeling org structure. Adding real identity fields is a separate, model-first decision
(Open question Q4); the mapper UI is forward-compatible (a new token group is additive) but does not
drive that decision.

---

## 6. The manual-task inbox

Some steps need a human: an app with no API, or a "which team / which manager?" decision. A manual step
**pauses the run** and creates a **manual task** assigned to IT. The frontend surfaces these as a
first-class **inbox**.

### 6a. Ride the ADR-0052 notification bell + SSE

The brief instructs reusing the ADR-0052 notification/bell/SSE stack — and it is the right fit:

- A new manual task **emits a `Notification`** (a new notification type, e.g. `workflow.manual_task`),
  so it appears in the **topbar bell** with live **SSE** push (the bell already consumes
  `GET /notifications/stream` via the fetch-based SSE client decided in the decision-history note,
  reusing the session-token store — no auth change). The operator gets an instant "a task needs you"
  without polling.
- The bell links to the **inbox** (`/settings/integrations/tasks`, also reachable from the per-app
  Workflows tab filtered to that app), which is a `<ResourceTable>` of pending tasks: app, workflow,
  step, "what's needed," age, `Open`. This is the queue.

### 6b. The task action UI

Opening a task is a focused form:

- **What happened** — "Granting Jira access to Jane Doe paused at step ‹Assign to team›."
- **The fields to fill** — exactly the fields the step marked "ask a human," rendered as inputs.
  Suggestions (e.g. team-by-role) come from a backend `suggestions` payload on the task — the UI is a
  combobox seeded from it (same datalist pattern). Suggestions are **hints, never enforced**.
- **Actions** — `Submit` (provide the data → resume the run), `Skip step` (if optional), `Fail run`
  (give up, with a reason). Each is a mutation that invalidates the task list + the run.
- Completing/dismissing the task marks the originating notification read (the ADR-0052 delivery model
  already tracks per-notification read state).

> **Dependency flag:** the inbox **depends on ADR-0052 being merged to `dev`** (it is currently on
> `feat/settings_notifications_smtp`). If the workflow engine ships first, the inbox degrades
> gracefully to a **polled** list page (no live bell) — still fully usable, just not real-time. The
> builder/runs/connection surfaces have **no** ADR-0052 dependency. (Dependency D1.)

### 6c. Scope-creep guardrail

The manual-task inbox is an **access-provisioning task queue**, not a general ticketing/approval system
(`access-request` approval is a *separate* deferred design — `docs/03-decisions/0023-access-management-design.md`).
Keep its vocabulary about *provisioning steps*, not generic "approvals," or it drifts toward the
ticketing pillar we have deliberately not built.

---

## 7. Run observability UI — the run timeline

Every trigger firing creates a **Run**. The run UI is the audit + debugging surface, and it should
feel like the asset-history timeline operators already know
(`apps/web/app/(app)/assets/_components/asset-history-timeline.tsx`) — a vertical timeline with status
badges, relative timestamps, and a request id.

### 7a. Run list

Per-app (Workflows tab → Recent runs) and global (hub → Runs), a `<ResourceTable>` paginated per the
`Page<T>` contract (`docs/03-decisions/0030-list-pagination-contract.md`): trigger, grantee, started,
duration, **status** (`StatusBadge`: Queued / Running / **Waiting (manual)** / Succeeded / Failed /
Partially failed), and a link to the run detail. Server-side sort/filter by status + app + date.

### 7b. Run detail timeline

A vertical step timeline (reusing the `asset-history-timeline` visual grammar — connecting line, status
dot, badge, ml-auto timestamp, AA-safe `StatusBadge` tones per ADR-0049 §4):

```
● Run #1042 · access granted → Jane Doe · Jira          [Succeeded]   2m ago
│   request-id: 7f3a…  (copyable)            [Retry failed steps] [Re-run]
│
├─● ① Create Jira user           [REST]  POST /rest/api/3/user      ✓ 200   320ms
│    ↳ request-id 7f3a-1 · 2 retries · ▸ show redacted request/response
│
├─● ② Assign to team             [Manual] resolved by IT            ✓        15m
│    ↳ "team = Platform" (provided by Alice)
│
└─● ③ Notify in Slack            [Webhook]                          ✗ 502   ▸ details
     ↳ retry 3/3 exhausted · ▸ show redacted log · [Retry]
```

Per step the timeline shows: type, target (method/path), **status**, **retry count**, duration, the
step's **request id** (ADR-0031, copyable via `RequestIdNote`), and an expandable **redacted**
request/response log. **Redaction is non-negotiable** (INV-6, ADR-0031 bodies-never-logged) —
the UI renders whatever the API returns (already redacted), and **never** un-redacts; secret tokens and
mapped sensitive values appear as `‹redacted›`. Failed steps offer `Retry` (single step) and the run
offers `Retry failed` / `Re-run` where the backend supports it (BullMQ retries/backoff per ADR-0053).

### 7c. The grant ↔ run cross-link

On the application detail Active-access list (and the per-user grants view), a grant whose workflow ran
gets a small **run-status chip** ("Provisioned ✓" / "Provisioning…" / "Needs attention ✗") linking to
the run. This closes the loop: the operator who granted access sees, *non-blockingly*, what the
automation did — without the grant action ever having waited. This is the visible payoff of the
decoupled model (§1) and the contrast with the synchronous Zitadel mirror.

---

## 8. Dry-run / test affordances

Two distinct test surfaces, both read-only-ish and clearly labelled:

1. **Test connection** (§4c) — does the credential work? One probe, no provisioning.
2. **Test run (dry-run)** in the builder — execute the workflow against a **chosen sample grant** in a
   mode where the backend either (a) runs with a `dryRun` flag that **skips side-effecting calls and
   returns the resolved payloads + would-be requests**, or (b) runs for real against a sandbox the
   admin points the connection at. v1 should prefer **(a) payload-resolution dry-run** — it needs no
   sandbox, it is safe by construction, and it directly validates the data mapping (the most
   error-prone part). The dry-run renders into the **same run-timeline component** with a "DRY RUN"
   banner, so the operator learns one observability surface. (Backend contract C4, §11.)

Both reuse `notifyError` + `RequestIdNote` for failures so every test is traceable.

---

## 9. Permission gating with `can()`

All workflow surfaces gate render with the live `can('domain:action')` infra
(`apps/web/lib/hooks/use-permissions.ts`, fails closed) — the API guard is always the real gate
(ADR-0046 §P6b). This feature needs **new catalog entries**, which is a **`@lazyit/shared` change**
(the frozen `PermissionSchema` in `packages/shared/src/schemas/permission.ts`) and therefore a
backend/shared decision the engine's core ADR must own — the frontend only *consumes* them. Proposed
literals (to be ratified in the engine ADR, extending the ADR-0046 catalog):

| Permission | Gates (frontend) | Suggested default |
| --- | --- | --- |
| `workflow:read` | the Workflows tab, run list/detail, connection card (masked) | ADMIN + MEMBER (sensitive — like `accessGrant:read`) |
| `workflow:manage` | create/edit/enable/delete workflows, connection + **secret** entry, test-connection, dry-run | ADMIN-only by default (coarse verb, like `settings:manage`) |
| `workflow:task` | act on a **manual task** (submit/skip/fail) | ADMIN + MEMBER (day-to-day ops can resolve tasks) |

Notes & rationale:

- Splitting `manage` (configure the engine — high blast radius, touches secrets) from `task` (resolve
  a queued human step — routine ops) matches the brief's "workflow management gated by its OWN RBAC"
  while letting MEMBERs clear the inbox without granting them connection/secret editing.
- Because secrets ride `workflow:manage`, the **write-only secret fields render only for managers**;
  a `workflow:read` holder sees `hasSecret: true` but never a Replace control.
- Per ADR-0046 the catalog must carry human-readable `PERMISSION_META` + a capability grouping (under
  the **Access** pillar) so the role-editor (`/settings/roles/permissions`) can render the new toggles
  — that copy lives in `@lazyit/shared` next to the catalog (covering-set test guards drift). The
  workflow-management capability should be flagged ⚠ "Admin-level" if granted to MEMBER/VIEWER, the
  same friction-not-block treatment the role editor already applies to coarse verbs.
- Reuse `AdminGate` for the Settings hub shell (it is already `settings`-area chrome), then re-check
  `can('workflow:manage')` at the affordance level inside (the same belt-and-suspenders the
  Service-accounts manager uses with `useCan('settings:manage')`).

---

## 10. Backend API contracts the frontend needs

The frontend lane needs these contracts defined by the backend lane (shapes are illustrative; the
engine ADR owns the truth). All list reads follow the `Page<T>` envelope (ADR-0030); all responses
carry `X-Request-Id` (ADR-0031); all bodies are pre-redacted (INV-6).

- **C1 — Workflows & connections CRUD** (`/applications/:id/workflows`, `/applications/:id/connection`,
  or a flat `/workflows` + `?applicationId=`). Standard CRUD → fits `createCrudEndpoints` +
  `createQueryKeys` (ADR-0020). Secret fields are **write-only**: reads return `{ hasSecret, prefix? }`,
  writes accept cleartext once, never echoed back.
- **C2 — Run status**
  - `GET /workflow-runs?applicationId=&status=&...` → `Page<RunSummary>` (list, sort/filter per ADR-0030).
  - `GET /workflow-runs/:id` → run + ordered steps with `{ status, retryCount, durationMs, requestId,
    redactedRequest?, redactedResponse?, error? }`.
  - **Realtime:** run/step status changes **should also push over the ADR-0052 SSE channel** as
    notifications/events the bell + an open run-detail can consume; the run-detail page **subscribes to
    SSE when mounted and falls back to short polling** (`refetchInterval`) while a run is non-terminal,
    stopping once it reaches a terminal status. (Substrate detail — §11.)
- **C3 — Test connection** — `POST .../connection/test` → `{ ok, status, message, requestId }`.
  Synchronous, bounded, read-only.
- **C4 — Dry-run** — `POST /workflow-runs/dry-run` (or `POST .../workflows/:id/test`) with a sample
  grant id → resolved payloads + would-be requests, **no side effects**. Returns the same step-shaped
  data the run timeline renders.
- **C5 — Manual tasks**
  - `GET /workflow-tasks?status=pending&applicationId=` → `Page<TaskSummary>` (the inbox).
  - `GET /workflow-tasks/:id` → the task + the fields to fill + optional `suggestions`.
  - `POST /workflow-tasks/:id/submit` (the field values) → resumes the run;
    `POST /workflow-tasks/:id/skip`, `POST /workflow-tasks/:id/fail`.
  - New notifications of type `workflow.manual_task` and `workflow.run_failed` flow through the
    ADR-0052 notification + SSE stack (no new transport).
- **C6 — Context-token catalog** — either a static set the web ships (preferred for v1; it is small and
  tied to the trigger) or `GET /workflow-context-tokens?trigger=` if it must stay server-authoritative.
  v1: ship it in `web` next to the mapper (like the access-level suggestions) to avoid a round-trip.

### Poll vs SSE — the decision

- **Manual-task inbox & run-failed alerts → SSE** (the bell), because they are exactly the
  "something needs a human / went wrong" events the ADR-0052 bell exists for, and latency matters
  (an operator should see a paused run promptly).
- **An open run-detail timeline → SSE if available, else short polling** while the run is non-terminal.
  Polling is the dependency-free floor (works with **any** durable substrate and even before ADR-0052
  lands); SSE is the upgrade that makes it live. Both stop at a terminal status, so there is no idle
  polling.
- **List pages → no realtime**; refetch on focus/navigation (TanStack default) + the user's own
  mutations invalidate. A run list does not need to tick live.

---

## 11. Substrate verdict — from the frontend lens

**The question the frontend actually answers is: "how does run status reach the UI, and can the grant
action stay instant?"** From that lens:

- **Synchronous execution is wrong** — and not just for performance. A grant that blocks on an external
  Jira call would (a) make the grant UI hang on a third party, and (b) re-create the Zitadel
  strong-coupling the brief explicitly says **not** to copy for provisioning (INV-5: a failed external
  call must not block/roll back the local grant). The frontend *requires* the grant mutation to return
  immediately and the run to be a separate, watchable object. So the substrate **must be durable
  async**. ✅
- **Given durable async, the frontend is substrate-agnostic for the happy path** — whether the queue
  is **BullMQ+Valkey** (ADR-0053) or **pg-boss**, the UI consumes the *same* contracts (C1–C6) and the
  same poll-or-SSE pattern. The FE does not care which broker stores the job.
- **But three things tilt the FE toward the ADR-0053 BullMQ+Valkey choice that is already accepted:**
  1. **Multi-step runs with retries are first-class in BullMQ** (flows, per-step retry/backoff). The
     run timeline (§7) renders per-step status + retry count + step-level `Retry`; BullMQ gives the
     backend a native model to feed that UI, whereas pg-boss has no first-class parent/child flows
     (ADR-0053 rejected it for exactly the workflow-engine need). A richer backend run model = a
     richer, truthful timeline with no FE faking.
  2. **It is already decided and already adds the SSE-adjacent plumbing** — ADR-0053 is accepted and
     the article-import pilot establishes the `202 + jobId + watch-status` pattern this UX copies. The
     FE gets to reuse a proven shape rather than invent one.
  3. **It composes with ADR-0052 SSE** for the live bell/run updates the UX leans on, on the same
     single host.
- **Temporal and n8n are overkill / wrong-shape from the FE:**
  - **Temporal** gives the FE nothing extra — we still poll/SSE a status; meanwhile it imposes a heavy
    operational surface that violates the one-command-self-host operator constraint
    (`docs/03-decisions/0015-deployment-model.md`, product-vision operator profile). Its durable-workflow
    guarantees are real but unneeded for "fire a few HTTP calls per grant."
  - **n8n is a *product*, not a substrate** — adopting it would **replace this entire admin builder
    UX** with n8n's own canvas, breaking `can()` gating (ADR-0046), the Activated Restraint design
    system (ADR-0049), the unified audit trail (INV-SA-4), the manual-task-via-bell integration, and
    the self-hosted single-app experience. It is the opposite of "keep it inside the Access pillar."
    From the FE lens it is a non-starter.

**Verdict (frontend lens): durable async, and BullMQ+Valkey (ADR-0053) is the right substrate — not
overkill here because the workflow engine is precisely the multi-step/retry/flow use case that ADR
chose it for. Run status reaches the UI via the ADR-0052 SSE channel for live updates (bell + open run
timeline) with short polling as the dependency-free fallback; the grant action stays synchronous and
instant, and the run is a decoupled, observable object.** pg-boss would *technically* serve the same
FE contracts but loses the first-class flows/retries the run timeline wants and would be replaced when
the engine matures (ADR-0053's own reasoning); synchronous and Temporal/n8n are rejected for the
reasons above.

---

## 12. Frontend data-layer plan (ADR-0020)

Concrete shape so the build slots into the existing mold:

- **Endpoints** (`apps/web/lib/api/endpoints/`): `workflows.ts`, `workflow-connections.ts`,
  `workflow-runs.ts`, `workflow-tasks.ts` — pure `apiFetch` functions, request/response types from
  `@lazyit/shared`. CRUD resources use `createCrudEndpoints`; the bespoke ones (`testConnection`,
  `dryRun`, `submitTask`, `retryStep`) are explicit typed functions spread onto the result.
- **Hooks** (`apps/web/lib/api/hooks/`): `use-workflows.ts` (+`-mutations`), `use-workflow-runs.ts`,
  `use-workflow-tasks.ts`. Query-key factories via `createQueryKeys` (`workflowKeys`, `runKeys`,
  `taskKeys`); nested run/step keys under `runKeys.detail(id)` so a status push invalidates precisely.
  The run-detail hook takes a `refetchInterval` that is **active only while non-terminal**.
- **Components**: builder + run + connection live in
  `apps/web/app/(app)/applications/[id]/workflows/_components/`; the cross-app hub + inbox in
  `apps/web/app/(app)/settings/integrations/_components/` (the folder already exists). The run timeline
  is a shared component if both surfaces use it (promote on genuine reuse, ADR-0020).
- **Forms**: builder uses `react-hook-form` + a shared zod **discriminated-union step schema**; empty
  optionals → `undefined` (strict-schema convention). The step list is a `useFieldArray`.
- **Errors**: `notifyError` + `RequestIdNote` everywhere (ADR-0031 request-id correlation).
- **i18n**: all copy via `next-intl` with en/es parity (ADR-0051), matching the rest of `web`.

---

## 13. Phased, v1-first delivery

Ordered so each phase is independently shippable and the riskiest UX (the builder + mapping) is
de-risked by an early dry-run.

- **Phase 0 — contracts & catalog (shared/back, FE-blocking).** The engine ADR ratifies the permission
  literals (§9) and the C1–C6 contract shapes (§10) in `@lazyit/shared`. FE can stub against them.
- **Phase 1 — read-only surfacing.** The Workflows tab (empty/"not configured" state), the run list +
  run-detail timeline (reusing the asset-history grammar), `workflow:read` gating, the grant↔run chip.
  Proves observability before configurability. No ADR-0052 dependency.
- **Phase 2 — connection + REST step + data mapping + dry-run.** The builder (list editor),
  write-only secret fields, test-connection, the data-mapper with the token combobox, and the
  payload-resolution dry-run (the single highest-value test). `workflow:manage` gating. This is the
  core feature.
- **Phase 3 — manual tasks + inbox + bell.** The manual step type, the inbox table, the task action
  form, and the ADR-0052 bell/SSE wiring (`workflow.manual_task`). **Gated on ADR-0052 reaching `dev`**
  — degrades to a polled inbox if not. `workflow:task` gating.
- **Phase 4 — realtime run status over SSE.** Upgrade run-detail/list from polling to SSE push.
- **Later (own decisions):** webhook-inbound/callback step state, SDK/prebuilt connectors, MCP step,
  timer/scheduled trigger UI, drag-reorder, the richer identity-token groups (model-first, Q4).

---

## 14. Risks, dependencies, open questions

### Risks

- **Scope drift into n8n / a general flow builder.** Mitigation: list-not-canvas (§3), step types
  scoped to access provisioning, manual tasks framed as provisioning steps not generic approvals.
- **Scope drift into HR/Identity Governance** via team/manager/AD identity fields (§5b). Mitigation:
  the v1 token catalog offers only fields that exist; "which team?" is a manual task, not a model
  change.
- **Secret leakage through the UI** (preview, dry-run log, run timeline). Mitigation: write-only
  fields, placeholder substitution, render-only-what-the-API-redacts, never un-redact (INV-6,
  ADR-0031). Needs a security review of every place a mapped value or log is shown.
- **ADR-0052 not on `dev`** when the engine ships → no live inbox. Mitigation: polled-inbox fallback;
  builder/runs/connection have no ADR-0052 dependency.
- **Operator confusion that automation is mandatory.** Mitigation: a loud "grants are recorded only —
  no automation configured" empty state; the grant flow is visually unchanged when no workflow exists.

### Dependencies

- **D1 (ADR-0052)** — the bell + SSE + notification model for the manual-task inbox and live run
  status. On `feat/settings_notifications_smtp`, not yet on `dev`.
- **D2 (ADR-0053)** — the durable async substrate (BullMQ+Valkey) that makes runs decoupled/observable;
  the `202 + watch-status` pattern this UX mirrors.
- **D3 (shared catalog / ADR-0046)** — the new `workflow:*` permissions + `PERMISSION_META` are a
  `@lazyit/shared` change owned by the engine ADR, consumed by `can()`.
- **D4 (backend contracts C1–C6)** — defined by the backend lane; the FE data layer is a thin typed
  wrapper over them.

### Open questions (CEO / cross-lane)

- **Q1 — IA confirmation:** per-application Workflows tab as primary + a Settings/Integrations hub as
  the cross-app console — agreed? (§2)
- **Q2 — `workflow:task` default tier:** should resolving a manual task be ADMIN+MEMBER (proposed) or
  ADMIN-only? It is day-to-day ops, but it can supply data into an external system. (§9)
- **Q3 — Dry-run semantics:** payload-resolution dry-run (no side effects, recommended) vs a sandbox
  connection the admin points at. (§8)
- **Q4 — Identity fields:** if/when role/team/manager/AD land, that is a model-first decision (not this
  doc); the mapper is forward-compatible but must not drive it. (§5b)
- **Q5 — Inbox placement** if ADR-0052 is not yet on `dev` at engine ship time: polled standalone page
  now, retrofit the bell later — acceptable? (§6b)

---

Related: `docs/03-decisions/0020-frontend-data-layer.md` · `docs/03-decisions/0049-activated-restraint-ux-direction.md` ·
`docs/03-decisions/0048-service-accounts.md` · `docs/03-decisions/0046-roles-permissions-v2.md` ·
`docs/03-decisions/0023-access-management-design.md` · `docs/03-decisions/0043-zitadel-source-of-truth.md` ·
`docs/03-decisions/0053-async-workers-bullmq-valkey.md` · `docs/03-decisions/0030-list-pagination-contract.md` ·
`docs/03-decisions/0031-logging-strategy.md` · `docs/03-decisions/0007-flexible-asset-specs-jsonb.md` ·
`docs/06-security/INVARIANTS.md` · `.claude/skills/lazyit-cto/references/decision-history.md` ·
`apps/web/lib/hooks/use-permissions.ts` · `apps/web/app/(app)/settings/service-accounts/_components/secret-reveal.tsx` ·
`apps/web/app/(app)/applications/[id]/page.tsx` · `apps/web/app/(app)/assets/_components/asset-history-timeline.tsx`
</content>
</invoke>
