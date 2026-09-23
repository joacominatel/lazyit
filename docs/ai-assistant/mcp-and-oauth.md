---
title: "AI assistant — MCP server, lazyit as OAuth 2.1 authorization server, and the instance-served Claude Code skill"
tags: [ai-assistant, mcp, oauth, auth, security, design]
status: draft
created: 2026-09-23
updated: 2026-09-23
---

# MCP server, OAuth 2.1 authorization server, and the instance-served skill

> Design analysis for **channel 2** of the AI capability: an MCP server so external agents (Claude Code,
> Cursor, claude.ai, ChatGPT…) can use lazyit **as the invoking user**. lazyit itself is the OAuth 2.1
> authorization server, built on the local session ([[0086-local-authentication-mode]]). Sibling notes in
> `docs/ai-assistant/` own the tool catalog, the provider layer, the in-app chat and the headless API; this
> note owns how the catalog is **exposed over MCP**, how MCP clients are **authorized**, and how the
> **Claude Code skill** is distributed.
>
> **Labels.** **[R]** repository fact (cited path/symbol) · **[E]** external fact (cited URL + version) ·
> **[C]** conclusion of this analysis · **[A]** assumption that must be verified or honored by another slice.
>
> **Reconciled with the synthesis (2026-09-23).** The CEO's decisions and the CTO's cross-slice
> reconciliations (R1–R10) are applied throughout. [[ai-assistant/_synthesis|The synthesis]] is binding:
> where this note and the synthesis disagree, the synthesis wins. The implementation units at the end are
> superseded by the synthesis's unified wave plan.

---

## 1. Context

**Settled by the CEO (not re-litigated here):**

- The AI capability is **off by default**, enabled by an admin wizard.
- The AI acts **as the invoking user**, with exactly their permissions. External MCP = the human user,
  authenticated via OAuth; scripts = Service Account ([[0048-service-accounts]], [[0080-service-account-secret-retrieval]]).
- **"OAuth 2.1 desde el día uno."** All OIDC (bundled Zitadel + BYOI) will be removed (issue #1310), so lazyit
  is its own authorization server on top of the **local** session and this design adds **zero** dependency
  on Zitadel/OIDC.
- Over MCP, **the client owns confirmation UX**; the user's permissions bound what can happen.
- The AI may do **anything the user can**, except the Secret Manager (zero-knowledge,
  [[0061-secret-manager-zero-knowledge]]), operations that return a credential in cleartext (SA token
  create/rotate, temporary passwords) and the AI's own configuration (CEO, round 2). Privilege- and
  identity-changing tools stay in, behind the `elevated` class.
- In-app chat and headless use are gated by `ai:use`. MCP is gated by its own permission **`ai:connect`**
  (ADMIN + MEMBER by default), and the MCP switch is independent of the LLM provider configuration (CEO,
  round 2).
- The skill is **served by the instance** ("Install in Claude Code"), pre-configured with the instance URL,
  versioned with the instance.

**What must not change [C]:**

- The REST API's authentication and authorization (`JwtAuthGuard` → `MustChangePasswordGuard` → `RolesGuard`)
  and INV-1 / INV-8 / INV-SA-1…4 ([[INVARIANTS]]).
- The local session token's semantics (HS256, `sessionEpoch` revocation) — MCP does not reuse it as a bearer.
- INV-10 (the server never decrypts vault material): no Secret Manager tool exists on any channel.
- Existing Caddy routes; existing `/api/*` behavior.
- No OIDC/IdP code path is added anywhere.

---

## 2. Repository facts

- **[R] Global guard chain.** `apps/api/src/auth/auth.module.ts` registers `APP_GUARD`s in order
  `JwtAuthGuard` → `MustChangePasswordGuard` → `RolesGuard`.
- **[R] Service-account branch runs first, in every mode.** `apps/api/src/auth/jwt-auth.guard.ts`
  `canActivate` routes a `Bearer lzit_sa_…` to `handleServiceAccount` (lookup incl. soft-deleted,
  constant-time compare, generic 401), then dispatches `shim | local | oidc` by `AUTH_MODE`.
- **[R] Local human auth is DB-first with an epoch.** `JwtAuthGuard.handleLocal` verifies the HS256 session
  via `LocalCredentialService.verifySession` (`apps/api/src/auth/local/local-credential.service.ts`,
  hand-rolled on `node:crypto`, alg-pinned), then re-loads the `User` every request and rejects on
  `sessionEpoch` mismatch, `!isActive`, `directoryOnly`, or soft-delete. Epoch bumps live in
  `password-lifecycle.service.ts` (lines ~151, ~526), `users.service.ts` (~1232, ~1328) and
  `reset-admin-password.ts`.
- **[R] Opaque-token precedent.** `apps/api/src/service-accounts/service-account-token.ts`: 32-byte CSPRNG
  secret, base64url, stored as SHA-256 hex, `timingSafeEqual`, shown once, greppable prefix.
- **[R] Principal model.** `apps/api/src/auth/principal.ts`: `Principal = HumanPrincipal | ServicePrincipal`.
  `RolesGuard` (`roles.guard.ts`) authorizes humans via `PermissionResolverService` (DB rows; ADMIN = full
  catalog) and service accounts fail-closed on their direct grants.
- **[R] `@Public` routes skip the forced-password-change wall.** `must-change-password.guard.ts` exempts
  `@Public()` routes — a route that authenticates itself must re-check `mustChangePassword`.
- **[R] No global prefix; routing is Caddy's.** `apps/api/src/main.ts` has no `setGlobalPrefix`;
  `infra/caddy/Caddyfile` sends `/api/*` (minus Auth.js paths) to `api:3001` with `uri strip_prefix /api`
  and **everything else to `web:3000`**. So `/.well-known/*` and `/mcp` currently hit Next.js. The site
  block sets `X-Frame-Options DENY` and `encode zstd gzip` globally.
- **[R] Origin handling.** `main.ts` sets `trust proxy` from `TRUST_PROXY`; CORS reflects the request origin
  when `AUTH_TRUST_HOST=true` (`common/cors-origin.ts`). JSON body limit via `resolveJsonBodyLimit`.
- **[R] Deployment axes.** [[0087-plain-http-lan-deployment-axis]]: `lan` = port-only Caddy address, plain
  HTTP, any host, `WEB_ORIGIN` unset, `AUTH_TRUST_HOST=true`, requires `AUTH_MODE=local`; `local` =
  `localhost` + internal CA; `real` = FQDN + Let's Encrypt or internal CA. `lan` is an insecure browser
  context.
- **[R] Web gate.** `apps/web/proxy.ts` redirects unauthenticated navigation to `/login?callbackUrl=…` and
  keeps an explicit public-path list (incl. `/install.sh`, `/install.ps1` — anonymous instance-served
  artifacts carrying no secret).
- **[R] Settings is admin-only.** `apps/web/app/(app)/settings/page.tsx` is wrapped in `AdminGate`
  (`settings:manage`). A per-user area exists at `apps/web/app/(app)/account/` (today: `notifications`).
- **[R] Egress guard.** `apps/api/src/common/egress/egress-guard.ts` `guardedFetch`: HTTPS-only by default,
  resolves + pins IPs, denies private/loopback/link-local/IMDS, re-validates redirects, strips credentials
  cross-origin. Its header comment says it has no consumer yet.
- **[R] Credential rows are hard-deleted.** `PasswordResetToken` (`apps/api/prisma/schema.prisma`) stores
  `tokenHash @unique`, `expiresAt`, `usedAt`; `password-lifecycle.service.ts` prunes with `deleteMany`.
- **[R] Security audit logs are per-source and readable.** [[0081-audit-log-read-surface]]: `SecretAuditLog`,
  `PermissionAuditLog`, `ServiceAccountAuditLog`, read via `apps/api/src/audit/` under `logs:read`.
- **[R] Instance version is not anonymous.** `apps/api/src/instance/instance.controller.ts` keeps
  `GET /instance/version` deliberately non-`@Public`.
- **[R] Instance-served artifact precedent.** `apps/api/src/agent-dist/agent-dist.controller.ts` serves
  agent binaries baked into the API image ([[0074-server-reporting-agent]]).
- **[R] Stack.** `apps/api/package.json`: NestJS `^12.0.1` (ESM packages), zod `^4.4.3`, jose `^6.2.3`,
  jszip `^3.10.1`. [[0096-jest-commonjs-against-esm-nestjs]]: Jest stays CommonJS; any ESM-only runtime
  dependency must join `transformIgnorePatterns`.
- **[R] Permission catalog.** `packages/shared/src/schemas/permission.ts` — `PERMISSION_DOMAINS` has no `ai`
  domain yet; the catalog is frozen/closed (INV-8).
- **[R] Constraint issue.** #1310: "Any authentication a new feature needs, such as OAuth 2.1 for MCP
  clients, is issued by lazyit itself on top of the local session."

---

## 3. External facts

**MCP specification — revision `2026-07-28` (current)**
<https://modelcontextprotocol.io/specification/2026-07-28/changelog>

- **[E]** Protocol-level sessions and `Mcp-Session-Id` removed; the `initialize` handshake removed; every
  request carries protocol version/capabilities in `_meta`; new mandatory `server/discover`; GET stream
  replaced by `subscriptions/listen`; SSE resumability removed; `ping`/`logging/setLevel` removed.
  Requests carry `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers that the server must validate
  against the body (`HeaderMismatch` `-32020`).
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- **[E]** A 2026-07-28-only server **SHOULD** answer GET/DELETE with 405 and ignore `Mcp-Session-Id`;
  servers wanting older clients implement the older revision behavior too.
- **[E]** Servers **MUST** validate `Origin` (403 on an invalid present `Origin`).
- **[E]** `tools/list` **MUST NOT** vary per connection but **MAY** vary by the authorization presented;
  **SHOULD** be deterministic in order. List results carry `ttlMs` and `cacheScope` (`public`|`private`).
  <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- **[E]** Tool errors: unknown tool / malformed request → JSON-RPC error; API, validation and business
  errors → result with `isError: true` so the model can self-correct. Servers **MUST** validate inputs,
  enforce access control, **rate-limit tool invocations**, sanitize outputs. `structuredContent` should be
  mirrored as serialized JSON text for back-compat.
- **[E]** `ToolAnnotations` (schema `2026-07-28/schema.ts`): `readOnlyHint` (default **false**),
  `destructiveHint` (default **true**, meaningful only when not read-only; false = "only additive
  updates"), `idempotentHint` (default false), `openWorldHint` (default **true**). Clients **MUST** treat
  annotations as untrusted unless the server is trusted.
- **[E]** Server-to-client interactions (elicitation etc.) now use Multi Round-Trip Requests
  (`InputRequiredResult`, SEP-2322).
- **[E] Authorization** (<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> and
  sub-pages): the MCP server is an OAuth 2.1 resource server and **MUST** publish RFC 9728 Protected
  Resource Metadata (via `WWW-Authenticate: Bearer resource_metadata=…` on 401 and/or well-known
  `/.well-known/oauth-protected-resource[/<path>]`); the AS **MUST** expose RFC 8414 or OIDC discovery and
  **MUST** advertise `code_challenge_methods_supported` (clients refuse otherwise); clients **MUST** use PKCE
  S256 and send RFC 8707 `resource` on authorize **and** token requests; servers **MUST** validate audience
  and **MUST NOT** accept or pass through other tokens; AS **SHOULD** send RFC 9207 `iss` and advertise
  `authorization_response_iss_parameter_supported`; AS **MUST** rotate refresh tokens for public clients;
  **"All authorization server endpoints MUST be served over HTTPS"** and **"All redirect URIs MUST be either
  localhost or use HTTPS"**; exact redirect matching; consent screen **MUST** show the redirect hostname and
  **SHOULD** warn for localhost-only redirects; CIMD fetches **SHOULD** consider SSRF. Registration priority
  for clients: pre-registered → CIMD (if `client_id_metadata_document_supported`) → DCR. **DCR is
  deprecated** (kept for compatibility). Insufficient scope → 403 `insufficient_scope` with `scope=`;
  servers **MUST** account for scope hierarchies. `offline_access` **SHOULD NOT** appear in PRM.
- **[E] Skills over MCP** (`io.modelcontextprotocol/skills`, SEP-2640 Final 2026-09-13); client matrix shows
  **no Claude Code support** yet, partial ChatGPT.
  <https://modelcontextprotocol.io/community/working-groups/skills-over-mcp>,
  <https://modelcontextprotocol.io/extensions/client-matrix>

**Official TypeScript SDK** (npm registry, checked 2026-09-23)

- **[E]** v2 is stable. It was first released 2026-07-27 as 2.0.0. **W1-B pinned
  `@modelcontextprotocol/server@2.1.0` and `@modelcontextprotocol/node@2.1.0`** (PR #1331); the current
  `@modelcontextprotocol/express` is 2.0.1. Exports are dual `import`/`require`, so no Jest lookahead
  entry is needed. It needs `zod ^4.2.0` and Node ≥ 20. `hono` is only an optional peer of `/node`. The
  v1 line is `@modelcontextprotocol/sdk@1.30.0` (legacy, fixes only).
  <https://github.com/modelcontextprotocol/typescript-sdk>
- **[E] Compatibility spike (W1-B, PR #1331)** — `apps/api/src/ai/providers/__compat__/mcp-server-load.spec.ts`.
  The MCP-server unit (W3-2) must know:
  - **A modern request needs more than the version header.** `LATEST_PROTOCOL_VERSION` still reports
    `2025-11-25`; the 2026-07-28 revision is served only on `createMcpHandler`'s *modern* path. A
    request reaches that path only if it carries:
    - the `mcp-protocol-version: 2026-07-28` and `mcp-method: <method>` headers (and `mcp-name` where
      the method names a target);
    - `params._meta` keys `io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientInfo`
      and `io.modelcontextprotocol/clientCapabilities`.

    Anything else is classified 2025-era and served by the stateless legacy leg (`legacy: 'stateless'`,
    the default). Golden tests must send the full envelope, or they silently test the legacy leg.
  - **`createMcpHandler` performs no Origin or Host validation**, and no token verification either:
    `authInfo` is pure pass-through. The MCP route must validate `Origin` (403 on an invalid present
    `Origin`, per the spec) and `Host` before the handler. Use the `@modelcontextprotocol/node` helpers
    `originValidation` / `hostHeaderValidation` with the instance's public origin, not the localhost
    variants.
  - **Wiring verified.** `toNodeHandler(handler)` over `node:http` forwards `req.auth` as `authInfo`
    to the per-request factory, and `fromJsonSchema(schema)` accepts the catalog's JSON Schema as a
    tool's `inputSchema`. Both were checked in-process.
- **[E]** `createMcpHandler(factory)` builds a fresh `McpServer` per request, serves the 2026 era and, by
  default, 2025-era traffic statelessly (`legacy: 'stateless'`); the factory receives `authInfo`, so it can
  register a different tool set per caller. `toNodeHandler(handler)(req, res, req.body)` adapts to
  Express and forwards `req.auth` → `ctx.http.authInfo`. `docs/protocol-versions.md`, `docs/serving/express.md`.
- **[E]** v2 ships **resource-server** helpers only (`requireBearerAuth`, `verifyBearerToken`,
  `bearerAuthChallengeResponse`, `buildOAuthProtectedResourceMetadata`, `validateOriginHeader`,
  per-tool `scopeChallenge`); **"The Authorization Server helpers (`mcpAuthRouter`,
  `ProxyOAuthServerProvider`, …) are frozen in `@modelcontextprotocol/server-legacy/auth`. Use a dedicated
  identity provider for new servers."** `docs/serving/authorization.md`.
- **[E]** `AuthInfo = { token, clientId, scopes, expiresAt?, resource?: URL, extra? }`; `requireBearerAuth`
  401s a token whose `expiresAt` is unset.
- **[E]** The **v2 client refuses non-TLS, non-loopback token endpoints**: `assertSecureTokenEndpoint` throws
  `InsecureTokenEndpointError` ("SEP-2207: refuse to send credentials to a non-TLS, non-loopback token
  endpoint") — `@modelcontextprotocol/client@2.0.0` `dist/index.mjs`. The v1 client has no such check
  (inspected `@modelcontextprotocol/sdk@1.30.0`).

**Clients**

- **[E] Claude (all surfaces)** — <https://claude.com/docs/connectors/building/authentication>: supports
  `oauth_dcr` and `oauth_cimd`; CIMD is chosen only if AS metadata advertises **both**
  `client_id_metadata_document_supported: true` **and** `"none"` in
  `token_endpoint_auth_methods_supported`; PKCE S256 always; hosted surfaces (claude.ai, Desktop, mobile,
  Cowork) redirect to `https://claude.ai/api/mcp/auth_callback` and **connect from Anthropic's cloud**
  (egress `160.79.104.0/21`; host must have public DNS and a globally routable address — private,
  split-horizon, IPv6-only hosts rejected, per the Claude Help Center
  <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>);
  **Claude Code** runs OAuth locally with CIMD `client_id` `https://claude.ai/oauth/claude-code-client-metadata`,
  declaring `http://localhost/callback` and `http://127.0.0.1/callback` — **the AS must match these
  port-agnostically**; refresh reactive on 401 plus proactive ≤5 min before expiry; token endpoint must
  accept `application/x-www-form-urlencoded`; answer `invalid_grant` for dead refresh tokens; 10 s timeout
  for discovery/registration/token, 30 s for refresh; appends `offline_access` if the AS lists it.
- **[E] Claude Code config** — <https://code.claude.com/docs/en/mcp>: `claude mcp add --transport http
  <name> <url>`; `.mcp.json` `{"type":"http","url":…,"headers":…,"headersHelper":…,"oauth":{…}}`;
  `oauth.authServerMetadataUrl` must be `https://`. Known CIMD port-mismatch regression in 2.1.80
  (anthropics/claude-code#37747, closed) confirms the port-agnostic requirement.
- **[E] Claude Code plugins** — <https://code.claude.com/docs/en/plugins-reference>,
  <https://code.claude.com/docs/en/plugin-marketplaces>, <https://code.claude.com/docs/en/skills>: a plugin
  bundles `skills/<name>/SKILL.md` and a root `.mcp.json`; `userConfig` values (optionally `sensitive`,
  stored in secure storage) substitute as `${user_config.KEY}` in MCP server configs; a marketplace can be
  added by **direct URL to `marketplace.json`**, in which case plugin sources must be remote — an
  `archive` source (`{"source":"archive","url":…,"sha256":…}`) works, and without an explicit `version`
  the archive's SHA-256 is the update signal. `SKILL.md` frontmatter: `name`, `description` (+`when_to_use`,
  ≤1,536 chars in listings), keep `SKILL.md` under 500 lines, supporting files loaded on demand.
- **[E] ChatGPT developer mode** — <https://developers.openai.com/api/docs/guides/developer-mode>: Streamable
  HTTP/SSE, OAuth; "We respect the `readOnlyHint` tool annotation… Tools without this hint are treated as
  write actions", and write actions require confirmation by default. CIMD and DCR supported.
- **[E] Cursor** — <https://cursor.com/docs/context/mcp>: `mcp.json` with `url` (+`headers`), DCR by default,
  static `auth.CLIENT_ID`; desktop redirect `http://localhost:8787/callback` per docs (not verified
  empirically).

**Prior art**

- **[E] GitHub remote MCP** — <https://github.com/github/github-mcp-server> `docs/remote-server.md`: OAuth by
  default, PAT via `Authorization` header as the alternative; toolsets as URL paths (`/mcp/x/<toolset>`) or
  `X-MCP-Toolsets`/`X-MCP-Tools` headers; `/readonly` URL suffix to drop write tools.
- **[E] Sentry MCP** — <https://docs.sentry.io/product/sentry-mcp.md>: the consent screen lets the user pick
  which capability groups ("skills") to grant; `?skills=` narrows the tool surface; org/project-scoped URLs.
- **[E] panva `oidc-provider`** 9.12.2 (2026-09-05, ESM, Koa-based): RFC 8707, CIMD (draft-02) and DCR
  support; a full OpenID Provider.

---

## 4. Options per fork

### F1 — How is the authorization server built?

| Option | Assessment |
| --- | --- |
| **A. Hand-rolled minimal AS in `apps/api` (recommended)** | Surface is small and bounded: authorization code + PKCE S256, refresh rotation, DCR, CIMD, RFC 7009 revocation, two metadata docs, public clients only, one resource. Reuses proven repo primitives (SA token hashing, egress guard, rate-limit guards, DB-first user reload). Typed Prisma tables fit the "connected apps" UI and audit. Cost: security-critical code lazyit owns — mitigated by a sentinel review, the MCP conformance suite, and RFC 9700 as checklist. |
| B. panva `oidc-provider` mounted in Nest | Battle-tested, feature-complete. But it is an **OpenID Provider** (id_token, userinfo, `openid-configuration`) — against the #1310 direction; Koa inside Nest; its opaque key-value adapter model fights typed tables and per-user listing; ESM-only (ADR-0096 transform); large configuration surface to switch *off*. |
| C. SDK v1 `mcpAuthRouter` (`server-legacy/auth`) | Frozen by upstream; no CIMD; the SDK itself steers away from it. |
| D. External IdP (Keycloak/Authentik/Zitadel) | Excluded by the CEO (#1310). |

### F2 — Client registration

| Option | Assessment |
| --- | --- |
| DCR only | Works offline (no AS egress), every current client supports it. Deprecated in the spec; unauthenticated endpoint to rate-limit; self-asserted client names (phishable consent). |
| CIMD only | Spec direction; stable, domain-bound client identity. Needs AS **egress** to fetch the document — breaks on internet-less instances, and Claude Code does **not** fall back to DCR mid-flow once CIMD is advertised. |
| **DCR + CIMD, with a bundled offline copy of known client documents (recommended)** | DCR first (unit U1), CIMD next (U2). CIMD fetch through `guardedFetch`; for well-known client ids (Claude Code's `https://claude.ai/oauth/claude-code-client-metadata`) a copy ships in the image and is used when the fetch fails, so internet-less HTTPS instances still work. Consent screen shows "verified domain: claude.ai" for CIMD vs "self-declared, unverified" for DCR. |
| Pre-registration only | Forces every user to paste a client id; bad UX; no client needs it. |

### F3 — Token format

| Option | Assessment |
| --- | --- |
| **Opaque, hashed at rest (recommended)** | `lzit_oat_<secret>` (access), `lzit_ort_<secret>` (refresh): 32 random bytes, SHA-256 stored, looked up by unique hash index. Immediate revocation (per grant), no signing key, identical to the SA precedent. One indexed read per request — the guard already reloads `User` per request anyway. |
| Self-contained JWT | Still needs a DB hit for revocation/epoch/deactivation, so statelessness buys nothing; adds a key to manage and an alg-pin surface. |
| Reuse the local session JWT | Violates audience binding / token-passthrough rules; not per-client revocable; would let a leaked MCP token drive the whole REST API. |

### F4 — Where OAuth tokens are accepted

**`/mcp` only (recommended).** Audience = the canonical MCP URI. `JwtAuthGuard` already rejects
`lzit_oat_…` by construction (not a 3-segment HS256 JWT in local mode, JWKS failure in OIDC mode, ignored in
shim) — lock it with a regression test instead of new guard code. The reverse also holds: the local session
JWT is not accepted on `/mcp`.

### F5 — Mounting MCP in NestJS

| Option | Assessment |
| --- | --- |
| **Nest controller + SDK v2 `createMcpHandler` (recommended)** | `McpController` `@All('mcp')` → `toNodeHandler(createMcpHandler(factory))(req, res, req.body)`. Keeps DI, logging (pino/request id), and one process. Auth via a route-scoped Nest middleware/guard that implements the RFC 6750/9728 challenge (SDK `verifyBearerToken`/`bearerAuthChallengeResponse` with a lazyit verifier) and sets `req.auth`. The controller is `@Public()` towards the global session guards (like `/config/setup`) and **fails closed** if `req.auth` is absent; a golden test pins that the MCP route carries the MCP guard. The MCP layer itself adds no edit to `jwt-auth.guard.ts` or `roles.guard.ts`; the feature's only guard changes (the delegated-identity branch and the `ServiceAccountAuthenticator` extraction) belong to the AI-core unit ([[ai-assistant/_synthesis|synthesis]] §10). |
| Raw Express middleware in `main.ts` | Outside DI; invisible to Nest conventions. |
| Separate process/container | New infra, a second DB client, duplicated auth; unjustified for a 5–20 person tool. |

### F6 — Public URL layout / routing

| Option | Assessment |
| --- | --- |
| **Caddy routes a short allowlist to the API (recommended)** | Add an `@mcp_oauth` matcher (no strip): `/mcp`, `/.well-known/oauth-protected-resource*`, `/.well-known/oauth-authorization-server*`, `/oauth/token`, `/oauth/register`, `/oauth/revoke` → `api:3001`. Issuer is the bare origin, which every client's RFC 8414 probe handles first. `/oauth/authorize` stays on web (it is the consent UI). |
| Next.js route handlers proxying to the API | Extra hop; SSE streaming through Next; duplicated error handling. |
| Everything under `/api` with a path issuer | Well-known path-insertion lands on web anyway; relies on clients' third discovery fallback. |

### F7 — Session model

**Stateless per request (recommended)** — the 2026-07-28 spec removed sessions; `createMcpHandler` serves
legacy clients statelessly. No Valkey state, no sticky routing. Cross-call state (none needed today) would use
explicit handles in tool arguments.

### F8 — The plain-HTTP `lan` reality (decided: option C)

| Option | Works with | Assessment |
| --- | --- | --- |
| A. MCP only on HTTPS modes | all local clients on `real` (+internal CA trusted via `NODE_EXTRA_CA_CERTS`) | Spec-compliant; excludes the majority `lan` segment unless they add internal DNS + CA. |
| B. OAuth over plain HTTP anyway | v1-SDK-era clients only | Violates "AS endpoints MUST be HTTPS"; **breaks as clients move to SDK v2** (`InsecureTokenEndpointError`). Not recommended. |
| **C. A + per-user personal MCP tokens (`lzit_pat_…`) for `lan` (decided — CEO, round 2)** | Claude Code, Cursor, VS Code (static `Authorization` header / plugin `userConfig`) | Same grant table, same revocation UI, mandatory expiry. Cleartext on the LAN is the posture ADR-0087 already accepted for the session token. OAuth remains the only path on HTTPS instances. |

### F9 — Permission gate for MCP (decided: `ai:connect`)

| Option | Assessment |
| --- | --- |
| Reuse `ai:use` | One concept; but conflates two different risks. |
| **New `ai:connect` (decided — CEO, round 2)** | `ai:use` = "may consume the **organization's** configured LLM provider" (cost, org DPA). `ai:connect` = "may delegate my account to an **external** agent" — data leaves to whatever LLM vendor the user's client uses (possibly a personal ChatGPT account), with long-lived refresh tokens stored off-instance. An admin plausibly wants one without the other. Seeded ADMIN + MEMBER like `ai:use`. |

### F10 — OAuth scopes

| Option | Assessment |
| --- | --- |
| No scopes (user permissions only) | Simplest; no way for a user to connect an agent read-only. |
| **Coarse scopes `lazyit.read`, `lazyit.write`, plus `lazyit.admin` for `elevated`-class tools (decided — R7)** | Narrow, never widen: effective authority = user's current permissions ∩ scope class. `write` implies `read` (scope hierarchy). Consent screen offers "Read only" / "Read & write" (Sentry precedent). `lazyit.admin` is never preselected and requires password step-up at consent ([[ai-assistant/security|security]] §6.3). Dotted names avoid confusion with the `domain:action` permission catalog. |
| Per-domain scopes | Duplicates the permission matrix; consent-screen overload. |

### F11 — Tool surface size

**All tools the caller may use, one endpoint (recommended for v1).** GitHub-style toolsets (`/mcp/x/<set>`,
headers) are deferred until the catalog is large enough to hurt clients' context; tool names are domain-prefixed
so grouping can be added without renames.

### F12 — Confirmations over MCP

**Annotations only (recommended).** Accurate `readOnlyHint`/`destructiveHint`/`openWorldHint` drive client
confirmation (ChatGPT confirms every non-read-only tool; Claude Code prompts per tool). Server-driven
elicitation (MRTR `input_required`) is not built: client support varies and the CEO assigned confirmation to
the client.

### F13 — Service Account tokens on `/mcp` (adopted by default — R10)

| Option | Assessment |
| --- | --- |
| Reject | Smallest surface; CI agents use the headless channel or REST. |
| **Accept, fail-closed, gated by the SA holding `ai:connect` (adopted by default — R10; CEO to confirm)** | An SA can already call every REST route it has grants for, so exposing the same tools adds no privilege; enables "Claude Code in CI" with a header. Cost: extract the SA verification out of `JwtAuthGuard` into a shared `ServiceAccountAuthenticator` (a security-critical refactor) rather than duplicate it. |

### F14 — Skill distribution

| Option | Assessment |
| --- | --- |
| **URL marketplace + archive plugin served by the instance — HTTPS instances with MCP enabled (decided — R8)** | `claude plugin marketplace add <origin>/api/ai/claude-code/marketplace.json` then `claude plugin install lazyit@lazyit`. The plugin zip is rendered from in-repo templates + the **live tool registry**; `sha256` (no `version`) is the update signal → never drifts, no version disclosure. Bundles `skills/lazyit/SKILL.md`, reference files, `.mcp.json` pointing at `<origin>/mcp`. |
| **Authenticated zip download + manual install — always available (decided — R8)** | No anonymous surface; loses auto-update (drift). The only path on `lan` (Claude Code's `archive` source is HTTPS-only) and a fallback everywhere. |
| Skills over MCP extension | Drift-proof and client-agnostic, but Claude Code does not support it yet (client matrix). Follow-up. |

Universal complement: the MCP server's `instructions` carry a short usage primer for every client.

### F15 — Consent memory

**Always show consent (recommended).** Re-authorization is rare (refresh tokens last 30 days, sliding);
DCR creates a new client per connection anyway; always-prompt defeats silent re-grant via a lookalike client.

---

## 5. Recommendation

### 5.1 Endpoints

| Purpose | Public URL | Served by | Auth |
| --- | --- | --- | --- |
| MCP endpoint (resource) | `{origin}/mcp` | api `McpController` | Bearer `lzit_oat_` (HTTPS) / `lzit_pat_` (`lan`) / `lzit_sa_` (an SA holding `ai:connect`, R10) |
| Protected Resource Metadata | `{origin}/.well-known/oauth-protected-resource/mcp` (+ root alias) | api | none |
| AS metadata (RFC 8414) | `{origin}/.well-known/oauth-authorization-server` | api | none |
| Authorization endpoint (consent UI) | `{webOrigin}/oauth/authorize` | web page | local session |
| Consent validate / decision (internal) | api `/oauth/authorize/validate`, `/oauth/authorize/decision` (via `INTERNAL_API_URL`) | api | session Bearer |
| Token | `{origin}/oauth/token` (form-urlencoded) | api | public client (`client_id`) |
| Registration (DCR) | `{origin}/oauth/register` (JSON) | api | none, rate-limited |
| Revocation (RFC 7009) | `{origin}/oauth/revoke` | api | `client_id` |
| My connections | `{origin}/api/oauth/grants/mine` (list/revoke) · `{origin}/api/oauth/personal-tokens` (`lan` only) | api | session + `ai:connect` |
| All users' connections (admin) | `{origin}/api/oauth/grants?userId=` (list/revoke) | api | session + `settings:manage` |
| Plugin marketplace + archive (public) | `{origin}/api/ai/claude-code/marketplace.json`, `…/lazyit-plugin.zip` | api | none — only when MCP is enabled on an HTTPS instance (R8) |
| Plugin download (authenticated) | `{origin}/api/ai/claude-code/plugin.zip` | api | session + `ai:connect`; always available while MCP is enabled |

`origin` = `WEB_ORIGIN` when pinned (`local`/`real`). The canonical resource is `{origin}/mcp` (no trailing
slash); the issuer is `{origin}` and is **pinned configuration, never derived from `Host`**
([[ai-assistant/security|security]] T-30). **When MCP is disabled every row above answers 404** — off by
default means no new anonymous surface. **On a `lan` instance** (plain HTTP, `Host`-derived origin) the
authorization server, both metadata documents and the public marketplace answer 404; `/mcp` accepts only
personal tokens (and SA tokens), and its 401 carries a plain `Bearer` challenge without `resource_metadata`
(CEO, round 2; §5.4).

**AS metadata** advertises: `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`,
`revocation_endpoint`, `response_types_supported: ["code"]`, `grant_types_supported:
["authorization_code","refresh_token"]`, `code_challenge_methods_supported: ["S256"]`,
`token_endpoint_auth_methods_supported: ["none"]`, `scopes_supported: ["lazyit.read","lazyit.write","lazyit.admin"]`,
`client_id_metadata_document_supported: true` (from U2), `authorization_response_iss_parameter_supported:
true`, `service_documentation` → the Manual page. **PRM** advertises `resource`, `authorization_servers:
[issuer]`, `scopes_supported: ["lazyit.read","lazyit.write","lazyit.admin"]`, `bearer_methods_supported: ["header"]`,
`resource_name: "lazyit"`.

### 5.2 Authorization flow

1. Client → `GET {webOrigin}/oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&scope&resource`.
2. `proxy.ts` sends an unauthenticated browser to `/login?callbackUrl=…`; a `mustChangePassword` user hits the
   existing forced-change wall first.
3. The page (server component) calls API `POST /oauth/authorize/validate` with the session Bearer and the raw
   parameters. The API validates: MCP enabled; user holds `ai:connect`; client exists (DCR row, CIMD fetch or
   bundled copy); `redirect_uri` matches **exactly** — except loopback `http://127.0.0.1|localhost|[::1]`
   where only the port is ignored (RFC 8252 §7.3, Claude Code); PKCE S256 present (`plain` refused);
   `resource` equals the canonical URI (absent → defaulted, tolerant); scopes ⊆ supported. **An invalid
   `client_id` or `redirect_uri` renders an error page and never redirects** (RFC 6749 §4.1.2.1); other errors
   redirect with `error`, `state`, `iss`.
4. The consent screen shows: client name + "verified domain" (CIMD) or "self-declared, unverified" (DCR); the
   **redirect host**, with an extra warning when it is loopback-only; "acting as <name> (<role>) — it can do
   anything you can in lazyit, except the Secret Manager, credential-returning actions and the AI's own configuration"; the access choice
   Read only / Read & write (preselected) / Admin actions (`lazyit.admin`: never preselected, password step-up); how to
   revoke later. Clickjacking is already blocked (`X-Frame-Options DENY` in Caddy).
5. Approve → a Next.js server action calls `POST /oauth/authorize/decision` with the Bearer and the **same raw
   parameters plus the chosen scope** (the API re-validates everything; no trust in the page). The API stores a
   single-use code (hash, 60 s TTL, bound to user, client, redirect, challenge, scope, resource) and returns
   `redirect_uri?code&state&iss`. The API is Bearer-authenticated, so no cookie-CSRF surface.
6. `POST /oauth/token` (`authorization_code`): atomic single use (`updateMany where usedAt null`), PKCE verify,
   redirect/client/resource match → creates the **grant** and returns `lzit_oat_` (1 h) + `lzit_ort_` (30 days)
   with `Cache-Control: no-store`.
7. `POST /oauth/token` (`refresh_token`): atomic rotation; a rotated token presented again **outside** a 30 s grace
   window = reuse → the whole grant is revoked (audited); inside the grace window → `invalid_grant` without
   revocation (benign concurrent-refresh race). Dead tokens always answer `invalid_grant`.
8. Resource-server check on every `/mcp` request: token hash → grant (live, not expired) → **user reloaded**
   (live, `isActive`, not `directoryOnly`, `!mustChangePassword`, `sessionEpoch == grant.sessionEpoch`) →
   MCP enabled → `ai:connect` held **now** → `resource` matches. Failure → 401 with
   `WWW-Authenticate: Bearer resource_metadata="…", scope="lazyit.read lazyit.write"`. `lastUsedAt` stamped
   fire-and-forget (SA precedent).

**Lifetimes:** code 60 s; access token 1 h; refresh token 30 days, rotated on each use (effectively a 30-day
idle timeout); no absolute cap in v1 (revocation, deactivation and epoch bumps cover it); personal tokens
(`lan` only) 90 days by default, 365 days max, always with an expiry. The security note's shorter
access-token recommendation (≤ 15 min) and absolute 30-day cap are reconciled in favour of these values:
opaque tokens are checked DB-first on every request, so revocation is already immediate
([[ai-assistant/_synthesis|synthesis]] §8; adopted by default, CEO to confirm).

### 5.3 Tool exposure over MCP

- **Factory per request**: `createMcpHandler(({ authInfo }) => buildServer(ctx))`, where `ctx = { principal,
  channel: 'mcp', grant: { id, clientId, clientName, scopes }, requestId }` is taken from the verified
  `authInfo.extra`.
- **Listing** (deterministic, sorted by name): registry tools where `channels` includes `mcp` **and** the principal
  holds every `requiredPermission` (via `PermissionResolverService` for humans, the grant Set for service
  accounts) **and** the scope covers the tool's class (`lazyit.read` → `read`; `lazyit.write` adds `write`;
  `lazyit.admin` adds `elevated`). `cacheScope: "private"`, `ttlMs: 60000`;
  `listChanged: false` (no `subscriptions/listen` in v1).
- **Calling**: re-run every listing check (permissions may have changed within the token's life), validate input,
  invoke `AiToolService.invoke(name, input, ctx)` — which dispatches through Nest's own guard and pipe
  pipeline (R1) — and return `structuredContent` + a serialized text mirror.
- **Annotations** derive from the registry's tool class (R4) and its `destructive` / `externalEffects` /
  `idempotent` flags ([[ai-assistant/tools-and-execution|tools]] §8.2):

| Class | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `read` | true | — | — | false |
| `write`, additive (e.g. create) | false | **false** | registry value | `externalEffects` |
| `write` with `destructive: true` (overwrite, archive, revoke, offboard) | false | **true** | registry value | `externalEffects` |
| `elevated` (listed only under `lazyit.admin`) | false | **true** | registry value | `externalEffects` |
| `navigate` | not exposed over MCP (chat-only) | | | |

  "External effects" = the tool sends email, triggers the workflow engine towards an external system,
  etc. Omitting `openWorldHint` would default to *true*, and omitting `destructiveHint` on a create would
  default to *true* — so both are always set explicitly.

- **Pagination**: list tools follow the catalog convention — `limit` default 20, max 50, and a
  `truncated { shown, total?, nextOffset? }` marker ([[ai-assistant/tools-and-execution|tools]] §7; reconciled in the synthesis)
  (an offset over the [[0030-list-pagination-contract]]). The MCP layer adds a hard
  backstop: a result over ~100 KB serialized returns `isError` guidance ("narrow the query or page") instead of
  flooding the client (Claude Code caps MCP output around 25k tokens by default).
- **Error shape**:

| Situation | MCP answer |
| --- | --- |
| Missing/invalid/expired token, epoch mismatch, disabled user | HTTP 401 + `WWW-Authenticate` (resource_metadata) |
| Token lacks the scope a call needs | HTTP 403 `insufficient_scope`, `scope="lazyit.write"` (SDK `scopeChallenge`) |
| MCP disabled / no `ai:connect` | HTTP 403 (a token exists but the capability is withdrawn) |
| Unknown tool, malformed params | JSON-RPC `-32602` |
| Input validation (zod) | `isError: true`, `structuredContent: { error: { code: "INVALID_INPUT", issues } }` |
| Domain 403 / 404 / 409 | `isError: true`, `code: "FORBIDDEN" \| "NOT_FOUND" \| "CONFLICT"`, safe message |
| Rate limit | `isError: true`, `code: "RATE_LIMITED"`, retry hint |
| Unexpected 5xx | `isError: true`, `code: "INTERNAL"`, request id ([[0031-logging-strategy]]), no internals |

- **Rate limits**: per grant (indicative 300 calls/min, 60 writes/min); `/oauth/register` per IP (10/h) with a cap
  on unused registrations; `/oauth/token` per IP; the decision endpoint per user. Pattern:
  `SetupRateLimitGuard` / `login-rate-limit.guard.ts`.
- **`Origin` check** (spec MUST): reject a present cross-origin `Origin` with 403; native clients send none.
- **Response mode**: prefer JSON responses over SSE for tool calls (no long-lived streams through Caddy's
  `encode`); verify SSE passes unbuffered if the SDK chooses it.
- **Server `instructions`**: a short primer (asset-centric model, search-first, pagination, confirm destructive
  actions, no Secret Manager) so non-Claude-Code clients get guidance without the skill. It is rendered from the single
  `LAZYIT_DOMAIN_PRIMER` constant ([[ai-assistant/tools-and-execution|tools]] §12), never hand-copied.

### 5.4 Personal MCP tokens (`lan` only — decided, CEO round 2)

`lzit_pat_…` minted in the user's AI connections page, shown once, stored hashed as a grant of `kind =
personal`, mandatory expiry, same verifier/checks, same revoke button. The plugin rendered for a `lan`
instance declares `userConfig.token` (`sensitive: true`) and
`"headers": {"Authorization": "Bearer ${user_config.token}"}`; HTTPS instances ship the header-less OAuth
variant. Offered **only** when the instance is in `lan` mode.

### 5.5 Skill package (instance-served)

```
lazyit-plugin.zip
├── .claude-plugin/plugin.json   name "lazyit", displayName "lazyit (<host>)", homepage <origin>,
│                                description; userConfig.token only for lan + personal tokens
├── .mcp.json                    { "mcpServers": { "lazyit": { "type": "http", "url": "<origin>/mcp" } } }
└── skills/lazyit/
    ├── SKILL.md                 frontmatter: name, description (+when_to_use) ≤1,536 chars;
    │                            body <500 lines: what lazyit is, the domain model in brief, the
    │                            workflow (search → read → act), write etiquette, pagination, errors
    ├── reference/domain.md      asset-centric rules, assignments as joins, soft delete, access grants
    └── reference/tools.md       GENERATED from the live registry at request time (names, one-liners,
                                 tool class, required permission) — the no-drift guarantee
```

- Templates live in the repo under the MCP module; the archive is assembled with `jszip` (already a
  dependency), cached per process and keyed by (template hash, registry hash, origin).
- `marketplace.json` has no `version` and carries the `sha256` → auto-update on content change, no version
  disclosure (the ADR-0083 posture keeps `/instance/version` non-anonymous).
- `Cache-Control: no-store`.
- **Availability (R8).** The authenticated download (`plugin.zip`, session + `ai:connect`) is always
  available while MCP is enabled; it is the only path on `lan`, where the plugin carries
  `userConfig.token`. The public `marketplace.json` + archive exist only when MCP is enabled on an HTTPS
  instance, because Claude Code's `archive` source is HTTPS-only.
- The page also shows a generic `.mcp.json` / `mcp.json` snippet for Cursor/VS Code, and — only when the
  instance is on `real` with a public name — the claude.ai connector URL.

### 5.6 Where the UI lives

- **Settings → AI (admin)**: an "External agents (MCP)" switch, independent of provider configuration (decided — CEO, round 2),
  plus the list of all users' active connections with revoke, for incident response and offboarding (R9).
- **Account → AI connections (`/account/ai`, every user holding `ai:connect`)**: install instructions (Claude
  Code plugin commands, generic snippet), the user's connected apps (client, verified/unverified, access level,
  created, last used, revoke), and — in `lan` — personal tokens (R9).
- Manual (en + es): "Connect an AI agent (MCP)" — per [[0062-in-app-help-manual-surface]].

### 5.7 OIDC mode — transitional footnote

The AS depends only on "the web session resolves a human via `JwtAuthGuard`", which holds in every mode. On an
instance still running `AUTH_MODE=oidc`, the consent page works unchanged: the Bearer is the IdP token and the
guard resolves the `User`. `sessionEpoch` exists (default 0) and deactivation or soft-delete still kills grants.
**No OIDC-specific code is written**; when #1310 lands, nothing in this design changes.

---

## 6. Data model sketch (additive, Prisma-ish)

> The consolidated table list for the whole feature — one migration — is in
> [[ai-assistant/_synthesis|the synthesis]] §6. This sketch is its OAuth part.

```prisma
/// A registered OAuth client — DCR-registered, CIMD-cached, or a bundled known client.
model OAuthClient {
  id           String    @id @default(cuid())
  clientId     String    @unique            // random "lzc_…" for DCR; the https URL for CIMD
  kind         String                       // 'dcr' | 'cimd' | 'known'  (String, not a DB enum — InstanceConfig precedent)
  name         String
  clientUri    String?
  logoUri      String?
  redirectUris String[]
  metadata     Json                         // sanitized registration / CIMD document
  fetchedAt    DateTime?                    // CIMD cache freshness
  lastUsedAt   DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  grants       OAuthGrant[]
  codes        OAuthAuthorizationCode[]
  @@index([kind, lastUsedAt])
  @@map("oauth_clients")
}

/// A "connected app": one user's delegation to one client (or a personal token). Soft-deleted = revoked.
model OAuthGrant {
  id            String    @id @default(cuid())
  userId        String    @db.Uuid
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind          String    @default("oauth") // 'oauth' | 'personal'
  clientRefId   String?                     // null for personal tokens
  client        OAuthClient? @relation(fields: [clientRefId], references: [id], onDelete: SetNull)
  label         String?                     // personal-token name
  scopes        String[]                    // subset of lazyit.read / lazyit.write / lazyit.admin
  resource      String                      // canonical MCP URI at issuance
  sessionEpoch  Int                         // snapshot; mismatch with User.sessionEpoch = dead (R7)
  expiresAt     DateTime?                   // personal tokens only
  lastUsedAt    DateTime?
  revokeReason  String?                     // 'user' | 'admin' | 'refresh_reuse' | 'revocation_endpoint' | 'client_deleted'
  revokedById   String?   @db.Uuid
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  deletedAt     DateTime?                   // ADR-0006/0032 soft delete = revoked; add to SOFT_DELETABLE_MODELS
  tokens        OAuthToken[]
  @@index([userId])
  @@map("oauth_grants")
}

/// Single-use authorization codes (credential material — hard-deleted by the sweeper, PasswordResetToken precedent).
model OAuthAuthorizationCode {
  id            String    @id @default(cuid())
  codeHash      String    @unique
  userId        String    @db.Uuid
  clientRefId   String
  client        OAuthClient @relation(fields: [clientRefId], references: [id], onDelete: Cascade)
  redirectUri   String
  codeChallenge String
  scopes        String[]
  resource      String
  expiresAt     DateTime
  usedAt        DateTime?
  createdAt     DateTime  @default(now())
  @@index([expiresAt])
  @@map("oauth_authorization_codes")
}

/// Access, refresh and personal tokens (hash only; hard-deleted on expiry/revocation).
model OAuthToken {
  id         String    @id @default(cuid())
  grantId    String
  grant      OAuthGrant @relation(fields: [grantId], references: [id], onDelete: Cascade)
  kind       String                         // 'access' | 'refresh' | 'personal'
  tokenHash  String    @unique              // SHA-256 hex of the secret
  expiresAt  DateTime
  usedAt     DateTime?                      // refresh rotation / reuse detection
  createdAt  DateTime  @default(now())
  @@index([grantId])
  @@index([expiresAt])
  @@map("oauth_tokens")
}

/// Append-only security audit (ADR-0081 source 'oauth'). Never records a secret.
model OAuthAuditLog {
  id         Int       @id @default(autoincrement())
  action     String    // CLIENT_REGISTERED | GRANT_CREATED | CONSENT_DENIED | GRANT_REVOKED |
                       // REFRESH_REUSE_DETECTED | PERSONAL_TOKEN_CREATED | PERSONAL_TOKEN_REVOKED
  userId     String?   @db.Uuid   // subject
  actorId    String?   @db.Uuid   // who acted (user/admin); null for protocol events
  grantId    String?
  clientId   String?              // OAuthClient.clientId (string, survives client GC)
  ip         String?
  detail     Json?                // scopes, redirect host, reason — no secrets
  createdAt  DateTime  @default(now())
  @@index([userId, createdAt])
  @@map("oauth_audit_log")
}
```

**Upgrade safety [C]:** five **new** tables and no change to any existing column. A `User` back-relation adds
no column. A populated database gets empty tables; nothing is backfilled; rollback of the app leaves inert
tables. The only cross-cutting data change is the `ai:connect` catalog entry and its `RolePermission` seed rows
(ADMIN implicit via the resolver short-circuit; MEMBER inserted `ON CONFLICT DO NOTHING`), shipped together with `ai:use` as a
one-time migration after #1314 (the seed re-grant fix) lands. Because the capability is off by default at instance level,
granting MEMBER the permission on upgrade exposes nothing until an admin enables MCP. Sweeper: expired
codes/tokens and DCR clients unused for 24 h with no grant are hard-deleted (protocol/credential state, not
domain data — `PasswordResetToken` precedent); grants are soft-deleted.

---

## 7. Security notes

Candidate invariants. They are merged into the INV-AI-n set in [[ai-assistant/_synthesis|the synthesis]] §7 and
are added to [[INVARIANTS]] only when ADR-0097 is accepted:

- **INV-MCP-1** OAuth/MCP tokens are opaque, CSPRNG 256-bit, SHA-256-hashed at rest, shown once, never logged,
  verified DB-first; accepted **only** on `/mcp`. Session JWTs are never accepted on `/mcp`, and MCP tokens are
  never accepted on REST routes (regression test in `jwt-auth.guard` specs).
- **INV-MCP-2** An MCP call's authority = the user's **current** DB permissions ∩ the grant's scope class,
  re-evaluated on **every** request (list and call), together with `ai:connect` and the instance MCP switch.
  Never a token claim (INV-1/INV-8).
- **INV-MCP-3** A grant dies with the user: soft-delete, `isActive=false`, `directoryOnly`, `sessionEpoch` bump
  (R7), or `mustChangePassword` (re-checked by the MCP guard because `@Public` routes skip the global wall).
- **INV-MCP-4** Authorization codes are single-use, ≤60 s, PKCE-S256-bound; redirects match exactly (loopback
  port-agnostic only); refresh tokens rotate with reuse detection that revokes the grant; `iss` is returned.
- **INV-MCP-5** The AS contains no OIDC/IdP code path (#1310).
- **INV-MCP-6** CIMD documents are fetched only through `common/egress` `guardedFetch` (HTTPS, private
  ranges denied, IP pinned, size/time bounded).
- **INV-MCP-7** No Secret Manager tool, no credential-returning tool and no AI-configuration tool exists on any
  channel (INV-10; catalog-level; CEO round 2), and SA-ungrantable
  verbs stay ungrantable.

Threats worth naming:

- **Tools must not bypass Nest route guards.** Had tools called services directly, `HumanOnlyGuard`,
  `ServicePrincipalForbiddenGuard`, KB folder ACLs ([[0060-kb-folder-access-control]]), author-only article
  edits and `MustChangePasswordGuard` would not run. **Resolved by R1:** every tool executes in-process
  through Nest's own pipeline (`ExternalContextCreator`, a synthetic request, the delegated-identity branch
  in `JwtAuthGuard`), so the route's guards, pipes and controller logic run by construction
  ([[ai-assistant/tools-and-execution|tools]] §5 Fork C3). The tool↔route parity golden test (like
  `permission-parity.golden.spec.ts`) stays as a backstop. This remains the highest-impact risk of the whole
  AI feature.
- **Prompt injection** from user-authored content (KB articles, notes, comments — [[0029-untrusted-content-sanitization]])
  steering a write-capable agent. Mitigations here: accurate annotations (clients confirm writes), the read-only
  consent option, per-grant write rate limits, and per-invocation audit. The rest is client-side.
- **Consent phishing** through a DCR client named "Claude Code": the "self-declared, unverified" badge,
  prominent redirect host, loopback warning, and always-prompt consent.
- **DCR abuse**: per-IP rate limit, cap on unused registrations, 24 h GC, 404 when MCP is off.
- **SSRF via CIMD `client_id`**: egress guard (the fetch runs with a logged-in victim's request, so treat it as
  hostile input); response size cap; `client_id` must be `https` with a path; cached with bounded TTL.
- **Host-header-derived origin** in `lan`: the issuer is pinned configuration, and the anonymous routes
  (metadata, public marketplace) answer 404 in `lan`, so no anonymous response is built from `Host`. The
  authenticated plugin download derives the origin only for the requester's own response, with `no-store`.
  Link-generation routes that reach third parties remain `WEB_ORIGIN`-only (the #1268 rule in
  [[0086-local-authentication-mode]]).
- **Data governance**: MCP sends lazyit data to whichever LLM vendor the user's client uses — the reason for
  a separate `ai:connect` permission and an off-by-default admin switch.
- **Logging**: confirm pino redaction covers `Authorization` and the form bodies of `/oauth/token`
  (`code`, `code_verifier`, `refresh_token`) and `/oauth/revoke`.
- **New `@Public` route**: the MCP controller is `@Public` towards session guards; it fails closed without
  `req.auth`, and a golden test pins its MCP guard — the same checklist rule ADR-0048 applies to
  principal-management endpoints.

---

## 8. Client × deployment matrix [C]

| Client | `lan` (plain HTTP, any host) | `local` (localhost + internal CA) | `real` (FQDN; LE or internal CA) |
| --- | --- | --- | --- |
| Claude Code (CLI/IDE) | personal token; OAuth unsupported | same machine only; trust CA | OAuth; internal CA needs `NODE_EXTRA_CA_CERTS` [A] |
| Cursor / VS Code (desktop) | personal token | same machine only | OAuth |
| claude.ai / Claude Desktop connectors / Cowork | ✗ (cloud must reach the instance) | ✗ | only if publicly reachable with a public CA cert |
| ChatGPT developer mode | ✗ | ✗ | only if publicly reachable |

---

## 9. What is deliberately NOT built

- No OIDC surface: no `id_token`, no userinfo, no `openid-configuration`, no `openid` scope.
- No confidential clients, `client_credentials`, `private_key_jwt`, PAR/JAR, DPoP, or token introspection
  endpoint.
- No `subscriptions/listen` / `listChanged` notifications, no MCP resources or prompts, no MCP Apps UI, no
  Tasks extension, no elicitation-based confirmations.
- No toolsets / per-URL tool subsets (names are domain-prefixed to allow it later).
- No Skills-over-MCP extension yet (Claude Code does not support it).
- No remembered consent; no absolute grant lifetime cap in v1.
- No OAuth over plain HTTP.
- No per-organization pre-registered OAuth clients for claude.ai (`oauth_anthropic_creds`).
- No MCP-specific change to `JwtAuthGuard`/`RolesGuard`. The AI core adds the delegated-identity branch and
  extracts `ServiceAccountAuthenticator` (R1, R10); both are CEO-reviewed ([[ai-assistant/_synthesis|synthesis]] §10).

---

## 10. Resolved decisions

The eight questions this note raised were answered by the CEO (round 2) or settled by the CTO's
reconciliation; [[ai-assistant/_synthesis|the synthesis]] §2 quotes them.

1. **Q1 — MCP on `lan` instances → personal tokens on `lan`, OAuth 2.1 on HTTPS.** Revocable personal MCP
   tokens (`lzit_pat_…`, mandatory expiry, the same connected-apps list) exist only on `lan`; OAuth 2.1 is
   the only path on HTTPS instances (CEO, round 2). §5.4.
2. **Q2 — Permission → a separate `ai:connect`**, ADMIN + MEMBER by default (CEO, round 2).
3. **Q3 — MCP without an LLM provider → yes.** An independent "External agents (MCP)" switch (CEO, round 2).
4. **Q4 — Where "Install in Claude Code" lives → `/account/ai`** for holders of `ai:connect` (install,
   connected apps, personal tokens); Settings → AI for admins (the MCP switch and every user's grants) (R9).
5. **Q5 — SA tokens on `/mcp` → accepted, fail-closed, only if the SA holds `ai:connect`** (R10; adopted by
   default, CEO to confirm on review).
6. **Q6 — Password change / "sign out everywhere" / admin reset kill MCP connections → yes**, through the
   grant's `sessionEpoch` snapshot (R7). Open PR #1313 amends ADR-0086's session expiry; if it changes
   `sessionEpoch` semantics, the grant binding follows whatever "all prior sessions die" means after it.
7. **Q7 — Anonymous plugin marketplace → served only when MCP is enabled on an HTTPS instance**; the
   authenticated zip download is always available (R8).
8. **Q8 — Read-only at consent → offered.** Read only / Read & write (preselected); `lazyit.admin` is
   never preselected and requires step-up (R7).

**Client trust policy → resolved (CEO, 2026-09-23).** Raised by [[ai-assistant/security|security]] §11
Q-7: an admin-configurable allowlist in Settings → AI, pre-seeded with the well-known clients, matched on
the CIMD URL or redirect-URI pattern (never `client_name`) →
[[0097-ai-assistant-mcp-and-headless-api|ADR-0097]] decision 13.

The durable decisions (F1, F3, F4, the F8 outcome, INV-MCP-*) are recorded in
[[0097-ai-assistant-mcp-and-headless-api|ADR-0097]] (proposed).

---

## 11. Implementation units (superseded)

> **Superseded** by the unified wave plan in [[ai-assistant/_synthesis|the synthesis]] §10. Kept for
> traceability of this slice's original decomposition.

Lanes and shared critical files from `.claude/charter.md`. `apps/api/prisma/schema.prisma` is not on the
critical list, but all five AI slices add models, so migrations must be serialized across slices.

| Unit | Lane | Owns | Depends on | Shared critical file |
| --- | --- | --- | --- | --- |
| **U0** ADR + invariants + design vault | documentation | `docs/03-decisions/0097-*.md`, `docs/03-decisions/_MOC.md`, `docs/06-security/INVARIANTS.md` (INV-MCP-*), `docs/01-architecture/authorization.md`, `docs/ai-assistant/mcp-and-oauth.md` (+ `_MOC.md`) | CEO answers Q1–Q8 | **yes** — `docs/03-decisions/_MOC.md` |
| **U1** OAuth AS core (DCR, authorize validate/decision, token, revoke, metadata, grants API, audit, sweeper) | backend | `apps/api/src/oauth/**`, `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/<ts>_add_oauth_authorization_server/`, `packages/shared/src/schemas/oauth.ts`; if Q1 = yes, the `personal` grant kind + endpoints here too (same files) | U0; the `ai:connect` permission + MCP switch from the AI-settings slice | **yes** — `apps/api/src/app.module.ts`, `packages/shared/src/index.ts` |
| **U2** CIMD (fetch via egress guard, cache, bundled known-client docs) | backend | `apps/api/src/oauth/cimd/**` | U1 merged | no |
| **U3** MCP resource server (controller, bearer guard/middleware, factory from registry, annotations, error mapping, pagination backstop, rate limit, Origin check, `instructions`) | backend | `apps/api/src/mcp/**`, `apps/api/package.json` (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, peer `hono`), root `bun.lock`, Jest config only if needed | U1 (token verification), tool registry slice | **yes** — `bun.lock`, `app.module.ts` (serialize after U1) |
| **U4** Caddy routing + runbook | infrastructure | `infra/caddy/Caddyfile`, `infra/test/caddy-routing.sh`, `docs/05-runbooks/*` (MCP section; `NODE_EXTRA_CA_CERTS` for internal CA) | none (routes 404 until the API ships) — can run in parallel with U0/U1 | no |
| **U5** Consent page + Account → AI connections + Manual | frontend | `apps/web/app/oauth/authorize/**` (outside `(app)` shell), `apps/web/app/(app)/account/ai/**`, `apps/web/proxy.ts` (only if callbackUrl needs a fix), `apps/web/messages/*`, `apps/web/content/manual/{en,es}/…` | U1 contract in `@lazyit/shared` | **yes** — `apps/web/content/manual/_nav.ts` |
| **U6** Claude Code plugin distribution (marketplace.json + archive, templates, generated tool index) | backend | `apps/api/src/mcp/distribution/**` (inside `McpModule`, so no new module registration) | U3; registry | no |
| **U7** SA on `/mcp` (only if Q5 = yes): extract `ServiceAccountAuthenticator` | backend | `apps/api/src/auth/service-account-authenticator.ts`, `apps/api/src/auth/jwt-auth.guard.ts`, `apps/api/src/mcp/mcp-auth.*` | U3 | no, but touches the auth guard → CEO-reviewed PR (charter merge authority) |

**Sequencing:**
1. U0 ∥ U4.
2. U1.
3. U2 ∥ U3 ∥ U5 (U3 registers its module only after U1 has merged).
4. U6.
5. U7.

**Validation beyond the charter commands:**
- the MCP Inspector against a dev instance;
- the modelcontextprotocol/conformance suite's auth scenarios (to evaluate);
- a manual matrix: Claude Code on a `real` instance with an internal CA; Cursor; claude.ai against a publicly
  reachable test instance; SDK-v2 client refusal on `lan`;
- sentinel review of `apps/api/src/oauth/**` before merge. U1, U3 and U7 touch authentication, so the CEO
  merges them.
