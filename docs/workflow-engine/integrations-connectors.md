---
title: "Workflow Engine — Integrations & Connector Model"
tags: [design, workflow-engine, integrations, connectors, access, security, proposed]
status: proposed
created: 2026-06-07
area: Integrations & connector model
---

# Workflow Engine — Integrations & Connector Model

> **Scope of this document.** This is the *integrations lens* of the Applications Workflow Engine
> (the CEO's "per-application, opt-in provisioning/deprovisioning automation"). It designs the
> **connector abstraction** that makes *any* external application automatable **without writing
> code**, the **data-mapping** layer that turns lazyit context into an external payload **safely**,
> the **idempotency/correlation** model, the **MANUAL** human-task connector, **MCP-as-a-connector**,
> the **prebuilt-connector** (catalog-as-code) plan, the **secret-reference** contract, and the
> **dry-run / test-connection** contract. It explicitly answers the execution-substrate question
> *from the connector lens*.
>
> **Out of scope (owned by sibling area docs):** the orchestration loop itself (run-state machine,
> step fan-out, flow dependencies, retry policy, queue wiring), the Prisma schema/migrations, and the
> frontend. This doc defines the **executor leaf** the orchestrator calls and the **event contract**
> it consumes; it hands the loop mechanics to the orchestration/substrate area. **No code, no schema,
> no migrations are written here** — field tables and config shapes are *design intent* in the house
> style of the entity notes (`docs/02-domain/entities/`), to be realized as Prisma + zod by the data
> and backend areas.

---

## 1. Where this plugs in (the trigger source)

Access today is **`Application` + `AccessGrant`** (ADR-0023, `docs/03-decisions/0023-access-management-design.md`).
A grant is an append-only `User ↔ Application` join; `revokedAt` closes it. The two v1 triggers map
1:1 onto the two existing write paths:

| Trigger | Source call (today) | File |
| --- | --- | --- |
| `access.granted` | `AccessGrantsService.create()` | `apps/api/src/access-grants/access-grants.service.ts` (~L112) |
| `access.revoked` | `AccessGrantsService.revoke()` (+ `batchRevoke()`) | `apps/api/src/access-grants/access-grants.service.ts` (~L145, ~L200) |

The controller gates both on `@RequirePermission('accessGrant:grant')`
(`apps/api/src/access-grants/access-grants.controller.ts`).

**Coupling posture — the single most important architectural rule of this engine.** The Zitadel
write-back mirror (ADR-0043, `docs/06-security/INVARIANTS.md` INV-5) is **strongly coupled**: a
Management-API failure **rolls the local change back and returns 503**. The workflow engine must do
the **opposite**. A failing external provisioning call **must never roll back or block the local
`AccessGrant`**: the grant is the system of record and commits regardless; the workflow runs
*after/around* the commit and a failure surfaces as a failed **run** + a notification + a manual
remediation path — **never** a 503 on `POST /access-grants`. (Rationale: the grant is a durable
audit fact even when the downstream system is unreachable; offboarding a departed user must record
locally even if Jira is down. ADR-0023 already treats `AccessGrant` as the auditable truth.)

**Seam.** After the grant transaction commits, the trigger source emits a domain event
(`access.granted` / `access.revoked`) carrying the **run context** (§5). An after-commit hook (or a
transactional-outbox row) — *not* an inline call — decouples the grant write from the engine. The
orchestrator consumes the event, selects the matching workflow(s) for `(applicationId, trigger)`,
and runs their steps; this connector doc owns **what each step does** (the executor) and **what
context it gets** (the event payload), and defers *how runs are enqueued/sequenced/retried* to the
orchestration/substrate area. If **no** workflow is configured for the application, nothing runs —
behaviour is exactly as today (opt-in per application; ADR-0023 stays the default path).

---

## 2. The layered model: Connector vs Operation vs Step

Three layers keep the model general and reusable. Conflating them is the main design trap.

1. **Connector type (framework, shipped in the image).** The *kind* of integration and its runtime
   executor — `rest`, `webhook_out`, `webhook_in`, `mcp`, `manual`, plus the code-backed `sdk` /
   `prebuilt` / `custom`. Each type ships a **zod config schema** + an **executor** implementing one
   contract. This is **our** code, selected by a discriminator — *not* admin-authored.

2. **Connector instance (admin-configured, per application).** A concrete, reusable connection:
   *"Jira Cloud — acme.atlassian.net"* = a `rest` connector with a base URL + an auth **secret
   reference**. Belongs to one `Application` (the CEO's "configure the connection per app"). Reusable
   by every workflow/step of that app (the grant flow and the revoke flow share one Jira connector).

3. **Step / operation binding (inside a workflow).** A unit of work: *"call `POST
   /rest/api/3/user` on the Jira connector, with this data mapping and this idempotency key."* A step
   references a connector instance and supplies the **operation-specific** config (method/path/tool
   name), the **data mapping** (§6), the **idempotency key** (§7) and the **response/correlation
   extraction** (§7).

This mirrors patterns already in the tree: the **`IdentityProvider` factory** keyed on a
discriminator (`apps/api/src/auth/identity/identity-provider.factory.ts`) is the exact shape the
**connector-executor registry** should take (`createConnectorExecutor(kind) → Executor`), and the
**`IdentityProvider` interface** (`apps/api/src/auth/identity/identity-provider.interface.ts`,
`createUser`/`deactivateUser`/`supportsManagement`) is the precedent for a small, capability-flagged
executor contract.

### 2.1 The executor contract (the leaf the orchestrator calls)

Every connector type implements one narrow contract (conceptual — realized in `apps/api/src/`):

- `kind` — the discriminator (for logging/branching, like `IdentityProvider.kind`).
- `validateConfig(config)` — zod-validate the instance + step config (ADR-0018 `nestjs-zod`).
- `testConnection(connector)` — side-effect-free probe → redacted diagnostic (§9).
- `dryRun(connector, step, ctx)` — resolve the mapping, return the **would-send** payload, redacted,
  **without** mutating the external system (§9).
- `execute(connector, step, ctx) → ExecuteResult` — perform the operation; return
  `{ status, externalRef?, output?, retryable? }` where `externalRef` is the captured correlation id
  (§7) and `retryable` tells the orchestrator whether a transient failure may be re-enqueued.
- `capabilities` — flags like `supportsTestConnection`, `isAsync` (returns immediately, completes via
  an inbound callback), `isManual` (suspends for a human). The orchestrator branches on these instead
  of `instanceof`.

The executor is **stateless and idempotent-by-key**; durability, retry scheduling, step ordering and
run state live in the orchestrator (§10), not here.

---

## 3. Connector type taxonomy (the discriminator)

Two tiers. The honest framing of "automate **any** app without code" is that the **declarative tier**
covers the overwhelming majority, and the **code-backed tier** is the curated extension path for the
rest. The CEO's seven integration shapes all land in one of these.

### Tier A — declarative connectors (configured entirely as data)

No code is written to add an instance; the admin fills a zod-validated config.

| `kind` | What it is | Covers |
| --- | --- | --- |
| `rest` | An HTTP/REST API client | Jira, GitHub, AWS-via-API, **any self-hosted REST target**, "internal system with an API" |
| `webhook_out` | A signed POST to one URL | Bridge to **any** automation platform (n8n, Make, Zapier, an internal script), "outbound webhook" |
| `webhook_in` | An endpoint lazyit **exposes** for callbacks | Async completion from external work; "inbound webhook"; the resume half of long-running steps |
| `manual` | A human task in an inbox | Apps with **no API**; a step needing human judgement/data ("which team?"); the universal fallback |
| `mcp` | lazyit as an **MCP client** to an external MCP server | Apps that ship an MCP server; AI-tool ecosystems (§8) |

### Tier B — code-backed connector providers (shipped in the image, selected by key)

These cannot be "configured without code" in the literal sense — an SDK call or a bespoke protocol is
code. The honest design: **lazyit ships the code**, the admin configures only **credentials +
mapping** and picks the provider from a gallery. This preserves both the no-code promise (for the
admin) and the **"no arbitrary code at runtime"** security rule.

| `kind` | What it is | How it ships |
| --- | --- | --- |
| `sdk` | A vendor Node SDK behind the executor contract (AWS SDK, `@slack/web-api`, Okta SDK) | Always a **prebuilt** catalog entry — never an admin-loaded SDK |
| `prebuilt` | A curated famous-app connector (Jira/GitHub/Google/Okta/Entra…) with pre-authored operations + mappings | **Catalog-as-code** (§ Phase 4), like the permission catalog (ADR-0046) |
| `custom` / `to_build` | The "we build the API ourselves" escape hatch | A **server-side connector provider** registered by key in the api at build time (same registry as the factory) — **not** runtime-loaded code |

> **Why `sdk`/`prebuilt`/`custom` are not "runtime-pluggable".** Letting an admin upload/point-to a
> module that the api `require()`s at runtime is arbitrary code execution inside the trusted backend —
> a critical vulnerability and a direct violation of the operator-safety posture
> (`product-vision-tech.md`: "defaults are safe and sensible"). It also bloats the single-host image
> with every vendor SDK. So these live in-tree, behind the registry, gated by review — exactly how the
> `IdentityProvider` factory ships exactly two vetted implementations.

> **`to_build` as a first-class placeholder.** Before a bespoke connector exists, an admin can still
> *author the workflow* by using `to_build`, which **degrades to a `manual` task** ("integration not
> built yet — do this by hand and confirm"). This lets the workflow shape be designed and audited
> before engineering builds the real connector, and the upgrade path is a `kind` swap on the connector
> instance.

---

## 4. Per-type configuration shapes

All connector/step configs are stored as **jsonb validated by zod** — the accepted flexibility
pattern (ADR-0007, `docs/03-decisions/0007-flexible-asset-specs-jsonb.md`; same as `Asset.specs` /
`Application.metadata`). The zod schemas live in `@lazyit/shared`
(`packages/shared/src/schemas/`, new files e.g. `connector.ts`) so `api` (validate/execute) and `web`
(the config UI) share one definition — the catalog-as-code instinct of ADR-0046. The top-level config
is a **zod discriminated union on `kind`**, so an invalid shape for a type is a 400 at the boundary
(ADR-0018 global `ZodValidationPipe`).

Below, each type's config is described as field tables (design intent, *not* a schema). `secretRef`
fields are **never** the secret itself — they are a key into the ADR-0052 `SystemSecret` store (§ a).

> **Internal / on-prem targets (Phase 2):** the `http`-only / self-signed `tlsVerify` downgrade and the
> "internal target on the LAN" path below are governed by
> [[0055-on-prem-internal-target-connectors]] (`proposed`) — a per-`WorkflowConnection` audited
> `host[:port]` allowlist wired to the egress guard's `isInternalTargetAllowed` seam, with `http://`
> validating only when a non-empty allowlist is declared. v1 ships **public https only** (ADR-0054 §6b);
> internal targets are deferred to that ADR (CEO holding the build).

### 4.1 `rest`

*Connector instance:*

| Field | Notes |
| --- | --- |
| `baseUrl` | Origin + base path. Validated like `Application.url` (SEC-008): **http(s) only**, reject `javascript:`/`data:`/`file:` (`docs/02-domain/entities/application.md`). The **host is fixed here, never templatable from ctx** (anti-SSRF, §6.4). |
| `auth` | A nested discriminated union: `none` · `bearer{secretRef}` · `basic{userRef,secretRef}` · `apiKeyHeader{headerName,secretRef}` · `oauth2ClientCreds{tokenUrl,clientIdRef,clientSecretRef,scopes}` (token cached+refreshed, §a). |
| `defaultHeaders` | Static non-secret headers (e.g. `Accept`). |
| `timeoutMs` / `tlsVerify` | Bounded timeout; `tlsVerify` default **true**. A self-signed internal target may set it false **with a loud UI warning** (a deliberate, audited downgrade). |

*Step operation:*

| Field | Notes |
| --- | --- |
| `method` / `pathTemplate` | `pathTemplate` may interpolate ctx into **path segments only**, percent-encoded (§6.4). |
| `queryTemplate` / `bodyTemplate` | Data mappings (§6). |
| `expectedStatus` | Allowlist of success codes (e.g. `[200,201]`); anything else = failure. |
| `responseExtract` | A read-only selector (JMESPath/JSONPath) capturing the **external correlation id** from the response (§7). |
| `idempotency` | The idempotency-key expression + the header to send it on (§7). |

### 4.2 `webhook_out`

A constrained, single-endpoint `rest` POST with a **signature**. Distinct because it standardises the
"notify my automation platform" pattern.

| Field | Notes |
| --- | --- |
| `url` | Single target (same scheme allowlist + fixed-host rule). |
| `signing` | `hmacSha256{secretRef, headerName}` (default) — lazyit signs `timestamp + body`; the receiver verifies. Replaces per-request auth tokens for the common "fire-and-forget to n8n/script" case. |
| `bodyTemplate` | The event payload mapping (§6). |
| `ackMode` | `2xx-is-success` (default) **or** `await-callback` → pairs with a `webhook_in` connector for the result (§4.3). |

### 4.3 `webhook_in` (inbound)

**lazyit exposes** an endpoint; an external system (or a human-driven callback) reports completion and
pushes a result back. This is the **resume half** of long-running external work — no polling.

| Field | Notes |
| --- | --- |
| `callbackPath` | A generated, unguessable path bound to a specific **run/step** (not a static global URL). |
| `inboundAuth` | `hmacSha256{secretRef}` **or** a **per-run bearer token** minted when the step suspends and accepted **once** (single-use, scoped to that run/step). |
| `resultMapping` | Maps the inbound body → the step's `externalRef` + `output` merged into ctx for downstream steps (§6). |
| `dedupKey` | An idempotency guard so a re-delivered callback resumes the run **once** (§7). |

> Security-critical (see §6.4 + §11): the inbound endpoint authenticates every call, scopes the token
> to a single suspended step, is idempotent on `dedupKey`, and never trusts an unauthenticated body.
> It is the engine's only externally-reachable *write* surface.

### 4.4 `mcp`

| Field | Notes |
| --- | --- |
| `transport` | `http` (streamable-HTTP/SSE to a remote MCP server) **or** `stdio` (spawn a local self-hosted MCP server process). |
| `endpoint` | URL (`http`) **or** command+args (`stdio`, run in a **sandboxed child**, §8/§10). |
| `auth` | Same auth union as `rest` for `http`; env/secret injection for `stdio` (secretRef). |
| `toolName` / `argsTemplate` | The MCP tool to call + its argument mapping (§6). |
| `resultExtract` | Selector over the tool result for the correlation id (§7). |

### 4.5 `manual`

See §7-bis below — no transport config; assignee + task + return-form + suggestions.

### 4.6 `sdk` / `prebuilt` / `custom`

Config is **just** `{ providerKey, credentials: { ...secretRefs }, operation, mapping }` — the
provider (shipped in the image) owns the protocol; the admin supplies credentials + mapping. The
`providerKey` resolves through the registry (§2). Phase 4 (§12).

---

## 5. The run context (`ctx`) — what a mapping may read

The executor receives a **frozen, allowlisted** context assembled server-side from the run. The
template/mapping layer (§6) can read **only** from `ctx`; it has no access to `process`, env, the DB,
globals, or anything not placed here. This allowlist is the contract between the trigger source and
every connector.

| Path | Source | Notes |
| --- | --- | --- |
| `ctx.event` | `granted` \| `revoked` (\| later `timer`) | The trigger. |
| `ctx.user.{email,firstName,lastName,displayName,id,externalId}` | The grantee `User` | `id` is uuid, `externalId` = OIDC `sub`. **All treated as untrusted strings** (a display name is user-influenced). |
| `ctx.application.{id,name,vendor,url,metadata}` | The `Application` | `metadata` is unvalidated jsonb (known debt, `docs/02-domain/entities/application.md`) — treat as untrusted. |
| `ctx.grant.{id,accessLevel,grantedAt,expiresAt}` | The `AccessGrant` | `accessLevel` is free-form (untrusted). `grant.id` is the natural idempotency seed (§7). |
| `ctx.actor.{kind,id,displayName}` | The principal who acted (human or service account, ADR-0048) | For attribution in the external payload + the audit trail (§ INV-SA-4 alignment). |
| `ctx.priorRun` / `ctx.priorSteps[]` | Prior runs/steps for this `(user,application)` | Carries the **captured `externalRef`** so the **revoke** workflow can target the exact external account the grant workflow created (§7). |
| `ctx.steps[<id>].output` | Outputs of earlier steps **in this run** | E.g. a `manual` step's submitted form, or a `rest` create's captured id, feeding a later step. |

> **FUTURE (document, do not design):** richer identity fields — `role`, `team`, `manager`, `boss`,
> Active-Directory attributes — would extend `ctx.user.*` when those exist in the model. **They do
> not exist today.** Adding them (especially `team`/`manager`) edges the manual connector toward
> **Identity Governance / HR-onboarding**, which is an explicit anti-goal (`product-vision-tech.md`:
> "Not an HR system"). Flagged as a scope boundary for the CEO (§13), not built here.

---

## 6. Data mapping — the safe template layer (security-critical)

**The problem.** A step must turn `ctx` into an external payload: a JSON body, query params, a path,
headers, MCP tool args. The admin authors this mapping. **It must never become a code-execution
sink.**

### 6.1 Recommendation (v1)

A **logic-less, structural template** over the frozen `ctx`, with a **closed set of named filters** —
*not* an expression evaluator.

- **Structure:** the admin authors the payload **shape** as a JSON template; leaf values are
  placeholders. Illustrative (non-normative):

  ```
  bodyTemplate (illustrative):
  { "emailAddress": "{{ ctx.user.email }}",
    "displayName":  "{{ ctx.user.firstName }} {{ ctx.user.lastName }}",
    "products":     ["jira-software"],
    "team":         "{{ ctx.steps.pick_team.output.team | default: 'unassigned' }}" }
  ```

- **Engine:** a **logic-less Mustache/Handlebars-style** resolver with **custom helpers disabled** and
  **`{{ }}` interpolation only** — no `{{#if}}` arbitrary blocks, no inline JS, no `eval`/`Function`,
  no `vm` with host access. The ONLY logic is a **closed allowlist of pure filters**
  (`default:`, `lower`, `upper`, `trim`, `substring`, `splitFirst`, `jsonStringify`) — Liquid-style,
  but a fixed enum, never admin-extensible.
- **Context is frozen + allowlisted (§5):** the template can resolve **only** `ctx.*`. A reference to
  anything else resolves empty (or errors, per `onMissing`). There is **no** path to
  `process`/`require`/`global`.
- **Prototype-pollution / SSTI guards (mandatory):** reject any path touching `__proto__`,
  `constructor`, `prototype`; resolve against a null-prototype copy of `ctx`. Use a library with a
  clean SSTI record, pinned, and reviewed by the security area (§11) — verified via Context7 before
  adoption per the repo's external-library rule (`CLAUDE.md`).

**Rejected alternatives:** raw JS expression `eval`; Handlebars with arbitrary registered helpers;
any `vm`/`Function` sandbox (escapes are a known class); a full Liquid with custom tags. If a future
need genuinely outgrows logic-less, the next step is **JMESPath** (declarative, side-effect-free, no
host access) for *selection* — **never** a general-purpose evaluator. That is a future ADR.

### 6.2 Context-aware output encoding (the injection defense)

Every `ctx` value is **untrusted** (a user display name, a free-form `accessLevel`, an app's
unvalidated `metadata`). The mapping must **encode per destination**, automatically, by the executor —
not left to the admin:

- **JSON body leaves** → JSON-encoded (a `"` or `{` in a name can't break the payload).
- **URL path segments** → percent-encoded; **query values** → URL-encoded.
- **HTTP headers** → strip CR/LF (no header injection / response splitting), reject control chars.
- **MCP tool args** → passed as typed JSON values, never string-concatenated into a command.
- **`stdio` MCP / any spawn** → **never** interpolate ctx into a shell string; pass args as an argv
  array (no shell), and prefer the sandboxed child (§10).

### 6.3 The injection risk, named (for the security area)

1. **SSTI** — template engine code execution → mitigated by logic-less + frozen null-proto ctx +
   pollution guards (§6.1).
2. **Downstream injection** (header/CRLF, JSON-break, path traversal, query/command injection) →
   context-aware encoding (§6.2); treat all ctx as untrusted.
3. **SSRF** — lazyit can reach the internal network (self-hosted targets). Mitigation: the **host is
   fixed in the connector config**, validated at config time (http(s) only, SEC-008 precedent); only
   **path/query/body** are templatable, and path segments are encoded. An **egress allowlist** is a
   recommended later hardening. The inbound `webhook_in` is the only external write surface and is
   authenticated + run-scoped + idempotent (§4.3, §11).
4. **Secret leakage** — the resolved payload may carry an injected auth token; bodies/headers are
   **never logged** (ADR-0031; INV-6, `docs/06-security/INVARIANTS.md`), the dry-run redacts secrets
   (§9), and the audit row stores a **redacted** payload (§ a).

---

## 7. Idempotency & correlation

External systems are flaky and at-least-once delivery is the norm; retries **must not** double-provision.

- **Idempotency key (per operation).** Each step declares a key templated from ctx — default
  `lazyit:{{ctx.application.id}}:{{ctx.grant.id}}:<stepKey>`. Where the target API supports it (e.g.
  Stripe-style `Idempotency-Key`, or a client-supplied id), it is sent as a header; the orchestrator
  *also* uses it as the **dedup guard** (a step that already succeeded for this run is never re-run).
- **Non-idempotent creates** (no server-side idempotency, no client id — e.g. a plain `POST` that
  mints a new user): **single-shot, do not retry on a lost response** — exactly the precedent in
  `apps/api/src/auth/identity/zitadel-management.service.ts` (the `request(..., {retryOnTransient:
  false})` path for `POST /v2/users/human` and grant-ADD, to avoid a duplicate). The executor reports
  `retryable: false` for these; a transient failure surfaces as a failed run for manual remediation.
- **Correlation capture (the "remember what we created" linkage).** On a successful create, the step's
  `responseExtract`/`resultExtract` captures the **external id** (Jira accountId, GitHub user id, …)
  into `externalRef`. This is persisted **append-only** as a **CorrelationRecord** keyed by
  `(connector, applicationId, userId|grantId, externalSystemId)`. The **revoke** workflow reads it via
  `ctx.priorRun`/`ctx.priorSteps` to deactivate the *exact* external account the grant created. Without
  this linkage, deprovisioning is guesswork. (Append-only + immutable, consistent with ADR-0006 and
  the audit philosophy; never hard-deleted.)
- **Retry semantics are the orchestrator's** (backoff/jitter/budget — the same shape as the Zitadel
  client, `request()`/`computeBackoff()`), but the **key** and the **retryable flag** are defined here
  because only the connector knows whether an operation is safe to repeat.

---

## 7-bis. The MANUAL connector (human task)

`manual` is how an app with **no API** is still part of an automated, audited flow: lazyit
**orchestrates and records**, a human **executes** in the external system (and optionally **types data
back**). It is also the `to_build` fallback and the natural home for "which team?" decisions.

**Mechanics.** A `manual` step **suspends** the run and creates a **HumanTask** delivered through the
**ADR-0052 notification stack** (in-app bell + SSE realtime + the notification model — see
`.claude/skills/lazyit-cto/references/decision-history.md`, ADR-0052). When a human completes the task
(submits the form + marks done), a completion event **resumes** the run (the same suspend/resume the
`webhook_in` callback uses — §10). The submitted form merges into `ctx.steps[<id>].output`.

| Config | Notes |
| --- | --- |
| `title` / `body` | Templated from ctx (§6) — "Create a Jira account for {{ctx.user.email}}". |
| `assignee` | Resolution strategy: a **specific user**, a **role**, or "anyone holding permission X". (A **team** target is FUTURE — it needs the team model that doesn't exist; §5/§13.) |
| `returnForm` | A list of fields the human must supply (`name`, `type`, `required`), each with **optional `suggestions`** — a closed list, or a server-computed shortlist. |
| `sla` / `reminders` | Optional due-time + reminder cadence (reminders ride the notification stack; the timer rides the substrate, §10). |

**Suggestions** start as a **static closed list** (e.g. the known Jira teams the admin typed). "Suggest
by role/team" is deferred — it requires identity fields lazyit lacks and pushes toward Identity
Governance (anti-goal; §13). Completing a task is gated by a **new permission** (§ RBAC).

---

## 8. MCP as a first-class connector type

**Direction.** lazyit acts as an **MCP client** invoking an **external app's MCP server** (e.g. an
app exposes `create_user`/`deactivate_user` MCP tools). This is genuinely first-class in the *model*
(a `kind` slot, §3/§4.4) because MCP is becoming a standard automation/tool surface and many apps
will ship MCP servers — modelling it now future-proofs the connector layer at near-zero cost.

**Feasibility.** The MCP TypeScript SDK provides a client + transports (streamable-HTTP/SSE and
stdio). `http` transport is the lowest-risk, self-hosted-friendly path (a remote/self-hosted MCP
server over HTTP with auth). `stdio` (spawn a local MCP server process) is feasible but is a real
attack surface (process spawn, untrusted server binary) — it **must** run in the BullMQ **sandboxed
processor** isolation that ADR-0053 already adopts for untrusted/heavy jobs
(`docs/03-decisions/0053-async-workers-bullmq-valkey.md`), with a memory cap and **argv arrays, never
a shell string** (§6.2).

**Value vs cost.** Value: leverages a fast-growing ecosystem; one connector type, many future targets;
aligns with the AI-tool direction. Cost/risk: MCP spec churn (maturity), the stdio spawn surface, and
that today **few IT SaaS apps actually expose MCP servers for provisioning** — REST is still the
workhorse. **Verdict: ship the `mcp` discriminator in the model from the start, but defer the executor
implementation to Phase 3** (start with `http` transport; `stdio` later, sandboxed). Don't let MCP
delay the v1 `rest`/`manual`/`webhook_out` value.

---

## 9. Dry-run & test-connection contract

Two distinct, **explicitly safe** operations — the operator's primary defense against a misconfigured
mapping silently corrupting an external system.

- **`testConnection(connector)` — connector-level, side-effect-free.** Validates credentials +
  reachability with a **read-only/idempotent** probe: `rest` → a GET to a whoami/health path; `mcp` →
  the `list-tools` handshake; `webhook_out` → a signed ping carrying `X-Lazyit-Test: true` (receiver
  may ignore); `webhook_in` → validate the route is registered + the secret resolves; `manual` →
  trivially ok; `sdk`/`prebuilt` → the vendor's whoami. Returns `{ ok, latencyMs, status?,
  requestId }` — **redacted**, never the secret, never the full response body (ADR-0031, INV-6).
- **`dryRun(connector, step, ctx)` — step/workflow-level.** Resolves the data mapping against a
  **sample ctx** (or a chosen real grant) and returns the **exact would-send payload** (method, URL,
  resolved body/headers) with **secrets redacted**, **without sending it**. A `send-for-real` toggle is
  allowed **only for idempotent operations** and behind a loud confirm. This is what an admin runs
  before flipping a workflow live.

Both run **synchronously inside the request** (they are interactive, bounded, read-only) — the one
legitimate niche for synchronous execution (§ substrate). Both are gated by a workflow-management
permission (§ RBAC).

---

## a. Secrets — referenced, never inlined (hard dependency on ADR-0052)

Per-app credentials (Jira token, OAuth client secret, HMAC signing key, inbound shared secret) are
**never stored in the connector config**. The config holds a **`secretRef`** — a key into the
**ADR-0052 `SystemSecret`** store (encrypted at rest, with a redacted `SettingAuditLog`; see
`.claude/skills/lazyit-cto/references/decision-history.md`, 2026-06-06). The executor resolves
`secretRef → plaintext` **only at execute time, in memory**, and:

- Mirrors **INV-6** (`docs/06-security/INVARIANTS.md`): secrets are never baked into an image, never
  committed, never logged.
- Mirrors **ADR-0031**: request bodies/headers (which carry the resolved token) are not logged; the
  audit row persists a **redacted** payload; the dry-run/test output redacts.

**Dependencies / gaps to flag:** (1) ADR-0052 currently lives on branch
`feat/settings_notifications_smtp`, **not yet on `dev`** — this engine **blocks on it landing**.
(2) `SystemSecret` was designed for SMTP-style static secrets; **OAuth2 with refresh tokens** needs a
*refreshable/rotatable* secret (store + update the access token, keep the refresh token) — likely a
small **ADR-0052 extension**, flagged for the CEO (§13). (3) The notification/bell/SSE half of
ADR-0052 is the delivery substrate for the `manual` task inbox + run-status (§7-bis).

---

## RBAC — workflow management is its own gated surface (extends ADR-0046)

Workflow/connector administration is privileged and must extend the **frozen permission catalog**
(ADR-0046, `docs/03-decisions/0046-roles-permissions-v2.md`) — catalog-as-code in `@lazyit/shared`
(`packages/shared/src/schemas/permission.ts`), resolved DB-first (INV-1/INV-8), never a token claim.
Proposed new `domain:action` literals (a new `workflow` domain):

| Permission | Gates |
| --- | --- |
| `workflow:read` | View workflows/connectors/runs (secrets always redacted). |
| `workflow:manage` | Create/edit connectors + workflows; configure secret refs; run test-connection/dry-run. **ADMIN-only in the safe-default seed** (it can configure outbound calls + reference secrets — high blast radius). |
| `workflow:task:complete` | Complete a `manual` HumanTask (may be granted more broadly, e.g. MEMBER). |
| (later) `workflow:run` | Manually (re)trigger / re-run a workflow. |

**Who executes the actions.** Workflow runs act on behalf of a **principal** for attribution. Runs are
attributed in the audit trail like everything else (ADR-0048, INV-SA-4): a run triggered by a human
grant carries that human as `ctx.actor`; a **service account** (ADR-0048,
`docs/03-decisions/0048-service-accounts.md`) that opens grants via the API attributes the run to the
service account (`grantedBySaId`). The engine itself, when it acts autonomously (a timer trigger), is
a **system actor** (null human, like the existing `SetNull` actor design in ADR-0023). New run/step
tables get the same nullable `serviceAccountId` + at-most-one-actor pattern as the 6 audit-bearing
tables (INV-SA-4) — handed to the data area.

---

## 10. The orchestration seam (handoff, summarized)

This area defines the leaf + the suspend/resume semantics; the **orchestration/substrate area owns the
loop**. The connector layer needs the substrate to provide:

- **Durable, at-least-once jobs** (a run that crashes mid-step must resume; an orphaned external
  create — succeeded remotely, lost locally — is reconciled via the idempotency key + correlation
  capture, §7).
- **Retry with bounded backoff + jitter** (the Zitadel `request()` shape), honouring the executor's
  `retryable` flag (non-idempotent creates single-shot).
- **Suspend/resume** for `manual` and `webhook_in` (and `webhook_out` with `await-callback`): a step
  enters `waiting_for_human` / `waiting_for_callback`; an inbound event (task completion / signed
  callback) **resumes** by enqueuing the continuation. This is modelled in **our** run-state, not
  bought from a durable-workflow engine (§ substrate).
- **Flows / step dependencies** (multi-step grant flows) — BullMQ Flows (ADR-0053).
- **Delayed/repeatable jobs** for the FUTURE timer triggers (N-days-after, re-certification) — BullMQ
  delayed/repeatable (ADR-0053).
- **Rate-limiting** per connector (don't hammer Jira) — BullMQ.
- **Sandboxed child** for `stdio` MCP / any heavy/untrusted executor (ADR-0053).

---

## 11. Security summary (for the sentinel area to review)

- **SSTI / code execution** in the mapping → logic-less engine + frozen null-proto ctx + pollution
  guards + closed filter set (§6.1).
- **Downstream injection** (CRLF/header, JSON-break, path/query/command) → executor-side
  context-aware encoding; all ctx untrusted (§6.2).
- **SSRF** → fixed host in config, http(s) allowlist (SEC-008), only path/query/body templatable;
  egress allowlist as later hardening (§6.3).
- **Inbound `webhook_in`** → HMAC or single-use per-run token, run-scoped, idempotent on `dedupKey`;
  the only external write surface (§4.3).
- **Secrets** → ADR-0052 `SystemSecret` refs only; never inlined/logged; redacted in dry-run/test +
  audit; INV-6 (§a).
- **`stdio` MCP / spawn** → sandboxed child (ADR-0053), argv arrays never shell strings (§6.2, §8).
- **RBAC** → `workflow:manage` ADMIN-only by default; DB-first (INV-1/INV-8); runs attributed
  honestly (INV-SA-4) (§ RBAC).
- **No rollback of the local grant** on external failure (loose coupling) — the inverse of INV-5,
  stated as a non-negotiable (§1).

---

## 12. Prebuilt connectors — catalog-as-code (later phase)

For the famous apps (Jira, GitHub, Google Workspace, Okta, Microsoft Entra, Slack), ship **prebuilt
connectors** as **catalog-as-code** — the same philosophy as the permission catalog (ADR-0046) and the
two-implementation `IdentityProvider` factory (ADR-0043): a **frozen, code-defined registry in the
image**, keyed by a `providerKey`, **reviewed and pinned**, never runtime-loaded. Each prebuilt entry
declares:

- its underlying `kind` (`rest` or `sdk`),
- a curated set of **operations** (`createUser`, `deactivateUser`, …) with **pre-authored mappings +
  idempotency keys + correlation extraction** (so the admin authors no template),
- a **credential schema** (what the admin must supply — API token / OAuth / base URL / tenant),
- a **test-connection** probe.

The admin picks the app from a gallery, fills credentials, and it works — the **paved road**. The
declarative `rest`/`webhook_out`/`manual` types remain the **generic escape hatch** for everything
else. **Phase 4** — v1 ships only the generic declarative types. `external library → latest docs`
applies before adopting any vendor SDK (`CLAUDE.md`; Context7).

---

## 13. Substrate verdict — from the connector lens

**The question:** BullMQ + Valkey vs Temporal vs pg-boss vs n8n vs synchronous, for *this* engine.

**Verdict: BullMQ on Valkey (ADR-0053) is the right substrate for v1 and v2.** From the connector
lens, what external calls demand of the substrate is: **durability** (an orphaned external create is a
real failure mode — §7), **retry with bounded backoff** (external systems are flaky — the Zitadel
precedent already does this), **decoupling from the request** (the loose-coupling rule — §1),
**suspend/resume** (manual tasks + inbound callbacks run for hours/days), **flows** (multi-step
provisioning), **delayed/repeatable jobs** (the future timer triggers), and **rate-limiting**. BullMQ
provides every one of these, and ADR-0053 (`docs/03-decisions/0053-async-workers-bullmq-valkey.md`) —
**already accepted** — explicitly names the workflow engine as a justifying use case and commits Valkey
to compose with AOF persistence. **Crucially, the operator cost is already paid:** the one-command-setup
constraint (`product-vision-tech.md`) is the binding limit, and ADR-0053 already adds the Valkey
container. Building the engine on BullMQ adds **zero new infrastructure**.

Concretely against each option:

- **pg-boss (Postgres-only, zero new infra)** — its sole advantage (no new backing service) is
  **already spent**: ADR-0053 committed Valkey for other reasons, so the marginal operator cost of
  BullMQ is zero, while pg-boss lacks first-class **flows/parent-child** (the engine's core need) and
  weaker rate-limiting — ADR-0053 rejected it as primary precisely because it would be replaced *when
  the workflow engine lands*. **This is that moment. Don't re-litigate; don't add a second queue.**
- **Temporal** — genuinely *better* at the one hard thing the connector layer wants: **durable,
  long-lived, human-in-the-loop suspend/resume** with durable timers + signals (which `manual` +
  `webhook_in` + re-certification all need). **But** it is a heavy second system (its own
  server + datastore + UI + worker fleet) — a major operator burden that violates the single-host,
  non-expert-operator, "boring durable technology" posture. **Honest call: adopt BullMQ now and model
  suspend/resume explicitly in our own run-state** (a `waiting_for_*` step status that an inbound event
  resumes by enqueuing the continuation, §10). That is more engineering than Temporal's
  await-for-free, but **far** less operational weight, and it keeps the data model + RBAC + audit
  native (which the CEO wants). Revisit Temporal only if saga-style compensation across many systems
  explodes — a **future ADR**, not now.
- **n8n** — **not an execution substrate; it is a peer product** to the engine. Embedding it would mean
  shipping/operating n8n (its own DB, opinionated runtime) and ceding the native data model, RBAC and
  audit. **Reject n8n-as-engine.** But **embrace n8n-as-a-target:** the `webhook_out` connector lets an
  operator's *own* n8n/Make/Zapier receive a signed lazyit event and reach n8n's 400+ connectors — a
  huge integration surface for ~zero lazyit effort. (This is a connector-lens insight: lazyit need not
  build every connector; it can **bridge** to an automation platform the operator already runs.)
- **Synchronous execution** — **rejected for the engine** (it would couple to the request, block/risk
  the grant, lose work on a crash, and can't retry/suspend/schedule). It has exactly **one legitimate
  niche: `testConnection` and `dryRun`** (§9), which are interactive, bounded and read-only and run
  inline in the request.

**Net:** BullMQ + Valkey (ADR-0053) for the engine; our own explicit suspend/resume run-state for
human/callback steps; `webhook_out` to bridge to n8n rather than embed it; synchronous only for
test/dry-run; Temporal deferred to a future ADR if complexity demands it.

---

## 14. Phased, v1-first plan

| Phase | Deliverable | Connector lens |
| --- | --- | --- |
| **0 — Foundation** | Connector/Workflow/Step model (jsonb+zod, ADR-0007); the **executor registry** (factory keyed on `kind`, mirroring `identity-provider.factory.ts`); the **after-commit trigger** from `access-grants.service.ts`; **secret-ref** resolution via ADR-0052 `SystemSecret`; the **safe template engine** (§6); `workflow:*` permissions (ADR-0046). **Blocks on ADR-0052 landing on `dev`.** | The contract + the seam. |
| **1 — v1 connectors** | `rest` + `manual` + `webhook_out`; triggers `access.granted` + `access.revoked`; idempotency keys + **correlation capture** + **test-connection** + **dry-run**. | Covers the 80%: any HTTP API, any human-do-it, any bridge-to-automation. **This is the shippable v1.** |
| **2 — Async + timers** | `webhook_in` (callbacks → suspend/resume run-state); **timer/scheduled triggers** (BullMQ repeatable/delayed) for N-days-after + re-certification. | Long-running external work; the future trigger class. |
| **3 — MCP** | `mcp` executor — `http` transport first; `stdio` later, **sandboxed** (ADR-0053). | First-class type slot shipped in Phase 0; executor here. |
| **4 — Prebuilt catalog** | Catalog-as-code famous-app connectors (Jira/GitHub/Google/Okta/Entra); `sdk`-backed providers; the `custom`/`to_build` server-plugin registry formalized. | The paved road on top of the generic escape hatch. |
| **Cross-cutting (later)** | OAuth-refresh secret support (ADR-0052 extension); org-level shared connectors; egress allowlist; bull-board run observability (ADR-0053 follow-up). | Hardening + reach. |

---

## 15. Dependencies on other areas

- **Orchestration / substrate area:** the run-state machine, enqueue, flow dependencies, retry policy,
  BullMQ wiring, suspend/resume mechanics. *This doc gives them: the executor leaf contract (§2.1), the
  `ctx` event contract (§5), the idempotency key + `retryable` flag + correlation linkage (§7), and the
  loose-coupling rule (§1).*
- **Data model area:** the Prisma models for Connector/Workflow/Step/Run/HumanTask/CorrelationRecord
  (described here as field tables, §4/§7/§7-bis) + the nullable `serviceAccountId` actor + at-most-one
  CHECK (INV-SA-4) + append-only run/correlation history (ADR-0006).
- **ADR-0052 (Settings/Secrets/Notifications):** `SystemSecret` for credentials (§a, **blocking**);
  notification/bell/SSE for the `manual` inbox + run-status (§7-bis); possible OAuth-refresh extension.
- **Security / sentinel area:** review the template engine (SSTI/pollution), context-aware encoding,
  SSRF posture, inbound-webhook auth, secret handling (§11).
- **RBAC:** the new `workflow:*` catalog entries (ADR-0046).
- **Frontend area:** the connector-config UI (the discriminated-union form), the **dry-run preview**,
  the connector **gallery** (Phase 4), and the **manual-task inbox**.

---

## 16. Open questions for the CEO

1. **Connector scope.** Per-application connectors for v1 (matches "configure per app"), with
   **org-level shared connectors** deferred — confirm? (One Jira instance reused across many apps would
   want sharing eventually.)
2. **Loose-coupling confirmation.** A failing external provisioning call **never** rolls back/blocks the
   local `AccessGrant` (the inverse of the Zitadel INV-5 posture). Is there **any** application where
   provisioning must be atomic with the grant? (Recommendation: no — keep the grant authoritative.)
3. **Template language for v1.** Logic-less Mustache + a **closed filter set** + JMESPath-only-if-needed
   (no general evaluator, ever) — confirm the no-arbitrary-code stance is acceptable even if it means
   some mappings need a `manual` or `to_build` step.
4. **Identity-Governance boundary.** The `manual` connector's "which team/manager?" suggestions and the
   FUTURE `role/team/manager/AD` identity fields edge toward HR-onboarding (an anti-goal). How far do we
   go — static suggestions only for v1, richer governance behind a later explicit decision?
5. **ADR-0052 sequencing + OAuth.** This engine **blocks on ADR-0052 landing on `dev`**, and OAuth2
   credentials likely need a small `SystemSecret` **refresh-token extension**. Approve the dependency +
   the extension?
6. **MCP direction.** This feature uses lazyit as an MCP **client** (calling external MCP servers).
   lazyit *exposing its own* MCP server is a separate idea — out of scope here; confirm.

---

Related: [[0023-access-management-design]] · [[0043-zitadel-source-of-truth]] · [[0046-roles-permissions-v2]] ·
[[0048-service-accounts]] · [[0053-async-workers-bullmq-valkey]] · [[0007-flexible-asset-specs-jsonb]] ·
[[0031-logging-strategy]] · [[0030-list-pagination-contract]] · [[0009-bun-first-vs-app-stack]] ·
[[application]] · [[access-grant]] · [[INVARIANTS]] ·
`apps/api/src/access-grants/access-grants.service.ts` ·
`apps/api/src/auth/identity/identity-provider.factory.ts` ·
`apps/api/src/auth/identity/zitadel-management.service.ts` ·
`.claude/skills/lazyit-cto/references/decision-history.md` (ADR-0052)
</content>
</invoke>
