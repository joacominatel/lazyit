---
title: "Workflow Engine — Frontend / Admin Builder UX design"
tags: [design, frontend, web, workflow-engine, access, ux, builder]
status: proposed
created: 2026-06-07
updated: 2026-06-08
---

> **2026-06-08 revision (CEO decision).** The builder is now an **opinionated error-handling DAG**:
> a visual diagram of boxes (trigger → steps) connected by **first-class success/failure edges**, each
> box clickable to configure, with a **category-organized** step palette. What was *rejected* for v1 is
> a **free-form business-condition canvas** (arbitrary if/else conditions on edges, any-box-to-any-box —
> the n8n trap). The earlier "flat list, not a canvas" recommendation (§3a) is **partially superseded**:
> the list's anti-n8n instinct was right but its purely *linear* model has no error tolerance — a step
> that POSTs and gets a `500`/`404` must not be silently "done." We keep the list's data-model and
> design-system simplicity and add the missing axis: per-step success criteria + retry policy +
> success/failure transitions, **rendered** as a constrained DAG diagram (not authored by raw
> edge-drawing). Cites `docs/03-decisions/0054-applications-workflow-engine.md` (the accepted keystone
> ADR) and `docs/workflow-engine/_synthesis.md` (binding).

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
- A workflow is **a connection + a DAG of steps wired by first-class success/failure edges**. Each step
  does something against the external app (REST call, webhook, MCP/SDK call later, or a **manual human
  task**), **maps lazyit data into the payload**, **declares how its own success is judged** (e.g. which
  HTTP status codes count as success), and **declares what happens on failure** (retry, then escalate to
  a human / run a compensation step / alert+stop). The **common case is still a straight sequence** — a
  *degenerate* DAG the operator authors top-to-bottom without ever drawing an edge — but the engine is
  error-handling-first by construction, never blindly linear (ADR-0054). This is the CEO's rule: an HTTP
  call that returns `500`/`404` is **not** "done"; an automation with no error tolerance or alerting
  violates the basic norms of automation.
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

### 3a. Recommendation: a structured error-handling DAG diagram — opinionated edges, NOT a free-form canvas

**The builder is a visual diagram of boxes (trigger → steps) connected by first-class _success_ and
_failure_ edges, rendered with the asset-history timeline grammar and authored with opinionated
controls — _not_ a flat list, and _not_ a free-form node-graph canvas.** This supersedes the prior
"flat list, NOT a canvas" recommendation, and it is worth being precise about *what changed and what did
not*, because the old reasoning was half right.

**Three options, weighed honestly:**

1. **Flat ordered list (the prior recommendation) — _rejected now_.** Its instinct was right (reuse the
   form stack, stay inside the design system, refuse n8n's open-ended scope), but its model is purely
   **linear**: a step is "done" the moment it runs. That cannot express the CEO's load-bearing point —
   *"if we fire an HTTP request and call it done because it returned a response, what if it's a `500` or
   a `404`? We must have error control; we can't make it linear — that goes against the norms of any
   automation: no fault tolerance, no alerts."* A provisioning engine with no first-class failure
   handling is a footgun, so the flat list is out.
2. **Free-form business-condition canvas (n8n / xyflow / React Flow) — _rejected for v1_.** Arbitrary
   `if/else` conditions on edges, any-box-to-any-box wiring, user-drawn topology, branch-on-any-field.
   **This is the n8n trap** the brief and ADR-0054 §6.c explicitly exclude. *The entire anti-n8n
   argument now points here, not at "a diagram."* A free-form canvas (a) invites "build any flow" scope
   creep beyond Access-pillar provisioning; (b) is a power-user tool with its own interaction language
   (pan/zoom/connect/auto-layout) that the IT-generalist operator profile
   (`.claude/skills/lazyit-cto/references/product-vision-tech.md`, "edits a `.env` file") does not want;
   (c) has a real accessibility/mobile cost (keyboard and AT support for free edge-drawing is hard); and
   (d) would force a bespoke node/edge rendering layer outside the Activated Restraint token system
   (ADR-0049). Rejected.
3. **Structured error-handling DAG diagram (chosen).** A diagram of connected boxes whose edges are
   **limited to a closed, opinionated set of outcomes** — *success → next step*, and *failure →* one of
   `{ continue, escalate-to-human, run a compensation step, alert + stop }`. The operator never draws a
   raw edge and never writes a business condition; they configure each box's **success criteria**,
   **retry policy**, and **"on failure →"** choice, and the diagram *renders* the resulting graph. The
   edge set is fixed by the product, not by the user — that is the whole point of "opinionated."

**Why this lands the middle, and why it does _not_ reintroduce the canvas costs:**

- **The common case stays a sequence.** With every step's `onSuccess` defaulting to "the next step" and
  `onFailure` defaulting to "stop + alert," a simple workflow is authored exactly like the old list —
  top-to-bottom, **no edges drawn**. The DAG is *degenerate* (a straight line) until the operator opts a
  step into escalation/compensation. So the floor is no harder than the list it replaces; the ceiling is
  error tolerance.
- **It reuses everything we already have.** The persisted shape is still an ordered, zod-validated
  `steps[]` discriminated union (ADR-0007 jsonb, ADR-0054 §4) edited via `react-hook-form`
  `useFieldArray`; each step simply also carries `successCriteria` + `retry` + `onSuccess`/`onFailure`
  transition fields. The "diagram" is a **read-mostly render** of that array plus its transitions — not
  a free editing surface. Configuration happens in the same per-step form bodies (§3c) we'd have built
  anyway.
- **No heavy node-graph runtime is required — and we should not add one.** React Flow / xyflow exist to
  solve free-form canvases: pan/zoom, drag-to-connect arbitrary edges, auto-layout of dense graphs,
  collision routing. **We have none of those problems.** The topology is constrained (mostly linear,
  bounded fan-out: at most a success edge + one failure edge per step) and authored by controls, not by
  dragging. A **lightweight bespoke renderer** built on the existing
  `asset-history-timeline.tsx` vocabulary (vertical connected boxes, a status dot, a connecting line,
  AA-safe `StatusBadge` tones) draws the success spine as the main column and a **failure edge as a
  short labelled branch** to the escalation/compensation/stop box. That keeps us inside the design
  system and the token set, keyboard-native, and responsive — the things a canvas would have cost us.
  (If genuine *parallel fan-out* ever lands — ADR-0054 reserves BullMQ flows as a latent capability —
  revisit a richer renderer then; v1 does not need it.)
- **It stays honestly scoped.** The closed edge set is the guardrail: success/failure *handling* only,
  never a business condition. You cannot express "if the user's department is Finance, branch here" —
  there is no condition primitive and no any-to-any wiring. That is the line between an *opinionated
  error-handling DAG* (what we are building) and a *general flow-automation canvas* (what we are not).

So: **a constrained DAG diagram now — opinionated success/failure edges, authored by per-step controls,
rendered in the timeline grammar — and a free-form business-condition canvas never, until that is a
real, validated, separately-decided need.**

### 3b. Builder layout

A full-page route, not a dialog, because it is multi-section and the user will iterate:
`/applications/[id]/workflows/[workflowId]/edit` (and `/new`), mirroring how Assets/Applications use
page-route forms for the heavy create/edit (ADR-0020 "Page-route forms").

```
PageHeader: "Jira — provisioning on access granted"   [Disabled ▢→enabled]  [Save]
──────────────────────────────────────────────────────────────────────────────────
1. Trigger          ── a small fixed section: choose Granted | Revoked (radio cards).
                       (later: + a Timer trigger card, disabled with a "coming soon" hint)
──────────────────────────────────────────────────────────────────────────────────
2. Connection       ── "Uses the Jira connection"  [Edit connection] [Test]
                       (or: pick/create a connection if none — §4)
──────────────────────────────────────────────────────────────────────────────────
3. Steps  [+ Add step ▾]     palette grouped by category (§3c)

       ┌─────────────────────────────────────────────────┐
       │ ▸ TRIGGER · access granted → Jane Doe           │   (fixed top box)
       └───────────────────────┬─────────────────────────┘
                               │ success
       ┌───────────────────────▼─────────────────────────┐
       │ ① Create Jira user        [API/HTTP]            │   click → configure
       │   POST /rest/api/3/user · success = 200,201     │
       │   on failure: retry ×3, then ──────────────┐    │
       └───────────────────────┬────────────────────┼────┘
                               │ success            │ failure (exhausted)
       ┌───────────────────────▼──────────┐   ┌─────▼──────────────────────────┐
       │ ② Assign to team   [Human task]  │   │ ⚑ ESCALATE → manual task (§6)  │
       │   needs a human · on failure:    │   │   "create user failed — do it  │
       │   alert + stop                   │   │    by hand, then resume"       │
       └───────────────────────┬──────────┘   └────────────────────────────────┘
                               │ success
       ┌───────────────────────▼──────────┐
       │ ③ Notify in Slack  [Webhook]     │   on failure: alert + stop
       └──────────────────────────────────┘
──────────────────────────────────────────────────────────────────────────────────
[ Test run (dry-run) ]                                  [ Discard ] [ Save ]
```

- **Steps are clickable boxes** rendered in the timeline grammar and backed by a `react-hook-form`
  `useFieldArray`. The box shows type-icon + name + a one-line summary (target, success criteria) + the
  validation state; **clicking a box opens its per-type config** (method/url, headers, data-mapping §5,
  success criteria, retry policy, and the **"on failure →"** control §3d). The collapsed/expanded
  affordance is unchanged from the prior list; what's new is that the boxes are **wired** by their
  success/failure transitions and drawn as a diagram.
- **Success edges form the main vertical spine.** Each step's `onSuccess` defaults to "the next step"
  (the degenerate sequence); the operator only intervenes to point it at a specific step or to `END`.
- **Failure edges are short labelled branches**, not free-drawn — they are the *render* of the step's
  "on failure →" choice (§3d). A step with the default `alert + stop` shows no branch (an implicit
  terminal); a step set to `escalate` or `compensate` draws a branch to the manual/compensation box.
- **Add step** is the **category-organized palette** (§3c). Each type renders a different config body —
  a discriminated union in the shared zod schema drives both the form and validation (ADR-0054 §4).
- **Reorder** = up/down buttons in v1 (keyboard-accessible, no dep) reorder the success spine; a drag
  handle is a fast-follow only if justified. Reordering never silently rewires a non-default transition
  (an `onSuccess`/`onFailure` pointed at an explicit step key follows the step, not the position).
- **Enable/disable** is a top-level switch (a disabled workflow never fires — same affordance the
  Service-accounts `isActive` toggle uses).

### 3c. The "Add step" palette — organized by category

The "+ Add step" control is a **category-organized palette**, not a flat dropdown — it groups the
step types by what they *do* and greys the not-yet-shipped tiers as explicit "coming soon," so the
operator sees the roadmap without being able to pick a dead option. Each type maps to a step-type box
with its own config body; the discriminated-union step schema (ADR-0054 §4) makes a later type an
*additive variant*, not a rewrite:

| Category | Step type | v1? | Config body (frontend form fields) |
| --- | --- | --- | --- |
| **API / HTTP** | REST / HTTP call | ✅ v1 | method, URL (relative to the connection base), headers (kv), body template + **data mapping** (§5), **success criteria** (expected status codes), **retry policy**, **on failure →** (§3d) |
| **API / HTTP** | Self-hosted / internal host | later | same REST box pointed at an internal host (gated on the per-connector internal-target allowlist — ADR-0054 §6.b) |
| **Webhooks** | Outbound webhook | ✅ v1 (a REST POST + signature toggle) | URL, signing secret (write-only, §4b), payload mapping, success criteria, retry, on-failure |
| **Webhooks** | Inbound webhook / callback | later | the engine exposes a callback URL; the box shows it + a "waiting for callback" step state |
| **Human tasks** | Manual task | ✅ v1 | title, instructions (markdown), the fields a human must fill (typed input + **STATIC admin-typed suggestions** only — §6b), assignee policy |
| **SDK** *(greyed — coming soon)* | Vendor SDK / prebuilt connector | later | a connector picker (Jira/GitHub/…) with a typed form instead of raw REST |
| **MCP** *(greyed — coming soon)* | MCP server call | later | server URL + tool picker + arg mapping |

The palette is the **integration-diversity surface** — "automate any app" lives here — but it is
**opinionated-where-it-helps, configurable-where-it-must**, the brief's explicit carve-out from
"opinionated over configurable." The greyed SDK/MCP groups are reserved enum slots with no behavior
(ADR-0054 §7); they read as "coming soon," never as a broken control. Suggestions for manual fields
live in `web` and stay **static** — the same lightweight pattern as
`apps/web/components/access-level-combobox.tsx`, with **no** directory/role/team/AD lookup (the
anti-IGA guardrail, §5b / ADR-0054 §6.c).

### 3d. The "on failure →" control — first-class error handling per step

Every step carries a small, opinionated **failure-handling block** in its config body — this is the
feature that makes the engine a DAG rather than a linear list, and it maps 1:1 onto the persisted step
shape the definition CRUD must carry (contract **C1**, §10):

1. **Success criteria** — *what counts as success for this step.* For an **API/HTTP** step this is the
   set of **expected success status codes** (e.g. `2xx`, or an explicit `200,201,204` list); anything
   else is a failure. This is the direct answer to the CEO's `500`/`404` point — a step is **not** "done"
   just because a response arrived. (Manual steps succeed on human submit; webhook-out steps succeed on
   accepted delivery.)
2. **Retry policy** — `maxAttempts` + backoff (the BullMQ per-step retry/backoff the substrate provides,
   ADR-0053). Default: a couple of attempts with exponential backoff for transient `5xx`/`429`; `4xx` is
   **never retried** (ADR-0054 §3); non-idempotent creates are single-shot (`retryOnTransient: false`).
   The UI exposes attempts + backoff as a simple picker, not raw BullMQ options.
3. **On failure (after retries are exhausted)** — a single-select of a **closed, opinionated set**:
   - **Continue** — proceed to the next step anyway (for genuinely optional side-effects). Rare; the box
     warns that the run will still be marked *partially failed*.
   - **Escalate to a human** — pause the run (`AWAITING_INPUT`) and open a **manual task** (§6) so IT can
     do the step by hand / decide, then resume. This is the failure-edge form of the manual inbox.
   - **Run a compensation step** — execute a designated compensation step (e.g. "delete the half-created
     account") then stop — the saga-compensation concept ADR-0054 borrows from Temporal, surfaced as a
     pick-a-step control. v1 keeps this to *named existing steps*, no new condition logic.
   - **Alert + stop** *(default)* — mark the run `FAILED`, emit a `workflow.run_failed` notification
     (bell/SSE, §6a), stop. Never touches the grant (§1).

The set is fixed by the product. There is **no** "if &lt;field&gt; then &lt;branch&gt;" — that is the
business-condition primitive we are deliberately not building (§3a, ADR-0054 §6.c). A failure edge is
*error handling*, not *flow control*.

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

Per `docs/06-security/INVARIANTS.md` INV-6 (secrets never logged/leaked) and the engine's **own**
AES-256-GCM credential store (`WorkflowSecret` — ADR-0054 §5 drops the earlier Settings-`SystemSecret`
reuse so credential handling is governed by the engine's lifecycle + `workflow:secrets` RBAC; same
crypto primitive, separate key axis), credential entry must be **write-only from the UI** — the store
behind the field changed, the UI pattern did not:

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
  a **literal**, or **ask-a-human-at-runtime** (which promotes a field into a manual sub-task — §6).
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
path is the v1 answer for "which team?" — a human supplies it, optionally with **static, admin-typed
suggestions** (never a directory/role/team/AD lookup, ADR-0054 §6.c) — **without** modeling org
structure. Adding real identity fields is a separate, model-first decision
(Open question Q4); the mapper UI is forward-compatible (a new token group is additive) but does not
drive that decision.

---

## 6. The manual-task inbox

A run reaches a human **two ways**, both surfaced through the same inbox: (1) a **Manual-task step** —
an app with no API, or a "which team?" decision the workflow always routes to a person; and (2) a
**failure ESCALATE edge** (§3d) — any step whose "on failure →" is set to *escalate-to-human*, so when
its retries are exhausted the run pauses and a person is asked to do/decide the step by hand. Either
way the run transitions to `AWAITING_INPUT` (it does **not** hold a worker — ADR-0054 §3 / synthesis
keystone 3), a **manual task** is created for IT, and the operator resumes the run on submit. The
frontend surfaces these as a first-class **inbox**; the task simply records whether it arose from a
manual step or an escalated failure so the action UI (§6b) can show the right context.

### 6a. Ride the notification bell + SSE

> **Decision:** the notification bell this section assumed (from a Settings/Notifications branch that
> **never landed on `dev`**) is now its own ratified decision — [[0056-in-app-notification-bell]]
> (`accepted`, #313): an append-only `Notification` + per-admin `NotificationRead` (fan-out-on-read),
> a closed shared type enum (incl. `workflow.manual_task` / `workflow.run_failed`), **poll delivery in
> v1 with SSE as a Phase-2 upgrade behind the same API**, gated by a new `notification:read`
> (ADMIN-only). Read the "ADR-0052 SSE" references below as **ADR-0056, poll-first**: the manual-task
> inbox + run-failed alerts ride that bell; the live SSE push is the Phase-2 upgrade, so the v1 inbox is
> a **polled** list until then (dependency D1 below is resolved by ADR-0056, not the dead branch).
>
> **Landed (#313, on `dev`):** the bell now exists — the topbar `NotificationBell` (poll v1, gated
> `notification:read`) + the `workflow.manual_task` emitter fires on ManualTask creation. The
> `workflow.run_failed` emitter is a noted follow-up (its type + the bell's render path already exist).
> See [[notification]].

The brief instructs reusing the notification/bell/SSE stack — and it is the right fit:

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

- **What happened** — for a manual *step*: "Granting Jira access to Jane Doe paused at step ‹Assign to
  team›." For an *escalated failure*: "Step ‹Create Jira user› failed after 3 attempts (`502`) and is
  set to escalate — please complete it by hand, then resume."
- **The fields to fill** — exactly the fields the step marked "ask a human," rendered as inputs.
  Suggestions come from a **static, admin-typed** `suggestions` list carried on the task — the UI is a
  combobox seeded from it (same datalist pattern). Suggestions are **hints, never enforced**, and are
  **never** computed from a directory/role/team/AD lookup (anti-IGA, ADR-0054 §6.c).
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
duration, **status** (`StatusBadge` mapping the ADR-0054 run states: `PENDING` Queued / `RUNNING`
Running / `AWAITING_INPUT` **Waiting (manual)** / `SUCCEEDED` Succeeded / `FAILED` Failed /
`COMPENSATED` Compensated, plus a derived **Partially failed** when a step took a `continue`-on-failure
edge), and a link to the run detail. Server-side sort/filter by status + app + date.

### 7b. Run detail timeline

A vertical step timeline (reusing the `asset-history-timeline` visual grammar — connecting line, status
dot, badge, ml-auto timestamp, AA-safe `StatusBadge` tones per ADR-0049 §4). Because the engine is now a
DAG, the timeline is the **executed path through the diagram**: it shows, per step, **which edge was
taken** (success vs failure), the **attempt count**, and — when a failure edge fired — the
**escalation** (a nested manual task) or **compensation** step it routed to. The same constrained
renderer as §3a draws it; the *builder* diagram is the *authored* graph, the *run* timeline is the
*traversed* graph:

```
● Run #1042 · access granted → Jane Doe · Jira      [Partially failed]   2m ago
│   request-id: 7f3a…  (copyable)            [Retry failed steps] [Re-run]
│
├─● ① Create Jira user        [API/HTTP]  POST /rest/api/3/user
│ │   attempt 3/3 · ✗ 502 (success = 200,201) · retried 1s,4s · exhausted   1.4s
│ │   ↳ request-id 7f3a-1 · ▸ show redacted request/response
│ │
│ ╰──✗ failure edge → ESCALATE
│       ⚑ manual task · resolved by Alice                                   12m
│       ↳ "account created by hand" · run resumed
│
├─● ② Assign to team          [Human task]  resolved by IT      ✓           3m
│ │   ↳ "team = Platform" (provided by Alice)
│ ╰──✓ success edge → next
│
└─● ③ Notify in Slack         [Webhook]                         ✓ 200      210ms
      ╰──✓ success edge → END · ▸ show redacted log
```

Per step the timeline shows: type, target (method/path), **status against the step's success criteria**
(a `502` is a failure even though a response arrived — the CEO's point made visible), the **attempt
count** (e.g. `3/3` with the backoff intervals), duration, the step's **request id** (ADR-0031,
copyable via `RequestIdNote`), an expandable **redacted** request/response log, **and the edge it
took**: `✓ success edge → next | END | ‹stepKey›`, or `✗ failure edge → continue | escalate |
compensate | stop`. A **failure edge to ESCALATE** renders the resolved manual task inline (who, when,
the provided value); a **failure edge to COMPENSATE** renders the compensation step that ran as a
nested entry (`↻ compensation · delete half-created account · ✓`); a **failure edge to STOP** ends the
run as `FAILED`. **Redaction is non-negotiable** (INV-6, ADR-0031 bodies-never-logged) — the UI renders
whatever the API returns (already redacted), and **never** un-redacts; secret tokens and mapped
sensitive values appear as `‹redacted›`. Each row maps to one `WorkflowStepRun` attempt (ADR-0054 §4);
the edge taken + escalation/compensation linkage are the contract additions enumerated in **C2** (§10).

**Retry a FAILED run (wired — issue #308).** A terminal `FAILED` run offers a single **Reintentar**
action — on the run-detail panel header AND inline on the recent-runs row (`RetryRunButton`, gated on
`workflow:run`, hidden otherwise). It calls `POST /workflow-runs/:id/retry`, which **resumes from the
step that failed onward, NOT from the start**: every already-`SUCCEEDED` step is skipped, so a
non-idempotent create cannot double-provision. The transition is a guarded `FAILED`→`RUNNING`
compare-and-set and the retried step re-executes as a NEW append-only attempt; only `FAILED` is
retryable (a `COMPENSATED` run rolled its effects back — re-grant, don't retry → the API returns 409).
On success the run polls live again; a 409 / 422 / broker hiccup surfaces via `notifyError` with the
request id. (Per-step single-step `Retry` and a full `Re-run` remain future affordances.)

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
   banner, so the operator learns one observability surface, and it draws the **happy-path traversal of
   the DAG** plus each step's configured `onFailure` handling. Now that error handling is first-class,
   it also accepts an optional **"simulate this step failing"** toggle (C4) so the operator can preview a
   failure edge — the escalation / compensation / stop branch — without provoking a real error. (Backend
   contract C4, §10.)

Both reuse `notifyError` + `RequestIdNote` for failures so every test is traceable.

---

## 9. Permission gating with `can()`

All workflow surfaces gate render with the live `can('domain:action')` infra
(`apps/web/lib/hooks/use-permissions.ts`, fails closed) — the API guard is always the real gate
(ADR-0046 §P6b). This feature needs **new catalog entries**, which is a **`@lazyit/shared` change**
(the frozen `PermissionSchema` in `packages/shared/src/schemas/permission.ts`) and therefore a
backend/shared decision the engine's core ADR owns — the frontend only *consumes* them. **ADR-0054 §5
ratifies the verb set** (extending the ADR-0046 catalog); the frontend gates render with them:

| Permission | Gates (frontend) | Suggested default |
| --- | --- | --- |
| `workflow:read` | the Workflows tab, run list/detail (incl. the diagram), connection card (masked) | ADMIN + MEMBER (sensitive — like `accessGrant:read`) |
| `workflow:manage` | create/edit/enable/delete workflows, the builder + DAG edges, connection entry, test-connection, dry-run | ADMIN-only by default (coarse verb, like `settings:manage`) |
| `workflow:secrets` | the **write-only secret** fields (the `Replace` control) — separation of duties from logic authoring | ADMIN-only (the most sensitive verb) |
| `workflow:run` | manually re-run a workflow + the **`Retry` / `Retry failed steps` / `Re-run`** run-timeline actions (§7b) | ADMIN + MEMBER (ops re-drives a failed run) |
| `workflow:task` | act on a **manual task** (submit/skip/fail), incl. escalated-failure tasks | ADMIN + MEMBER (day-to-day ops can resolve tasks) |

Notes & rationale:

- Splitting `manage` (configure the engine — high blast radius) from `secrets` (hold credentials), from
  `run` (re-drive a run / retry a failed step), from `task` (resolve a queued human step) matches the
  brief's "workflow management gated by its OWN RBAC" and ADR-0054's separation of duties — a MEMBER can
  clear the inbox and retry a stuck run without gaining connection/secret editing.
- Because the secret fields ride **`workflow:secrets`**, they **render only for that holder**; a
  `workflow:read`/`workflow:manage` holder sees the `configured` descriptor but never a `Replace`
  control.
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

The frontend lane needs these contracts defined by the backend lane (Phase 1b-B). Shapes are
illustrative; **ADR-0054 owns the persisted truth** (the `WorkflowVersion.steps` jsonb, the
`WorkflowRun` / `WorkflowStepRun` ledger, `ManualTask`). All list reads follow the `Page<T>` envelope
(ADR-0030); all responses carry `X-Request-Id` (ADR-0031); all bodies are pre-redacted (INV-6). The
**DAG decision tightens C1, C2 and C4** specifically: the definition must carry per-step success
criteria + retry policy + the success/failure transitions, the run-detail must report which edge each
step took, and the builder must be able to read the graph back to render the diagram.

- **C1 — Workflow-definition & connection CRUD** (`/applications/:id/workflows`,
  `/applications/:id/connection`, or a flat `/workflows` + `?applicationId=`). Standard CRUD → fits
  `createCrudEndpoints` + `createQueryKeys` (ADR-0020). Secret fields are **write-only**: reads return
  `{ configured, label? }` (the ADR-0054 `WorkflowSecret` redacted descriptor), writes accept cleartext
  once, never echoed back. **DAG additions — the definition is a graph, not a list:**
  - A write persists a new immutable `WorkflowVersion` (ADR-0054 §4); a read returns the **latest
    version's full graph** so the builder can render the diagram and re-open it for editing (this is
    the "give the builder the graph shape back" requirement).
  - The `steps[]` payload (the zod discriminated union keyed on `kind`) must carry, **per step**: a
    stable `stepKey`; the per-`kind` `config`; **`successCriteria`** (REST/webhook: expected status
    codes — the `200,201` vs `500/404` distinction); a **`retry`** policy (`maxAttempts` + backoff,
    `retryOnTransient`); an **`onSuccess`** transition `{ NEXT | GOTO(stepKey) | END }` (default
    `NEXT`); and an **`onFailure`** transition `{ CONTINUE | ESCALATE(manual-task config) |
    COMPENSATE(stepKey) | STOP }` (default `STOP`). No condition/predicate primitive exists on any
    transition — the closed set *is* the contract (guardrail: no business-condition edges).
  - The write must **validate the graph** and return field-addressable errors the builder can attach to
    a box: every `GOTO`/`COMPENSATE` target must reference an existing `stepKey`; `END` is terminal; no
    transition may form a non-compensation cycle; every step must be reachable from the trigger.
  - The trigger (`ACCESS_GRANTED | ACCESS_REVOKED`, ADR-0054 §7) and the `deprovisionPolicy`
    (`LAST_ACTIVE_GRANT` default) ride the `ApplicationWorkflow` header, not the step list.
- **C2 — Run status** (the run-detail must report the **traversed graph**, not just a flat step list)
  - `GET /workflow-runs?applicationId=&status=&...` → `Page<RunSummary>` (list, sort/filter per
    ADR-0030; `status` ∈ the ADR-0054 enum + derived `PARTIALLY_FAILED`).
  - `GET /workflow-runs/:id` → the run (`status`, pinned `workflowVersionId`, trigger, grantee, actor
    attribution) **+ the ordered `WorkflowStepRun` attempts**, each carrying:
    `{ stepKey, stepIndex, kind, attempt /* e.g. 3 of maxAttempts, with the backoff schedule */,
    status /* judged against successCriteria */, durationMs, requestId, redactedRequest?,
    redactedResponse?, error? }` **plus the DAG fields**: **`transitionTaken`** —
    `{ outcome: SUCCESS|FAILURE, edge: NEXT|GOTO|END|CONTINUE|ESCALATE|COMPENSATE|STOP, targetStepKey? }`
    — and, when the edge escalated/compensated, the linkage: **`manualTaskId?`** (the task an ESCALATE
    opened) and **`compensationStepKey?` / `compensationStepRunId?`** (the step a COMPENSATE ran). This
    is exactly what §7b renders.
  - **Realtime:** run/step status changes **also push over the ADR-0052 SSE channel** as
    notifications/events the bell + an open run-detail can consume; the run-detail page **subscribes to
    SSE when mounted and falls back to short polling** (`refetchInterval`) while a run is non-terminal,
    stopping once it reaches a terminal status. (Substrate detail — §11.)
- **C3 — Test connection** — `POST .../connection/test` → `{ ok, status, message, requestId }`.
  Synchronous, bounded, read-only. Unchanged by the DAG.
- **C4 — Dry-run** — `POST /workflow-runs/dry-run` (or `POST .../workflows/:id/test`) with a sample
  grant id → resolved payloads + would-be requests, **no side effects**. Returns the **same step-shaped
  data the run timeline renders, including the authored transitions**, so the dry-run draws the
  happy-path traversal of the diagram and shows each step's configured `onFailure` handling. Where cheap,
  accept an optional `simulate: { stepKey, outcome: FAILURE }` so the operator can **preview a failure
  edge** (escalation/compensation/stop) without a live error — the single highest-value validation now
  that error handling is first-class.
- **C5 — Manual tasks** (reachable from a manual *step* **or** a failure *ESCALATE* edge — §6)
  - `GET /workflow-tasks?status=pending&applicationId=` → `Page<TaskSummary>` (the inbox).
  - `GET /workflow-tasks/:id` → the task + `origin` (`MANUAL_STEP | ESCALATED_FAILURE`) + the originating
    `runId`/`stepKey` + the fields to fill + an optional **static, admin-typed** `suggestions` list (no
    directory/role/team/AD lookup — anti-IGA).
  - `POST /workflow-tasks/:id/submit` (the field values) → records the input and **resumes the run at
    the correct next step** (the resume re-enters the DAG); `POST /workflow-tasks/:id/skip`,
    `POST /workflow-tasks/:id/fail`. Completion is gated by `workflow:task` **and** an assignee/cohort
    match (the IDOR guard, synthesis §5).
  - New notifications of type `workflow.manual_task` and `workflow.run_failed` flow through the
    ADR-0052 notification + SSE stack (no new transport).
- **C6 — Context-token catalog** — a **static set the web ships** (preferred for v1; small, tied to the
  trigger), or `GET /workflow-context-tokens?trigger=` if it must stay server-authoritative. v1 ships it
  in `web` next to the mapper (like the access-level suggestions) to avoid a round-trip. The catalog
  offers **only fields that exist** — `grantee.{email,firstName,lastName,id}` + `application.*` +
  `grant.*` + `context.*` — **no `role`/`team`/`manager`/AD tokens** (anti-IGA, ADR-0054 §6.c).
  Unchanged by the DAG.

### 10a. The DAG contract refinements for 1b-B (crisp checklist — "apuntar el b")

The exact deltas the Phase 1b-B endpoints must satisfy so the builder/run UI can be aimed at them:

1. **Definition write/read carries the per-step DAG fields** — `stepKey`, `successCriteria`, `retry`
   (`maxAttempts` + backoff + `retryOnTransient`), `onSuccess { NEXT | GOTO(stepKey) | END }`,
   `onFailure { CONTINUE | ESCALATE(manual-config) | COMPENSATE(stepKey) | STOP }` — in the shared
   discriminated-union step schema (an explicit enumeration of ADR-0054 §4's generic `steps` jsonb; **no
   migration**, it is jsonb). Defaults `onSuccess=NEXT`, `onFailure=STOP` make a linear workflow author
   with zero edges.
2. **Definition read returns the latest version's full graph** (header + ordered steps + transitions) so
   the builder renders the diagram and re-opens it for edit; each run pins its `workflowVersionId`.
3. **Definition write validates the graph** and returns **field-addressable** errors (bad `GOTO`/
   `COMPENSATE` target, unreachable step, non-compensation cycle, `END`-only-terminal) the builder can
   attach to the offending box.
4. **Run-detail exposes, per `WorkflowStepRun`: `attempt` count + backoff schedule, `status` judged
   against `successCriteria`, and `transitionTaken { outcome, edge, targetStepKey? }`** — the "which edge
   was taken" the §7b timeline draws.
5. **Run-detail exposes escalation/compensation linkage** — `manualTaskId?` for an ESCALATE edge,
   `compensationStepKey?`/`compensationStepRunId?` for a COMPENSATE edge — so the timeline renders the
   nested manual task / compensation step inline.
6. **Manual task carries `origin` (`MANUAL_STEP | ESCALATED_FAILURE`)** + `runId`/`stepKey` so the inbox
   action UI shows the right context, and `submit` resumes the run at the correct next DAG step.
7. **Dry-run returns the authored transitions** and optionally accepts `simulate {stepKey, outcome}` to
   preview a failure edge (escalation/compensation/stop) with no side effects.
8. **Closed-set guarantee:** no transition type carries a predicate/condition; the four-value
   `onFailure` set and three-value `onSuccess` set are the entire vocabulary (encodes the
   no-business-condition-edges guardrail at the contract boundary).

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
  1. **Multi-step runs with retries map cleanly onto BullMQ** (per-step retry/backoff +
     step-at-a-time re-enqueue, the synthesis keystone — *not* a held Flow tree; flows stay a latent
     capability for future parallel fan-out, synthesis conflict #2). The run timeline (§7) renders
     per-step status + attempt count + the **success/failure edge taken** + step-level `Retry`; the
     DAG's failure edges (escalate/compensate/stop) are realized as Postgres-remembered next-step
     re-enqueues, which BullMQ feeds natively, whereas pg-boss does per-step retry/backoff and
     rate-limiting poorly (ADR-0053 rejected it for exactly the workflow-engine need). A richer backend
     run model = a richer, truthful timeline with no FE faking.
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
FE contracts but loses the per-step retry/backoff + rate-limiting fidelity the DAG run timeline wants
and would be replaced when the engine matures (ADR-0053's own reasoning); synchronous and Temporal/n8n
are rejected for the reasons above.

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
  `apps/web/app/(app)/settings/integrations/_components/` (the folder already exists). A **lightweight
  bespoke DAG renderer** (`workflow-graph.tsx`) built on the `asset-history-timeline` grammar draws both
  the *authored* builder diagram and the *traversed* run timeline — **no React Flow / xyflow** (§3a) —
  and is promoted to a shared component on genuine reuse (ADR-0020).
- **Forms**: builder uses `react-hook-form` + a shared zod **discriminated-union step schema** whose
  every variant carries `stepKey` + `successCriteria` + `retry` + `onSuccess`/`onFailure` transitions
  (§10 C1); empty optionals → `undefined` (strict-schema convention). The steps are a `useFieldArray`;
  the diagram renders from that array + its transitions (the array *is* the graph). Reorder mutates the
  spine; the "on failure →" select mutates a step's `onFailure` — there is no free edge-drawing surface.
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
- **Phase 2 — connection + REST step + data mapping + dry-run.** The builder (the **DAG diagram** with
  per-step success criteria, retry policy and the "on failure →" control — §3), write-only secret
  fields, test-connection, the data-mapper with the token combobox, and the payload-resolution dry-run
  (the single highest-value test, now able to preview a failure edge). `workflow:manage` /
  `workflow:secrets` gating. This is the core feature.
- **Phase 3 — manual tasks + inbox + bell.** The manual step type, the inbox table, the task action
  form, and the ADR-0052 bell/SSE wiring (`workflow.manual_task`). **Gated on ADR-0052 reaching `dev`**
  — degrades to a polled inbox if not. `workflow:task` gating.
- **Phase 4 — realtime run status over SSE.** Upgrade run-detail/list from polling to SSE push.
- **Later (own decisions):** webhook-inbound/callback step state, SDK/prebuilt connectors, MCP step,
  timer/scheduled trigger UI, drag-reorder, the richer identity-token groups (model-first, Q4).

---

## 14. Risks, dependencies, open questions

### Risks

- **Scope drift into n8n / a general flow builder.** Mitigation: the **closed edge set** — success/
  failure *handling* only (`NEXT`/`GOTO`/`END` and `CONTINUE`/`ESCALATE`/`COMPENSATE`/`STOP`), **no
  business-condition primitive and no any-to-any wiring** (§3a, §3d, ADR-0054 §6.c); a constrained DAG
  renderer (no React Flow), not a free-form canvas; step types scoped to access provisioning; manual
  tasks framed as provisioning steps not generic approvals.
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
