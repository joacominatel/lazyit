---
title: "ADR-0097: AI assistant, MCP server and headless API"
tags: [adr, ai-assistant, mcp, oauth, llm, security, authorization, data-model]
status: accepted
created: 2026-09-23
updated: 2026-09-24
deciders: [Joaquín Minatel]
---

# ADR-0097: AI assistant, MCP server and headless API

## Status

**accepted** — 2026-09-23 (CEO review of PR #1317; epic #1315). The build follows the wave plan.
The depth lives in the design vault [[ai-assistant/_MOC|docs/ai-assistant/]], whose
[[ai-assistant/_synthesis|synthesis]] is binding.

**To amend on acceptance** (not edited by this ADR): [[0046-roles-permissions-v2]] (the `ai` permission
domain), [[0048-service-accounts]] (SA tokens on `/mcp`, the per-SA AI access setting) and
[[0080-service-account-secret-retrieval]] (SA bearer verification extracted into a shared
authenticator; SA token issuance is never an AI tool). Builds on [[0086-local-authentication-mode]]
(the local session; open PR #1313 amends its session expiry) and [[0087-plain-http-lan-deployment-axis]].
Depends on #1314 and on #1310's direction (no OIDC).

## Context

The CEO wants lazyit to be operable by AI, off by default and enabled by an admin: "elegis el
proveedor, modelo, y tus api key, y configuraciones extras (despues se pueden modificar), de que se te
recargue la aplicacion, y te habilita un chat adentro de la app (en la navbar), un chat donde puedas
controlar la app en vivo desde ahi. Al mismo tiempo, podes habilitar un mcp, para usarlo desde claude
code o desde cualquier otra herramienta, y tambien podes instalar el skill que entiende que es lazyit y
como se usa."

That is **three channels over one capability**:

1. **Chat** — a navbar chat running lazyit's own agent loop against an admin-configured provider
   (Anthropic, OpenAI, Gemini, OpenAI-compatible), acting as the logged-in user.
2. **MCP** — external agents (Claude Code, Cursor, claude.ai) acting as the user who connected them.
3. **Headless** — a server script's Service Account sends a prompt: "si quiero mandar un prompt desde
   un server obviamente seria la SA".

The forces that shape the design:

- **Authorization is DB-first and lives in the HTTP layer** — the `JwtAuthGuard` →
  `MustChangePasswordGuard` → `RolesGuard` chain, handler guards, the KB folder ACL inside services, and
  real logic in controllers. A tool layer that called services directly would bypass it
  ([[ai-assistant/tools-and-execution|tools]] §2).
- **The MCP specification (revision 2026-07-28) requires HTTPS for every authorization-server
  endpoint**, and SDK-v2 clients refuse a plain-HTTP token endpoint — yet `lan`, plain HTTP, is how most
  of the target segment runs ([[ai-assistant/mcp-and-oauth|MCP]] §3).
- **Assume the model will be fooled.** Much of what the AI reads is written by other people; the design
  must limit the blast radius rather than trust the model ([[ai-assistant/security|security]] §0, §6.1).
- **Operators upgrade in place over populated databases**; the Jest suite is CommonJS against ESM
  packages ([[0096-jest-commonjs-against-esm-nestjs]]); there is no streaming transport in the codebase
  yet; OIDC is being removed (#1310).

## Decision drivers

- The AI's authority must be **exactly** the invoking principal's — provably, not by convention.
- Every mutation must be **attributable and permanently audited**, whatever the channel.
- Off by default, additive, and **invisible to an operator who never enables it** — including during
  guided updates.
- Boring, owned code over a framework with its own persistence; no new container.
- The provider layer must be **extensible** — "ordenemos bien los archivos, estructuremos bien el
  codigo, y hagamoslo escalable".
- **Zero OIDC dependency**.

## Considered options

The key forks only; each links its analysis.

- **Tool execution** — *direct service calls* (skip guards, pipes and controller logic); *HTTP loopback*
  (needs a credential in the loop, a forbidden token passthrough); **in-process dispatch through Nest's
  own pipeline** — chosen, the only option that is route-equivalent by construction
  ([[ai-assistant/tools-and-execution|tools]] §5 Fork C).
- **LLM library** — *AI SDK end to end* (couples api and web to its most volatile surfaces); *LangChain*
  / *Mastra* (their own persistence beside Prisma); *own adapters over official SDKs* (the fallback);
  **AI SDK 7 as the model-call layer only, behind a port** — chosen
  ([[ai-assistant/provider-and-runtime|provider]] §5 Fork A).
- **Where the loop runs** — *in the HTTP request* (a reload kills a run; headless needs a second host);
  **a BullMQ job with Postgres as the system of record** — chosen, the workflow-engine pattern
  ([[ai-assistant/provider-and-runtime|provider]] §5 Fork B).
- **Browser transport** — *WebSocket*; *polling*; *a POST that streams its response*; **a GET SSE
  stream read with `fetch`, Bearer and `Last-Event-ID`** — chosen, with a lazyit-owned event union
  ([[ai-assistant/provider-and-runtime|provider]] §5 Fork C, [[ai-assistant/frontend|frontend]] Fork B).
- **Authorization server** — *an external IdP* (excluded by #1310); *panva `oidc-provider`* (an OpenID
  Provider); *the SDK's frozen v1 router*; **a small hand-written OAuth 2.1 server in `apps/api`** —
  chosen ([[ai-assistant/mcp-and-oauth|MCP]] §4 F1).
- **MCP on plain-HTTP `lan`** — *MCP only on HTTPS*; *OAuth over plain HTTP* (non-conforming, refused by
  SDK-v2 clients); **OAuth on HTTPS plus revocable personal tokens on `lan`** — chosen by the CEO
  ([[ai-assistant/mcp-and-oauth|MCP]] §4 F8).
- **Headless autonomy** — *a per-request tool allowlist, read-only by default* (the security note's
  recommendation); **autonomous within grants, configurable in-app per SA** — chosen by the CEO
  ([[ai-assistant/security|security]] §11 E4).

## Decision

1. **Three channels, one principal, exactly its authority.** The AI acts as the logged-in user (chat),
   the connecting user (MCP) or the Service Account (headless), never as a synthetic identity. Chat and
   headless are gated by a new permission **`ai:use`**, MCP by a separate **`ai:connect`** (both ADMIN +
   MEMBER by default); MCP has its own switch, usable without an LLM provider. Authority is the
   principal's current DB permissions, narrowed by the OAuth scope (MCP) or the SA's AI access setting
   (headless). → [[ai-assistant/_synthesis|synthesis]] §1–2.

2. **Tools execute through Nest's own pipeline.** A tool calls a controller handler wrapped with
   `ExternalContextCreator` on a synthetic request; a module-private symbol carries a delegated identity
   that a new branch in `JwtAuthGuard` resolves by re-loading the principal from the database. Global
   guards, handler guards, pipes, controller logic and service-level checks all run as for HTTP; the
   branch is unreachable from the network. A tool↔route parity test and a coverage test are the
   backstop. → [[ai-assistant/tools-and-execution|tools]] §5, §8.

3. **One tool catalog, four classes.** One registry in `apps/api/src/ai/`; names
   `^[a-z][a-z0-9_]{0,39}$`; the permission is derived from the bound route. Classes `read`, `write`,
   `elevated` (privilege, identity, credential delivery, configuration) and `navigate` (chat only) drive
   the confirmation card, the MCP annotations, the OAuth scope and the headless ceiling. The v1 cut is 44
   tools. Excluded on every channel: the Secret Manager, operations that return a credential in cleartext
   (SA token create/rotate, temporary passwords), the AI's own configuration, and any generic egress
   tool. → [[ai-assistant/tools-and-execution|tools]] §3, §7; [[ai-assistant/_synthesis|synthesis]] §4.1.

   > Amended 2026-09-24 (#1315): the workflow engine is exposed to the AI. The CEO: "La ia con
   > workflows podemos hacer todo ahora, para mi es el feature mas grande, al menos dentro de chat y lo
   > que dejamos pendiente en issue";
   > on the outbound-integration warning: "Na que no pida contraseña, que sea flexible, excepto que la
   > aplicacion sea critica"; on Service Accounts: "Y si las service account en workflows estoy de
   > acuerdo con tu recomendación".
   >
   > - **Operations, every channel** (chat, MCP, headless): reading workflows, their connections, runs
   >   and manual tasks; retrying a failed run (never with the route's one-shot `overrides`) and
   >   replaying it on the latest version; resolving manual tasks (submit, skip, fail) through the same
   >   assignee guard as the route. A Service Account gets exactly these — reads, retry/replay, and the
   >   manual tasks its assignee guard admits (in practice, unassigned ones).
   > - **Authoring, chat only in v1**: workflows and their versions, connections (incl. the connection
   >   test), the dry-run, and enabling or disabling a workflow. Every authoring tool is `elevated` and
   >   declares `channels: ['CHAT']`. MCP and headless authoring are deferred (#1344). A Service Account
   >   never authors, connects or enables a workflow.
   > - **Workflow secrets stay structurally excluded** (INV-AI-5, INV-AI-14): the AI never reads, creates,
   >   rotates or deletes one. It may report "credential configured: yes/no" from a connection's
   >   `secretId`, never a value.
   > - **Two new preview warnings.** `OUTBOUND_INTEGRATION`: the action creates or changes an outbound
   >   integration or its destination (creates a connection; changes its host, URL or credential
   >   reference; authors a version on an enabled workflow; enables a workflow). The preview lists every
   >   outbound host and every mapped field → token. It needs **no step-up** by itself.
   >   `CRITICAL_APPLICATION`: the action is a workflow write — authoring or operations — or an access
   >   grant or revoke, on an application with `isCritical = true`. It **requires step-up**: it joins the
   >   core's closed list (`AI_STEP_UP_WARNINGS`), and core derives step-up from that list on **any**
   >   write preview, `write` or `elevated` — an access revoke (a `write` tool) on a critical application
   >   needs the password too. Step-up is a chat control: over MCP and headless no preview is built and
   >   nothing asks for a password, so whether MCP and headless may act on a critical application at all
   >   is an open CEO question; core carries a per-channel refusal seam (`AI_CHANNEL_REFUSED_WARNINGS`,
   >   empty today).
   > - **Disabled first.** A workflow the AI creates is created disabled. Enabling it is a separate
   >   approval whose preview embeds a dry-run against a named sample grant.
   >
   > Decision 4's step-up list grows by `CRITICAL_APPLICATION`; nothing else in decisions 1–13 changes.
   > → [[ai-assistant/tools-and-execution|tools]] §3, §7, §9; [[ai-assistant/security|security]] §6.1,
   > §6.9.

4. **Interactive writes need approval on a server-built preview.** A chat write becomes a pending
   action with a deterministic before→after preview; only its owner approves, from a human session,
   once, before it expires; authorization and the target's version are re-checked at execute. Elevated
   actions get a distinct card — full diff, one action per approval, an untrusted-source banner — and a
   password step-up for privilege grants and credential delivery. Over MCP the client confirms; headless
   runs are autonomous within the SA's grants and its per-SA AI access setting (off / read-only /
   read-write, optional mutation cap). → [[ai-assistant/tools-and-execution|tools]] §9;
   [[ai-assistant/security|security]] §6.2, §6.6.

   > Amended 2026-09-24 (#1315): step-up is derived by core from a closed list of preview warnings —
   > `ROLE_CHANGE`, `IDENTITY_CHANGE`, `PRIVILEGE_GRANT`, `CREDENTIAL_DELIVERY` (CEO, "Opción 2") and
   > `CRITICAL_APPLICATION` (decision 3 amendment) — on any chat write preview carrying one, whatever
   > the tool's class. `OUTBOUND_INTEGRATION` is not on it.
   >
   > Amended 2026-09-24 (#1315): changing a person's manager is not an identity change and needs no
   > step-up. The CEO, on the manager change: "Si deja de pedir passwd". `IDENTITY_CHANGE` stays on the
   > list for the other identity attributes (e.g. the email).

5. **Lazyit owns the agent loop; providers sit behind a port.** Each model step is one call through
   `ChatModelPort`, implemented over AI SDK 7 in `ai/providers/` — the only code that imports it. Adding
   a provider is a descriptor, one definition file and one registry line. Runs are BullMQ jobs carrying
   only `{ runId }`, with conversations, messages, runs and approvals in Postgres; a sweeper recovers
   lost resumes; a write is never retried blindly. Conversations are append-only and pinned to their
   provider, model and prompt version. → [[ai-assistant/provider-and-runtime|provider]] §6, §8.

6. **The browser follows a run over SSE.** `POST` creates the run; the browser reads
   `GET /ai/runs/:id/events` with `fetch`, a Bearer header and `Last-Event-ID`. The event union is
   lazyit-owned and versioned in `@lazyit/shared`. Tool results carry entity refs and a call kind; the
   web invalidates every active query after an executed mutation, renders "Open" chips, and
   auto-navigates only for an explicit navigate tool when nothing unsaved is on screen. The web builds
   every href. → [[ai-assistant/_synthesis|synthesis]] §4.3, §4.6; [[ai-assistant/frontend|frontend]] §4.

7. **Configuration is an encrypted singleton, off by default.** `AiSettings` mirrors the SMTP
   precedent: `settings:manage` only, the provider key write-only under its own optional key axis
   `AI_SECRET_KEY`, cleared whenever the provider or base URL changes. Enabling requires a passing
   connection test and an acknowledged egress disclosure. All provider traffic goes through the egress
   guard. → [[ai-assistant/provider-and-runtime|provider]] §9–10, §12; [[ai-assistant/security|security]]
   §6.4–6.5.

8. **lazyit is its own OAuth 2.1 authorization server for MCP.** Hand-written in `apps/api/src/oauth/`
   on the local session, with no OIDC surface: authorization code + PKCE S256, exact redirects, RFC 8707
   resources, `iss`, DCR and CIMD, consent always shown, scopes `lazyit.read`, `lazyit.write` and
   `lazyit.admin` (elevated tools only, never preselected, step-up). Tokens are opaque, hashed,
   audience-bound, accepted only on `/mcp`, rotated with reuse detection, and die with the user's
   `sessionEpoch`. The issuer is pinned configuration, so the authorization server exists only on
   HTTPS instances. → [[ai-assistant/mcp-and-oauth|MCP]] §5.1–5.2, §6.

9. **The MCP server is stateless and per-caller.** `/mcp` runs the official SDK v2 handler inside Nest,
   lists only the tools the caller may use under the granted scope, re-checks everything on each call,
   and derives annotations from the tool class. It accepts OAuth tokens on HTTPS, revocable personal
   tokens (`lzit_pat_…`, mandatory expiry) on `lan`, and the tokens of Service Accounts that hold
   `ai:connect`. → [[ai-assistant/mcp-and-oauth|MCP]] §5.3–5.4.

10. **The skill is served by the instance.** A Claude Code plugin rendered from the live registry and
    the domain primer: always downloadable by authenticated users with `ai:connect`; also published as a
    public marketplace (auto-updating) when MCP is enabled on an HTTPS instance.
    → [[ai-assistant/mcp-and-oauth|MCP]] §5.5.

11. **One permanent ledger; transcripts are allowed to forget.** `AiActionLog` records every
    AI-initiated mutation on every channel — actor, channel, tool, redacted input, approval provenance,
    outcome — append-only and blocked against `UPDATE`/`DELETE` at the database. `asset_history` and
    `user_history` gain a nullable `aiInvocationId`. Conversations are owner-only and hard-deleted after
    a configurable retention (default 90 days), on user request and on offboarding — a deliberate
    exception to "never hard-delete", because transcripts are not the system of record.
    → [[ai-assistant/_synthesis|synthesis]] §6; [[ai-assistant/tools-and-execution|tools]] §10.

12. **Fourteen invariants** (INV-AI-1…14) formalize the above and join [[INVARIANTS]] on acceptance.
    → [[ai-assistant/_synthesis|synthesis]] §7.

13. **MCP client trust policy: a configurable allowlist, pre-seeded.** The CEO, on review: "Revise el
    adr, esta ok, lo unico del mcp que daria es que haya una allowlist configurable, pero por defecto
    todos o los que tengamos en cuenta, https, claude code, codex, opencode, pi, y algun otro que me
    este olvidando, los de siempre basicamente." Every MCP client that connects through OAuth is
    checked against an **admin-configurable allowlist in Settings → AI**, pre-seeded with the
    well-known clients: Claude Code, Claude Desktop / claude.ai, OpenAI Codex, ChatGPT, OpenCode, Pi,
    Cursor, VS Code / GitHub Copilot, Gemini CLI, Windsurf and Zed. The seed list lives in code as a
    curated default; its exact identifiers (CIMD `client_id` URLs and/or redirect-URI patterns) are
    verified during W2-4 and W3-3. Admins can add or remove entries. Non-loopback redirect URIs must be
    HTTPS. DCR-registered client names are self-asserted, so matching relies on the CIMD URL or the
    redirect-URI pattern, **never on `client_name`**; the consent screen still shows the client
    identity. → [[ai-assistant/mcp-and-oauth|MCP]] §4 F2, §10; [[ai-assistant/security|security]] §6.3.

    > Amended 2026-09-23 (#1315, PR #1332): native-app redirect schemes. The CEO, on review: "Permitir
    > solo en la allowlist". A private-use URI scheme (RFC 8252 §7.1, e.g. `cursor://…`, `vscode://…`)
    > is accepted as a redirect URI **only on an explicit allowlist entry** — a curated default or one an
    > admin adds. The scheme must be reverse-domain (`com.example.app:`) or one of a vetted list of
    > editor schemes (`cursor`, `vscode`, `vscode-insiders`, `windsurf`). The "allow any HTTPS client"
    > toggle never admits one, and browser-interpreted schemes (`javascript`, `data`, `file`, `blob`,
    > `about`, `view-source`, `vbscript`, `filesystem` — the SEC-051 list) and plain `http` off loopback
    > are always refused. The rest of the decision is unchanged.

## Consequences

**Positive**

- "Exactly the user's permissions" is true by construction, not by a parallel permission map that can
  drift.
- One catalog feeds three channels, the skill and the MCP instructions; a new endpoint forces a
  decision (tool or `unexposed`) through the coverage test.
- A provider is one file; the runtime does not know which one it talks to.
- Every AI mutation is traceable from the ledger to the domain history row it produced.
- Operators who never enable AI see nothing new — no required env key, no new container, no behavior
  change.

**Negative / trade-offs**

- `JwtAuthGuard` gains a branch and `ExternalContextCreator` becomes a dependency on Nest internals; a
  Nest major upgrade must re-run the spike tests.
- lazyit now owns a security-critical OAuth authorization server.
- Two new ESM-only runtime dependencies join ADR-0096's Jest lookahead; the AI SDK ships a major roughly
  yearly.
- `lan` users get MCP only through static personal tokens; cloud connectors (claude.ai, ChatGPT) need a
  publicly reachable HTTPS instance.
- A long conversation ends at the context cap instead of being summarized; a provider or model change
  makes old conversations read-only.
- Headless runs have no human in the loop by the CEO's choice; the blast radius is the SA's grants.

**Risks**

- **Prompt injection** from other-authored content steering a write — bounded by approvals, the
  elevated tier, honest MCP annotations, `lazyit.admin` off by default, and the renderer that drops
  external images; never eliminated.
- **The delegated-identity branch** is the highest-impact code in the feature — CEO review, a
  network-unreachability test and a DB-reload parity test.
- **A young MCP SDK and a moving spec** (revision 2026-07-28 is eight weeks old); clients are mid-transition.
- **Caddy compression and SSE** must be verified on the pinned image before the chat ships.

## Upgrade safety

Every schema change is additive: new tables for AI settings, conversations, messages, runs, tool
invocations, the action ledger, usage, per-SA settings, AI config audit, and five OAuth tables; two
`ADD COLUMN … NULL` (no default, no FK, no index) on `asset_history` and `user_history`. A populated
database gets empty tables and nothing is backfilled. With no settings row and no `AI_SECRET_KEY`, the
API boots and behaves exactly as today. `AI_SECRET_KEY` ships commented in `.env.prod.example`, so
guided updates do not stop. Status, channel and provider values are text validated on write, so a
newer value degrades gracefully on an older build. `ai:use` and `ai:connect` reach MEMBER through the
seed-once ledger from #1314 on the next deploy, with no data migration; because the capability is off at
instance level, the grant exposes nothing until an admin enables it. Downgrading leaves inert tables.
→ [[ai-assistant/_synthesis|synthesis]] §6.

> Amended 2026-09-23 (#1315, PR #1332): default grants for `ai:use` / `ai:connect` are applied by the
> seed-once ledger from #1314; no data migration. This corrects the mechanism only; the decision is
> unchanged.

## Prerequisites

- **#1314** — the seed must stop re-granting revoked default permissions before `ai:use` / `ai:connect`
  ship.
- **SEC-021** (last-admin lockout via `isActive`) before the user-management tools; **SEC-051**
  (`javascript:` bypass on `Application.url`) before the application write tools; **SEC-072 / SEC-032**
  closed, or a nesting cap in tool argument validation.
- **Caddy** routes `/mcp`, `/.well-known/oauth-*`, `/oauth/token`, `/oauth/register` and `/oauth/revoke`
  to the API and passes SSE unbuffered and uncompressed.

The build follows the unified wave plan in [[ai-assistant/_synthesis|synthesis]] §10.

## Not built

Click-level UI driving; conversation summarization; approve-all or approve-with-edits; provider
fallback chains or per-user keys; MCP elicitation, resources, prompts or toolsets; any OIDC surface or
OAuth over plain HTTP; lazyit as an MCP client; generic "call any endpoint" or file tools; admins reading
other people's conversations; a per-request headless tool allowlist; workflow authoring over MCP or
headless (deferred, #1344); any tool over workflow secrets. → [[ai-assistant/_synthesis|synthesis]] §9.2.

## Adopted by default — CEO to confirm on review

**Confirmed by the CEO on review of PR #1317 ("esta ok").** These were recommended by the analysts and
adopted so the design is complete. Each can be reversed without reshaping the rest.

1. **AI SDK 7** as the model-call layer only, behind `ChatModelPort`, gated by a go/no-go ESM/Jest
   spike; the fallback is own adapters over the official SDKs.
2. **MCP TypeScript SDK v2**, stateless handler.
3. **Conversations are owner-only**; admins see the write ledger and usage; conversations are purged
   on offboarding.
4. **Retention** defaults to 90 days (range 7–3650).
5. **Token budget** 2,000,000 tokens per principal per 24 h, admin-editable.
6. **`AI_SECRET_KEY`** optional and commented in `.env.prod.example`, generated by `start.sh` — a
   deviation from the SMTP precedent so guided updates do not stop.
7. **Conversations become read-only** after a provider, model or prompt-version change.
8. **A hard per-conversation context cap**, with write-time tool-result truncation.
9. **Private-network LLMs:** the OpenAI-compatible provider may target a private host through an admin
   `allowPrivateNetwork` toggle scoped to that host; loopback and IMDS never.
10. **The v1 tool catalog** is the 44-tool cut.
11. **`ai:use` / `ai:connect` default grants** are applied by the seed-once ledger from #1314 on the next
    deploy; no data migration.

    > Amended 2026-09-23 (#1315, PR #1332): default grants for `ai:use` / `ai:connect` are applied by the
    > seed-once ledger from #1314; no data migration. This corrects the mechanism only; the decision is
    > unchanged.
12. **SA tokens on `/mcp`** only when the SA holds `ai:connect`, fail-closed.
13. **The headless setting lives per Service Account** (off / read-only / read-write, default
    read-write, optional mutation cap) — the CTO's interpretation of "Autonomo total, pero configurable
    in-app tambien".
14. **Token lifetimes:** 1 h access, 30-day rotating refresh, no absolute cap in v1; personal tokens 90
    days by default (max 365).
15. **Approval expiry** 30 minutes, admin-editable.
16. **No AI access for an SA that holds `infra:report`** (the fleet-wide agent token).
17. **Turning AI off keeps conversations and connected apps dormant** until re-enabled.

The MCP client trust policy, the one open item at proposal time, is resolved by decision 13.
