---
title: "AI Assistant — Provider layer, agent runtime, configuration lifecycle, infrastructure"
tags: [design, ai-assistant, backend, llm, providers, agent-loop, bullmq, sse, infra, security]
status: draft
created: 2026-09-23
updated: 2026-09-24
---

# AI Assistant — Provider layer, agent runtime, configuration lifecycle, infrastructure

> Scope: the slice of the opt-in AI capability that owns **how lazyit talks to an LLM** (the
> provider abstraction and registry), **lazyit's own agent loop** (used by the in-app chat and the
> headless API), its **pause/resume approval state machine**, the **streaming transport** to the
> browser, the **instance configuration** (`AiSettings`) and its enable/disable lifecycle, limits,
> observability, and the **infrastructure** impact.
>
> Out of scope here (sibling notes in this folder): the MCP server and its OAuth, the frontend UX,
> the contents of the tool catalog, and the full threat model.
>
> Labels: **[R]** repository fact (cited) · **[E]** external fact (source URL, fetched 2026-09-23) ·
> **[C]** conclusion · **[A]** assumption.
>
> **Reconciled with the synthesis (2026-09-23).** The CEO's decisions and the CTO's cross-slice
> reconciliations (R1–R10) are applied throughout. [[ai-assistant/_synthesis|The synthesis]] is binding:
> where this note and the synthesis disagree, the synthesis wins. In particular: tools execute through
> Nest's own pipeline rather than by direct service calls (R1); the per-call approval row is
> `AiToolInvocation` and the single permanent AI mutation ledger is `AiActionLog` (R6); the SSE vocabulary
> in §9.3 is the reconciled union (R2, R3). The implementation units that followed this note are
> superseded by the synthesis's unified wave plan.

## 1. Context

The CEO's settled decisions (verbatim where quoted), which this note implements and does not re-open:

- Off by default; an admin **enables** it through a configuration process — "elegis el proveedor,
  modelo, y tus api key, y configuraciones extras (despues se pueden modificar)" — after which the
  app reloads and an in-app chat appears.
- Providers v1: **Anthropic, OpenAI, Google Gemini, OpenAI-compatible** (Ollama, vLLM, LM Studio,
  OpenRouter — by base URL). The code structure and the extension point for a new provider are a
  first-class deliverable: "ordenemos bien los archivos, estructuremos bien el codigo, y hagamoslo
  escalable".
- Configuration is **instance-wide**, set by an admin (`settings:manage`); the API key is
  **encrypted at rest**.
- The AI acts **as the invoking principal**. Headless runs as the **Service Account**, autonomous
  within its grants — "Autonomo total, pero configurable in-app tambien" (CEO, round 2): a per-SA
  in-app setting (AI access off / read-only / read-write, default read-write when the SA holds
  `ai:use`, optional mutation cap per run). The per-SA placement is a CTO interpretation, to confirm on
  review.
- **Interactive writes require user approval.** The loop must pause on a proposed mutation and
  resume after approve or reject.
- Conversations are persisted with a **configurable retention**. Mutating tool calls also go to the
  **append-only audit log**.
- A new permission, **`ai:use`**, gates usage of the chat and headless channels. MCP has its own,
  **`ai:connect`**, and its own switch (CEO, round 2).

Channels 1 (in-app chat) and 3 (headless API) run the loop described here. Channel 2 (MCP) shares
the tool registry but not the loop.

## 2. Repository facts (cited)

### Secrets and instance configuration

- **[R] Encrypted-instance-secret precedent.** ADR [[0079-instance-smtp-outbound-email]] ships a
  singleton `SmtpSettings` row pinned to `id = 'singleton'` by a migration CHECK. It stores an
  AES-256-GCM envelope (`passwordCiphertext`/`Iv`/`AuthTag`/`KeyVersion`) under its **own optional**
  key axis, `SMTP_SECRET_KEY`.
  - The app boots without the key; a password save without it is a clean **409**.
  - The password is write-only on the wire (`passwordSet`).
  - `POST /config/smtp/test` performs a real send.
  - Every route is gated by `settings:manage` plus `ServicePrincipalForbiddenGuard`.
  - Code: `apps/api/src/smtp/smtp.crypto.ts`, `smtp.service.ts`, `smtp.controller.ts`.
- **[R] Crypto implementation constraint.** The crypto is a standalone `node:crypto` helper,
  deliberately **not** `@lazyit/shared/crypto`, because that pulls ESM `@noble/*` into the CommonJS
  Jest suite (`apps/api/src/smtp/smtp.crypto.ts` header). There are already two copies of the
  envelope code: `workflow-engine/secrets/secret.service.ts` and `smtp/smtp.crypto.ts`.
- **[R] Configuration model.** Configuration is `.env` per level; secrets never go in examples
  ([[0028-secrets-and-config]]). `WORKFLOW_SECRET_KEY` is a DR linchpin and `SMTP_SECRET_KEY` is
  low-DR (`docs/05-runbooks/backups.md`).

### Queues and durable runs

- **[R] BullMQ on Valkey** ([[0053-async-workers-bullmq-valkey]]). Postgres is the system of record
  and BullMQ is transport; workers are co-located in the `api` container. `QueueModule` is global
  and uses `enableOfflineQueue: false`, so enqueues fail fast (`apps/api/src/queue/queue.module.ts`).
- **[R] The pause/resume precedent is the workflow engine** ([[0054-applications-workflow-engine]]):
  - The run state lives in Postgres; a job carries only `{ runId }`.
  - `AWAITING_INPUT` means no job is in flight; a resume job is enqueued on completion.
  - A sweeper re-enqueues lost resumes and fails stale `RUNNING` runs.
  - A caught engine fault finalizes the run `FAILED` and is **not rethrown**, "a blind BullMQ retry
    could double-execute steps".
  - Code: `apps/api/src/workflow-engine/run/workflow-run.worker.ts`, `workflow-run.constants.ts`
    (`AWAITING_INPUT_SWEEP_AFTER_MS = 60_000`, `RUNNING_STALE_AFTER_MS = 300_000`),
    `workflow-run.sweeper.ts`.

### Egress

- **[R] The egress guard** (`apps/api/src/common/egress/`):
  - `guardedFetch` checks the scheme (https-only by default; `http:` is opt-in).
  - It pins DNS against rebinding and re-validates every redirect.
  - It denies private addresses unless the `isInternalTargetAllowed` seam allows them. The seam is
    consulted **only** for RFC1918 and ULA addresses. Loopback, IMDS, link-local and CGNAT are
    **never** allowlistable (`ip-rules.ts`).
  - It returns a streaming `Response` (`Readable.toWeb`).
  - Its default idle timeout is 30 s, and **the total deadline defaults to the idle timeout**
    (`egress-guard.ts`: `DEFAULT_TIMEOUT_MS = 30_000`, `deadlineMs ?? timeoutMs`).
  - It is used today by `workflow-engine/handlers/rest.handler.ts` and `webhook-out.handler.ts`.
  - The per-connection private allowlist in [[0055-on-prem-internal-target-connectors]] is
    **proposed, and the CEO is holding the build**.

### Auth, principals and permissions

- **[R] Principal model** (`apps/api/src/auth/principal.ts`): `HumanPrincipal { user }` or
  `ServicePrincipal { serviceAccount, permissions }`. Service accounts are fail-closed
  ([[0048-service-accounts]]).
- **[R] Service-account token checks.** `jwt-auth.guard.ts` rejects SA tokens that are revoked
  (`deletedAt`), inactive or expired, and resolves grants DB-first (`serviceAccountPermission`).
  Humans are rejected when `!user.isActive`.
- **[R] SA-ungrantable permissions:** `settings:manage`, `user:manage`, `import:run`,
  `secret:read`, `secret:manage` (`packages/shared/src/schemas/service-account.ts`). A service
  account therefore can never configure AI. `ai:use` would be grantable.
- **[R] Permission catalog.** The frozen catalog lives in `packages/shared/src/schemas/permission.ts`
  (`PERMISSION_DOMAINS`, `PERMISSIONS`); there is no `ai` domain yet ([[0046-roles-permissions-v2]]).

### Retention, logging, testing and runtime

- **[R] Retention precedent.** The notification bell is "allowed to forget": a 90-day sweep
  hard-deletes rows because "the append-only history tables and ledgers … remain the durable record"
  ([[0056-in-app-notification-bell]] §7; `apps/api/src/notifications/notifications-retention.sweeper.ts`).
- **[R] Logging** ([[0031-logging-strategy]]): pino with metadata only, no bodies; `authorization`
  and `cookie` redacted; a request id on every line.
- **[R] Testing** ([[0012-testing-strategy]], [[0096-jest-commonjs-against-esm-nestjs]]): api tests
  are CommonJS Jest under Node. `transformIgnorePatterns: ["/node_modules/(?!.*@nestjs)"]` with
  `@swc/jest` for `.js`. "If another ESM-only dependency lands in the runtime import graph it must be
  added to the same negative lookahead." W1-B (PR #1331) extended it for the AI SDK; see §3,
  "Compatibility spike findings".
- **[R] Runtime.** The api runs `node:26-alpine` from a CommonJS `dist/` that loads ESM through
  `require(esm)` (`infra/docker/api.Dockerfile`, ADR-0096). tsconfig uses `module: nodenext`
  (`apps/api/tsconfig.json`).

### Browser path, proxy and deployment

- **[R] Browser → API path.** The browser calls `/api/*` with `Authorization: Bearer` (no cookies,
  no Next.js hop). Caddy strips `/api` and proxies to `api:3001` (`apps/web/lib/api/client.ts`,
  `infra/caddy/Caddyfile`). `EventSource` cannot send an `Authorization` header.
- **[R] Caddy.** A site-level `encode zstd gzip` wraps every route; there are three site-address
  shapes, including plain HTTP on the LAN (`:80`, HTTP/1.1) ([[0026-reverse-proxy-tls]],
  ADR-0087). The Caddy image is pinned by digest (`compose.yaml` `caddy:2-alpine@sha256:86dea…`).
- **[R] Streaming.** There is no SSE or WebSocket anywhere in `apps/api` or `apps/web` today. The
  bell polls; ADR-0056 defers SSE ("no Valkey pub/sub fanout").
- **[R] Compose limits.** The `api` container is `mem_limit: 768m`, `cpus: 1.0`. The `internal`
  network is a plain bridge, so outbound Internet works (`compose.yaml`).
- **[R] Guided update.** `infra/update.sh` **fails loud** when the target `.env.prod.example` has an
  active `KEY=` line missing from the live `.env.prod`; it never writes `.env.prod`
  ([[0084-update-awareness-and-guided-update]]). `infra/start.sh` generates `SMTP_SECRET_KEY` on
  install and on `--reconfigure`.
- **[R] Upgrade-safety rule.** Additive migrations, write-only validation, graceful degradation
  (`docs/04-development/claude-workflow.md` §7, charter "Review dimensions").

## 3. External facts (sources and versions, fetched 2026-09-23)

### Library landscape

| Package | Version | Module format | Node | License | Notes |
| --- | --- | --- | --- | --- | --- |
| `ai` (Vercel AI SDK) | 7.0.112 | **ESM-only** (`type: module`, import-only exports) | ≥ 22 | Apache-2.0 | deps: `@ai-sdk/gateway` 4.0.90 (→ `@vercel/oidc`), `@ai-sdk/provider` 4.0.18, `@ai-sdk/provider-utils` 5.0.46 (→ `undici`, `eventsource-parser`, `@workflow/serde`); ~7.7 MB unpacked. Of the transitive deps only `@workflow/serde` is ESM-only; the others ship CommonJS |
| `@ai-sdk/anthropic` · `openai` · `google` · `openai-compatible` | 4.0.61 · 4.0.73 · 4.0.78 · 3.0.54 | ESM-only | ≥ 22 | Apache-2.0 | |
| `@anthropic-ai/sdk` | 0.128.0 | dual (CJS `require` export) | — | MIT | |
| `openai` | 7.23.0 | dual (CJS) | ≥ 22 | Apache-2.0 | |
| `@google/genai` | 2.24.0 | dual (`require` → `.cjs`) | ≥ 20 | Apache-2.0 | deps: `google-auth-library`, `protobufjs`, `ws`; ~11.9 MB |
| `langchain` / `@langchain/core` | 1.5.12 / 1.2.12 | dual (`.cjs` main) | ≥ 20 | MIT | deps include `langsmith`, `@langchain/langgraph`, `-checkpoint` |
| `@mastra/core` | 1.69.0 | ESM-only | ≥ 22.13 | Apache-2.0 | deps include `hono`, `execa`, `posthog-node`, A2A SDKs, **three** AI SDK provider majors |

Source: npm registry `https://registry.npmjs.org/<pkg>/latest`. The five AI SDK rows are the versions
W1-B pinned in `bun.lock` (PR #1331); `apps/api/package.json` carries caret ranges.

### Vercel AI SDK 7 specifics

- **Module format and Node** — [E] "All AI SDK packages are now ESM-only. The `require()` function is
  no longer supported"; Node 22+ is required. `needsApproval` on tools is **deprecated in favour of
  `toolApproval`**. The `toUIMessageStream*` helpers were removed from the `streamText` result.
  Google provider identifiers were renamed `GoogleGenerativeAI` → `Google`.
  <https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0>
- **Tool approval** — [E] `toolApproval` returns `'user-approval' | 'approved' | 'denied' |
  'not-applicable'`. The loop emits a `tool-approval-request` part, and you resume by appending a
  `role: 'tool'` message with `tool-approval-response` parts. This works server-side with persisted
  `ModelMessage[]`. <https://ai-sdk.dev/docs/agents/tool-approvals>
- **Loop controls** — [E] `stopWhen` (`isStepCount(n)`, `hasToolCall`), `prepareStep`,
  `repairToolCall`, `abortSignal` forwarding, `tool-error` parts, JSON-Schema `inputSchema` through
  `jsonSchema(...)` / `dynamicTool`; `execute` is optional on `tool()`.
  <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>,
  <https://ai-sdk.dev/docs/reference/ai-sdk-core/tool>
- **OpenAI-compatible provider** — [E] `createOpenAICompatible({ name, baseURL, apiKey, headers,
  fetch, includeUsage, supportsStructuredOutputs, queryParams })` supports tool calling with
  streaming. **No model-listing API.** <https://ai-sdk.dev/providers/openai-compatible-providers>
- **Anthropic provider** — [E] `createAnthropic({ baseURL, apiKey, authToken, headers, fetch })`.
  - Prompt caching: `providerOptions.anthropic.cacheControl`.
  - Thinking: `providerOptions.anthropic.thinking: { type: 'adaptive' }` plus `effort`.
  - Usage: `usage.inputTokenDetails.cacheReadTokens` / `cacheWriteTokens`.
  - Model ids listed include `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5`,
    `claude-haiku-4-5`.
  - The API key falls back to the `ANTHROPIC_API_KEY` env var when omitted.
  <https://ai-sdk.dev/providers/ai-sdk-providers/anthropic>
- **OpenAI provider** — [E] `openai(model)` calls the **Responses API** by default. The `store`
  option **defaults to `true`** (OpenAI retains the generation). `reasoningEffort` goes through
  `providerOptions.openai`; `openai.chat()` targets Chat Completions.
  <https://ai-sdk.dev/providers/ai-sdk-providers/openai>

### Other frameworks

- **LangChain.js v1** — [E] `humanInTheLoopMiddleware` "requires a checkpointer" and a `thread_id`,
  i.e. LangGraph's own persistence.
  <https://reference.langchain.com/javascript/langchain/index/humanInTheLoopMiddleware>

### Current models and API behaviour

- **Anthropic models** — [E] from the claude-api reference (cached 2026-06-24, confirmed by the AI
  SDK provider page):
  - `claude-opus-5`: 1M context, $5/$25 per MTok; the default recommendation.
  - `claude-opus-5-5`: launching; $4/$20.
  - `claude-sonnet-5`: $2/$10.
  - `claude-haiku-4-5`: 200K context, $1/$5.
- **Anthropic API behaviour** — [E] same reference:
  - Opus 5 / Sonnet 5 / Opus 4.7+ **reject `temperature`/`top_p`/`top_k` with a 400**.
  - Opus 5 thinks adaptively by default.
  - Opus 5.5 and Fable 5.1 **reject forced `tool_choice` `any`/`tool`**.
  - `stop_reason: "refusal"` exists.
  - **Preserved thinking**: `system`, `tools` and every earlier message must stay byte-identical
    across turns. Accounts created on or after 2026-08-31 are enforced with a 400. The fix is
    "append-only histories … freeze the top-level `system` … declare from the first request any tool
    the session may need later".
  - Prompt caching is a prefix match (tools → system → messages); the minimum cacheable prefix is
    512–4096 tokens.
- **OpenAI models** — [E] `gpt-6-astra` (most capable), `gpt-6-sol` ("built to power complex coding
  and agentic workflows"), `gpt-6-luna` (most efficient). <https://developers.openai.com/api/docs/models>
- **Gemini models** — [E] stable `gemini-3.8-flash` ("autonomous agents"), `gemini-3.7-flash`,
  `gemini-3.5-flash-lite`; preview `gemini-3.1-pro-preview`; the 2.5 models are to be avoided.
  <https://ai.google.dev/gemini-api/docs/models>

### Caddy

- **reverse_proxy** — [E] responses with `Content-Type: text/event-stream` or an unknown length are
  **flushed immediately**. There is no default `read_timeout`, `write_timeout` or `stream_timeout`,
  and `stream_close_delay` (for config reloads) defaults to none.
  <https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>
- **encode** — [E] the default `match` includes `text/*`, which covers `text/event-stream`;
  `minimum_length` defaults to 512. <https://caddyserver.com/docs/caddyfile/directives/encode>
  The encode-plus-SSE header-flush bug (#6293) was fixed by PR #7905, **merged 2026-07-31**; no
  release tag is shown. <https://github.com/caddyserver/caddy/issues/6293>,
  <https://github.com/caddyserver/caddy/pull/7905>

### Compatibility spike findings (W1-B, PR #1331)

[E] measured against the pinned versions above. The regression specs live in
`apps/api/src/ai/providers/__compat__/`. Verdict: **go** on every item. Jest loads the SDK and its
mocks; the compiled `require(esm)` path works on `node:26-alpine`; a tool without `execute` plus one
step returns tool calls; reasoning replays on all three providers; `guardedFetch` serves as the SDK
`fetch`.

- **Jest lookahead.** ADR-0096's pattern is now
  `"/node_modules/(?!.*@nestjs|.*@ai-sdk|.*@workflow|(?:.*/)?ai/)"` in `apps/api/package.json` and
  `test/jest-e2e.json`. Each alternative is required. `eventsource-parser`, `@standard-schema/spec`,
  `undici` and `@vercel/oidc` ship CommonJS and need no entry.

Findings the provider layer (W2-1) must act on:

1. **v7 API renames.**
   - Pass the frozen system prompt as `instructions`; `system` is a deprecated fallback.
   - v7 **rejects `role: 'system'` messages inside `messages`** unless `allowSystemInMessages` is set.
     Persisted history must therefore never contain a system message.
   - Other renames: `fullStream` → `stream`, `stepCountIs` → `isStepCount`,
     `createGoogleGenerativeAI` → `createGoogle`.
   - Persist from `result.responseMessages`. In v7 it holds only this call's messages, which is one
     step for us.
2. **A bare `jsonSchema()` does not validate tool input.** A call that violates the schema comes back
   with `invalid: false`. Only an unknown tool name is flagged `invalid: true`. The loop must validate
   every call against the tool's JSON Schema itself (§6.4), or pass a `validate` function to
   `jsonSchema(schema, { validate })`.
3. **An error after the headers loses the egress reason.** When the transport cuts a stream
   mid-body, the SDK surfaces `APICallError` with cause `Error('aborted')`, not
   `EgressError('deadline-exceeded')`. `classifyError` must treat a mid-stream `aborted` as a
   transport cut, and cannot rely on the `EgressError` reason once the response has started.
   `provider-fetch.ts` must always pass **both** `timeoutMs` and `deadlineMs` (§9.2): without
   `deadlineMs`, the node transport's deadline falls back to the idle timeout (30 s by default) and
   kills long generations. The SDK's `abortSignal` does reach the socket and closes the upstream.
4. **OpenAI capabilities are keyed on the model id.** The SDK treats `gpt-5+` and `o*` ids as
   reasoning models (the `gpt-6-*` ids are recognised). Only for those does `store: false`
   automatically add `include: ['reasoning.encrypted_content']` and send the system prompt as a
   `developer` message. For any other id, including a custom or aliased one, set
   `providerOptions.openai.forceReasoning: true`, or reasoning replay silently degrades.
5. **Gemini 3 hides dropped signatures.** If a `functionCall` is replayed without its
   `thoughtSignature`, the SDK injects the `skip_thought_signature_validator` sentinel and only emits
   a warning. Persist `ModelMessage[]` with `providerOptions` intact, byte for byte, and treat that
   warning as a bug. Anthropic replays `{ type: 'thinking', thinking, signature }` from
   `providerOptions.anthropic.signature`. OpenAI with `store: false` replays a `reasoning` item with
   `encrypted_content` and no `item_reference`.
6. **Choose one way to set reasoning per provider.** v7 adds a portable top-level
   `reasoning` option (`'none' … 'xhigh'`). It is **ignored** whenever reasoning keys are present in
   `providerOptions` (`effort`, `thinking`, `reasoningEffort`, …); the two are never merged. Choose
   one mechanism per provider definition. Also, since v7 any OpenAI reasoning effort other than
   `'none'` defaults `reasoningSummary` to `'detailed'`.
7. **Never pass a model as a string id.** `ai` hard-depends on `@ai-sdk/gateway` (and
   `@vercel/oidc`), which routes a string model id to the Vercel AI Gateway. Always pass the model
   instance built by the provider definition. Telemetry stays off because no integration is registered
   (`@ai-sdk/otel` is not installed).

## 4. What must change, and what must not

**Must change [C]:**

- a new `apps/api/src/ai/` module;
- additive Prisma models;
- two new permission literals, `ai:use` and `ai:connect`;
- shared zod contracts;
- one optional env key;
- Caddy verification (and possibly a fix) for SSE;
- runbooks.

**Must not change [C]:**

- The api boots and every existing route works with no AI row, no AI env key, and Valkey healthy.
- `/health/ready` never depends on an LLM provider.
- The egress guard's un-allowlistable categories (loopback, IMDS, link-local) are untouched.
- ADR-0096's transform semantics for existing suites; the lookahead is only extended.
- No existing table gains a column, except the two additive nullable `aiInvocationId` provenance
  columns on `asset_history` and `user_history` (R6).
- Existing Caddy routing for `/api/*` and `/api/auth/*` is unchanged.
- The `JwtAuthGuard` network authentication paths are unchanged. The only addition is the
  delegated-identity branch used by tool dispatch, unreachable from HTTP (R1).

## 5. Options per fork, with trade-offs

### Fork A — LLM library

| Option | Provider parity and tool calling | Pause/resume | OpenAI-compat base URL | Model listing | Caching and usage | Jest (ADR-0096) | Weight and maintenance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A1. AI SDK 7 as the model-call layer only; lazyit owns the loop** | Best: one normalized message/tool/stream/usage model over all four providers, including provider-specific reasoning replay through provider metadata | Ours (Postgres state machine); SDK approval API unused | `createOpenAICompatible` + custom `fetch` | Not provided → own thin `listModels()` per provider | `usage` normalized incl. cache reads; Anthropic `cacheControl` through `providerOptions` | ESM-only → extend the lookahead (`@ai-sdk`, `@workflow`, `ai/`; measured in W1-B); loop specs never import it | ~10 MB; a new major roughly yearly, with churn (v7 deprecated `needsApproval`, removed UI helpers) |
| A2. AI SDK 7 end to end (`ToolLoopAgent` + `toolApproval` + UI message stream + `useChat`) | Same | SDK-native, but durability, TTL, re-authorization and headless autonomy still have to be built around it | Same | Same | Same | Same, plus the web depends on the SDK stream protocol | Couples api **and** web to the SDK's most volatile surfaces |
| A3. Thin own adapters over official SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`) | Must hand-write three translators (messages, tool calls, streaming deltas, usage, errors, reasoning replay: Anthropic thinking signatures, OpenAI encrypted reasoning items, Gemini thought signatures) | Ours | `openai` SDK `baseURL` | Each SDK can list | Manual per provider | Dual CJS → zero Jest friction | Roughly 2k LOC plus tests to keep in step with monthly API drift; `@google/genai` ~12 MB |
| A4. LangChain.js v1 | Good via `@langchain/*` | HITL requires a LangGraph **checkpointer**, a second persistence model outside Prisma migrations | Yes | Partial | Via callbacks | Dual → OK | Heavy (`langsmith`, `langgraph`); abstraction-heavy |
| A5. Mastra | Good (wraps AI SDK) | Own workflow/suspend engine and storage adapters with their own tables | Yes | — | — | ESM-only | Heaviest: `hono`, `execa`, **`posthog-node`** telemetry, three provider majors; competes with NestJS, BullMQ and Prisma |

**[C] Rejections:**

- **A4 and A5** are rejected because each brings its own persistence and runtime. That collides
  with "Postgres is the system of record" (ADR-0054 §2) and with `prisma migrate deploy` being the
  only migration path (the upgrade-safety dimension).
- **A2** is rejected because the SDK's approval and UI-stream APIs are exactly what churned in v7.
  They would still need our durable state around them, and they would couple the frontend and the
  headless contract to a vendor protocol.
- **A3** is the escape hatch rather than the default. The parity work (especially reasoning-token
  replay across three wire formats) is where the bugs live, and the AI SDK already tracks it.

### Fork B — Where the loop runs

| Option | Pros | Cons |
| --- | --- | --- |
| B1. In the HTTP request (SSE response drives the loop) | Fewest moving parts | Page reload or disconnect kills a generation; headless still needs a worker, so there are two hosts; no global concurrency ceiling in a 768 MB container |
| **B2. One BullMQ in-process worker for all runs; SSE subscribes to a run event bus** | One host for the loop; reattach after reload; `worker concurrency` is a natural global cap; reuses the ADR-0054 durable pattern (job = `{ runId }`, sweeper) | An event bus is needed between worker and SSE; a few milliseconds of queue latency; AI is unavailable while Valkey is down (enqueue fails fast, as today) |

**[C] Choose B2.** The bus is a port (`RunEventBus`). v1 implements it **in-process**, which is
correct because ADR-0053 co-locates the worker in the `api` container. It adds a Postgres snapshot
fallback for replay. A Valkey Streams implementation replaces it only when the ADR-0053
"dedicated worker container" follow-up happens.

### Fork C — Browser transport

| Option | Pros | Cons |
| --- | --- | --- |
| **C1. SSE over `fetch` streaming (GET with `Authorization`), `Last-Event-ID` resume** | Unidirectional server → client is all that is needed (client actions are ordinary POSTs); Caddy auto-flushes `text/event-stream`; works over HTTP/1.1 LAN mode | `EventSource` cannot send Bearer → use `fetch` + `ReadableStream`; the Caddy `encode` interaction must be verified |
| C2. WebSocket (Nest gateway) | Bidirectional | New dependency (`@nestjs/websockets` / `platform-ws`), auth at upgrade time, bidirectionality unused |
| C3. Polling only | Zero new transport | No token streaming; poor chat UX |

**[C] Choose C1.** Headless callers can use the same SSE stream or poll.

### Fork D — Context-window management (must respect preserved thinking)

| Option | Pros | Cons |
| --- | --- | --- |
| **D1. Hard cap per conversation, then closed ("start a new conversation")** | Append-only; identical on four providers; trivial | A long conversation ends abruptly |
| D2. Client-side summarization, then continue | Continuity | Violates the append-only prefix unless it replaces *everything* with a summary; quality varies per provider |
| D3. Anthropic server-side compaction | Continuity, append-safe on Anthropic | Anthropic-only, beta |

**[C] Choose D1 for v1**, with write-time tool-result truncation. D2/D3 are deliberately not built.

## 6. Recommendation

### 6.1 Direction

- **Library.** AI SDK 7 (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`,
  `@ai-sdk/openai-compatible`) is the **model-call normalization layer only**. It sits behind a
  lazyit-owned port (`ChatModelPort`), and only `apps/api/src/ai/providers/**` imports it.
- **Loop.** lazyit owns the loop. Each model step is one `streamText` call:
  - `stopWhen: isStepCount(1)`, with tools passed without `execute`, so the SDK never runs a tool;
  - `toolChoice: 'auto'` normally and `'none'` on the final forced step. Forced `any`/`tool` is
    never used (400 on Opus 5.5 / Fable 5.1).
- **Execution.** Every run executes in an in-process BullMQ worker on a new `ai-run` queue.
  Postgres holds all run, approval and message state; the job carries `{ runId }`.
- **Streaming.** SSE on `GET /ai/runs/:id/events`, fed by an in-process `RunEventBus`.
- **Egress.** All provider HTTP, including model listing and the connection test, goes through
  `guardedFetch`, passed as the SDK's `fetch` option with explicit long timeouts (§9.2).
- **Configuration.** A singleton `AiSettings` row mirrors `SmtpSettings`. The API key is encrypted
  under a new optional key axis, `AI_SECRET_KEY`, through a generic envelope helper.

### 6.2 Directory tree (apps/api)

> The unified tree for the whole feature is in [[ai-assistant/_synthesis|the synthesis]] §5; this is the
> provider/runtime part as the slice proposed it. Reconciliation moved three things: the system-prompt
> builder lives in `ai/prompt/` (shared with the MCP `instructions` and the skill); the `ChatModelPort`,
> `RunEventBus` and settings-reader ports are declared up front in `ai/core/ports/` so the provider,
> runtime and settings units can run in parallel; and the principal re-load (`principal-context.ts`)
> becomes an `auth/principal-loader.service.ts` shared with the delegated-identity branch (built by the
> core unit: `loadHuman(userId, sessionEpoch)`, `loadServiceAccount(id)`).

```
apps/api/src/ai/
├── ai.module.ts                      # registers the ai-run queue, worker, sweepers, controllers
├── ai.constants.ts                   # queue/job names, limits, AI_PROMPT_VERSION
├── settings/
│   ├── ai-settings.controller.ts     # GET/PUT /config/ai · POST /config/ai/test · POST /config/ai/models
│   ├── ai-settings.service.ts        # singleton read/upsert, write-only key, enable gate, config audit; AI_SETTINGS_READER
│   ├── ai-settings.constants.ts      # AI_SECRET_KEY name, audit actions, test bounds
│   ├── ai-provider-override.ts       # the connection test's draft, answered by the reader (ALS)
│   └── ai-connection-tester.ts       # auth → model → tool-calling round trip
├── status/
│   ├── ai-status.controller.ts       # GET /ai/status (any authenticated principal)
│   └── ai-status.service.ts          # per-caller availability, MCP auth mode
├── providers/                        # THE EXTENSION POINT — only place that imports `ai` / `@ai-sdk/*`
│   ├── ai-providers.module.ts        # (as built, W2-1) imports AiSettingsModule; exports CHAT_MODEL_PORT, AiModelListService
│   ├── provider.types.ts             # LlmProviderDefinition, ProviderCallSettings, ProviderErrorPatterns, ModelInfo
│   ├── provider.registry.ts          # static map kind → definition (one line per provider)
│   ├── aisdk-chat-model.ts           # ChatModelPort over streamText (the port itself is core/ports/chat-model.port.ts)
│   ├── model-step.ts                 # one step: streamText, tool set without execute, usage mapping
│   ├── ai-model-list.service.ts      # listModels of an explicit (draft) connection, for POST /config/ai/models
│   ├── ai-provider.error.ts          # AiProviderError { code: run error code } — no SDK import
│   ├── provider-errors.ts            # classifyProviderError: SDK / egress / abort → AiProviderError
│   ├── provider-fetch.ts             # guardedFetch → FetchLike with LLM timeouts + the private-host seam
│   ├── model-listing.ts              # capped GET + parse for listModels
│   ├── sdk-import-boundary.spec.ts   # fails if anything outside providers/ imports the SDK
│   ├── anthropic/anthropic.provider.ts          (+ .spec.ts)
│   ├── openai/openai.provider.ts                (+ .spec.ts)
│   ├── google/google.provider.ts                (+ .spec.ts)
│   └── openai-compatible/openai-compatible.provider.ts (+ .spec.ts)
├── runtime/                          # no `ai` import anywhere below this line
│   ├── agent-loop.ts                 # pure step engine over ports (ChatModelPort, ToolRegistry, stores)
│   ├── agent-run.orchestrator.ts     # Nest service: load run, guardrails, loop, persist, emit
│   ├── agent-run.worker.ts           # @Processor('ai-run') — start/resume jobs, never rethrows
│   ├── agent-run.sweeper.ts          # lost resumes, stale RUNNING, approval TTL expiry
│   ├── approval.service.ts           # CAS decisions, resume enqueue
│   ├── principal-context.ts          # re-load + re-authorize the principal per step
│   ├── system-prompt.ts              # frozen, versioned prompt builder + domain primer
│   ├── limits.ts                     # budgets, step caps, context cap, tool-result truncation
│   └── run-event-bus.ts              # RunEventBus port + InProcessRunEventBus (ring buffer)
├── conversations/
│   ├── conversations.controller.ts   # /ai/conversations (in-app)
│   └── conversations.service.ts
├── retention/                        # W3-6, §7 "As built"
│   ├── ai-retention.sweeper.ts       # the hourly pass
│   └── ai-conversation-purge.service.ts # the only deleter of conversations
└── runs/
    ├── runs.controller.ts            # /ai/runs (headless create/get/cancel), approvals
    ├── run-events.controller.ts      # SSE
    └── runs.service.ts

apps/api/src/common/crypto/envelope-cipher.ts   # generic AES-256-GCM envelope keyed by an env var name
```

As built, the runtime's files differ from the sketch above: `system-prompt.ts` lives in `ai/prompt/`, and
the runtime adds `run-lifecycle.ts`, `run-records.ts`, `run-queue.ts`, `step-up.verifier.ts` and
`runtime.constants.ts` — the table is in §8.1.

`packages/shared/src/schemas/` holds **contracts only**: `ai-provider.ts` (provider kinds and
descriptors), `ai-settings.ts`, `ai-run.ts` (run, conversation and approval wire shapes plus the SSE
event union). **[C]** Nothing provider-executing belongs in shared: keys, fetch and SDKs are
server-only. A separate `packages/ai` would be YAGNI because only `apps/api` consumes it.

### 6.3 The provider interface and how to add a provider

```ts
// providers/provider.types.ts (sketch)
export interface LlmProviderDefinition {
  kind: AiProviderKind;                                   // from @lazyit/shared
  createModel(cfg: ResolvedAiConfig, fetch: FetchLike): LanguageModel; // AI SDK model instance
  listModels(cfg: ResolvedAiConfig, fetch: FetchLike): Promise<ModelInfo[]>;
  providerOptions(cfg: ResolvedAiConfig): ProviderOptions; // effort/thinking/store:false/cache hints
  classifyError(err: unknown): AiErrorClass;               // auth | rate_limited | unavailable | bad_request | refused | egress_denied
}
```

**As built (W2-1, #1315).** The definition is
`{ kind, requiresApiKey, defaultBaseUrl, createModel(config, modelId, fetch), callSettings(config, modelId),
listModels(config, fetch), errorPatterns: { contextLimit, auth? }, adaptCall?(fetch, toolChoice) }` in
`providers/provider.types.ts`. Classification is shared (`provider-errors.ts`): the definition contributes
only the wording a status code cannot tell apart. Failures are thrown as `AiProviderError` (`code` is an
`AI_RUN_ERROR_CODES` value: `AI_DISABLED`, `PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT` with `retryAfterSec`,
`PROVIDER_UNAVAILABLE`, `PROVIDER_BAD_REQUEST`, `CONTEXT_LIMIT`, `EGRESS_DENIED`, `CANCELLED`,
`CONVERSATION_READ_ONLY`), with a fixed message and no `cause`; it lives in `ai-provider.error.ts`, which
imports nothing from the SDK, so the runtime can catch it without pulling `ai` into its graph. A refusal
is not an error: it comes back as the step's `finishReason` (`content-filter`) and the runtime decides.

- **`ChatModelPort.step`** reads `AI_SETTINGS_READER.resolveProviderConfig()` on **every** call and never
  caches it: the settings unit's connection tester runs a step inside an `AsyncLocalStorage` override that
  answers its draft for that call only. `AiProvidersModule` imports `AiSettingsModule` for the reader
  (injected `@Optional()`, so the module boots before a reader is bound); the settings module does not
  import this one — its tester resolves `CHAT_MODEL_PORT` lazily. With no reader, or a `null` config, the
  step fails `AI_DISABLED`. A config whose provider differs from the request's pinned provider fails
  `CONVERSATION_READ_ONLY` before any I/O, so the stored key never goes to another provider. The model id
  is the request's. The SDK retries a transient failure twice (§6.4), so a failing connection test can
  take the retry back-off before it answers.
- **The connection test goes through the port** (no separate probe): one `step` with a single tool.
  Every failure carries a `code` from `AI_RUN_ERROR_CODES`, which the tester maps onto its checks.
- **Model listing** is **not** on the port. The definitions implement `listModels` and
  `AiModelListService.listModels(config)` (exported, takes an explicit draft connection) exposes it;
  wiring `POST /config/ai/models` to it is a follow-up for the settings unit, which answers the
  descriptor's `suggestedModel` until then.
- **Tool calls are returned unvalidated, and may be invalid** (for W2-3). A call can name a tool that is
  not in the toolset — look the name up with an own-property check, since the model can send
  `constructor` — and a call whose arguments are not valid JSON arrives with `input` set to the **raw
  string**. The loop must answer every call, invalid ones included (a follow-up could surface the SDK's
  `invalid` flag on `ChatModelToolCall`, which is a port change).
- **Messages.** `responseMessages` is filtered to the assistant message: for a call to an unknown tool
  the SDK synthesizes its own `tool` message, and the loop must answer **every** call of a step (unknown
  and invalid ones included) in the one message `toolResultsMessage` builds, or the provider rejects the
  next request. `toolResultsMessage` emits `json` / `error-json` (or `text` / `error-text` for a string
  output); `userMessage` emits `{ role: 'user', content: text }`.
- **Log hygiene.** `streamText` gets `onError: () => undefined`: the SDK's default prints the raw error,
  whose `requestBodyValues` is the whole prompt. `AI_SDK_LOG_WARNINGS` is set to `false` and SDK call
  warnings are logged through the Nest logger as `ai.provider.warning` metadata (Gemini's
  `skip_thought_signature_validator` shows up there — finding 5). Nothing in the layer logs a key, a
  prompt, a header or a body, so no outbound request shape reaches pino and no new redact path was
  needed; a later change that logs one must add `x-api-key`, `x-goog-api-key`, `api-key` and
  `authorization` to the paths in `logging/logging.config.ts` (security.md §6.5). Upstream errors that
  echo the key (OpenAI's 401 message does) are dropped by the wrapping — the provider specs assert it
  on the thrown error and on every captured log line.
- **No egress outside the guard, no telemetry.** `streamText` gets an `experimental_download` that
  refuses every request (`EGRESS_DENIED`): otherwise the SDK would fetch a message's URL file part
  itself, with the global `fetch`, when the model cannot take the URL directly (INV-AI-7). It also gets
  `telemetry: { isEnabled: false }`, so a registered telemetry integration never receives prompts or
  completions (ADR-0031).
- **Environment fallbacks.** Every SDK factory gets `apiKey` and `baseURL` explicitly: the SDKs read not
  only `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` but also
  `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` when a value is omitted. A provider that requires a key and has
  none fails `PROVIDER_AUTH` before any I/O.
- **Anthropic `toolChoice: 'none'`.** The Anthropic SDK drops the whole `tools` array for `none`. The
  forced final step would then be rejected once the history holds `tool_use` blocks, and the frozen tools
  prefix would change. The definition's `adaptCall` hands the SDK `auto` and rewrites the request body to
  Anthropic's native `tool_choice: { type: 'none' }`, tools kept. OpenAI, Gemini (`mode: NONE`) and the
  compatible provider keep the tools on their own.
- **Per provider**, beyond the notes below: Anthropic caching is a `cacheControl` breakpoint on the system
  message plus the request-level automatic breakpoint (which follows the last message); OpenAI sends
  `store: false` and does **not** force `forceReasoning` — an id the SDK does not recognise as a reasoning
  model is sent as a plain model, because forcing it would break non-reasoning models (finding 4's
  trade-off); Gemini answers a bad key with a **400** `API_KEY_INVALID`, matched by `errorPatterns.auth`;
  the compatible provider sends no `effort` (servers differ on `reasoning_effort`) and no `Authorization`
  without a key.
- **Model listing** has its own 15 s deadline (`MODEL_LIST_TIMEOUT_MS`, headers and body) instead of the
  600 s step budget, plus an optional caller signal; a timeout is `PROVIDER_UNAVAILABLE`. It is a capped
  (2 MiB, 500 entries) GET through the guarded fetch; the upstream body is
  read only to parse or classify, never returned. OpenAI's list drops non-chat ids; Gemini's keeps only
  `generateContent` models.

Shared descriptors drive the setup wizard generically:
`{ kind, label, requiresApiKey, requiresBaseUrl, defaultBaseUrl, suggestedModel, supportsModelListing }`.

Per-provider notes [C]:

- **anthropic**
  - Always pass `apiKey` explicitly, so the SDK's `ANTHROPIC_API_KEY` env fallback can never
    silently apply.
  - Set `cacheControl` on the end of the system prompt and on the last message.
  - Map `effort` to `providerOptions.anthropic`. Never send `temperature`.
  - Model listing via `GET /v1/models`.
- **openai**
  - Responses API with **`store: false`**, so provider-side retention is off by default, plus
    `include: ['reasoning.encrypted_content']` so reasoning replays statelessly.
  - `reasoningEffort` comes from `effort`.
  - Model listing via `GET /v1/models`.
- **google**
  - Uses `@ai-sdk/google` (Gemini API key, not Vertex); thinking level comes from `effort`.
  - Model listing via `GET /v1beta/models`, filtered to `generateContent`.
- **openai-compatible**
  - `createOpenAICompatible({ baseURL, apiKey?, includeUsage: true, fetch })`.
  - Model listing via `GET {baseURL}/models`, with free-text entry as the fallback.
  - The only provider whose optional `temperature` extra is honoured.

**Adding a provider** (for example Bedrock, Mistral or Azure) is five steps, with no migration
because `provider` is a text column validated on write:

1. Add the kind and its descriptor (and an optional `providerOptions` zod schema) to
   `packages/shared/src/schemas/ai-provider.ts`.
2. Create `apps/api/src/ai/providers/<kind>/<kind>.provider.ts` implementing
   `LlmProviderDefinition`, with its spec.
3. Register it with one line in `provider.registry.ts`.
4. Add a Manual line (en and es).
5. Add a line in this note.

If the AI SDK lags on a provider, that one definition can implement `ChatModelPort` directly over the
official SDK (the A3 escape hatch) without touching the runtime.

### 6.4 The agent loop (one run = one user message or one headless prompt)

```
guardrails():  AI enabled? principal still active? holds ai:use? cancel requested?
               conversation open (not closed / version-pinned mismatch)? daily token budget left?
               stepCount < maxStepsPerRun? lastInputTokens < contextTokenLimit?
step():        streamText(instructions = conversation.frozenSystem, tools = conversation.frozenToolset,
                          messages = persisted history (append-only), toolChoice = auto | none(last),
                          maxOutputTokens, providerOptions, abortSignal)
               → emit message.delta … ; persist assistant ModelMessage + AiUsage row (one tx)
if no tool calls                 → SUCCEEDED
validate each call vs JSON schema; unknown / out-of-toolset → error result
reads                            → AiToolService.invoke now (bounded parallelism); the Nest pipeline
                                   re-loads the principal on every call (R1)
writes, policy AUTONOMOUS        → AiToolService.invoke now, if the SA's AI access setting allows writes
                                   and the per-run mutation cap is not reached; AiActionLog
                                   ATTEMPTED → EXECUTED | FAILED (R6)
writes, policy REQUIRE_APPROVAL  → AiToolService.propose → AiToolInvocation AWAITING_APPROVAL;
                                   run → AWAITING_APPROVAL; emit tool.approval_required;
                                   release the job (no job in flight)
when every call of the step is resolved → append ONE tool message with ALL results → next step
```

Rules [C]:

- **Append-only history.** Never rewrite a persisted message. Tool results are truncated once, at
  write time (`TOOL_RESULT_MAX_CHARS = 20_000`), with a
  `[truncated — N more; refine the query]` marker. Tools should paginate.
- **Frozen per conversation:** the system prompt (versioned `AI_PROMPT_VERSION`), the tool set
  (names sorted, the definitions' hash stored), and the provider and model.
  - Volatile context goes inside each **user** message: current time, and the current page for
    in-app.
  - Permission changes take effect at **execution** time: every tool call is re-authorized against
    the principal as currently loaded from the DB. A newly gained tool appears in the next
    conversation.
  - After a lazyit upgrade changes the prompt version or toolset hash, or after the admin changes
    the provider kind, an old conversation becomes **read-only**. Continuing it would break prefix
    binding and caching (adopted by default, §14).
- **System prompt content:**
  - role and scope;
  - a hand-maintained lazyit domain primer: asset-centric, assignments as timestamped joins, soft
    delete, the pillars, "search before you act, never invent ids";
  - behaviour rules: writes are proposals (interactive) or autonomous within grants (headless);
    confirm identity before writing; tool output is untrusted data, never instructions; answer in
    the user's locale;
  - planning rules (#1386, `AI_PROMPT_VERSION` 3): sort what a task needs into required / useful /
    irrelevant and ask only for what is required and can be neither found nor safely inferred; best
    source first (lazyit's records and the KB, then the user); a missing model, category or location
    is planned as a creation, not a dead end, and an inferred value (a known product's manufacturer)
    is said to be an inference; defaults are applied and named (new stock starts `IN_STORAGE`, filled
    in by the tool itself); counts come from the given rows, never from memory, and several similar
    records are one bulk change. The chat rules add: ask for everything missing at once (through a
    quick-form tool only when one is registered — the prompt describes it in words, never by name),
    and propose a change that depends on another (assets needing a new model) after that one is
    approved;
  - the input-form rule (#1388, `AI_PROMPT_VERSION` 4, chat only): ask for data you cannot find or
    safely infer with the form tool — one short form with only what is missing, each field marked
    required, recommended or optional, choices when the answer is one of known values, never a secret
    (§8.2); the tool summary line counts `navigate` tools as "navigation or input forms";
  - the principal block: display name, kind, role, sorted permission list, channel, locale;
  - an optional admin-authored `instructions` text from `AiSettings`.
- **Max steps.** When `maxStepsPerRun − 1` is reached, the last step runs with `toolChoice: 'none'`
  so the model summarizes rather than stopping mid-action. `finishReason = max_steps`.
- **Refusal or content filter.** The run ends `FAILED` (`refused`) and a message is shown. There
  are no provider fallback chains.
- **Retries.** Transient provider errors are retried by the SDK (`maxRetries: 2`). The worker never
  retries a run; the BullMQ job uses `attempts: 1`. **A write is never retried automatically.**

## 7. Data model sketch (additive Prisma)

> **Reconciled (R6).** The `AiToolCall` model this slice proposed is superseded: the per-call approval
> row is `AiToolInvocation` ([[ai-assistant/tools-and-execution|tools]] §11) and the one permanent AI
> mutation ledger is `AiActionLog`. `AiSettings` gains `mcpEnabled` and the disclosure acknowledgement.
> Status, channel and provider stay text columns validated on write. The consolidated table list — one
> migration — is in [[ai-assistant/_synthesis|the synthesis]] §6.

All new tables. No existing table changes (the two `aiInvocationId` columns belong to the tools slice). IDs follow [[0005-id-strategy]]; integers are bounded in
zod per [[0036-int4-bounded-integers]].

```prisma
model AiSettings {                         // singleton; migration CHECK (id = 'singleton')
  id                          String    @id @default("singleton")
  enabled                     Boolean   @default(false)
  provider                    String?   // anthropic | openai | google | openai-compatible (zod on write, tolerant on read)
  model                       String?
  baseUrl                     String?
  apiKeyCiphertext            String?
  apiKeyIv                    String?
  apiKeyAuthTag               String?
  apiKeyKeyVersion            Int?
  allowPrivateNetwork         Boolean   @default(false)   // openai-compatible only; scoped to baseUrl's host
  effort                      String?   // low | medium | high → mapped per provider; null = provider default
  providerOptions             Json?     // per-provider zod-validated extras (e.g. openai-compatible temperature)
  instructions                String?   // admin addendum to the frozen system prompt (≤ 4000 chars)
  maxStepsPerRun              Int       @default(20)
  maxOutputTokens             Int       @default(16000)
  contextTokenLimit           Int       @default(150000)
  dailyTokenLimitPerPrincipal Int?      @default(2000000)  // null = unlimited
  retentionDays               Int       @default(90)       // zod range 7–3650
  approvalTtlMinutes          Int       @default(30)       // reconciled (tools/security notes)
  mcpEnabled                  Boolean   @default(false)    // independent of provider config
  disclosureAcknowledgedAt    DateTime?                    // egress disclosure, required to enable
  disclosureAcknowledgedById  String?   @db.Uuid
  verifiedAt                  DateTime?
  updatedById                 String?   @db.Uuid           // User, SetNull
  createdAt                   DateTime  @default(now())
  updatedAt                   DateTime  @updatedAt
  @@map("ai_settings")
}

model AiConversation {                     // transcript container; retention hard-deletes (like Notification)
  id              String    @id @default(cuid())
  channel         String    // CHAT | HEADLESS
  userId          String?   @db.Uuid       // owner — exactly one of userId / serviceAccountId (CHECK)
  serviceAccountId String?
  title           String?
  provider        String    // pinned at creation
  model           String
  promptVersion   Int
  toolsetHash     String
  toolNames       String[]
  closedReason    String?   // CONTEXT_LIMIT | CONFIG_CHANGED | VERSION_CHANGED
  lastActivityAt  DateTime  @default(now())
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  @@index([userId, lastActivityAt])
  @@index([serviceAccountId, lastActivityAt])
  @@index([lastActivityAt])
  @@map("ai_conversations")
}

model AiMessage {                          // append-only, ordered
  id             BigInt   @id @default(autoincrement())
  conversationId String                    // FK Cascade (retention is the only deleter)
  runId          String?                   // FK SetNull
  seq            Int
  role           String   // user | assistant | tool
  content        Json     // exact provider-replayable ModelMessage
  format         String   @default("aisdk-v7")   // converter hook for future SDK majors
  createdAt      DateTime @default(now())
  @@unique([conversationId, seq])
  @@map("ai_messages")
}

model AiRun {                              // mutable lifecycle row (ManualTask precedent); no content
  id               String    @id @default(cuid())
  conversationId   String?                 // FK SetNull (survives retention)
  channel          String
  userId           String?   @db.Uuid      // acting principal — exactly one (CHECK)
  serviceAccountId String?
  status           String    // QUEUED | RUNNING | AWAITING_APPROVAL | SUCCEEDED | FAILED | CANCELLED | EXPIRED
  approvalPolicy   String    // REQUIRE_APPROVAL_FOR_WRITES | AUTONOMOUS
  provider         String
  model            String
  stepCount        Int       @default(0)
  inputTokens      Int       @default(0)
  outputTokens     Int       @default(0)
  cachedInputTokens Int      @default(0)
  finishReason     String?
  error            Json?     // redacted { class, message }
  idempotencyKey   String?   // partial unique per principal (raw SQL)
  cancelRequestedAt DateTime?
  startedAt        DateTime?
  finishedAt       DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  @@index([status, updatedAt])
  @@map("ai_runs")
}

// AiToolCall — superseded (R6): the per-call row is AiToolInvocation and the permanent
// mutation ledger is AiActionLog; see tools-and-execution §11.

model AiUsage {                            // append-only per model step; budgets + usage view
  id               BigInt   @id @default(autoincrement())
  runId            String
  userId           String?  @db.Uuid
  serviceAccountId String?
  provider         String
  model            String
  inputTokens      Int
  outputTokens     Int
  cachedInputTokens Int     @default(0)
  reasoningTokens  Int?
  createdAt        DateTime @default(now())
  @@index([userId, createdAt])
  @@index([serviceAccountId, createdAt])
  @@map("ai_usage")
}
```

**Retention [C].** A periodic sweep deletes the following for conversations whose
`lastActivityAt < now − retentionDays` and that have no active run:

- the conversation, and its messages and tool invocations by cascade.

`AiActionLog` rows (the mutation ledger), `AiRun` rows and `AiUsage` rows are **kept**; they carry no
transcript. This follows the ADR-0056 §7 reasoning: "the bell is allowed to forget; the ledgers
are not." It is a documented, deliberate exception to soft delete for transcripts and must be
recorded in the ADR.

**As built (W3-6, `apps/api/src/ai/retention/`).**

- **One deleter.** `AiConversationPurgeService` is the only code that deletes a conversation. Every
  delete locks the candidate rows (`SELECT … FOR UPDATE`, with `SKIP LOCKED` for the sweeper), re-reads
  their runs and invocations in new statements, drops any conversation with a `QUEUED`, `RUNNING` or
  `AWAITING_APPROVAL` run or an `AWAITING_APPROVAL` or `EXECUTING` tool invocation, and deletes what still matches the caller's guard (the age cut-off, the
  owner, the offboarded owner). The runtime's submit takes the same row lock (it bumps
  `lastActivityAt`) before it creates a run, so a run never starts in a conversation being deleted and a
  conversation with an active run is never deleted. Transactions carry a 30 s timeout.
- **The sweeper** (`AiRetentionSweeper`) runs **hourly**, rather than daily, so the offboarding purge
  lands within the hour; a plain `unref`'d interval not started under `NODE_ENV=test` (the notifications
  retention precedent), re-entrancy guarded. Each pass, independently: (1) conversations past
  retention; (2) conversations of offboarded users — `User.deletedAt` set, whatever their age;
  (3) conversation-less (MCP) invocations past retention that are not `AWAITING_APPROVAL` or
  `EXECUTING`. Batches of 100, at most 20 batches per step per pass; whatever is left, and anything
  skipped, waits for the next pass. The log line carries counts only; an error is logged by class and
  code.
- **The window** is `AiSettings.retentionDays` through `AI_SETTINGS_READER`, clamped to 7–3650 on read:
  a hand-edited value below 7 reads as 7 (it can never shorten the window below the floor), and one above
  3650 reads as 3650 (that does delete earlier than the row asks — the documented range wins); a
  non-integer reads as 90. With no settings row the
  default 90 applies. A failed settings read skips the whole pass.
- **AI off.** The sweeper keeps running while the assistant is disabled (frontend §11 item 4: dormant
  conversations, retention keeps running).
- **Owner delete** — `deleteOwned(identity, id)` for `DELETE /ai/conversations/:id` (W3-1): owner only,
  anyone else and a missing id 404; an active run 409 `RUN_IN_PROGRESS` (cancel first); a blocking row
  lock, so it waits for a concurrent submit and then refuses.
- **Offboarding.** Offboarding soft-deletes the user and bumps `sessionEpoch`; the users module has no
  event or hook, and the soft delete is the durable signal, so the sweeper's offboarded-owner step is
  the purge — it needs no change to the users module. Only `User.deletedAt` triggers the offboarding
  purge; a plain deactivation does not, and a directory reconcile's soft offboarding
  (`isActive = false` + `directoryOffboardedAt`, no `deletedAt`) does not either — those conversations
  follow normal retention (CEO decision 2026-09-24). A run still active at offboarding ends at
  its next step (the epoch bump) or by approval expiry, and its conversation goes on the following pass. `purgeForUser(userId)` is exported for a
  synchronous caller should one be wired. A user restored before the pass keeps their conversations.
  Service-account conversations follow retention only; revoking an SA does not purge them.

## 8. Approval state machine

```mermaid
stateDiagram-v2
  [*] --> QUEUED: POST message / POST /ai/runs
  QUEUED --> RUNNING: worker CAS (status=QUEUED)
  RUNNING --> RUNNING: step with only reads / autonomous writes
  RUNNING --> AWAITING_APPROVAL: step proposes ≥1 write (REQUIRE_APPROVAL policy)
  AWAITING_APPROVAL --> QUEUED: last pending call decided → resume job (jobId ai-run:{id}:resume:{step})
  AWAITING_APPROVAL --> EXPIRED: approval TTL elapsed (sweeper)
  AWAITING_APPROVAL --> CANCELLED: user cancel · AI disabled · ai:use lost
  RUNNING --> SUCCEEDED: final step without tool calls (incl. forced summary at max steps)
  RUNNING --> FAILED: provider error · budget · refusal · context limit · engine-restart
  RUNNING --> CANCELLED: cancel observed at step boundary (LLM stream aborted)
  SUCCEEDED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
  EXPIRED --> [*]
```

Tool-call lifecycle:

The row is `AiToolInvocation`; its reconciled status set is in [[ai-assistant/_synthesis|the synthesis]]
§4.4.

- Reads and autonomous writes: `EXECUTING → SUCCEEDED | FAILED | DENIED`.
- Interactive writes: `AWAITING_APPROVAL → REJECTED | EXPIRED | CANCELLED`, or the atomic approve claim
  `AWAITING_APPROVAL → EXECUTING → SUCCEEDED | FAILED | OUTCOME_UNKNOWN`.
- Every write lifecycle event is also appended to `AiActionLog` (R6).

Invariants [C]:

1. **Who decides.** Only the run's own human principal may approve or reject. Admins cannot approve
   on someone else's behalf.
2. **Race-safe decisions.** A decision is a compare-and-set: `UPDATE … WHERE status =
   'AWAITING_APPROVAL' AND run.status = 'AWAITING_APPROVAL'`. The last decision in a step enqueues
   the resume, and the deterministic `jobId` dedupes double clicks.
3. **Checks before an approved write executes:**
   - AI is still enabled;
   - the principal is active and holds `ai:use` plus the tool's permission, as loaded **now** from
     the DB;
   - `inputHash` is unchanged, and the target's `updatedAt` precondition still holds (else `STALE`);
   - for an `elevated` tool, the password step-up in the decision request verified.
   Then compare-and-set `AWAITING_APPROVAL → EXECUTING`. **What was approved is exactly what runs** (no
   approve-with-edits in v1).
4. **Reject.** A rejected write returns `is_error` tool output: "The user declined this action.
   Reason: …". The loop continues so the model can respond.
5. **Every tool call is answered** (Anthropic requires a result for every tool use). Expiry, cancel
   and "AI disabled" append **synthetic error results** for every unanswered call before
   finalizing, so the conversation stays valid.
6. **One active run per conversation.** A new message while a run is `QUEUED`, `RUNNING` or
   `AWAITING_APPROVAL` returns 409.
7. **Crash safety** (ADR-0054 CCOR precedents):
   - the sweeper re-enqueues `AWAITING_APPROVAL` runs whose calls are all decided but not resumed
     after 60 s;
   - it finalizes `RUNNING` runs with no in-flight job after 5 min as `FAILED` (`engine-restart`);
   - any `EXECUTING` call becomes `OUTCOME_UNKNOWN` and is **never** retried.
8. **Headless.** A service-account principal gets `AUTONOMOUS`, bounded by its per-SA AI access
   setting (off / read-only / read-write; optional mutation cap per run) — CEO round 2, per-SA placement
   to confirm on review. A human calling `POST /ai/runs` gets `REQUIRE_APPROVAL_FOR_WRITES` and can
   decide through the same approval endpoint.

### 8.1 As built (W2-3, #1315) — `apps/api/src/ai/runtime/`

| File | What it is |
| --- | --- |
| `ai-runtime.module.ts` | registers the `ai-run` queue; imports the tool core, the provider layer, the settings reader and the prompt builder; binds and exports `RUN_EVENT_BUS` (and the concrete `InProcessRunEventBus`), exports `AgentRunOrchestrator` and `AiApprovalService` for W3-1 |
| `agent-run.orchestrator.ts` | the service API of the HTTP surfaces: `createConversation`, `submit` (message or headless prompt → `{ runId, conversationId, status, replayed }`), `cancel`, `ownedRun` |
| `agent-loop.ts` | the loop (`advance(runId)`): claim QUEUED → RUNNING, guardrails, one `ChatModelPort.step` per iteration, resolve every call, pause or continue |
| `agent-run.worker.ts` | `@Processor('ai-run')`, concurrency `AI_WORKER_CONCURRENCY` (default 4, max 16); `start` and `resume` both call `advance`; never rethrows |
| `agent-run.sweeper.ts` | the reconciler (every 30 s, off under `NODE_ENV=test`) |
| `approval.service.ts` + `step-up.verifier.ts` | the runtime side of a decision, with the password step-up |
| `run-lifecycle.ts` | events, append-only rows, answering a step, terminal transitions, the resume hand-off |
| `principal-context.ts` | re-load and re-authorize the principal (`ai:use`, the per-SA setting, `infra:report`) |
| `limits.ts` | budget and context queries, token buckets, tool-output cap, turn-context neutralization, toolset hash |
| `run-event-bus.ts` | the in-process bus with replay |
| `run-records.ts`, `run-queue.ts`, `runtime.constants.ts` | stored-row formats, the queue producer, limits and timings |

**Channels.** `CHAT` is the human channel (`REQUIRE_APPROVAL_FOR_WRITES`) and `HEADLESS` the Service
Account channel (`AUTONOMOUS`): a human submitting on `HEADLESS`, or a Service Account on `CHAT`, is refused
403. The headless endpoint (W3-1) therefore maps a human's `POST /ai/runs` to the `CHAT` channel — the
§8 invariant 8 case — and a Service Account's to `HEADLESS`.

**Conversations are frozen at creation.** `createConversation` (and `submit` without a conversation) pins
the configured provider and model, `AI_PROMPT_VERSION`, the toolset `AiToolService.list` gives the principal
**now** (with the headless ceiling) — `toolNames` plus `toolsetHash`, a SHA-256 over each tool's name,
description, class and input schema — and builds the system prompt **once** from that listing's classes.
The prompt text is stored as the conversation's first `ai_messages` row (see *Stored rows*). Before each
submission and each step the pin is re-checked: a different provider — or, for a conversation on the
instance default model (`modelChosen = false`), a different default model — closes the conversation
`CONFIG_CHANGED` (a model the user chose, #1373, is not affected by the admin's default), a different prompt version or toolset hash `VERSION_CHANGED`, a last step whose input
tokens reached `contextTokenLimit` `CONTEXT_LIMIT`; a closed conversation answers 409
`CONVERSATION_READ_ONLY`. A permission lost since creation does not close it: the call is refused at
execution time.

**Stored rows.** `ai_messages` holds provider messages (`format = aisdk-v7`, replayed byte for byte) and
three kinds of runtime record, role `system`, never sent to the model:

- `lazyit-system-prompt-v1` `{ text }` — the frozen system prompt, seq 0, sent as `instructions`;
- `lazyit-run-v1` `{ runId, sessionEpoch }` — written with each user message: the chat session epoch the
  run's tool calls are delegated under, so a logout, password change or deactivation refuses the next
  step (the run row has no column for it, and the job carries only `{ runId }`);
- `lazyit-step-v1` `{ stepIndex, calls, outcomes, untrustedSources }` — written with a step's assistant
  message (its calls) and again when the step pauses (the read results already known, and the pending
  invocation ids); the latest record of a step wins.

The conversation projection (W3-1) **must allow-list by format** — read `aisdk-v7` rows only, never
filter out `lazyit-*` — and carry a test that a runtime record never reaches the wire (done: §9.1 *As built
(W3-1)*, `conversations/transcript-projection.spec.ts`).
Records are append-only and go with the conversation (retention, owner delete).

**A run.** `submit`: principal and AI checks → idempotency replay (headless `Idempotency-Key`; a unique
violation race returns the existing run) → rate limit (30 creations per principal per minute, token
bucket) → at most 3 active runs per principal → budget → conversation → 409 `RUN_IN_PROGRESS` when the
conversation has an active run → the user message, prefixed with `buildTurnContext({ now, route })` (the
route only on `CHAT`) and with any user-typed turn-context tag neutralized — every `<` that opens
something reading as `turn_context`, opening or closing, with whitespace, attributes, line breaks or no
`>` at all, becomes `&lt;` → one
transaction that locks the conversation row, re-checks the active run, and writes the QUEUED run, the run
record and the user message → `run.status QUEUED` → the start job `start-<runId>`. A failed enqueue leaves
the run QUEUED for the sweeper. Before the user message, a step left unanswered by an earlier run is
answered (a repair; only when no run is active).

`advance(runId)` claims QUEUED → RUNNING (a duplicate or stale job does nothing), answers the step a resume
was waiting on, then loops. Before every step: cancel requested → CANCELLED; AI off → CANCELLED
`AI_DISABLED`; the principal re-loaded and re-authorized (`ai:use`, and for a Service Account its AI access
setting and no `infra:report`) else FAILED `FORBIDDEN`; the pin (above); the rolling 24 h budget from
`ai_usage` (`dailyTokenLimitPerPrincipal`, null = none) else FAILED `BUDGET_EXCEEDED`; the context cap; the
step cap. The step whose number reaches `maxStepsPerRun`, or the first after the run made 30 tool calls,
runs with `toolChoice: 'none'`, and its answer finishes the run with `finishReason = max_steps`. Each step
persists, in one transaction, the assistant message, its step record, an `AiUsage` row and the run's
counters. `finishReason = content-filter` → FAILED `PROVIDER_REFUSED`. An `AiProviderError` is mapped by
`code`: `CANCELLED` (our abort) → CANCELLED, `AI_DISABLED` → CANCELLED, `CONTEXT_LIMIT` and
`CONVERSATION_READ_ONLY` close the conversation, any other code fails the run with that code (and
`retryAfterSec`). Any other exception fails the run `INTERNAL`: invocations of the run still EXECUTING
become OUTCOME_UNKNOWN and every unanswered call is answered `UNKNOWN_OUTCOME` (whether it took effect is
not known; it is never retried).

**Every call is answered.** Every call gets a non-empty id unique within the run: an empty or repeated
id from the model is replaced by `lz_<runId>_<step>_<index>` (it keys the step record, the pending
invocation's `toolUseId`, the events and the decision). Before any call runs, the run is re-read: if it is
no longer RUNNING (another actor moved it during the model step) nothing is resolved, and a cancel
requested meanwhile ends it CANCELLED. Calls are resolved in order. A name not in the conversation's frozen tool map
(a `Map`, so `constructor` or `__proto__` never resolve) → `NOT_AVAILABLE`; arguments that arrived as the
raw string (invalid JSON) → `INVALID_INPUT`; past 30 calls per run or the per-principal bucket (60 per
minute) → `RATE_LIMITED`. Reads and navigation → `invoke`. Chat writes → `propose` with the tool-use id (at
most 5 pending per step; more → `RATE_LIMITED`). Headless writes → `invoke` after the per-run mutation cap
(attempted writes of the run in `ai_tool_invocations`; over the cap → `FORBIDDEN`). Each call's context
carries the provenance `{ provider, model }` and the turn's untrusted sources: the entity refs of every read
result whose data held `<untrusted_content>`, merged across the run. Every step record stores the merged
set so far, so a resumed run rebuilds it exactly (T-03). Outputs are capped once, at write time
(`AI_TOOL_OUTPUT_MAX_CHARS = 24 000` serialized, a `[truncated — N more characters; refine the query]`
marker; core already truncates the data at 20 000). With no pending proposal the step's single tool message
is appended and the loop continues. With one or more: the step record (known results + pending ids) is
written and RUNNING → AWAITING_APPROVAL compare-and-set in one transaction — only while no cancel is
requested (else the run ends CANCELLED and the proposals are cancelled) — then `tool.approval_required`
is emitted for each card and `run.status AWAITING_APPROVAL`, and a decision that already landed resumes the
run at once. No job stays in flight.

**Terminal transitions** (`run-lifecycle.ts` `finalize`) are a compare-and-set from the allowed statuses;
the winner cancels the run's still-pending approvals (core `cancel`), answers the open step (recorded
results, decided invocations' stored results, else a synthetic error naming why), and emits `run.status`
and `run.finished`. Expiry, cancel, AI-disabled and engine-restart all end with a valid history.

**Resume.** When no invocation of the run is `AWAITING_APPROVAL` or `EXECUTING`, AWAITING_APPROVAL →
QUEUED (compare-and-set, so a double decision resumes once) and the job `resume-<runId>-<stepCount>`.

**Cancel** (owner only, else 404): sets `cancelRequestedAt`; a QUEUED or AWAITING_APPROVAL run ends
CANCELLED at once; a RUNNING one at its next step boundary, and its in-flight model call is aborted when it
runs in this process.

**Sweeper** (`agent-run.sweeper.ts`, the workflow-run precedent): (1) `expireDue` → each affected run ends
EXPIRED (`finishReason = approval_expired`); (2) an invocation EXECUTING for 5 min whose run is not RUNNING
(the process died inside `approve`) → `markOutcomeUnknown`; (3) AWAITING_APPROVAL runs idle for 60 s:
CANCELLED when AI is off or the principal no longer passes (`AI_DISABLED` / `FORBIDDEN`), else a lost
resume is re-enqueued under a rotating job id; (4) QUEUED runs idle 30 s with no job → re-enqueued;
(5) RUNNING runs idle 5 min with no job, and not being driven by this process (a long model step) → their EXECUTING invocations `markOutcomeUnknown`, the run FAILED
`ENGINE_RESTART`, the calls answered with `UNKNOWN_OUTCOME`. A crashed run is **never resumed**, so a write
cannot run twice; BullMQ's stalled re-delivery finds it RUNNING and does nothing. When the broker cannot be
read, (4) and (5) skip the pass.

**Decisions** (`AiApprovalService.decide({ runId, toolCallId, decision, reason?, password?, identity })`,
for the W3-1 decision endpoint): a non-human identity → 403; a run or invocation that is not the caller's
own chat run → 404; a run not AWAITING_APPROVAL (finished, cancelled, already resumed — a double click
after the resume) → 409 `RUN_NOT_AWAITING_APPROVAL`; an approval while AI is switched off
(`resolveProviderConfig()` null) → 409 `AI_DISABLED`, the action stays pending (§8 invariant 3). `toolCallId` is the provider tool-use id announced in `tool.approval_required`. An
approval whose stored preview requires step-up (core's `requiresStepUp`) needs the password: none → 403
`STEP_UP_REQUIRED`; the user re-loaded at the session's epoch, then `LocalCredentialService.verify`
against the current hash — at most one verification in flight per user (a concurrent attempt is answered
429 without reaching the KDF) and each attempt counted as a failure before the KDF runs (cleared by a
success), so a burst of concurrent guesses is one guess; wrong → 403 `STEP_UP_FAILED`; after 5 failures an exponential lock from 1 s to
15 min (the `LoginService` policy, per user, in memory) → 429 `STEP_UP_RATE_LIMITED` with
`retryAfterSec`; outside `AUTH_MODE=local` → 403 `STEP_UP_UNAVAILABLE` (no lazyit password exists: such
actions cannot be approved from the chat — fail closed). Only a verified password calls core's
`approve(…, { stepUpVerified: true })`; a missing or wrong one never consumes the action. A password sent
for an action without step-up is ignored. Core's own refusals pass through; a decision that finds the
action expired ends the run EXPIRED. It returns `{ action, runStatus }` and emits
`tool.approval_resolved` and, for an executed approval, `tool.result`.

**Events** are the shared union, validated before publishing (an event that does not parse — say, a tool
name the union cannot carry — is dropped and logged). `message.delta`/`message.completed` use
`messageId = <conversationId>:<seq>` of the assistant row the step persists. Logs (`ai.run.start`,
`ai.step.finish`, `ai.run.finish`) carry metadata only; a tool name the model invented is logged as
`(invalid)`, and a caught error is logged by class and code, never its message (a Prisma message can
carry row values).

**Soft limits (follow-up).** Two limits are soft: the 3-active-runs-per-principal cap is counted outside
the creating transaction, so simultaneous submissions to different conversations can briefly exceed it;
and the token budget is checked before each step, so the step that crosses it completes (a run can
overshoot by one step's tokens). Both fail closed on the next check.

**Not built here.** The HTTP endpoints and the SSE controller (W3-1, as built in §9.1 and §9.3);
per-conversation deletion and retention (W3-6, §7 "As built"); the MCP stale-`EXECUTING` sweep (W3-2). The sweeper's lost-resume threshold means a
decision made while Valkey is down resumes within about a minute of its return.

### 8.2 As built — input requests (#1388) — `runtime/input-requests.ts`, `runtime/input.service.ts`

The assistant can ask the person for data it is missing with a small form it designs — the CEO: "es como
si la ia desarrollara su propio form en base a lo que necesita, de esa forma el usuario no responde una
pregunta como tal, si no que interactua con lo que la ia necesita" (ADR-0097 decision 3, amended
2026-09-24). It is a second kind of pause, next to the approval, and reuses its machinery.

**The tool.** `request_input` (`tools/input-request.tools.ts`, the `interaction` toolset) is class
`navigate` with `awaitsInput: true`: chat-only (boot validation refuses `awaitsInput` on any other class,
and a `navigate` tool is never listed on MCP or headless), no domain write, no approval card, no ledger
event. Its primary binding is the permission-free `GET /users/me`, so any human holding `ai:use` has it.
Input: `title` (≤ 120), `reason` (≤ 500, why it is needed), `fields[]` and optional `groups[]` (repeat
groups: rows of the same columns, `minRows` 0–50, default 1, `maxRows` 1–50; at most 3 groups). A field is
`{ key, label, kind: text | textarea | number | date | select | multiselect | checkbox, importance:
required | recommended | optional, placeholder?, help?, options? | optionsFrom?, min?, max? }`; at most
**20 fields in total** (top-level plus every group's columns), unique keys, a select has exactly one of
`options` (≤ 100, strings or `{ value, label }`) or `optionsFrom`, `min`/`max` on numbers only.
`optionsFrom` is a closed list — `manufacturers` (the distinct `AssetModel.manufacturer` names, up to three
pages of models), `assetCategories`, `locations`, `assetModels` (ids, labelled "name (manufacturer)") —
resolved at call time through the list routes **as the user** (`rt.call`, so a list they cannot read
refuses the call with the route's 403; an empty list asks the model to use a text field).

**No secrets.** The tool refuses (`INVALID_INPUT`, with a message telling the model never to ask for
secrets) any form whose field or group key looks like a credential (`isSensitiveKey`, the ledger's
redaction list), or whose title, reason, label, placeholder or help names one — word-based, English and
Spanish (`password`, `passphrase`, `pwd`, `secret`, `token`, `credential`, `otp`, `mfa`, `2fa`, `pin`,
`cvv`, `contraseña`, `clave`, …, and the pairs `api key`, `private key`, `secret key`, `access key`,
`license key`, `ssh key`, `recovery code`, `security code`, `card number`). `secretary` or `passenger` pass.

**The pause.** The loop invokes the tool like a read (validation, the class ceiling, `ai:use` held now,
the option lists through the guards), then stores the form on an `ai_tool_invocations` row — status
`AWAITING_INPUT`, `toolUseId` = the call id, `input` = the model's arguments, `preview` = `{ kind:
"input_request", form }` (never an `AiActionPreview`, so no approval path reads it), `expiresAt` = now +
`approvalTtlMinutes` — and pauses the run `RUNNING → AWAITING_INPUT` exactly like an approval (the step
record first, then the compare-and-set, then the announcement: `tool.call` with status `AWAITING_INPUT`,
`input.required { toolCallId, form, expiresAt }`, `run.status AWAITING_INPUT`). Two limits keep the pause
unambiguous: **one form per step** (a second `request_input` in the step is answered `INVALID_INPUT`), and
**never in a step that changes data** (a `request_input` in a step that also calls a write is answered
`INVALID_INPUT` — "ask in a step of its own, before proposing any change" — and the writes pause for their
cards as usual). So a run waits either for approvals or for one form, never both.

**The answer.** `POST /ai/runs/:id/tool-calls/:toolCallId/input { action: submit | skip | cancel, values?,
groups? }` (`ai:use`; `AiInputService.submit`): a Service Account → 403; not the caller's own chat run or
form → 404; the run or the form not waiting → 409 `RUN_NOT_AWAITING_INPUT` (a double submit answers once);
past its expiry → the form and the run end EXPIRED, 409 `EXPIRED`; AI switched off → 409 `AI_DISABLED`
(the sweeper then cancels the run). `submit` is validated against the **stored** form by the shared
`checkAiInputAnswer` — unknown field or group, a required field left blank, a wrong type, an option that was
not offered, an impossible date, a number out of `min`/`max`, a row count outside `minRows..maxRows`, text
over 500 (`text`) or 4000 (`textarea`) characters → 400 `INVALID_INPUT` with `issues: [{ path, message }]`
(`values.<key>`, `groups.<key>`, `groups.<key>.<row>.<key>`) and the form keeps waiting. The answer is
normalized (text trimmed, numbers sent as text parsed, multiselect de-duplicated, blanks dropped) and
becomes the call's result (`kind: navigate`, `mutated: false`): `{ outcome: "submitted", providedBy:
"user", answer: { values, groups }, labels? }` (`labels` names the chosen options of an `optionsFrom`
select, whose values are ids; those names come from lazyit records, so each is wrapped as
`<untrusted_content>`). `skip` → `{ outcome: "skipped", note }` (continue without it); `cancel` →
`{ outcome: "declined", note }` (do not ask again). The answer is **user-provided**: the owner typed it
for their own run, so it is not wrapped as `<untrusted_content>` — only the `labels` taken from lazyit
records are. Row status `SUCCEEDED` (submitted) or
`REJECTED` (skipped, declined); `input.resolved { toolCallId, outcome }` and `tool.result` are emitted and
the run resumes (`AWAITING_INPUT → QUEUED`, the same `resumeIfDecided` as an approval).

**Expiry, cancel, kill switch** — as for approvals: the sweeper expires forms past `expiresAt` (row
`EXPIRED`, `input.resolved expired`, the run EXPIRED with `finishReason: input_expired`, the call answered
`EXPIRED`); cancelling the run, or any finalization, closes a waiting form `CANCELLED` (`input.resolved
cancelled`); an AWAITING_INPUT run is cancelled by the sweeper when AI is turned off or the principal lost
`ai:use`, and a lost resume is re-enqueued. `AWAITING_INPUT` counts as an active run (one per conversation,
three per principal), and a conversation holding one is never purged. The stream closes after `run.status
AWAITING_INPUT` like after `AWAITING_APPROVAL`; `run.snapshot` carries `pendingInputs`; the conversation
state is `awaiting-input`; the transcript part `{ type: "input", request, outcome, answer? }` follows the
call's tool part.

**MCP elicitation is not built.** The tool is chat-only; over MCP the client's own elicitation would be
the equivalent, and lazyit does not use it yet (§13).

## 9. HTTP surfaces and the stream contract

### 9.1 Endpoints

**Configuration** — `settings:manage` plus `ServicePrincipalForbiddenGuard`, per the ADR-0079 posture:

- `GET /config/ai` returns redacted settings plus `apiKeySet` and `keyConfigured` (whether
  `AI_SECRET_KEY` is usable).
- `PUT /config/ai`. The API key is write-only: omit it to keep, send a value to set, send `null` to
  clear. A key write with no usable `AI_SECRET_KEY` returns **409**. **Destination binding
  (INV-AI-6):** changing `provider` or `baseUrl` clears the stored key, so a new key must accompany the
  change.
  - **MCP switch:** `mcpEnabled` is independent of the provider fields and passes no enable gate (CEO,
    round 2).
  - **Disclosure:** the first `enabled: true` requires the egress-disclosure acknowledgement, which is
    recorded with its author.
  - **Enable gate:** the server refuses (422, with the test result) to persist `enabled: true` when
    connection fields changed since `verifiedAt`, or `verifiedAt` is null, and an inline connection
    test fails.
- `POST /config/ai/test` tests a **draft** (body fields override the saved ones, and the key may be
  supplied inline). It returns `{ ok, checks: { auth, model, toolCalling }, latencyMs, error }`.
  The tool-calling check sends one prompt with a dummy `ping` tool and requires a tool call. This
  catches local models that do not support tools.
- `POST /config/ai/models` lists models for a draft or saved config.

> **As built (W2-2, #1315)** — `apps/api/src/ai/settings/`, `apps/api/src/common/crypto/envelope-cipher.ts`:
>
> - **Gate.** `settings:manage` at class level plus `ServicePrincipalForbiddenGuard`: a service account
>   is refused even if it holds the permission (ADR-0048). The key never appears in a response, an
>   error, a log line or the audit.
> - **Key custody.** `EnvelopeCipher` is a generic AES-256-GCM envelope keyed by an env var name (the
>   `smtp.crypto.ts` / `directory.crypto.ts` shape, generalized; SMTP and directory are not migrated).
>   The key is read lazily on every call, so the API boots without it; the envelope binds the purpose
>   `ai_settings.apiKey` as GCM additional data. A key write without a usable `AI_SECRET_KEY` → 409.
> - **Destination binding** also applies to the test: `POST /config/ai/test` uses the SAVED key only
>   while the draft keeps the saved provider and base URL; otherwise only an inline key is sent.
> - **`verifiedAt`** is cleared by any change to a connection field — provider, model, base URL, the
>   key, `allowPrivateNetwork`, `effort` or `providerOptions`. `PUT` never stamps it for a disabled
>   save; `enabled: true` runs the inline test when it is null and stamps it on a pass. `POST /test`
>   persists nothing.
> - **Enable gate order** (a refused save persists nothing): shim mode → 409; no disclosure → 422
>   `DISCLOSURE_REQUIRED`; no provider/model (or base URL for OpenAI-compatible) → 422
>   `PROVIDER_NOT_CONFIGURED`; a provider that takes a key, or any stored key, without a usable
>   `AI_SECRET_KEY` → 409; no key for a key-requiring provider → 422 `API_KEY_REQUIRED`; a failing
>   inline test → 422 `CONNECTION_TEST_FAILED` with `test`. The 422 body is `{ code, message, test? }`.
> - **Disclosure** is recorded once (`acknowledgeDisclosure: true` while none is stored), with its
>   author on the row and a `disclosure.acknowledged` audit row.
> - **Base URL checks beyond zod** (400, on save and on test): no userinfo, query string or fragment;
>   `http://` only for `openai-compatible` with `allowPrivateNetwork`, and never to a public IP literal;
>   loopback, link-local, metadata and reserved IP literals and `localhost` / `*.localhost` names are
>   refused for every scheme; a private or ULA literal needs `allowPrivateNetwork`. A **name** cannot be
>   classified without DNS, so it is saved and the **provider layer's egress guard enforces the
>   resolved-address check at call time** (INV-AI-7; W2-1). Provider options are re-checked per provider.
> - **Concurrent saves.** The save is a conditional write on the `updatedAt` it read (`updateMany`), and
>   a first save that races another creation fails on the singleton id; either answers **409** and
>   writes neither the row nor audit rows. The destination check that decides whether the stored key
>   survives therefore always sees the row it replaces. No lock is held across the inline test.
> - **Shim mode.** `POST /config/ai/test` answers 409 without a provider call, and the reader ignores a
>   test override.
> - **Allowlist admin surface:** the overlay (`mcpClientAllowlistAdded`, `mcpClientAllowlistRemovedDefaults`,
>   `mcpAllowAnyHttpsClient`) is saved wholesale through `PUT /config/ai`, validated by the shared
>   schema (the private-use-scheme amendment included), and read back read-tolerant. The curated
>   defaults and enforcement at registration/authorize belong to the OAuth units (W2-4/W3-3).
> - **Connection tester.** One `ChatModelPort.step()` with a dummy `ping` tool. The port names only
>   `{ provider, modelId }`, so the draft reaches the provider layer through the settings reader: the
>   step runs inside an `AsyncLocalStorage` override (`ai-provider-override.ts`) and
>   `resolveProviderConfig()` answers the draft in that async context only. **The provider layer must
>   therefore resolve its configuration through `AI_SETTINGS_READER` on every `step()`, never cache it.**
>   `CHAT_MODEL_PORT` is resolved lazily from the container (`ModuleRef`, non-strict) rather than by
>   importing `AiProvidersModule`, because the provider layer imports `AiSettingsModule` for the reader.
>   Failures are classified from the thrown error's `code` (a run error code) or `errorClass`
>   (`AiErrorClass`) and the egress guard's `EgressError`; the message is fixed per code and never
>   echoes the upstream text. A 60 s deadline aborts the step.
> - **`POST /config/ai/models`** answers the provider descriptor's `suggestedModel` until the port
>   gains a listing call (the port has none today); free text stays allowed.
> - **Reader port.** `AiSettingsModule` binds and exports `AI_SETTINGS_READER` (`useExisting:
>   AiSettingsService`). `resolveProviderConfig()` is null when disabled, in shim mode, without a known
>   provider or a model, or when the stored key cannot be decrypted.
>
> **Refusal codes (#1315 follow-up).** Every `/config/ai` refusal carries a stable machine `code` next
> to its human `message`; the web matches the code, never the sentence. The list is
> `AI_SETTINGS_ERROR_CODES` in `@lazyit/shared` (`schemas/ai-settings.ts`), the body shape
> `AiSettingsErrorSchema`. It only grows: a web treats an unknown code as a generic refusal and shows
> `message`. 400 and 409 bodies are `{ statusCode, error, message, code }`; the 422 enable-gate body is
> `{ code, message, reason?, test? }`.
>
> | Status | Code | When | Routes |
> | --- | --- | --- | --- |
> | 409 | `AI_SETTINGS_CONCURRENT_SAVE` | the row changed between the read and the conditional write — reload and save again | `PUT` |
> | 409 | `AI_SECRET_KEY_MISSING` | a key write, or enabling a key-bearing provider (or with a stored key), without a usable `AI_SECRET_KEY` | `PUT` |
> | 409 | `AI_SHIM_MODE` | `AUTH_MODE=shim`: no test, no enable | `PUT`, `POST /test` |
> | 400 | `BASE_URL_INVALID` | not a parseable URL | `PUT`, `POST /test` |
> | 400 | `BASE_URL_CREDENTIALS` | userinfo in the URL | `PUT`, `POST /test` |
> | 400 | `BASE_URL_QUERY_OR_FRAGMENT` | a query string (even empty) or a fragment | `PUT`, `POST /test` |
> | 400 | `BASE_URL_SCHEME` | neither `http:` nor `https:` | `PUT`, `POST /test` |
> | 400 | `BASE_URL_HTTP_NOT_ALLOWED` | `http://` outside OpenAI-compatible + `allowPrivateNetwork` | `PUT`, `POST /test` |
> | 400 | `BASE_URL_LOOPBACK` | a `localhost` / `*.localhost` name | `PUT`, `POST /test` |
> | 400 | `BASE_URL_HTTP_PUBLIC` | `http://` to a public IP literal | `PUT`, `POST /test` |
> | 400 | `BASE_URL_UNREACHABLE_RANGE` | a loopback, link-local, metadata or reserved IP literal | `PUT`, `POST /test` |
> | 400 | `BASE_URL_PRIVATE_NOT_ALLOWED` | a private/ULA literal without OpenAI-compatible + `allowPrivateNetwork` | `PUT`, `POST /test` |
> | 400 | `PRIVATE_NETWORK_PROVIDER_MISMATCH` | `allowPrivateNetwork` on a provider other than OpenAI-compatible | `POST /test` (on `PUT` the schema refuses first) |
> | 400 | `PROVIDER_OPTIONS_UNSUPPORTED` | provider options the selected provider does not take | `POST /test` (on `PUT` the schema refuses first) |
> | 400 | `PROVIDER_NOT_CONFIGURED` | a test with no provider or model to test | `POST /test` |
> | 422 | `DISCLOSURE_REQUIRED` | enable before the egress disclosure is acknowledged | `PUT` |
> | 422 | `PROVIDER_NOT_CONFIGURED` | enable without a provider, a model, or a required base URL | `PUT` |
> | 422 | `API_KEY_REQUIRED` | enable a key-requiring provider with no key; `reason: "DESTINATION_CHANGED"` when the stored key was cleared by this save's provider or base-URL change | `PUT` |
> | 422 | `CONNECTION_TEST_FAILED` | the inline connection test failed; `test` carries the result | `PUT` |
>
> A request body the zod schema refuses (the global validation pipe) keeps the pipe's generic 400 shape
> and no `code`. The connection-test *result* codes (`PROVIDER_AUTH`, `EGRESS_DENIED`, …) are the run
> error codes inside a 200 `AiConnectionTestResult`, not refusals.
>
> **Curated MCP client defaults.** The list is data in `@lazyit/shared`
> (`MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS`, schema `McpClientAllowlistDefaultSchema`): each entry is
> `{ id, label, match: { kind: "cimd_url", url } | { kind: "redirect_uri", pattern }, verification:
> "verified" | "vendor-docs", source }`. Settings → AI lists it and removes a built-in client by writing
> its id to `mcpClientAllowlistRemovedDefaults`; the authorization server enforces the same entries
> without the display metadata ([[ai-assistant/mcp-and-oauth|MCP]] §12). `GET /config/ai` is unchanged.

**Status** — any authenticated principal:

- `GET /ai/status` returns the reconciled per-caller shape `{ chat: { available }, mcp: { available,
  auth: "oauth" | "personal-token", endpoint, marketplaceUrl }, configRevision, retentionDays }` — no
  secrets ([[ai-assistant/_synthesis|synthesis]] §4.5).
- **Server-known MCP URLs (#1315 follow-up).** `mcp.endpoint` is `<WEB_ORIGIN>/mcp`, derived from the
  **pinned** origin the plugin renderer and the OAuth issuer use — never from the request `Host`
  (security.md T-30). It is present whether MCP is on or off, and null when no http(s) origin is pinned
  (a `lan` instance without `WEB_ORIGIN`: the web falls back to its page origin) or in shim mode.
  `mcp.marketplaceUrl` is `<origin>/api/ai/claude-code/marketplace.json`, only while the public
  marketplace is served (MCP on, a pinned HTTPS origin, not shim), else null. Both are null for an
  anonymous caller. The shared schema marks them optional only for tolerance of an older API; this build
  always sends them. The web install panel and settings card use them instead of
  `window.location.origin`.

> **As built (W2-2)** — `apps/api/src/ai/status/`: `@RequirePermission()` with no arguments, so every
> authenticated human passes. **Deliberate deviation (CTO, 2026-09-24):** a service account is
> refused (403) by the RolesGuard's fail-closed rule for ungated routes (INV-SA-2), although the
> contract reads "any authenticated principal"; a headless script calls `POST /ai/runs` directly and
> learns availability from its answer. The service still computes an SA's answer from its direct grants
> should that decision change. `chat.available` asks the reader's `resolveProviderConfig()` — the same
> check the runtime makes — so a stored key that no longer decrypts reads as unavailable; a
> key-requiring provider must also have a key. Both are `false` in shim mode. `auth` is `oauth` only when
> `WEB_ORIGIN` is pinned to `https://`, else `personal-token`. `configRevision` is the row's `updatedAt`
> (`"0"` with no row); `retentionDays` is sent only while the chat is available to the caller.

**In-app** — `ai:use`; owner only:

- `POST /ai/conversations` → `{ id }`.
- `GET /ai/conversations` and `GET /ai/conversations/:id` (messages projected to a
  provider-neutral wire shape).
- `DELETE /ai/conversations/:id` hard-deletes the transcript; write ledger rows survive.
- `POST /ai/conversations/:id/messages { text, context?: { route, entity? } }` → `202 { runId }`. The
  browser then follows `GET /ai/runs/:id/events` (R2).

**Runs** — `ai:use`; owner only:

- `POST /ai/runs { prompt, conversationId? }` with an optional `Idempotency-Key` header →
  `202 { runId, status }`. This is the headless entry.
- `GET /ai/runs/:id` returns the status, final text, usage and a tool-call summary.
- `POST /ai/runs/:id/cancel`.
- `POST /ai/runs/:id/tool-calls/:toolCallId/decision { decision: approve|reject, reason?, password? }`
  — human sessions only; `password` is the step-up for `elevated` tools. It returns JSON; the client
  re-subscribes to the event stream.

- `GET /ai/runs/:id/events` is the SSE stream (§9.3).

**Per-SA AI access** — `settings:manage` + `ServicePrincipalForbiddenGuard`:

- `GET|PUT /config/ai/service-accounts/:id` → `{ access: "off" | "read-only" | "read-write",
  maxMutationsPerRun: number | null }`.

> **As built (W3-1, #1315)** — `apps/api/src/ai/conversations/`, `ai/runs/`, `ai/headless/`. Thin controllers
> over the runtime's `AgentRunOrchestrator`, `AiApprovalService` and `InProcessRunEventBus` (§8.1); every
> refusal is a `{ code, message, retryAfterSec? }` body. All three controllers are listed `unexposed` in
> `ai/tools/platform.tools.ts` — the AI's own surfaces are never tools (INV-AI-14).
>
> - **Identity.** Derived only from the principal the global `JwtAuthGuard` loaded
>   (`conversations/ai-request-identity.ts`): a human acts with the `sessionEpoch` of the row the guard just
>   re-read (so a logout or password change refuses the run's later steps), a Service Account by its id; no
>   principal (shim) → 403. **The channel follows the principal:** a human's `POST /ai/runs` is `CHAT`
>   (writes wait for approval), a Service Account's is `HEADLESS` (autonomous).
> - **Gates.** `ai:use` at class level on `/ai/conversations` and `/ai/runs` (a Service Account through its
>   direct grants, fail-closed). `/ai/conversations` is the human channel: a Service Account is refused 403
>   `FORBIDDEN` there and uses `POST /ai/runs` (it can still continue its own headless conversation with
>   `conversationId`). The per-SA routes carry the `/config/ai` gate. The runtime re-checks the principal,
>   the per-SA setting and `infra:report` before every step; a Service Account whose access is `off` or that
>   holds `infra:report` is refused **403 `FORBIDDEN`** at creation; `read-only` freezes a conversation
>   without write tools.
> - **Owner only, 404 for everyone else** — another user, an admin (ADR-0097 default 3) or a Service
>   Account — on a conversation (read, send, delete), a run (read, cancel, events) and a decision. A
>   malformed id is the same 404. The SSE endpoint checks ownership **before** `subscribe`, `replay` or
>   `lastSeq`.
> - **`POST /ai/conversations`** → 201 `{ id }` (the frozen prompt's locale is the first tag of
>   `Accept-Language`). **`GET /ai/conversations`** → `Page<AiConversationSummary>` of the caller's `CHAT`
>   conversations by `lastActivityAt` desc (`updatedAt` on the wire is `lastActivityAt`); `status` from the
>   active run; `readOnly` when closed, or pinned to another prompt version, provider or model (the toolset
>   pin is checked by the runtime at the next submission). **`GET /ai/conversations/:id`** →
>   `AiConversationDetail`. **`POST /ai/conversations/:id/messages`** → 202 `{ runId, status }`.
> - **The projection** (`conversations/transcript-projection.ts`) reads `format = 'aisdk-v7'` rows only —
>   at the query and again in code, so a `lazyit-*` or unknown format never reaches the wire — and a row
>   whose stored role disagrees with its message is dropped. A user message is its text without the
>   runtime's `<turn_context>` prefix; an assistant message keeps text and tool calls (reasoning, provider
>   options and raw inputs are dropped); a tool message is folded into the calls it answers as the same
>   summary `tool.result` carries (never the result data). A chat proposal (an invocation with the tool-use
>   id) adds an `approval` part with the STORED preview and its outcome (`null` while pending; `approved`
>   once decided and executed). A run's redacted error becomes a `notice` part after its last message.
>   Message ids are `<conversationId>:<seq>` — the `messageId` of `message.delta`. Every part is validated
>   against the shared schema; what fails is dropped (read-tolerant).
> - **`DELETE /ai/conversations/:id`** → 204, through the retention unit's purge service (W3-6,
>   `AiConversationPurgeService.deleteOwned`, the only deleter of transcripts): 404 for anyone but the owner,
>   **409 `RUN_IN_PROGRESS`** while a run is active; messages and invocations cascade, run rows stay with
>   `conversationId = null`, `ai_action_log` is untouched. A Service Account is refused 403 before it. Reads
>   and deletes keep working while AI is off (conversations stay dormant,
>   [[ai-assistant/frontend|frontend]] §11 item 4); create and send answer **409 `AI_DISABLED`**.
> - **`POST /ai/runs`** → 202 `{ runId, status }`; an `Idempotency-Key` (1–255 printable ASCII, else 400)
>   returns the earlier run for the same principal and key, with the response header
>   `Idempotent-Replayed: true`. The key names one request: reused with another prompt or another
>   `conversationId` it answers **422 `IDEMPOTENCY_KEY_MISMATCH`**. There is no body-hash column (a schema
>   change would be needed), so the earlier run's first user message — without the turn context — and its
>   conversation are compared; a run whose conversation was deleted replays uncompared, and two first
>   submissions racing on one key are resolved by the runtime (one run). **`GET /ai/runs/:id`** → `AiRun`: `finalText` is the last assistant text of
>   the run, `toolCalls` the calls of the run's own projected messages. **`POST /ai/runs/:id/cancel`** → 200
>   `{ runId, status }`, idempotent.
> - **`POST /ai/runs/:id/tool-calls/:toolCallId/decision`** → 200 `{ runId, status }` (the run's status
>   afterwards: `QUEUED` when this decision resumed it). The body is the strict `AiApprovalDecisionSchema`
>   — any other field (arguments) is a 400. Errors: 404 not the caller's run or call; 403 `FORBIDDEN` for a
>   Service Account; 409 `RUN_NOT_AWAITING_APPROVAL`; 409 `AI_DISABLED` (an approval while off; the action
>   stays pending); **403 `STEP_UP_REQUIRED` / `STEP_UP_FAILED` / `STEP_UP_UNAVAILABLE`** and **429
>   `STEP_UP_RATE_LIMITED` + `retryAfterSec`**; core's own refusals pass through (409 `EXPIRED`, `STALE`, an
>   already-decided action), including **409 `PREVIEW_CHANGED`** and a `STEP_UP_REQUIRED` raised by a new
>   warning, both with **`addedWarnings`** (#1357: the fresh preview gained warnings, the stored card was
>   updated, nothing executed, the action stays pending for a new decision). **The `STEP_UP_*` 403s are about the password confirmation, never the session:
>   the web must not treat them as a logout** (nor any 403 from this endpoint).
> - **Per-SA AI access** (`headless/`): the account must be live (a revoked or unknown one is 404). No row
>   reads `read-write` with no cap; a stored value this build does not know reads `read-only`, a malformed
>   cap as none (the runtime's reading). `PUT` validates with the strict shared schema, writes nothing when
>   unchanged, and otherwise upserts the row and appends one `ai_config_audit_log` row
>   (`service_account.ai_access.updated`, the acting admin, `targetServiceAccountId`, `detail { before, after
>   }`) in the same transaction. Saving access for an account that holds `infra:report` is allowed; the
>   runtime refuses it anyway.

> **As built (#1373, #1376) — per-conversation settings.** ADR-0097 decision 4 and decision 5 / default 7
> as amended 2026-09-24. Shared contract in `@lazyit/shared` `ai-run.ts` (additive): `CreateAiConversation`,
> `UpdateAiConversation`, `AiConversationSettings`, `AiModelCatalog`, `AiConversationModelIdSchema`,
> `AiApprovalMode`; `AiProviderDescriptor.supportsEffort` in `ai-provider.ts`. The runtime rules live in
> `runtime/conversation-settings.ts`.
>
> - **`POST /ai/conversations`** takes an optional body `{ model?, effort?, providerOptions?, autoApprove? }`
>   (strict; an absent body is `{}` — the pre-#1373 behaviour). `model` is any model id of the configured
>   provider (`AiConversationModelIdSchema`: letters, digits and `. _ - : / @`, ≤ 200, no `..` segment —
>   a model id can end up in a provider URL path); omitted = the admin's model, `modelChosen = false`.
>   `effort` (`low|medium|high`) only where `AI_PROVIDER_DESCRIPTORS[provider].supportsEffort` (not
>   OpenAI-compatible) → else **400 `EFFORT_UNSUPPORTED`**; `providerOptions` must pass
>   `AI_PROVIDER_OPTIONS_SCHEMAS[provider]` → else **400 `PROVIDER_OPTIONS_UNSUPPORTED`**. `null` = the admin's
>   setting at call time. `autoApprove: true` records `autoApproveEnabledAt` and an audit row.
> - **`PATCH /ai/conversations/:id`** `{ model?, effort?, providerOptions?, autoApprove? }` (at least one) →
>   200 `AiConversationSettings`. Owner only (404), human only (403). Model fields: **409
>   `CONVERSATION_SETTINGS_LOCKED`** once the conversation has a run (the update takes the conversation row
>   lock a submission takes, then counts runs), 409 `CONVERSATION_READ_ONLY` when closed or on another
>   provider, 409 `AI_DISABLED` while off. `autoApprove` toggles at any time (AI on or off); each actual
>   change appends `ai_config_audit_log` `CONVERSATION_AUTO_APPROVE_CHANGED`, actor = the owner, `detail
>   { conversationId, before, after }`.
> - **`GET /ai/conversations/:id`** adds `settings: AiConversationSettings` — `{ provider, model,
>   modelChosen, effort, providerOptions, modelLocked, autoApprove, autoApproveEnabledAt }` (`modelLocked` =
>   a run exists). `readOnly` in the list and detail follows the amended pin.
> - **`GET /ai/models`** (`ai:use`, humans; 409 `AI_DISABLED` while off) → `AiModelCatalog`: `{ provider,
>   defaultModel, defaultEffort, supportsEffort, providerOptionKeys, models: [{ id, label }], listed,
>   listingError }`. The listing is `AiModelListService.listModels` over the resolved connection (the
>   egress-guarded fetch), cached in memory 10 minutes per connection (keyed by a hash of provider, base URL,
>   private-network flag and key — never the key itself), concurrent requests sharing one call; a failure is
>   `listed: false` + the run error code, remembered 1 minute, and the admin's default is always in
>   `models`. Nothing of the connection but the provider kind and model ids reaches the caller.
> - **Runtime.** Each step sends the conversation's own `effort` / `providerOptions` (read tolerantly: a value
>   the provider no longer takes falls back to the admin's) as `ChatModelStepRequest.effort` /
>   `providerOptions`; `AiSdkChatModel` overlays them on the resolved configuration for that call only.
> - **Run model under the lock.** `submit` writes the run's provider and model from the conversation row
>   re-read inside its locking transaction, so a model change racing the first message is exactly what the
>   run records and uses.
> - **Auto-approve.** In `AgentLoop.resolveCall`, after a successful chat `propose`, the conversation's
>   `autoApprove` is re-read, together with the run (still `RUNNING`, no cancel requested) and the provider
>   configuration (the assistant still on); when all hold, `AiToolService.approve(id, ctx, { auto: true })`
>   runs (tools §9). On
>   success the call is answered at once — events `tool.call` (`EXECUTING`), `tool.approval_resolved
>   { decision: "approved", auto: true, preview }`, `tool.result` — and the run does not pause. A core
>   refusal (`AUTO_APPROVE_NOT_ELIGIBLE` — incl. a turn that read untrusted content —, `AUTO_APPROVE_OFF`,
>   `PREVIEW_CHANGED`, `STEP_UP_REQUIRED`) leaves the
>   action pending and the normal card path runs; any other fault propagates like any write fault. The
>   transcript's approval part carries `auto: true` for an `AUTO` approval. `/ai/conversations` `PATCH` and
>   `/ai/models` are listed `unexposed` (INV-AI-14): the model cannot switch the mode on.

**Rate limits [C]** (DB counts, no new infrastructure):

- at most 30 run creations per principal per minute;
- at most 3 active runs per principal;
- `ai-run` worker concurrency 4 (env `AI_WORKER_CONCURRENCY`).

### 9.2 Provider HTTP timeouts [C]

`provider-fetch.ts` calls `guardedFetch` with:

- `timeoutMs: 120_000` (idle; reasoning models can pause);
- `deadlineMs: 600_000` (total per step);
- `allowedProtocols`: `['https:']`, plus `'http:'` only for an openai-compatible target that
  resolves to a private address (adopted by default, §14);
- `isInternalTargetAllowed`: `true` only when `allowPrivateNetwork` is set **and** the host equals
  the configured base-URL host.

As built (W2-1, `providers/provider-fetch.ts`), also: `maxRedirects: 0` (a 3xx is refused, never
followed); the private-host seam matches the base URL's host **and port**; an `http:` request is resolved
once, refused unless every address is non-public, and dialed at exactly the addresses checked (no second
resolution). Every response body is capped at `PROVIDER_RESPONSE_MAX_BYTES` (32 MiB — well over 100k
streamed output tokens of SSE framing, and 4 × 32 MiB fits the 768 MiB container at worker concurrency 4),
2xx streams and error bodies alike: past it the body errors (`ProviderResponseTooLargeError`, classified
`PROVIDER_UNAVAILABLE`) and the upstream is cancelled. The model listing and the connection test (a port
step) use the same fetch.

Known cost: no connection keep-alive per step (each step is a new TLS handshake) — acceptable.

### 9.3 SSE event contract (zod discriminated union in `packages/shared/src/schemas/ai-run.ts`, versioned `v: 1`)

- **Framing.** `id: <runId>:<seq>` and `event: <type>`; `data` is JSON.
- **Initial comment and heartbeats.** The server writes `: connected` immediately, then a heartbeat
  comment every 15 s.
- **Headers.** `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
  `X-Accel-Buffering: no`.
- **Closing.** The stream closes after a terminal status **or** after `AWAITING_APPROVAL`. The
  client re-subscribes after deciding, which keeps connections short on HTTP/1.1 LAN mode, where
  browsers allow six connections per origin.

The event vocabulary is the reconciled union (R2, R3), also consumed by the web's pure reducer
([[ai-assistant/frontend|frontend]] §5.2). It is lazyit-owned and deliberately **not** the AI SDK UI
message protocol.

| Event | Payload |
| --- | --- |
| `run.snapshot` | persisted state (messages since `seq`, pending approvals with previews, run status), sent on connect or when `Last-Event-ID` is older than the ring buffer |
| `run.status` | `{ status }` |
| `message.delta` | `{ messageId, text }` (assistant text) |
| `message.completed` | `{ messageId }` |
| `tool.call` | `{ toolCallId, name, kind: read \| mutation \| navigate, class, status, args? }` — `args` is a flat, redacted summary |
| `tool.approval_required` | `{ toolCallId, preview, elevated, stepUpRequired, untrustedSources, expiresAt }` — the preview is server-built |
| `tool.approval_resolved` | `{ toolCallId, decision: approved \| rejected \| expired \| cancelled }` |
| `input.required` | `{ toolCallId, form, expiresAt }` — a form the assistant asked for (#1388, §8.2) |
| `input.resolved` | `{ toolCallId, outcome: submitted \| skipped \| declined \| expired \| cancelled }` (#1388) |
| `tool.result` | `{ toolCallId, kind, status: ok \| error, summary?, mutated, entityRefs: { type, id, op, label?, slug? }[], error?, requestId? }` — a `navigate`-kind result carries the target ref; relayed on the CHAT channel only, where the web decides whether to navigate (R3) |
| `step.finished` | `{ stepIndex, usage }` |
| `run.finished` | `{ status, finishReason, usage, error?: { code, message, retryAfterSec?, requestId? } }` |

Reasoning text is not streamed in v1.

**As built (W2-3) — the in-process bus** (`runtime/run-event-bus.ts`). A ring buffer per run (2 000
events), listeners, and replay: `replay(runId, afterSeq)` returns the events after `afterSeq`, or `null`
when the buffer does not cover that position (evicted events, a dropped and re-created buffer, an unknown
run, or an id from another process). Sequence numbers come from one process-wide counter starting at a
per-process base (seconds since the epoch modulo 10⁶, × 1 000 — within int4): they increase strictly per
run (not contiguously), and a re-created buffer starts above every earlier number, so a stale
`Last-Event-ID` answers `null` and the SSE endpoint sends a `run.snapshot` instead of a wrong suffix.
`parseLastEventId(runId, header)` reads `<runId>:<seq>` for that run only; `formatRunEventId(envelope)`
writes it. The concrete class adds `lastSeq(runId)` — the `seq` a `run.snapshot` covers (the port in
`core/ports/` is frozen, so W3-1 injects `InProcessRunEventBus` for it). Subscribing creates no buffer. A
finished run's buffer is kept 5 minutes while nobody listens; at most 500 runs are tracked. A failing
listener never fails the run. **The bus does no authorization:** the SSE endpoint must load the run and
check the caller owns it before `subscribe`, `replay` or `lastSeq` — a run id is not a capability.

**As built (W3-1) — the endpoint** (`runs/run-event-stream.ts`). In order: the owner check (404, the bus
untouched); a client that went away during that load is dropped before anything is attached (its `close`
already fired, so nothing would release a slot or a listener); a cap of **8 open streams per principal** (429 `RATE_LIMITED`); the headers above plus
`Connection: keep-alive`, flushed at once, then `: connected`. It **subscribes before** building the replay
or the snapshot, holding what arrives meanwhile, so nothing is lost. A `Last-Event-ID` the buffer covers is
replayed (sequence numbers are compared, never counted); otherwise — no header, another run's id, a stale or
foreign position — a `run.snapshot` whose `seq` is `lastSeq(runId)` read **before** the database load, so an
event published during the load is sent again rather than lost (the reducer tolerates the duplicate). The
snapshot carries the run's own messages (the §9.1 projection limited to the run), its pending approvals with
their stored previews, and its status. Then the held and live events follow, each `id: <runId>:<seq>`,
`event: <type>`. **Closing:** live, on `run.finished` (it follows the terminal `run.status` and carries usage
and error, so the stream waits for it) or on `run.status AWAITING_APPROVAL`; a snapshot whose status is
terminal or `AWAITING_APPROVAL` closes after it; a replay is sent whole — it may cross a pause that is
already over — and the run's current status then decides. Heartbeat `: heartbeat` every 15 s, and each heartbeat re-checks the caller (`runs/stream-principal-check.ts`:
the human re-loaded at the stream's `sessionEpoch`, or the Service Account not revoked, inactive or expired,
and `ai:use` still held) — a stream the caller could no longer open is closed; a stream is
closed after **15 minutes** whatever the run does (the client resumes with `Last-Event-ID`). A client that
goes away unsubscribes the listener, clears the timers and frees its slot, exactly once; the run is
unaffected. Caddy leaves `/api/ai/runs/*/events` unencoded (#1328).

## 10. Configuration lifecycle, enable/disable, "reload"

- **Enable** (wizard; the frontend owns the UX):
  1. choose the provider;
  2. enter the key and/or base URL;
  3. `POST /config/ai/models` → pick a model;
  4. `POST /config/ai/test`;
  5. `PUT /config/ai` with `enabled: true`, which passes the enable gate;
  6. the client reloads.
- **What "reload" means [C].** The server needs no restart: every run reads `AiSettings` at start
  and re-checks `enabled` at every step boundary. Other users' shells pick the change up on their
  next `GET /ai/status` (`configRevision` = `updatedAt`, `"0"` while no row exists).
- **No row is created on boot** (as built): the first `PUT /config/ai` creates the singleton; until
  then every read answers the disabled default.
- **Modify.** Changing the provider, model, base URL or key while enabled re-runs the inline test
  before persisting. Existing conversations whose pinned provider or model no longer match become
  read-only (adopted by default, §14).
- **Disable.** New runs are refused (409 `ai_disabled`). Running runs are cancelled at the next step
  boundary. `AWAITING_APPROVAL` runs are cancelled by the sweeper, with synthetic results.
  Transcripts stay until retention; the navbar hides.
- **Revoking `ai:use`** takes effect at the next step boundary and on every endpoint.

## 11. Limits, observability, security notes

- **Budgets [C].**
  - `dailyTokenLimitPerPrincipal`: a rolling 24 h sum of `AiUsage` input + output tokens, checked
    before every step (adopted by default, §14).
  - `maxOutputTokens` per step; `maxStepsPerRun`; `contextTokenLimit` (the last step's input
    tokens). Crossing it closes the conversation (`CONTEXT_LIMIT`).
  - Cost in currency is **not** computed; prices drift per provider.
- **Prompt caching [C].** A frozen system prompt, a sorted and frozen tool set and an append-only
  history give prefix-cache hits on all three hosted providers (implicit on OpenAI and Gemini).
  Anthropic gets explicit breakpoints at the end of the system prompt and on the last message.
- **Logs [C]** (pino, ADR-0031 metadata only):
  - events `ai.run.start`, `ai.step.finish` and `ai.run.finish`;
  - fields `runId`, `conversationId`, principal kind and id, `provider`, `model`, `stepIndex`,
    `latencyMs`, `ttftMs`, usage, `finishReason`, tool names;
  - **never** prompt text, tool inputs or outputs, or keys.
  The error classes are the `AiErrorClass` vocabulary plus `budget_exceeded`, `max_steps`,
  `context_limit`, `cancelled` and `engine_restart` — as built, the shared `AI_RUN_ERROR_CODES`, which
  the provider layer throws as `AiProviderError.code` (§6.3).
- **Health.** `/health/ready` is unaffected. There are no metrics endpoints (none exist today).
- **Security posture this slice must state** (the threat model lives in its sibling note):
  - The key is write-only and never logged.
  - All provider egress goes through the guard.
  - Service accounts can never configure AI (`settings:manage` is SA-ungrantable).
  - Every tool execution is re-authorized as the principal.
  - Data leaves the instance to the chosen provider (a disclosure in the wizard and the Manual).
  - OpenAI `store: false`.
  - **Prompt-injection blast radius:** interactive writes are gated by approval; headless service
    accounts are bounded by their grants and their per-SA AI access setting, so operators should grant
    narrowly.

## 12. Infrastructure and operations impact

- **Env.**
  - `AI_SECRET_KEY`: optional; AES-256-GCM, 32 bytes (`openssl rand -hex 32`, or base64 of 32 bytes,
    or a raw 32-character string); its own axis; low-DR like `SMTP_SECRET_KEY`. Required only to store
    an API key — and so to enable any provider that takes one (Ollama without a key works without it).
    A malformed value counts as unset. Read on every use, so setting it needs an api restart only for
    the env to reach the process, never a re-save. Losing or changing it makes the stored key
    undecryptable: the chat reads as unavailable (never a crash) until an admin re-enters the key.
  - `AI_WORKER_CONCURRENCY`: optional, default 4.
  - The example file ships `AI_SECRET_KEY` **commented out**, so `infra/update.sh` does not
    fail-loud on existing installs (adopted by default, §14). `infra/start.sh` generates it on fresh install and on
    `--reconfigure`.
- **Compose.** No new service; memory headroom in `api` (768m) is adequate for I/O-bound runs at
  concurrency 4. Optional: `extra_hosts: ["host.docker.internal:host-gateway"]` on `api` so an
  Ollama on the Docker host is reachable. It resolves to a private bridge IP and needs
  `allowPrivateNetwork`. **Not adopted by default** (it would touch the shared-critical `compose.yaml`);
  the runbook documents it as an operator option.
- **Caddy.**
  - The infra unit must verify, through the pinned image, that an SSE response streams:
    time-to-first-event under 1 s, and deltas arrive incrementally through `encode zstd gzip`.
    Extend `infra/test/caddy-routing.sh`.
  - If the pinned Caddy predates PR #7905, either re-pin to a release that contains it, or move
    `encode` into the non-SSE `handle` blocks / use an explicit `match` list without
    `text/event-stream`.
  - No `stream_timeout` is set. A Caddy restart drops streams; clients reconnect with
    `Last-Event-ID` (a snapshot fallback exists).
- **Backups.** New tables ride the existing app-DB dump. Transcripts in backups outlive retention;
  this goes in the backups runbook. `AI_SECRET_KEY` sits alongside `.env.prod`; losing it means
  re-entering one API key.
- **Upgrade safety.**
  - Additive tables only; an absent `AiSettings` row reads as the disabled default.
  - Provider, status and channel are text columns validated on write, so a new value on a newer
    build degrades gracefully.
  - The api boots without `AI_SECRET_KEY`.
  - Existing data is untouched; nothing is backfilled.

## 13. Deliberately NOT built (v1)

- **Provider scope:** provider fallback chains or multi-provider routing; Anthropic server-side
  `fallbacks`; per-user or BYO keys; Bedrock, Vertex and Azure (addable through the registry).
- **Conversation features:** summarization or compaction; approve-with-edits; streamed reasoning;
  images, attachments and voice; embeddings or RAG (use the existing search tool); a prompt
  library beyond one `instructions` text.
- **Delivery and accounting:** currency cost accounting; webhooks on headless completion.
- **Runtime infrastructure:** a Valkey Streams event bus and a dedicated worker container (both
  wait for the ADR-0053 worker split); OpenTelemetry.
- **Separate integrations:** lazyit as an MCP **client**; a separate model per channel.

## 14. Resolved decisions

The CEO did not answer these five individually; the CTO adopted each recommendation **by default**, and
ADR-0097 lists them under "Adopted by default — CEO to confirm on review".

1. **Private-network LLM endpoints → allowed for the OpenAI-compatible provider only**, behind an
   admin-only `allowPrivateNetwork` toggle scoped to the configured host, through the egress-guard seam.
   Plain `http` only for such a private target; loopback and IMDS never.
2. **Transcript visibility → owner-only.** Admins see the write ledger (`AiActionLog`) and token usage,
   not other people's conversations; conversations are purged on offboarding.
3. **Default token budget → 2,000,000 tokens per principal per 24 h**, admin-editable, `null` removes it.
4. **`AI_SECRET_KEY` rollout → optional and commented** in `.env.prod.example`, generated by `start.sh`
   on install and `--reconfigure` — a deliberate deviation from the SMTP precedent so guided updates do
   not stop.
5. **Conversations after a provider/model/prompt-version change → read-only** ("start a new
   conversation").

Also adopted: **AI SDK 7 as the model-call layer only**, behind `ChatModelPort`, with a go/no-go
ESM/Jest spike; the fallback is own adapters over the official SDKs (option A3).

## 15. Related

[[0079-instance-smtp-outbound-email]] · [[0028-secrets-and-config]] ·
[[0053-async-workers-bullmq-valkey]] · [[0054-applications-workflow-engine]] ·
[[0055-on-prem-internal-target-connectors]] · [[0056-in-app-notification-bell]] ·
[[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[0031-logging-strategy]] ·
[[0012-testing-strategy]] · [[0096-jest-commonjs-against-esm-nestjs]] ·
[[0009-bun-first-vs-app-stack]] · [[0002-nestjs-backend]] ·
[[0084-update-awareness-and-guided-update]] · [[0026-reverse-proxy-tls]] ·
[[0036-int4-bounded-integers]] · [[backups]] · [[deployment]]
