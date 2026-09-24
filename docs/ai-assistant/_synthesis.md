---
title: "AI Assistant, MCP Server and Headless API — Architecture Synthesis"
tags: [ai-assistant, architecture, synthesis, mcp, oauth, llm, security, adr-candidate]
status: accepted
created: 2026-09-23
updated: 2026-09-24
authors: [cto]
reconciles:
  - "[[ai-assistant/mcp-and-oauth]]"
  - "[[ai-assistant/provider-and-runtime]]"
  - "[[ai-assistant/tools-and-execution]]"
  - "[[ai-assistant/frontend]]"
  - "[[ai-assistant/security]]"
---

# AI Assistant, MCP Server and Headless API — Architecture Synthesis

> This is the CTO's reconciliation of the five area designs in `docs/ai-assistant/`. It is the single
> coherent picture: the three channels, the CEO's decisions, the cross-slice contracts, one directory
> tree, one data model, the invariants, the defaults adopted pending review, and one implementation
> plan in waves. The decision record is [[0097-ai-assistant-mcp-and-headless-api|ADR-0097]]
> (accepted 2026-09-23).
>
> **Source of truth precedence:** the area notes are the depth; this file is the binding summary.
> Where this file and an area note disagree, this file wins — then the area note is corrected.
> Epic: #1315.

---

## 0. The one-paragraph answer

An **opt-in AI capability, off by default**, with **three channels over one tool catalog**. The AI
always acts **as the invoking principal with exactly its permissions** — the logged-in user in the
in-app chat, the connecting user over MCP, the Service Account on the headless API — and it never
gets a synthetic identity. Every tool executes **in-process through Nest's own guard and pipe
pipeline**, so a tool can do exactly what the equivalent HTTP route lets that principal do, by
construction. The in-app chat and headless runs use **lazyit's own agent loop**, run as BullMQ jobs
with Postgres as the system of record (the workflow-engine pattern), against an admin-configured
provider (Anthropic, OpenAI, Gemini, or OpenAI-compatible) called through a thin, ported model-call
layer. Interactive mutations wait for **explicit approval on a server-built preview card**. External
agents connect over **MCP**, authorized by **lazyit's own OAuth 2.1 authorization server** on HTTPS
instances and by **revocable personal tokens** on plain-HTTP `lan` instances. Every AI-initiated
mutation lands in **one permanent, append-only ledger**. Nothing depends on OIDC.

---

## 1. The three channels

| | **Chat** (in-app) | **MCP** (external agents) | **Headless** (server scripts) |
| --- | --- | --- | --- |
| Who initiates | a human in the navbar chat | a human's MCP client (Claude Code, Cursor, claude.ai…) | a script holding a Service Account token |
| Acts as | the logged-in user | the user who authorized the client | the Service Account |
| Gate | `ai:use` + AI enabled + provider configured | `ai:connect` + the MCP switch (independent of the provider) | `ai:use` on the SA + AI enabled + the SA's AI access setting |
| Authentication | the existing web session | OAuth 2.1 (`lzit_oat_`) on HTTPS; personal token (`lzit_pat_`) on `lan`; SA token for SAs holding `ai:connect` | the SA token (`lzit_sa_`) |
| Who confirms mutations | the user, per action, on a preview card | the external client (annotations inform it) | nobody — autonomous within grants and the per-SA setting |
| Agent loop | lazyit's (BullMQ worker) | the client's own | lazyit's (BullMQ worker) |
| Mutations audited in | `AiActionLog` (channel `CHAT`) | `AiActionLog` (channel `MCP`) | `AiActionLog` (channel `HEADLESS`) |

The instance also serves a **Claude Code skill/plugin** that explains lazyit and its tools, generated
from the same tool registry and the same domain primer.

---

## 2. The CEO's decisions

Quoted verbatim in Spanish where the CEO's words are the decision.

### Round 1 — intent (2026-09-23)

1. **Off by default, enabled by an admin wizard.** "elegis el proveedor, modelo, y tus api key, y
   configuraciones extras (despues se pueden modificar), de que se te recargue la aplicacion, y te
   habilita un chat adentro de la app (en la navbar), un chat donde puedas controlar la app en vivo
   desde ahi. Al mismo tiempo, podes habilitar un mcp, para usarlo desde claude code o desde cualquier
   otra herramienta, y tambien podes instalar el skill que entiende que es lazyit y como se usa."
2. **Identity.** The AI acts **as** the invoking user, with exactly their permissions: chat = the
   logged-in user; MCP = the user; headless = a Service Account — "si quiero mandar un prompt desde un
   server obviamente seria la SA".
3. **Confirmation.** Writes in the interactive chat need explicit approval on a preview card. Over MCP
   the client owns confirmation.
4. **Providers v1:** Anthropic, OpenAI, Gemini, OpenAI-compatible — "Al ser varios, tenemos que ver a
   nivel de codebase como manejamos los proveedores, ordenemos bien los archivos, estructuremos bien
   el codigo, y hagamoslo escalable".
5. **Configuration** is instance-wide, set by an admin; the API key is encrypted at rest.
6. **MCP authentication:** "OAuth 2.1 desde el día uno". All OIDC/Zitadel is to be removed (#1310);
   this design adds no OIDC dependency.
7. **Conversations** are saved with a configurable retention; mutating calls are permanently audited.
8. **The skill is served by the instance.**
9. **Live control** = backend actions + a reactive UI + navigation to entities. Not click-level UI
   driving.
10. **Access permission** `ai:use` (ADMIN + MEMBER).

### Round 2 — answers to the analysis (2026-09-23)

11. **Exclusions.** Keep "Todo lo que el usuario pueda" **except** (1) operations that return
    credentials in cleartext — SA token create/rotate, temporary passwords
    (`provision-local-account`) — and (2) the AI's own configuration — provider, base URL, key,
    budgets, retention. The Secret Manager stays out (zero-knowledge). Privilege- and
    identity-changing tools stay **in**, behind an elevated confirmation card: the full diff, one
    action per approval, an untrusted-source banner, and a password step-up for privilege grants and
    credential delivery.
12. **MCP on plain-HTTP `lan` instances:** revocable personal MCP tokens (`lzit_pat_…`, mandatory
    expiry, the same connected-apps list), on `lan` only. OAuth 2.1 is the only path on HTTPS
    instances.
13. **Headless:** "Autonomo total, pero configurable in-app tambien". Recorded as: by default a run is
    fully autonomous within the SA's grants; a **per-Service-Account in-app setting** sets AI access to
    off / read-only / read-write (default read-write when the SA holds `ai:use`) with an optional
    mutation cap per run. **The per-SA placement is a CTO interpretation — to confirm on review.**
14. **A separate permission `ai:connect` for MCP** (ADMIN + MEMBER by default). MCP can be enabled
    without configuring an LLM provider — an independent switch.
15. **MCP client trust policy** (on review of PR #1317, accepting ADR-0097): "Revise el adr, esta ok,
    lo unico del mcp que daria es que haya una allowlist configurable, pero por defecto todos o los que
    tengamos en cuenta, https, claude code, codex, opencode, pi, y algun otro que me este olvidando, los
    de siempre basicamente." Recorded in [[0097-ai-assistant-mcp-and-headless-api|ADR-0097]] decision 13.

---

## 3. Cross-slice reconciliations (R1–R10)

The five analysts disagreed in places. These CTO decisions resolve every conflict and apply across all
notes.

| # | Decision | What it supersedes |
| --- | --- | --- |
| **R1** | **Execution.** Tools run in-process through Nest's own pipeline: the controller handler is wrapped with `ExternalContextCreator` and invoked with a synthetic request; a module-private symbol carries a **delegated identity** that a new branch in `JwtAuthGuard` resolves by **re-loading the principal from the database**, exactly like the network branches ([[ai-assistant/tools-and-execution|tools]] §5 Fork C3). Route equivalence (INV-AI-2) holds by construction; the tool↔route parity and coverage golden tests stay as a backstop. | The provider note's assumption that handlers call services directly; the MCP note's "tools bypass Nest route guards" threat is now closed by design. |
| **R2** | **Streaming.** A run is a BullMQ job with Postgres as the system of record. `POST` creates the turn/run; the browser follows `GET /ai/runs/:id/events` as fetch-streamed SSE with `Authorization: Bearer` and `Last-Event-ID`. The event vocabulary is a lazyit-owned, versioned zod union in `@lazyit/shared` — **not** the AI SDK UI protocol (§4.6). | The frontend note's POST-streamed turn (`POST …/turns` answering with a stream); its pure reducer is kept and consumes this stream. |
| **R3** | **UI effects.** Tool results carry semantic entity refs `{ type, id, op }` and a call kind `read \| mutation \| navigate`. The web v1 invalidates every active query outside the `["ai", …]` subtree after any executed mutation; entity refs drive "Open ‹entity›" chips; auto-navigation happens only for an explicit navigate tool and only when no unsaved-changes guard is active. **The web builds every href**; the API never sends one. | The tools note's per-type invalidator mapping and `alsoAffects`; the provider note's `ui.effect` event. |
| **R4** | **Tool descriptor.** One registry in `apps/api/src/ai/`. Names match `^[a-z][a-z0-9_]{0,39}$`. Fields at least: name, title, description, zod input schema (JSON Schema via zod v4, `io: "input"`), permission, class (`read` \| `write` \| `elevated` \| `navigate`), a server-resolved preview builder for writes, and UI effects. MCP annotations derive from the class. | The tools note's `R/W/D` classes, the security note's `T0–T4` (now mapped onto the four classes), the MCP note's `effect` enum and the provider note's `read\|write` effect and 64-char name rule. |
| **R5** | **Module layout.** `apps/api/src/ai/` (providers, runtime, tools core + per-domain files, settings, status, conversations/runs, prompt, retention); `apps/api/src/oauth/` (the authorization server, its own module); `apps/api/src/mcp/` (the resource server + skill/plugin distribution). One unified tree (§5). | The per-slice trees, including `ai/chat`, `ai/mcp`, `ai/headless` as stub channel modules inside `ai/`. |
| **R6** | **Audit.** `AiActionLog` is the **single** permanent, append-only AI mutation ledger. The provider note's write-class `AiToolCall` rows collapse into it; the per-call approval row is `AiToolInvocation` (retention-bound). MCP writes use the same writer with channel `MCP`. Additive nullable `aiInvocationId` on `asset_history` and `user_history`. | The provider note's `AiToolCall` as the approval unit **and** the ledger. |
| **R7** | **OAuth.** Scopes `lazyit.read`, `lazyit.write`, and `lazyit.admin` (only `elevated`-class tools; never preselected at consent; password step-up). Consent offers read-only. Opaque, hashed, audience-bound tokens; refresh rotation with reuse detection; DCR **and** CIMD; consent always shown; a password change or "sign out everywhere" revokes grants (a normal web logout does not — ADR-0097 decision 8, amended 2026-09-24). | The security note's colon-named scopes, its "do not ship DCR", its remembered consent; the MCP note's two-scope set. |
| **R8** | **Skill.** An authenticated zip download is always available; the public plugin-marketplace URL is served only when MCP is enabled on an HTTPS instance (Claude Code's `archive` source is HTTPS-only). | The frontend note's "marketplace later" and the MCP note's "anonymous marketplace everywhere". |
| **R9** | **Per-user surface.** `/account/ai` (install + connected apps + personal tokens) for holders of `ai:connect`; Settings → AI for admins (provider wizard, MCP switch, retention, budgets, every user's grants). | The frontend note's `ai:use`-gated install panel. |
| **R10** | **SA tokens on `/mcp`** are accepted only if the SA holds `ai:connect`, fail-closed. Adopted by default (§8). | The security note's "`/mcp` rejects SA tokens". |

---

## 4. Reconciled contracts

The shapes below live in `packages/shared/src/schemas/` (wire) or `apps/api/src/ai/core/` (internal).
[[ai-assistant/tools-and-execution|Tools]] §16 has the full TypeScript sketch.

### 4.1 Tool descriptor and classes (R4)

A tool declares `name`, `title`, `description`, `domain`, `class`, `destructive`, `externalEffects`,
`idempotent`, `channels`, a zod `input`, `bindings` (the controller handlers it may call; `[0]` is
primary), `run`, and `preview` (mandatory for `write` and `elevated`). Its **`permission` is derived at
boot from the primary binding's `@RequirePermission`** and exposed on the manifest — never
hand-declared, so it cannot drift from the route. Boot validation fails loud on an unknown binding, a
`@Res`/upload handler, a non-allowlisted guard, an unrepresentable schema, a bad name, or a missing
preview; a coverage test forces a decision (bound or `unexposed`) for every controller handler.

| Class | Meaning (security tiers) | Chat | MCP scope needed | MCP annotations | Headless ceiling |
| --- | --- | --- | --- | --- | --- |
| `read` | T0 — reads | runs freely | `lazyit.read` | `readOnlyHint: true`, `openWorldHint: false` | allowed unless AI access is `off` |
| `write` | T1/T2 — ordinary and destructive writes (`destructive` flag, cascade warnings) | standard preview card | `lazyit.write` | `readOnlyHint: false`, `destructiveHint = destructive`, `idempotentHint = idempotent`, `openWorldHint = externalEffects` | `read-write` |
| `elevated` | T3/T4 — privilege, identity, credentials delivery, configuration, egress | elevated card: full diff, one action per approval, untrusted-source banner, no default focus, password step-up for privilege grants and credential delivery | `lazyit.admin` | as `write`, with `destructiveHint: true` | `read-write` (an SA cannot hold `user:manage` or `settings:manage` anyway) |
| `navigate` | chat-only navigation | runs freely; the web decides whether to navigate | never listed | — | never listed |

The class is a floor: a server-built preview may **escalate one invocation to `elevated`** (an edit to
another author's article, a move into a more visible folder). Excluded outright, on every channel: the
Secret Manager, cleartext-credential operations, the AI's own configuration, and any generic egress
(fetch, email compose, raw query).

> Amended 2026-09-24 ([[0097-ai-assistant-mcp-and-headless-api]] decision 3, #1315): the **workflow
> engine** is in the catalog. Reads, run retry/replay and manual tasks run on every channel
> (`workflows.tools.ts`, W2-13); authoring — workflows, versions, connections, connection test, dry-run,
> enable/disable — is `elevated` and **chat only** (`channels: ['CHAT']`, `workflow-authoring.tools.ts`,
> W2-14); MCP and headless authoring are deferred (#1344), and a Service Account never authors,
> connects or enables. Workflow secrets stay a structural exclusion. The step-up list gains **every
> write on a critical application** (`CRITICAL_APPLICATION`), and core derives step-up from the closed
> list on any write preview, `write` or `elevated`; MCP and headless refuse writes on critical
> applications (no step-up exists there).

### 4.2 Execution (R1)

`AiToolService` is the only façade channels use: `list(ctx)`, `invoke(name, input, ctx)`,
`propose(name, input, ctx)`, `approve(id, ctx, stepUp?)`, `reject(id, ctx, reason?)`. `invoke`
refuses a chat-channel write outside the approve path, so a loop bug cannot skip confirmation. Every
call re-checks, on top of the Nest pipeline: `ai:use` (chat, headless) or `ai:connect` (MCP), the
channel, the class **ceiling** (the MCP scope, or the SA's AI access setting), the per-run mutation
cap (headless), and a per-principal rate limit. Each dispatch runs inside an `AsyncLocalStorage`
`AiInvocationContext` so the asset and user history writers stamp `aiInvocationId`.

### 4.3 Tool result, entity refs and preview (R3)

- **Result:** `{ ok, kind: read | mutation | navigate, data | error, summary?, mutated, truncated?,
  entityRefs[] }`. Results are truncated once, at write time (~20 000 characters, with a
  `nextOffset`). Other-authored free text is wrapped in `<untrusted_content>` (defence in depth only).
- **Entity ref:** `{ type, id, op: created | updated | archived | restored | navigate, label?, slug?,
  parent? }`. Read-tolerant: unknown types are ignored.
- **Preview** (server-built, never model prose): `target`, `changes[] { field, before, after,
  valueKind }`, `warnings[]` (codes: `EXTERNAL_PROVISIONING`, `EXTERNAL_DEPROVISIONING`,
  `CASCADE_RELEASES_ASSIGNMENTS`, `CASCADE_REVOKES_GRANTS`, `ROLE_CHANGE`, `IDENTITY_CHANGE`,
  `PRIVILEGE_GRANT`, `CREDENTIAL_DELIVERY`, `LEDGER_APPEND`, `SOFT_DELETE`, `PUBLISHES_TO_READERS`, `VISIBILITY_CHANGE`, `NOTIFIES_USERS`,
  `IRREVERSIBLE`, `OUTBOUND_INTEGRATION`, `CRITICAL_APPLICATION` — the last two added 2026-09-24 for
  the workflow engine), `impacted[]`, `untrustedSources[]`, `elevated`, `stepUpRequired`, and a
  `precondition { entity, updatedAt }` checked at execute.
- **Pagination inside tools:** `limit` default 20, max 50, with `nextOffset`; the MCP layer adds a
  ~100 KB serialized backstop.

### 4.4 Runs, approvals and status sets

- **Run** (`AiRun.status`): `QUEUED → RUNNING → AWAITING_APPROVAL → … → SUCCEEDED | FAILED |
  CANCELLED | EXPIRED`; `approvalPolicy` = `REQUIRE_APPROVAL_FOR_WRITES` (humans) or `AUTONOMOUS`
  (Service Accounts). One active run per conversation (409 `RUN_IN_PROGRESS`); a job carries only
  `{ runId }` and is never retried blindly; a sweeper re-enqueues lost resumes and finalizes stale runs
  ([[ai-assistant/provider-and-runtime|provider]] §8).
- **Tool invocation** (`AiToolInvocation.status`): reads and autonomous writes `EXECUTING →
  SUCCEEDED | FAILED | DENIED`; interactive writes `AWAITING_APPROVAL → REJECTED | EXPIRED |
  CANCELLED`, or the atomic approve claim `AWAITING_APPROVAL → EXECUTING → SUCCEEDED | FAILED |
  OUTCOME_UNKNOWN`. A precondition mismatch fails with code `STALE`; `OUTCOME_UNKNOWN` is never
  retried.
- **Ledger** (`AiActionLog.event`): `PROPOSED`, `APPROVED`, `REJECTED`, `EXPIRED`, `CANCELLED`,
  `ATTEMPTED`, `EXECUTED`, `FAILED`, `DENIED`. MCP and headless write `ATTEMPTED` → outcome.
- **Approval:** only the run's own human, from a human session, carrying only the pending-action id
  (plus the password for step-up). Expiry 30 minutes by default (§8). Every tool call is answered —
  expiry, cancel and "AI disabled" append synthetic error results.

### 4.5 Status

`GET /ai/status` (any authenticated principal) → `{ chat: { available }, mcp: { available, auth:
"oauth" | "personal-token" }, configRevision, retentionDays }`. `chat.available` = enabled ∧ provider
configured ∧ `ai:use`; `mcp.available` = MCP switch ∧ `ai:connect`. No secrets, no provider
credentials. The web shell gates the launcher on it and fails closed (404 on an older API = off).

### 4.6 The run event stream (R2)

`GET /ai/runs/:id/events` — `text/event-stream`, `id: <runId>:<seq>`, heartbeats every 15 s,
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. Closes after a terminal status or
after `AWAITING_APPROVAL`; the client re-subscribes after deciding (short connections suit HTTP/1.1
`lan`). Replays from an in-process ring buffer, or sends `run.snapshot` from Postgres. Versioned union
(`v: 1`):

| Event | Payload |
| --- | --- |
| `run.snapshot` | persisted state: messages since `seq`, pending approvals with previews, run status |
| `run.status` | `{ status }` |
| `message.delta` / `message.completed` | `{ messageId, text }` / `{ messageId }` |
| `tool.call` | `{ toolCallId, name, kind, class, status, args? }` (`args` = flat, redacted summary) |
| `tool.approval_required` | `{ toolCallId, preview, elevated, stepUpRequired, untrustedSources, expiresAt }` |
| `tool.approval_resolved` | `{ toolCallId, decision: approved \| rejected \| expired \| cancelled }` |
| `tool.result` | `{ toolCallId, kind, status, summary?, mutated, entityRefs[], error?, requestId? }` |
| `step.finished` | `{ stepIndex, usage }` |
| `run.finished` | `{ status, finishReason, usage, error?: { code, message, retryAfterSec?, requestId? } }` |

Run error codes: `AI_DISABLED`, `FORBIDDEN`, `PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`,
`PROVIDER_UNAVAILABLE`, `PROVIDER_BAD_REQUEST`, `PROVIDER_REFUSED`, `EGRESS_DENIED`, `BUDGET_EXCEEDED`,
`CONTEXT_LIMIT`, `MAX_STEPS`, `CANCELLED`, `ENGINE_RESTART`, `RUN_IN_PROGRESS`,
`CONVERSATION_READ_ONLY`, `STEP_UP_REQUIRED`. Tool-level codes are the tools note's `AI_ERROR_CODES`.

### 4.7 HTTP surface

API paths are shown as the API sees them; the browser reaches them under `/api/*` (Caddy strips the
prefix). The rows marked **public path** are routed by Caddy to the API without a prefix.

| Surface | Endpoints | Gate |
| --- | --- | --- |
| AI configuration | `GET`/`PUT /config/ai`, `POST /config/ai/test`, `POST /config/ai/models` | `settings:manage` + `ServicePrincipalForbiddenGuard` |
| Per-SA AI access | `GET`/`PUT /config/ai/service-accounts/:id` → `{ access, maxMutationsPerRun }` | same |
| Status | `GET /ai/status` | any authenticated principal |
| Conversations (chat) | `POST`/`GET /ai/conversations`, `GET`/`DELETE /ai/conversations/:id`, `POST /ai/conversations/:id/messages` → `202 { runId }` | `ai:use`, owner only |
| Runs (chat + headless) | `POST /ai/runs { prompt, conversationId? }` (+ `Idempotency-Key`), `GET /ai/runs/:id`, `POST /ai/runs/:id/cancel`, `GET /ai/runs/:id/events` | `ai:use`, owner only |
| Approval decision | `POST /ai/runs/:id/tool-calls/:toolCallId/decision { decision, reason?, password? }` | `ai:use`, human session, the run's owner |
| MCP resource | `/mcp` — **public path** | Bearer `lzit_oat_` (HTTPS), `lzit_pat_` (`lan`), `lzit_sa_` (SA holding `ai:connect`); MCP switch; `ai:connect` |
| OAuth metadata | `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server` — **public path** | none; 404 when MCP is off or on `lan` |
| OAuth protocol | `/oauth/token`, `/oauth/register`, `/oauth/revoke` — **public path** | public client; rate-limited; 404 when MCP is off or on `lan` |
| Consent | web page `/oauth/authorize` ((auth) group) → API `POST /oauth/authorize/validate`, `POST /oauth/authorize/decision` | web session (Bearer) + `ai:connect` |
| Connected apps | `GET /oauth/grants/mine`, `DELETE /oauth/grants/:id`; admin `GET /oauth/grants?userId=`; `POST`/`GET /oauth/personal-tokens`, `DELETE /oauth/personal-tokens/:id` (mint on `lan` only) | `ai:connect` (own) / `settings:manage` (all) |
| Skill / plugin | `GET /ai/claude-code/plugin.zip` (authenticated); `GET /ai/claude-code/marketplace.json` + `…/lazyit-plugin.zip` (public, HTTPS + MCP on only) | `ai:connect` / none |

> **As built (W3-1, #1315)** — the conversations, runs, event stream, decision and per-SA rows above:
> [[ai-assistant/provider-and-runtime|provider]] §9.1 and §9.3 *As built (W3-1)*. In short: every route
> is owner-only with a 404 for anyone else (admins included); the channel follows the principal (a human's
> `POST /ai/runs` is `CHAT`, a Service Account's `HEADLESS`); `/ai/conversations` is human-only (a Service
> Account gets 403 and uses `POST /ai/runs`); `DELETE /ai/conversations/:id` answers 204 through W3-6's
> purge service (404 non-owner, 409 `RUN_IN_PROGRESS`); the decision answers `{ runId, status }` and its `STEP_UP_*` 403s
> (`REQUIRED`, `FAILED`, `UNAVAILABLE`) are about the password, **never a logout signal for the web**; 429
> `STEP_UP_RATE_LIMITED` carries `retryAfterSec`; per-SA changes are audited in `ai_config_audit_log`
> (`service_account.ai_access.updated`).

### 4.8 OAuth and MCP tokens (R7)

- **Authorization server:** hand-written in `apps/api/src/oauth/`, on the existing web session; code +
  PKCE S256 (plain refused, downgrade blocked), exact redirect matching (loopback port-agnostic only),
  RFC 8707 `resource`, RFC 9207 `iss`, RFC 7009 revocation, RFC 8414 and RFC 9728 metadata; public
  clients only; the issuer is **pinned configuration** and requires a pinned HTTPS origin. DCR ships
  with CIMD (fetched through the egress guard, with a bundled offline copy of Claude Code's document).
- **Tokens:** opaque, 256-bit, SHA-256-hashed, prefixed `lzit_oat_` (access, 1 h), `lzit_ort_` (refresh,
  30 days from last use, rotated on every use; reuse outside a 30 s grace window revokes the grant),
  `lzit_pat_` (personal, `lan` only, 90 days by default, 365 max, mandatory expiry). Codes are
  single-use and live 60 s. Accepted **only** on `/mcp`; session JWTs are never accepted there.
- **Every `/mcp` request:** token → grant (live, unexpired) → user re-loaded (active, not
  `directoryOnly`, not `mustChangePassword`, `mcpCredentialEpoch` equal to the grant's snapshot) → MCP switch
  → `ai:connect` now → resource matches. Authority = the user's current permissions ∩ the scope class.
- **Revocation:** user or admin revoke, refresh reuse, the revocation endpoint, and any
  `mcpCredentialEpoch` bump (password change or reset, admin reset or *revoke sessions*, deactivation,
  offboarding). A normal web logout bumps only `sessionEpoch` and does **not** revoke MCP credentials
  (ADR-0097 decision 8, amended 2026-09-24 — CEO: "Separarlos").
- **Client allowlist** ([[0097-ai-assistant-mcp-and-headless-api|ADR-0097]] decision 13): every OAuth
  client is checked against an admin-configurable allowlist, matched on its CIMD `client_id` URL or a
  redirect-URI pattern, **never on `client_name`**. The curated defaults (the usual clients) live in code
  and ship with W2-4/W3-3; `ai_settings` stores only an **overlay** on them —
  `mcpClientAllowlistAdded` (the admin's own entries) and `mcpClientAllowlistRemovedDefaults` (the ids of
  the defaults the admin removed) — so a later release can correct a default's identifier without
  undoing the admin's choices. An entry is `{ id, label, match: { kind: "cimd_url", url } | { kind:
  "redirect_uri", pattern } }` (`ai-settings.ts`). The policy toggle `mcpAllowAnyHttpsClient` (off by
  default) accepts any client whose redirect URIs are HTTPS and non-loopback, and the consent screen then
  shows a warning; the default policy is the curated list.
- **Redirect schemes** (ADR-0097 decision 13, amended 2026-09-23 — CEO: "Permitir solo en la
  allowlist"): a `redirect_uri` pattern is an exact URI that is HTTPS, loopback `http`
  (`127.0.0.1` / `localhost` / `[::1]`, port-agnostic), or a **private-use native-app scheme**
  (RFC 8252 §7.1) — reverse-domain (`com.example.app:`) or a vetted editor scheme (`cursor`, `vscode`,
  `vscode-insiders`, `windsurf`, `MCP_VENDOR_REDIRECT_SCHEMES`). A private-use redirect is admitted
  **only by an explicit entry** (a curated default or an admin's); `mcpAllowAnyHttpsClient` never admits
  one. Plain `http` off loopback and the browser-interpreted schemes (SEC-051's
  `BROWSER_INTERPRETED_SCHEMES`: `javascript`, `data`, `file`, `blob`, …) are always refused, and so is
  any redirect URI with userinfo (`user@host`) — the host is read from the parsed authority, so
  `http://localhost:80@evil.com/` is never loopback (PR #1338 review F2). The pure
  helper `isMcpRedirectUriAllowed` in `ai-settings.ts` states the rule for the authorization server.

### 4.9 Skill distribution (R8)

A Claude Code plugin rendered per request from in-repo templates, the **live tool registry** and
`LAZYIT_DOMAIN_PRIMER`: `.claude-plugin/plugin.json`, `.mcp.json` pointing at `<origin>/mcp`,
`skills/lazyit/SKILL.md` + `reference/domain.md` + a generated `reference/tools.md`. The authenticated
download is always available while MCP is enabled — on `lan` it declares `userConfig.token` for the
personal token. On an HTTPS instance with MCP enabled, a public `marketplace.json` (no `version`; the
archive's `sha256` is the update signal) enables `claude plugin marketplace add … && claude plugin
install lazyit@lazyit-<host>` and auto-update (once the user enables it for the marketplace). The MCP server's `instructions` carry the same primer.
As built (W3-5): the public archive omits the generated tool index, which ships only in the
authenticated download — [[ai-assistant/mcp-and-oauth|MCP]] §13 records what is public and why.

### 4.10 Surfaces in the web (R9)

- **Navbar chat:** a non-modal side panel mounted in the `(app)` layout (docked at `xl`, overlay at
  `md`–`xl`, sheet below `md`), toggled by `⌘J`/`Ctrl+J`, rendering only through `MarkdownView`'s chat
  variant (no images, no mermaid, external links not auto-linked).
- **Settings → AI** (`settings:manage`): the provider wizard (provider → credentials → model → test →
  egress disclosure → enable → hard reload), the editor, the MCP switch, retention and budgets, every
  user's connected apps, and the list of SAs holding `ai:use`. The per-SA AI access control lives on
  each Service Account's page.
- **`/account/ai`** (`ai:connect`): install instructions, the user's connected apps, and personal
  tokens on `lan`. Linked from the user menu.
- **Consent page** `/oauth/authorize` in the `(auth)` group: client name with a verified-domain or
  self-declared badge, the redirect host (with a loopback warning), "acting as you", Read only / Read &
  write (preselected) / Admin actions (never preselected, password).

---

## 5. Unified directory tree

New files unless marked `(edit)`. Ownership by wave unit is in §10.

```
packages/shared/src/
├── index.ts                                   (edit) barrel — W1-A only
└── schemas/
    ├── permission.ts                          (edit) `ai` domain: ai:use, ai:connect
    ├── permission-meta.ts                     (edit)
    ├── ai-provider.ts                         provider kinds + descriptors (drive the wizard)
    ├── ai-settings.ts                         AiSettings wire, status (§4.5), per-SA AI access
    ├── ai-tools.ts                            classes, call kinds, entity refs, tool result, preview, error codes
    ├── ai-run.ts                              conversation/run/message/approval wire + the event union (§4.6)
    └── oauth.ts                               scopes, grants, personal tokens, consent validate/decision

apps/api/
├── package.json                               (edit) ai, @ai-sdk/*, @modelcontextprotocol/*; Jest lookahead — W1-B
├── test/jest-e2e.json                         (edit) Jest lookahead — W1-B
├── prisma/schema.prisma                       (edit) — W1-A only
├── prisma/migrations/<ts>_add_ai_assistant_and_oauth/      one DDL migration (§6) — W1-A
└── src/
    ├── app.module.ts                          (edit) registers AiModule, OAuthModule, McpModule — W1-C only
    ├── auth/
    │   ├── delegated-identity.ts              the module-private symbol + type
    │   ├── principal-loader.service.ts        DB-first principal re-load (guard branch + runtime)
    │   ├── service-account-authenticator.ts   SA bearer verification, extracted (R10)
    │   ├── jwt-auth.guard.ts                  (edit) delegated-identity branch; uses the two above
    │   └── auth.module.ts                     (edit) providers
    ├── asset-history/asset-history.service.ts (edit) stamp aiInvocationId from the ALS context
    ├── user-history/user-history.service.ts   (edit) same
    ├── common/crypto/envelope-cipher.ts       generic AES-256-GCM envelope keyed by an env var name
    ├── ai/
    │   ├── ai.module.ts                       imports every submodule below (stubs created in W1-C)
    │   ├── ai.constants.ts                    queue/job names, limits, AI_PROMPT_VERSION
    │   ├── core/                              registry, dispatcher (C3 bridge), AiToolService,
    │   │   │                                  invocation-context (ALS), error-mapper, result-shaper,
    │   │   │                                  reference-resolver, action-log.service, boot validation
    │   │   └── ports/                         chat-model.port.ts, run-event-bus.port.ts, ai-settings.port.ts
    │   ├── tools/
    │   │   ├── index.ts                       imports every domain file (pre-wired once)
    │   │   ├── context.tools.ts               session_context, lazyit_search, navigate_to
    │   │   ├── platform.tools.ts              `unexposed` only: surfaces no domain owns (auth, config, secrets…)
    │   │   ├── assets.tools.ts · reference.tools.ts
    │   │   ├── access.tools.ts                applications, access grants, access requests
    │   │   ├── consumables.tools.ts · kb.tools.ts
    │   │   ├── users.tools.ts · activity.tools.ts
    │   │   └── infra.tools.ts                 read only in v1
    │   ├── providers/                         THE extension point — the only importer of `ai` / `@ai-sdk/*`
    │   │   ├── provider.types.ts · provider.registry.ts · aisdk-chat-model.ts · provider-fetch.ts
    │   │   └── anthropic/ · openai/ · google/ · openai-compatible/      one definition + spec each
    │   ├── runtime/                           agent-loop, orchestrator, worker (@Processor 'ai-run'),
    │   │                                      sweeper, approval.service, limits, in-process run-event-bus
    │   ├── prompt/                            primer.ts (LAZYIT_DOMAIN_PRIMER), system-prompt.ts
    │   ├── settings/                          /config/ai controller + service, connection tester, config audit
    │   ├── status/                            GET /ai/status
    │   ├── conversations/                     /ai/conversations
    │   ├── runs/                              /ai/runs, the SSE events controller, the decision endpoint
    │   ├── headless/                          per-SA AI access service + /config/ai/service-accounts/:id
    │   └── retention/                         the retention sweeper
    ├── oauth/
    │   ├── oauth.module.ts                    (stub in W1-C)
    │   ├── metadata.controller.ts             RFC 8414 + RFC 9728
    │   ├── authorize.controller.ts            validate + decision (Bearer)
    │   ├── token.controller.ts · register.controller.ts · revoke.controller.ts
    │   ├── grants.controller.ts               mine + admin
    │   ├── oauth-token.service.ts · oauth-audit.service.ts · oauth.sweeper.ts
    │   ├── cimd/                              fetcher (egress guard), cache, known-clients/claude-code.json
    │   └── personal-tokens/                   lan-only personal tokens
    └── mcp/
        ├── mcp.module.ts                      (stub in W1-C)
        ├── mcp.controller.ts                  @All('mcp') → createMcpHandler (SDK v2, stateless)
        ├── mcp-auth.guard.ts                  oat / pat / sa verification, RFC 6750/9728 challenge
        ├── mcp-server.factory.ts · annotations.ts · error-mapper.ts · mcp-rate-limit.ts · mcp-caller.ts
        ├── mcp-connection-notice.service.ts    the first-use "new AI agent connected" notice (as built)
        ├── mcp-invocation.sweeper.ts          interrupted MCP writes → OUTCOME_UNKNOWN (as built)
        └── distribution/                      plugin templates, marketplace + archive, authenticated download

apps/web/
├── app/(app)/layout.tsx                       (edit) AiAssistantRoot wrap, launcher, panel slot — W1-D only
├── app/(app)/settings/ai/**                   wizard + editor
├── app/(app)/settings/page.tsx                (edit) the "AI" hub card
├── app/(app)/settings/service-accounts/**     (edit) per-SA AI access control
├── app/(app)/account/ai/**                    install panel, connected apps, personal tokens, _lib/mcp-snippets.ts
├── app/(auth)/oauth/authorize/**              the consent page
├── components/ai/**                           root, launcher, panel slot (W1-D); panel, messages, cards (chat)
├── components/ui/radio-group.tsx              vendored (radix-ui already present; no new dependency)
├── components/user-menu.tsx                   (edit) "AI & connected apps"
├── lib/ai/**                                  sse-parser, stream-reducer, effects, entity-href, route-context,
│                                              unsaved-changes, error-kinds, history-groups (all bun-tested)
├── lib/api/client.ts                          (edit) apiFetchStream
├── lib/api/endpoints/ai.ts · ai-config.ts · oauth.ts
├── lib/api/hooks/use-ai-status.ts · use-ai-conversations.ts · use-ai-turn.ts · use-ai-config.ts · use-oauth-grants.ts
├── lib/hooks/use-before-unload-guard.ts       (edit) feeds the unsaved-changes registry
├── proxy.ts                                   (edit) keep the query string in callbackUrl
├── messages/{en,es}/_all.ts                   (edit) register ai, aiSettings, oauth — W1-D
├── messages/{en,es}/ai.json · aiSettings.json · oauth.json
├── messages/{en,es}/settings.json · shared.json · help.json     (edit)
└── content/manual/
    ├── _nav.ts                                (edit) the `ai-assistant` category — W1-D only
    └── {en,es}/ai-assistant-*.md              the new Manual pages

infra/  caddy/Caddyfile · test/caddy-routing.sh · env/.env.prod.example · start.sh   (edit) — W0-5
```

---

## 6. Consolidated data model

**One DDL migration** creates every table below and the two columns. There is **no data migration**
for the MEMBER default rows of `ai:use` and `ai:connect`: #1314's seed-once ledger grants a permission
new to `DEFAULT_ROLE_PERMISSIONS` exactly once on the next deploy's seed, and a revoke stays revoked.
Status, channel,
class and provider columns are **text validated on write** (zod), not Prisma enums, so a value added by
a newer build degrades gracefully on an older one. IDs follow [[0005-id-strategy]]; integers are
bounded per [[0036-int4-bounded-integers]].

| Table (model) | Kind · ID | Holds | Lifecycle | Source |
| --- | --- | --- | --- | --- |
| `ai_settings` (`AiSettings`) | singleton, CHECK `id = 'singleton'` | enabled, provider, model, baseUrl, the key envelope (`apiKeyCiphertext`/`Iv`/`AuthTag`/`KeyVersion`), `allowPrivateNetwork`, effort, provider options, admin instructions, step/output/context limits, `dailyTokenLimitPerPrincipal` (2M), `retentionDays` (90, 7–3650), `approvalTtlMinutes` (30), `mcpEnabled`, the MCP client allowlist overlay (`mcpClientAllowlistAdded` jsonb `[]`, `mcpClientAllowlistRemovedDefaults` text[] `{}`) and `mcpAllowAnyHttpsClient` (false) — §4.8, the disclosure acknowledgement, `verifiedAt` | mutable config, no `deletedAt`; an absent row reads as the disabled default | provider §7 |
| `ai_conversations` (`AiConversation`) | `cuid()` | owner (exactly one of user / SA — CHECK), channel (`CHAT` \| `HEADLESS`), title, pinned provider/model/`promptVersion`/`toolsetHash`/tool names, `closedReason`, `lastActivityAt` | transcript container; **hard-deleted** by retention, by its owner, and on offboarding | provider §7, tools §11 |
| `ai_messages` (`AiMessage`) | `BigInt` autoincrement | ordered, provider-replayable messages (`content` + `format`), `@@unique(conversationId, seq)` | append-only; cascades with its conversation | provider §7 |
| `ai_runs` (`AiRun`) | `cuid()` | channel, acting principal (CHECK), status, approval policy, provider/model, step count, token counts, finish reason, redacted error, `idempotencyKey` (partial unique per principal, raw SQL), cancel request, timestamps | mutable lifecycle row, **no content**; conversation FK `SetNull`; kept | provider §7 |
| `ai_tool_invocations` (`AiToolInvocation`) | `cuid()` = `invocationId` | every tool call on every channel: tool, class, actor (at most one — CHECK), MCP client/grant, input + hashes, status, preview, precondition, expiry, result, entity refs, error, duration | the approval unit; **retention-bound** (cascades with its conversation; conversation-less MCP rows pruned after `retentionDays`) — this is also the metadata access log for MCP and headless reads | tools §11 |
| `ai_action_log` (`AiActionLog`) | `Int` autoincrement | one row per write lifecycle event: invocation id, event, channel, tool, class, actor (at most one — CHECK), conversation/run/MCP client/grant ids as plain strings, redacted input, entity refs, approver, step-up flag, untrusted sources, provider/model, request id, error | **permanent, append-only**; a trigger blocks `DELETE` and every `UPDATE` except the one the actor FKs' own `ON DELETE SET NULL` performs (only `userId` / `serviceAccountId` may become NULL, nothing else may change); no FK to pruned rows; actor FKs `SetNull` | tools §10–11, security §6.7 |
| `ai_usage` (`AiUsage`) | `BigInt` autoincrement | per model step: principal, provider, model, input/output/cached/reasoning tokens | append-only; kept (budgets and the usage view) | provider §7 |
| `ai_service_account_settings` (`AiServiceAccountSettings`) | PK = `serviceAccountId` | `access` (`off` \| `read-only` \| `read-write`), `maxMutationsPerRun` | mutable config; an absent row reads as `read-write` | §2 decision 13 (editorial, §8.2) |
| `ai_config_audit_log` (`AiConfigAuditLog`) | `Int` autoincrement | who changed AI settings or a per-SA setting, what (redacted), the disclosure acknowledgement | append-only | security §6.4–6.5 (editorial, §8.2) |
| `oauth_clients` (`OAuthClient`) | `cuid()` | DCR / CIMD / known clients, redirect URIs, sanitized metadata | mutable; unused DCR clients without grants hard-deleted after 24 h | MCP §6 |
| `oauth_grants` (`OAuthGrant`) | `cuid()` | one user's delegation to one client, or a personal token: kind, scopes, resource, `mcpCredentialEpoch` snapshot (and an informational `sessionEpoch` one), expiry, revoke reason | **soft delete = revoked** (joins `SOFT_DELETABLE_MODELS`) | MCP §6 |
| `oauth_authorization_codes` (`OAuthAuthorizationCode`) | `cuid()` | code hash, PKCE challenge, redirect, scopes, resource, expiry, use | credential material — hard-deleted by the sweeper (`PasswordResetToken` precedent) | MCP §6 |
| `oauth_tokens` (`OAuthToken`) | `cuid()` | access / refresh / personal token hashes, expiry, rotation use | credential material — hard-deleted on expiry or revocation | MCP §6 |
| `oauth_audit_log` (`OAuthAuditLog`) | `Int` autoincrement | client registered, grant created, consent denied, grant revoked, refresh reuse, personal token created/revoked | append-only; ADR-0081 source `oauth` | MCP §6 |
| `asset_history`, `user_history` | existing | **`aiInvocationId String?`** — `ADD COLUMN … NULL`, no default, no FK, no index | metadata-only in PostgreSQL; the `recent_activity` view selects explicit columns and is unaffected | tools §10 |

**Upgrade safety.** Every change is additive: new tables and two nullable columns. A populated database
gets empty tables; nothing is backfilled. With no `ai_settings` row and no `AI_SECRET_KEY`, the API
boots and behaves exactly as before. `ai:use` and `ai:connect` reach ADMIN through the resolver's
full-catalog short-circuit and MEMBER through the seed-once ledger on the next deploy (#1314); because
the capability is off at instance level, granting them exposes nothing until an admin enables it. The
retention sweeper's hard deletion of transcripts is a deliberate, ADR-recorded exception to "never
hard-delete": conversations are not the system of record ([[0056-in-app-notification-bell]] §7
precedent); the ledgers are never pruned. Downgrading leaves inert tables.

---

## 7. Invariants (proposed)

The security note's INV-AI-n, merged with the MCP note's INV-MCP-n. They join
[[INVARIANTS]] **only when ADR-0097 is accepted** (wave 4).

- **INV-AI-1 — One real principal, exactly its authority** *(absorbs INV-MCP-2)*. The AI acts as the
  invoking human (chat, MCP) or Service Account (headless), never as a synthetic, system or engine
  identity. Authority = the principal's DB-first permissions ∩ the granted scope (MCP) ∩ the SA's AI
  access setting (headless), re-evaluated on every tool call together with `ai:use` / `ai:connect` and
  the instance switches.
- **INV-AI-2 — Route-equivalent execution, fail-closed catalog.** Every tool executes through the same
  guards, pipes and service-level checks as its HTTP route (R1, by construction). A tool without a
  resolvable permission is not exposed. Golden parity and coverage tests prove it.
- **INV-AI-3 — A chat mutation needs a bound, single-use human approval.** Bound to the server-stored
  pending action (principal, conversation, canonical arguments hash, target version); atomic,
  single-use, expiring; re-authorized and version-checked at execute. `elevated` actions are one per
  approval and need a password step-up for privilege grants and credential delivery. The model cannot
  approve; approval arguments never come from the client.
- **INV-AI-4 — Untrusted content is data, never authority.** No stored content can alter tool
  availability, approval requirements, tool metadata or the system prompt.
- **INV-AI-5 — Secrets never enter model context.** One-time credentials, the provider key, workflow,
  SMTP and directory secrets, and session/OAuth tokens are never in model context, conversation storage
  or provider requests. Secret Manager plaintext never reaches the AI (INV-10).
- **INV-AI-6 — Provider key custody.** Encrypted at rest under its own key axis (`AI_SECRET_KEY`),
  write-only, never logged, and bound to its destination: changing the provider or base URL clears it.
- **INV-AI-7 — Egress is guarded** *(absorbs INV-MCP-6)*. Provider and CIMD traffic go only through
  `common/egress` `guardedFetch`: scheme allowlisted, IP-pinned, no redirects for providers, size and
  time bounded. Private targets only through the explicit, audited `allowPrivateNetwork` seam for the
  OpenAI-compatible provider's own host; CIMD never. Loopback and IMDS never.
- **INV-AI-8 — Model output renders only through the sanitized KB pipeline.** No raw HTML, no external
  image loads, external links never auto-fetched.
- **INV-AI-9 — OAuth and MCP tokens are audience-bound and isolated** *(absorbs INV-MCP-1, -3, -4)*.
  Opaque, CSPRNG 256-bit, SHA-256-hashed, shown once, never logged, expiring, bound to the canonical
  `/mcp` resource and accepted nowhere else; `/mcp` accepts nothing else except personal tokens on `lan`
  and the tokens of SAs holding `ai:connect`. Codes are single-use, ≤ 60 s, PKCE-S256-bound; redirects
  match exactly (loopback port-agnostic only); refresh tokens rotate with reuse detection; `iss` is
  returned; the issuer is pinned. A grant dies with the user: soft delete, `isActive = false`,
  `directoryOnly`, an `mcpCredentialEpoch` bump (not a plain web logout), or `mustChangePassword`.
- **INV-AI-10 — Every AI-initiated mutation is permanently audited.** In `AiActionLog`, the single
  ledger for all channels (R6): append-only, blocked against `UPDATE`/`DELETE` at the database,
  attributed human XOR SA (INV-SA-4) with channel and approval provenance, independent of conversation
  retention.
- **INV-AI-11 — Consumption is bounded.** Step, tool-call, output, budget, concurrency and rate limits
  are enforced server-side, persisted where they must survive a restart, and fail closed.
- **INV-AI-12 — Off by default and gated by mode.** The chat is disabled until an admin enables it and
  acknowledges the egress disclosure; MCP has its own switch; every AI and OAuth route answers 404
  while its switch is off. Unavailable under `AUTH_MODE=shim`. The OAuth authorization server requires
  a pinned HTTPS origin; on `lan`, MCP authenticates with personal tokens only.
- **INV-AI-13 — No OIDC path** *(INV-MCP-5)*. The authorization server contains no OIDC/IdP code
  (#1310): no `id_token`, no userinfo, no `openid-configuration`.
- **INV-AI-14 — The catalog exclusions are structural** *(INV-MCP-7)*. No Secret Manager tool, no tool
  that returns a credential in cleartext, no tool over the AI's own configuration, and no generic egress
  tool exist on any channel; SA-ungrantable verbs stay ungrantable.

---

## 8. Defaults adopted — CEO to confirm on review

### 8.1 Adopted by default

Each is the analysts' recommendation, adopted so the design is complete; each can flip without
reshaping the rest.

1. **Model-call layer:** AI SDK 7 (`ai` + `@ai-sdk/*`) behind lazyit's `ChatModelPort`, as the
   normalization layer only — lazyit owns the loop. A go/no-go ESM/Jest spike (W1-B) gates it; the
   fallback is own adapters over the official dual-CJS SDKs behind the same port.
2. **MCP:** the official TypeScript SDK v2 (`@modelcontextprotocol/server` + `/node`), stateless
   `createMcpHandler`.
3. **Conversation privacy:** owner-only; admins see the write ledger and usage, not transcripts;
   conversations are purged on offboarding.
4. **Retention:** 90 days by default, configurable 7–3650, no "forever".
5. **Budget:** 2,000,000 tokens per principal per 24 h, admin-editable (`null` removes it).
6. **`AI_SECRET_KEY`:** optional, shipped **commented** in `.env.prod.example`, generated by `start.sh`
   on install and `--reconfigure` — a deliberate deviation from the SMTP precedent so guided updates do
   not stop for operators who never enable AI.
7. **Pinned conversations:** a conversation becomes read-only after a provider, model or prompt-version
   change.
8. **Context:** a hard per-conversation context cap; tool results truncated once, at write time.
9. **Private-network LLMs:** the OpenAI-compatible provider may target a private-network host through
   an admin `allowPrivateNetwork` toggle scoped to that host; loopback and IMDS never.
10. **v1 tool catalog:** the tools note's 44-tool cut.
11. **Default grants:** `ai:use` / `ai:connect` for MEMBER are applied by #1314's seed-once ledger on the
    next deploy — no data migration; an admin who revokes one keeps it revoked.
12. **SA tokens on `/mcp`** only when the SA holds `ai:connect`, fail-closed (R10).
13. **Headless per-SA setting placement** — the CTO's interpretation of "configurable in-app"
    (§2 decision 13).

### 8.2 Editorial reconciliations beyond R1–R10

Where two notes disagreed on something R1–R10 does not cover, the CTO chose as follows. Items marked ★
change behavior an operator would notice and are also listed in ADR-0097's to-confirm list.

- ★ **Token lifetimes:** access 1 h, refresh 30 days from last use with rotation, **no absolute cap in
  v1**, personal tokens 90 days (max 365). The security note asked for ≤ 15 min access tokens and an
  absolute 30-day cap; opaque tokens are checked DB-first on every request, so revocation is already
  immediate and a short lifetime buys little.
- ★ **Approval expiry:** 30 minutes, admin-editable (`approvalTtlMinutes`). The notes proposed 10 min
  (security), 30 min (tools) and 24 h (runtime); the target-version precondition closes the TOCTOU
  window regardless.
- ★ **`infra:report` SAs** cannot be given AI access (the fleet-wide agent token; security T-35).
- ★ **Turning AI off** keeps conversations and connected apps dormant; MCP tokens are refused while MCP
  is off and work again on re-enable.
- ★ **Page context:** the chat sends the current route and an entity ref (a visible, removable chip) —
  never page content or decrypted vault data.
- ★ **Key destination binding:** changing the provider or base URL clears the stored key (security
  INV-AI-6), refining the runtime note's "omit the key to keep it".
- **Token prefixes:** `lzit_oat_` / `lzit_ort_` / `lzit_pat_` (MCP note), not `lzit_mcp_at_…` (security
  note).
- **Consent flow:** the authorization endpoint **is** the web page `/oauth/authorize`, calling
  Bearer-authenticated `validate` and `decision` endpoints (MCP note), not an API endpoint that stores
  a pending request and redirects to `/oauth/consent?request=` (frontend note). The consent page stays
  in the `(auth)` group (frontend note).
- **Paths:** `/config/ai*` (mirrors `/config/smtp`), not `/ai/config`; `/mcp`, not `/api/mcp`;
  connected apps under `/oauth/grants*`, not `/me/ai-connections`.
- **Refresh-reuse revocation:** reuse of a rotated refresh token revokes the **grant** (MCP note); the
  security note's "family" is the same set of tokens.
- **Pagination inside tools:** `limit` 20 / max 50 with `nextOffset` (tools note), not a 25/100 opaque
  cursor (MCP note).
- **Data model shape:** text columns rather than Prisma enums; `AiRun` survives retention (runtime
  note) rather than cascading with its conversation (tools note); `AiMessage` stores the
  provider-replayable message with a `format` column rather than a neutral `{ v, blocks }` shape,
  because conversations are pinned to one provider and model.
- **Per-SA setting storage:** its own table `ai_service_account_settings`, so `service_accounts` gains
  no column.
- **AI configuration audit:** `ai_config_audit_log` records settings changes, per-SA changes and the
  disclosure acknowledgement — the security note required them audited without naming a store.
- **Concurrency:** at most 3 active runs per principal (runtime note), not 2 (security note).
- **Guard edits in one place:** the `ServiceAccountAuthenticator` extraction (R10) lands with the
  delegated-identity branch in the AI-core unit, so `jwt-auth.guard.ts` changes in one reviewed PR.
- **Prompt location:** the primer and system-prompt builder live in `ai/prompt/` (tools note), shared by
  the runtime, the MCP `instructions` and the skill.
- **Ports first:** `ChatModelPort`, `RunEventBus` and the settings reader are declared in
  `ai/core/ports/` by the core unit, so the provider, runtime and settings units run in parallel.
- **`compose.yaml` untouched:** the optional `extra_hosts: host.docker.internal` for an Ollama on the
  Docker host is documented as an operator option, not shipped.
- **Headless narrowing:** a per-request `allowedTools` or `dryRun` is not built; the per-SA setting
  covers the need.

---

## 9. Prerequisites and what is deliberately NOT built

### 9.1 Prerequisites

- **#1314** — the seed re-grants revoked default permissions on every deploy. Without the fix an admin
  cannot durably withdraw `ai:use` or `ai:connect`. Its seed-once ledger also delivers their MEMBER
  defaults, so no data migration is needed (merged, PR #1325).
- **SEC-021** — last-admin lockout via `isActive`. Before the user-management tools.
- **SEC-051** — `javascript:` URL bypass on `Application.url`. Before the application write tools.
- **SEC-072 / SEC-032** — deeply nested `specs`. Closed first, or a nesting cap in tool argument
  validation (the core unit carries the cap if they are still open).
- **Infrastructure:** Caddy routes `/mcp`, `/.well-known/oauth-*`, `/oauth/token`, `/oauth/register`
  and `/oauth/revoke` to the API (no prefix strip; `/oauth/authorize` stays on web) and passes
  `text/event-stream` unbuffered and uncompressed — verified against the pinned image (the
  `encode`+SSE fix is Caddy PR #7905).

### 9.2 Not built (v1)

- Click-level UI driving; a full-page assistant route; approve-all; approve-with-edits; message edit,
  regenerate or branching; attachments, images or voice.
- Summarization/compaction; streamed reasoning; embeddings/RAG; provider fallback chains; per-user or
  BYO keys; a model per channel; currency cost accounting; webhooks on headless completion.
- A Valkey Streams event bus or a dedicated worker container (both wait for the ADR-0053 worker split);
  OpenTelemetry.
- Server-side confirmation over MCP (elicitation); MCP resources, prompts, subscriptions, toolsets,
  Tasks; the Skills-over-MCP extension (Claude Code does not support it yet).
- Any OIDC surface; confidential clients, `client_credentials`, PAR/JAR, DPoP, introspection; remembered
  consent; OAuth over plain HTTP.
- lazyit as an MCP **client**; generic "call any endpoint" or OpenAPI-derived tools; file upload or
  download tools.
- A "via AI" badge in the activity feed; stamping ledgers beyond asset and user history; a hash-chained
  audit.
- Admins reading other people's conversations.
- Workflow authoring over MCP or headless (chat only in v1; deferred, #1344); any tool over workflow
  secrets (structural exclusion).

---

## 10. Unified implementation plan in waves

**Rules.** Units are disjoint by file ownership. Every shared critical file in `.claude/charter.md` is
touched by **exactly one** unit per wave: the barrel (W1-A), root `bun.lock` (W1-B), `app.module.ts`
(W1-C), `(app)/layout.tsx` and `manual/_nav.ts` (W1-D), `docs/03-decisions/_MOC.md` (this design unit
now, W4-4 on acceptance); `sidebar-nav.tsx`, root `package.json` and `compose.yaml` are not touched.
`schema.prisma` is not charter-critical but is contended, so only W1-A touches it — later units must not
need a schema change (a unit that does stops and escalates). **CEO merge** marks every PR touching
authentication, authorization, privilege, deletes or migrations (charter merge authority); the others
may merge under the CTO's standing authorization on green CI after their security gate. Gates G1–G4 are
[[ai-assistant/security|security]] §12. Nothing starts before ADR-0097 is accepted.

### Wave 0 — prerequisites (parallel)

| Unit | Lane | Owns | Depends on | Shared critical | Merge |
| --- | --- | --- | --- | --- | --- |
| **W0-1** Seed fix (#1314) | backend | `apps/api/prisma/seed.ts`, its golden spec | — | — | **CEO** (authorization defaults) |
| **W0-2** SEC-021 | backend (remediator) | the files the finding names (`apps/api/src/users/**`) | — | — | **CEO** (last-admin guard) |
| **W0-3** SEC-051 | backend (remediator) | the files the finding names (the `Application.url` scheme guard) | — | — | standing |
| **W0-4** SEC-072 / SEC-032 (optional) | backend (remediator) | the files the findings name | — | — | standing |
| **W0-5** Infrastructure | infrastructure (+ docs, authorized) | `infra/caddy/Caddyfile`, `infra/test/caddy-routing.sh` (routes + SSE streaming check), `infra/env/.env.prod.example` (commented `AI_SECRET_KEY`, `AI_WORKER_CONCURRENCY`), `infra/start.sh` (generate the key), `docs/05-runbooks/**` (backups, TLS/internal CA + `NODE_EXTRA_CA_CERTS`, MCP section), `docs/01-architecture/deployment.md` | — (routes answer 404 until the API ships) | — | **CEO** (new public routes) |

### Wave 1 — serial foundation

Order: W1-A → W1-B → W1-C; W1-D runs in parallel with W1-B and W1-C once W1-A has merged.

| Unit | Lane | Owns | Depends on | Shared critical | Merge |
| --- | --- | --- | --- | --- | --- |
| **W1-A** Contracts + schema | backend (+ web permission labels, authorized) | `packages/shared/src/schemas/{permission,permission-meta,ai-provider,ai-settings,ai-tools,ai-run,oauth}.ts` + tests, `packages/shared/src/index.ts`; `apps/api/prisma/schema.prisma`; the DDL migration (all §6 tables, the two columns, CHECKs, partial uniques, the ledger trigger); no default-grant migration (the #1314 seed-once ledger applies the MEMBER defaults); the permission golden specs; `apps/web/app/(app)/settings/_lib/permission-labels.ts` + `messages/{en,es}/settings.json` `permissionMeta` (so web `tsc` stays green) | W0-1 | **barrel** | **CEO** (catalog + migrations) |
| **W1-B** Dependencies + spike | backend | `apps/api/package.json` (`ai`, `@ai-sdk/anthropic`, `/openai`, `/google`, `/openai-compatible`, `@modelcontextprotocol/server`, `/node`; the Jest `transformIgnorePatterns` lookahead), `apps/api/test/jest-e2e.json`, root `bun.lock`, the spike specs. **Go/no-go:** Jest loads the SDK's mocks; the Nest build loads `ai` via `require(esm)` on Node 26; tools without `execute` + one step return tool calls; reasoning replay round-trips through persisted messages; `guardedFetch` works as the SDK `fetch`; the MCP SDK loads under CommonJS Jest | W1-A | **`bun.lock`** | standing; the verdict is reported to the CEO |
| **W1-C** AI core | backend | `apps/api/src/ai/ai.module.ts`, `ai.constants.ts`, `ai/core/**` (incl. `ports/`), `ai/tools/index.ts` + every pre-created `ai/tools/*.tools.ts` (the reference toolset `session_context`, `lazyit_search` filled), stub module files for every `ai/*` submodule, `oauth/oauth.module.ts` and `mcp/mcp.module.ts` stubs; `auth/delegated-identity.ts`, `auth/principal-loader.service.ts`, `auth/service-account-authenticator.ts`, `auth/jwt-auth.guard.ts`, `auth/auth.module.ts`; the ALS stamp in `asset-history.service.ts` and `user-history.service.ts`; tests: network-unreachability of the branch, DB-reload parity, boot validation, coverage, tool↔route parity golden; the nesting cap if W0-4 did not land; the single `app.module.ts` edit | W1-A (W1-B not required) | **`app.module.ts`** | **CEO** (authentication). Gate G2 (partial) |
| **W1-D** Web shell foundation | frontend (+ Manual manifest, authorized) | the `app/(app)/layout.tsx` edit; `components/ai/{ai-assistant-root,ai-chat-launcher,ai-chat-panel-slot}.tsx`; `lib/api/client.ts` (`apiFetchStream`); `lib/api/endpoints/ai.ts` (status only) + `lib/api/hooks/use-ai-status.ts`; `messages/{en,es}/_all.ts` + skeleton `ai.json`, `aiSettings.json`, `oauth.json`; `content/manual/_nav.ts` + `messages/{en,es}/help.json` labels | W1-A | **`layout.tsx`, `_nav.ts`** | standing (renders nothing until `/ai/status` exists) |

### Wave 2 — backend building blocks (parallel)

| Unit | Lane | Owns | Depends on | Merge |
| --- | --- | --- | --- | --- |
| **W2-1** Provider layer | backend | `apps/api/src/ai/providers/**` | W1-B (go), W1-C | standing; **G1** |
| **W2-2** Settings, status, crypto | backend | `apps/api/src/common/crypto/envelope-cipher.ts`, `ai/settings/**` (config endpoints, enable gate, disclosure, config audit, connection tester over the provider port), `ai/status/**` | W1-C | standing; **G1** |
| **W2-3** Runtime | backend | `apps/api/src/ai/runtime/**` (loop, orchestrator, worker, sweeper, approval service, limits, in-process event bus) | W1-C | **CEO** (approval = authorization of mutations); **G1**, **G2** |
| **W2-4** OAuth AS core | backend | `apps/api/src/oauth/**` except `cimd/` and `personal-tokens/`; the pino redaction paths for `/oauth/token` and `/oauth/revoke` bodies | W1-A, W1-C | **CEO** (authentication); **G3** |
| **W2-5** Tools — assets + reference | backend | `ai/tools/assets.tools.ts`, `reference.tools.ts` + specs | W1-C | standing; **G2** |
| **W2-6** Tools — access | backend | `ai/tools/access.tools.ts` + spec (applications, grants, requests) | W1-C, W0-3 | **CEO** (grants are `elevated`); **G2** |
| **W2-7** Tools — consumables | backend | `ai/tools/consumables.tools.ts` + spec | W1-C | standing; **G2** |
| **W2-8** Tools — knowledge base | backend | `ai/tools/kb.tools.ts` + spec | W1-C | standing; **G2** |
| **W2-9** Tools — users + activity | backend | `ai/tools/users.tools.ts`, `activity.tools.ts` + specs | W1-C, W0-2 | **CEO** (privilege and identity); **G2** |
| **W2-10** Tools — infra (read) | backend | `ai/tools/infra.tools.ts` + spec | W1-C | standing; **G2** |
| **W2-11** Primer + system prompt | backend | `apps/api/src/ai/prompt/**` | W1-C | standing |
| **W2-12** Workflow engine contract | backend + docs | ADR-0097 decision 3 amendment; `OUTBOUND_INTEGRATION` / `CRITICAL_APPLICATION` in `ai-tools.ts`; `AI_STEP_UP_WARNINGS`; the two pre-created workflow toolsets; primer (`AI_PROMPT_VERSION` 2) | W2-0, W2-11 | **CEO** (amends ADR-0097; step-up) |
| **W2-13** Tools — workflow operations | backend | `ai/tools/workflows.tools.ts` + spec (reads, retry/replay, manual tasks; every channel) | W2-12 | **CEO** (workflow runs re-provision); **G2** |
| **W2-14** Tools — workflow authoring | backend | `ai/tools/workflow-authoring.tools.ts` + spec (chat only) | W2-12, W2-13 | **CEO** (egress configuration); **G2** |

### Wave 3 — surfaces (parallel)

| Unit | Lane | Owns | Depends on | Merge |
| --- | --- | --- | --- | --- |
| **W3-1** HTTP surfaces | backend | `ai/conversations/**`, `ai/runs/**` (runs incl. headless create, SSE events, the decision endpoint with step-up, cancel), `ai/headless/**` (per-SA AI access, `/config/ai/service-accounts/:id`, the `infra:report` refusal) | W2-2, W2-3 | **CEO** (approval, step-up, per-SA access); **G2** |
| **W3-2** MCP resource server | backend | `apps/api/src/mcp/**` except `distribution/` | W2-4, W2-11 | **CEO** (authentication); **G3** |
| **W3-3** CIMD | backend | `apps/api/src/oauth/cimd/**` | W2-4 | **CEO** (client authentication); **G3** |
| **W3-4** Personal tokens (`lan`) | backend | `apps/api/src/oauth/personal-tokens/**` | W2-4 | **CEO** (a credential type); **G3** |
| **W3-5** Skill / plugin distribution | backend | `apps/api/src/mcp/distribution/**` | W1-C, W2-11 | **CEO** (a new anonymous surface); **G3** |
| **W3-6** Retention sweeper | backend | `apps/api/src/ai/retention/**` | W2-2 | **CEO** (hard deletes) |
| **W3-7** Web chat | frontend | `lib/ai/**`, `components/ai/**` (except W1-D's three files), `lib/api/endpoints/ai.ts`, `lib/api/hooks/use-ai-conversations.ts`, `use-ai-turn.ts`, `messages/{en,es}/ai.json`, `lib/hooks/use-before-unload-guard.ts`, Manual pages `ai-assistant-using-the-chat` and `ai-assistant-approvals` (en + es) | W1-D, W3-1 | standing; **G4** |
| **W3-8** Web Settings → AI | frontend | `app/(app)/settings/ai/**`, `settings/page.tsx`, `settings/service-accounts/**` (per-SA control), `lib/api/endpoints/ai-config.ts`, `lib/api/hooks/use-ai-config.ts`, `messages/{en,es}/aiSettings.json`, `messages/{en,es}/settings.json` (hub + SA strings), `components/ui/radio-group.tsx`, Manual pages `ai-assistant-overview` and `ai-assistant-setup` (en + es) | W1-D, W2-2, W3-1 | standing; **G4** |
| **W3-9** Web `/account/ai` + consent | frontend | `app/(app)/account/ai/**` (incl. `_lib/mcp-snippets.ts` and the install panel W3-8 embeds), `app/(auth)/oauth/authorize/**`, `lib/api/endpoints/oauth.ts`, `lib/api/hooks/use-oauth-grants.ts`, `messages/{en,es}/oauth.json`, `messages/{en,es}/shared.json`, `components/user-menu.tsx`, `proxy.ts` (keep the query in `callbackUrl`; coordinate with #1310), Manual pages `ai-assistant-claude-code-mcp` and `ai-assistant-connected-apps` (en + es) | W1-D, W2-4, W3-4, W3-5 | **CEO** (`proxy.ts`, consent); **G3**, **G4** |

W3-8 links to `/account/ai` until W3-9's install panel lands, then embeds it in a one-line follow-up.

### Wave 4 — completion

| Unit | Lane | Owns | Depends on | Merge |
| --- | --- | --- | --- | --- |
| **W4-1** Manual consolidation | documentation | `ai-assistant-troubleshooting` (en + es) and the edits to existing Manual pages ([[ai-assistant/frontend|frontend]] §8.2), incl. the egress disclosure and the MCP risk statement | W3-7, W3-8, W3-9 | standing |
| **W4-2** Security review | security review | gates G1–G4 re-run over the integrated feature, a `lazyit-sentinel` sweep of `apps/api/src/{ai,oauth,mcp}/**`; findings in `docs/06-security/` | all of W3 | — |
| **W4-3** Client × deployment matrix | infrastructure | end-to-end runs: Claude Code on `real` (public CA and internal CA), Cursor, claude.ai against a publicly reachable test instance, personal tokens on `lan`, an SDK-v2 client refused on `lan`; the MCP Inspector and the conformance suite's auth scenarios; results in the runbook | W3-2 … W3-5 | standing |
| **W4-4** Invariants and ADR acceptance | documentation | `docs/06-security/INVARIANTS.md` (INV-AI-1…14), the ADR-0046/0048/0080 amendments, `docs/01-architecture/authorization.md`, ADR-0097 status, `docs/03-decisions/_MOC.md` | ADR-0097 accepted | **CEO** |

The Manual pages ride with the web unit that ships each surface (AGENTS.md rule 5); W4-1 adds the
cross-cutting pages and the edits to existing ones.

---

## 11. Still open

1. ~~**Client trust policy**~~ — **resolved** (CEO, 2026-09-23): an admin-configurable allowlist in
   Settings → AI, pre-seeded with the well-known clients, matched on the CIMD URL or redirect-URI
   pattern, never `client_name`. → [[0097-ai-assistant-mcp-and-headless-api|ADR-0097]] decision 13.
2. ~~**Session semantics after PR #1313**~~ — **resolved** (CEO, 2026-09-24): grants bind to their own
   `mcpCredentialEpoch`, so a web logout no longer revokes them. → [[0097-ai-assistant-mcp-and-headless-api|ADR-0097]]
   decision 8 (amended).
3. **External facts to verify during the build** (not decisions): Claude Code's behavior against an
   `http://` MCP URL; Cursor's redirect URI and CIMD behavior; whether Claude Code honors
   `NODE_EXTRA_CA_CERTS`; Caddy `encode` with SSE on the pinned image; whether Auth.js keeps a long
   `callbackUrl` query. **Verified in W3-5** ([[ai-assistant/mcp-and-oauth|MCP]] §13): `${user_config.*}`
   substitutes inside MCP `headers` (and in skill markdown — hence a content guard); `claude plugin
   marketplace add` accepts a direct `https://` URL to the instance's `marketplace.json` (`http://` is
   refused), and third-party marketplaces do not auto-update until the user enables it.

---

## See also

- [[ai-assistant/_MOC|AI assistant — Map of Content]] · [[0097-ai-assistant-mcp-and-headless-api|ADR-0097]]
- [[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[0080-service-account-secret-retrieval]] ·
  [[0086-local-authentication-mode]] · [[0087-plain-http-lan-deployment-axis]] ·
  [[0053-async-workers-bullmq-valkey]] · [[0054-applications-workflow-engine]] ·
  [[0056-in-app-notification-bell]] · [[0079-instance-smtp-outbound-email]] ·
  [[0061-secret-manager-zero-knowledge]] · [[0096-jest-commonjs-against-esm-nestjs]] · [[INVARIANTS]]
