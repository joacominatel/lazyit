---
title: AI agents (MCP) — client × deployment matrix and verification
tags: [runbook, ai, mcp, oauth, verification]
status: accepted
created: 2026-09-25
updated: 2026-09-25
---

# Runbook — MCP client × deployment matrix and verification

Which AI agents connect to lazyit's MCP endpoint (`/mcp`) in which network mode, what was verified
end to end and with which versions, and the checklist an operator runs for the cells that cannot be
run from a sandbox: a publicly reachable instance, a desktop editor, a browser sign-in.

The design is in [[ai-assistant/mcp-and-oauth|MCP and OAuth]] (§8 the intended matrix, §12–§14 the
as-built server) and [[0097-ai-assistant-mcp-and-headless-api|ADR-0097]]. Deploy-time setup — routes,
the internal CA, `NODE_EXTRA_CA_CERTS` — is in [[deploy-self-hosted]] §7. This page is the evidence and
the procedure for epic #1315, unit W4-3.

> [!info] Two authentication paths, chosen by the network mode
> - **`lan`** (plain HTTP, [[0087-plain-http-lan-deployment-axis]]): **personal MCP tokens**
>   (`lzit_pat_…`) sent as a static `Authorization: Bearer` header. There is no authorization server:
>   OAuth metadata and endpoints answer 404.
> - **HTTPS** (`local`, `real`): **OAuth 2.1** (discovery, registration, PKCE, consent at
>   `/oauth/authorize`). Personal tokens are refused.
>
> `GET /api/ai/status` → `mcp.auth` says which one the instance uses (`"personal-token"` | `"oauth"`).

---

## 1. The matrix

Status: **Verified** = run end to end on 2026-09-25 with the versions in §2 · **Needs operator run** =
cannot run from a sandbox; the checklist in §4 · **Not possible** = the architecture rules it out.

### 1a. Clients the product documents

| Client | `lan` — personal token | `local` — localhost + internal CA, OAuth | `real` — FQDN, public CA (Let's Encrypt), OAuth | `real` — FQDN, internal CA, OAuth |
| --- | --- | --- | --- | --- |
| **Claude Code** (CLI) | **Verified** — header config: connects over the 2026-07-28 revision, 61 tools, `session_context` called. Without a token: status `failed` (expected). | **Verified up to sign-in** — with `NODE_EXTRA_CA_CERTS`: discovery answers, status `needs-auth`; without it: TLS refusal, status `failed`. An OAuth bearer over the internal CA: connected, 61 tools. The browser sign-in itself: **Needs operator run** (§4.3). | **Needs operator run** (§4.3) | **Needs operator run** (§4.3) — the `local` result shows `NODE_EXTRA_CA_CERTS` is honored |
| **Claude Code plugin** (skill + MCP server) | **Verified** — `@skills-dir` folder and `--plugin-dir <zip>` load `lazyit:lazyit`; with the `userConfig.token` value set, `plugin:lazyit:lazyit` connects; without it, the MCP server is absent (non-interactive). The interactive `userConfig` prompt: **Needs operator run** (§4.4). | `--plugin-dir <zip>` **Verified** (skill loads, server `needs-auth`). Marketplace install: **refused by Claude Code** on a loopback host (finding F3). | **Needs operator run** (§4.4) | **Needs operator run** (§4.4) |
| **Cursor** (desktop) | **Needs operator run** (§4.2) | **Needs operator run** (§4.2), same machine only | **Needs operator run** (§4.2) | **Needs operator run** (§4.2), OS trust store |
| **claude.ai / Claude Desktop / Cowork** connectors | **Not possible** — connects from Anthropic's cloud | **Not possible** | **Needs operator run** (§4.1) — only when publicly reachable | **Not possible** — the cloud does not trust an internal CA |
| **ChatGPT developer mode** | Not possible | Not possible | Out of W4-3's scope; same prerequisites as §4.1 | Not possible |

### 1b. Protocol tooling (run here)

| Tool | `lan` — personal token | HTTPS internal CA — OAuth |
| --- | --- | --- |
| **MCP Inspector CLI** 2.8.0 | **Verified** — `tools/list` (61) in `legacy`, `modern` and `auto` eras; `tools/call session_context` and `asset_search` | **Verified** — its own OAuth client: DCR, consent, token, `tools/list` and `tools/call`; `lazyit.admin` with the password step-up lists 67 tools. Needs an allowlist entry for its callback (§5). |
| **SDK-v2 client** (`@modelcontextprotocol/client` 2.1.0) | **Verified** with a personal token — `legacy`, `auto` (negotiates 2026-07-28) and pinned `2026-07-28`. **OAuth refused** — see the row below. | **Verified** — full OAuth (DCR, PKCE, `resource`, RFC 9207 `iss`, refresh token issued) in `legacy` and `2026-07-28` eras |
| **SDK-v2 client, OAuth attempted on `lan`** | **Refused**, but not with the designed message: `SyntaxError: Unexpected token '<'` (finding F1). With OIDC discovery answering 404, a pre-registered v2 client stops at `InsecureTokenEndpointError` — the designed refusal. | — |
| **MCP conformance suite** 0.1.16, server scenarios | Run — 4 pass, the rest not applicable (§3.5) | Run — same result; DNS-rebinding refused |

Server-side checks run on both modes with `curl` (all **as designed**): GET/DELETE `/mcp` → 405;
a foreign or `null` `Origin` → 403; a `Host` outside the pinned origin → 403 (HTTPS); a token in the
query string → 400 **and the token is revoked**; a session JWT on `/mcp` → 401; an OAuth token on the
REST API → 401; a `lan` personal token on the HTTPS instance → 401 with *"This instance uses OAuth for AI
agents: personal tokens are not accepted…"*; minting a personal token on HTTPS → 403 `OAUTH_INSTANCE`;
a read-only personal token lists 27 read tools and a write call is not found; Caddy does not compress
`/mcp` (no `Content-Encoding` with `Accept-Encoding: gzip, zstd`).

---

## 2. What was run, and how it differs from production

| Component | Version / source |
| --- | --- |
| lazyit | `dev` at `5b0c1fd8` (2026-09-25) |
| API | `nest build`, run with `node dist/src/main` on **Node 22.22.2** (the image runs Node 26) |
| Web | `next build` with `NEXT_PUBLIC_API_URL=/api`, run with `next start` |
| Postgres, Valkey, Meilisearch | `compose.yaml` + `compose.override.yaml` (the pinned images) |
| Reverse proxy | `caddy:2-alpine` at the digest pinned in `compose.yaml` (Caddy 2.11.3), **the repository `infra/caddy/Caddyfile`**, `api`/`web` mapped to the host; `LAZYIT_SITE_ADDRESS=:80` for `lan`, `localhost` for HTTPS (internal CA) |
| Claude Code | 2.1.282 |
| MCP Inspector | `@modelcontextprotocol/inspector` 2.8.0 |
| Conformance suite | `@modelcontextprotocol/conformance` 0.1.16 |
| SDK-v2 client | `@modelcontextprotocol/client` 2.1.0 (+ `undici` 7.30.0 for the harness) |
| Server SDK | `@modelcontextprotocol/server` / `node` 2.1.0 (pinned by the API) |

The only deviation from a production install: the `api` and `web` **images** were not built — the
sandbox's egress proxy re-terminates TLS and `bun install` inside `docker build` does not trust it.
The same code ran natively behind the same Caddyfile in the same Caddy image, so routing, TLS and
headers are the production ones; the Node major is not.

---

## 3. Re-running the automatable checks

Run these after a change to `apps/api/src/{mcp,oauth}/**`, the Caddyfile, or an SDK bump. The harness
is in `scripts/mcp-matrix/`; it is test tooling, not part of any image.

### 3.1 Prepare

1. An instance in the mode to test, with MCP on (Settings → AI → *Let AI agents connect (MCP)*, or
   `PUT /api/config/ai` with `mcpEnabled: true` — the MCP switch passes no provider gate).
2. A session for the harness: `POST /api/auth/login` `{"identifier": …, "password": …}` → `token`.
3. On `lan`, a personal token: Account → AI → *Personal tokens*, or
   `POST /api/oauth/personal-tokens` `{"label":"matrix","expiresInDays":1}` with the session bearer.
4. On an internal CA, export the root (see [[deploy-self-hosted]] §7c) and
   `export NODE_EXTRA_CA_CERTS=/path/to/caddy-local-root.crt`.
5. A scratch directory for the harness dependencies:

   ```sh
   mkdir -p /tmp/mcp-matrix && cp scripts/mcp-matrix/* /tmp/mcp-matrix/ && cd /tmp/mcp-matrix
   bun add @modelcontextprotocol/client@2.1.0 undici@7
   ```

`bunx --bun=false` runs a package's bin on Node — both CLIs below need Node ≥ 22.19.

### 3.2 MCP Inspector CLI — personal token (`lan`)

```sh
I="bunx --bun=false @modelcontextprotocol/inspector@2.8.0 --cli"
for era in legacy modern auto; do
  $I http://<host>:<port>/mcp --transport http --header "Authorization: Bearer $PAT" \
     --method tools/list --protocol-era $era --format json | jq '.result.tools | length'
done
$I http://<host>:<port>/mcp --transport http --header "Authorization: Bearer $PAT" \
   --method tools/call --tool-name session_context --protocol-era modern --format json
```

Expected: the same tool count in every era (61 for an ADMIN with a read + write token), exit 0, and
`structuredContent.ok: true`. `tools/list` in the 2026-07-28 era carries `ttlMs: 60000` and
`cacheScope: "private"` (the Inspector does not print them; `curl` with the modern envelope does).

### 3.3 MCP Inspector CLI — OAuth (HTTPS)

The Inspector registers `http://127.0.0.1:6276/oauth/callback`, which is **not** a curated default:
add a `redirect_uri` entry `http://127.0.0.1/oauth/callback` in Settings → AI → *Allowed MCP clients*
first (loopback redirects match on any port). Without it, registration answers 400
`invalid_redirect_uri`, as designed.

Interactive: run the command in a terminal and approve in the browser. Headless, let
`fake-browser.sh` approve on the consent API:

```sh
export BASE=https://<host> SESSION=<session token> SCOPES="lazyit.read lazyit.write"
# PASSWORD=<the user's password> instead of SCOPES grants lazyit.admin through the step-up
MCP_AUTO_OPEN_ENABLED=true BROWSER=$PWD/fake-browser.sh \
  bunx --bun=false @modelcontextprotocol/inspector@2.8.0 --cli https://<host>/mcp \
  --transport http --method tools/list --protocol-era modern --format json
```

Expected: `Authorization complete.`, the tool list, and a new row under Account → AI → *Connected apps*
("MCP Inspector", unverified, redirect host `127.0.0.1:6276`). The Inspector stores its tokens in
`~/.mcp-inspector/storage/oauth.json`; delete that file to force a new sign-in.

### 3.4 SDK-v2 client

```sh
# lan, personal token, every era
for era in legacy auto 2026-07-28; do ERA=$era MCP_TOKEN=$PAT node v2-client.mjs pat http://<host>:<port>/mcp; done

# HTTPS, full OAuth (DCR + consent through consent.mjs)
BASE=https://<host> SESSION=<session token> CONSENT_CMD=./consent.mjs ERA=2026-07-28 \
  node v2-client.mjs oauth https://<host>/mcp

# lan, OAuth must be refused. RESOLVE_TO keeps a loopback-bound instance reachable under a
# non-loopback NAME (the SDK exempts loopback hosts from the TLS rule).
printf '#!/bin/sh\necho "http://127.0.0.1:33418/callback?code=dummy"\n' > dummy.sh && chmod +x dummy.sh
RESOLVE_TO=127.0.0.1 node v2-client.mjs oauth http://lazyit.lan:<port>/mcp
RESOLVE_TO=127.0.0.1 STATIC_CLIENT_ID=x CONSENT_CMD=./dummy.sh node v2-client.mjs oauth http://lazyit.lan:<port>/mcp
```

Expected: `RESULT: OK` with `tools: 61` and `callTool session_context … ok true` for the first two;
`RESULT: REFUSED` for the last two. Today the refusal reads `SyntaxError: Unexpected token '<'`
(finding F1); once F1 is fixed the pre-registered case must read `InsecureTokenEndpointError - Refusing
to send credentials to non-https token endpoint 'http://lazyit.lan:<port>/token'`.

### 3.5 Conformance suite

The suite (0.1.16) has **no server-side authorization scenarios** — every `auth/*` scenario tests a
*client* against a mock server — and its server scenarios speak the 2025-era protocol only, with no
option to send a header. `bearer-proxy.mjs` adds the bearer:

```sh
MCP_TOKEN=$PAT TARGET=http://127.0.0.1:<port> PORT=8090 node bearer-proxy.mjs &
bunx --bun=false @modelcontextprotocol/conformance@0.1.16 server --url http://127.0.0.1:8090/mcp -o ./conf-lan
# HTTPS: MCP_TOKEN=<lzit_oat_…> TARGET=https://<host> REWRITE_HOST=1 PORT=8091 node bearer-proxy.mjs &
```

Result on 2026-09-25 (both modes): exit 1 with 4 passes, and every failure is one of these:

| Scenario | `lan` | HTTPS | Reading |
| --- | --- | --- | --- |
| `server-initialize`, `ping`, `tools-list` | pass | pass | — |
| `server-sse-multiple-streams` | warning | warning | "no session ID" — the server is stateless by design |
| `tools-call-*`, `elicitation-*` | fail | fail | call the reference server's fixture tools (`test_simple_text`, …); not applicable |
| `logging-set-level`, `completion-complete`, `resources-*`, `prompts-*`, `tools-call-with-logging` | fail | fail | `-32601` for capabilities the server does not advertise — the correct answer; not applicable |
| `dns-rebinding-protection` | rebinding **accepted** | rebinding **refused** | `lan` compares `Origin` with the request's own `Host`: accepted by design, a page cannot read the bearer (G3 review F3, [[ai-assistant/mcp-and-oauth\|MCP]] §14). The HTTPS "valid Host accepted" check fails only because the proxy rewrites `Host` and not `Origin`; the same-origin request answers 200 with `curl`. |

Keep a baseline of the not-applicable scenarios (`--expected-failures`) if this runs in CI; a change in
the pass set is the signal.

### 3.6 Claude Code (non-interactive parts)

```sh
# lan: add with a personal token (project scope writes ./.mcp.json; it asks for approval in a session)
claude mcp add --scope project --transport http lazyit http://<host>:<port>/mcp --header "Authorization: Bearer $PAT"
claude -p "Use the lazyit tool session_context and reply with the user's email" \
  --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__lazyit__session_context

# HTTPS: discovery and CA trust, without signing in
echo '{"mcpServers":{"lazyit":{"type":"http","url":"https://<host>/mcp"}}}' > oauth.json
claude -p "reply ok" --mcp-config oauth.json --strict-mcp-config --output-format stream-json --verbose \
  | head -1 | jq '.mcp_servers'
```

Expected: the user's email; `lazyit` `connected` on `lan`; `needs-auth` on HTTPS with the CA trusted and
`failed` without it. The API log shows `claude-code/<version>` requests with
`mcp-protocol-version: 2026-07-28`.

---

## 4. Operator checklists

Record each run in the table in §6 (date, versions, result). Prerequisites for all: MCP on, the user
holds `ai:connect` (MEMBER and ADMIN by default), and on HTTPS the client's redirect is allowed (the
curated defaults cover Claude Code, claude.ai, Cursor, Codex, OpenCode, ChatGPT; Settings → AI →
*Allowed MCP clients*).

### 4.1 claude.ai connector — `real`, public CA

Only for an instance the organization has decided to expose ([[deploy-self-hosted]] §7b).

1. **Reachability from outside.** From a machine off the LAN:
   `curl -sS https://<fqdn>/.well-known/oauth-protected-resource/mcp` → JSON with
   `"resource": "https://<fqdn>/mcp"`, and `curl -sS -o /dev/null -w '%{http_code}' -X POST https://<fqdn>/mcp`
   → `401`. The name must have public DNS, a globally routable address and a publicly trusted
   certificate; a firewall in front must admit Anthropic's egress range (the Claude Help Center lists it).
2. **Add the connector.** Pro/Max: *Customize → Connectors → + → Add custom connector*; Team/Enterprise
   owners: *Organization settings → Connectors → Add → Custom → Web*. URL: `https://<fqdn>/mcp`. Leave the
   OAuth client id and secret empty (lazyit registers the client).
3. **Sign in.** Connect → a lazyit tab opens `/oauth/authorize`. Expected: the consent page names the
   client, shows the redirect host `claude.ai` (verified only if the allowlist entry matched), and the
   scopes. Approve.
4. **Use it.** In a chat, enable the connector and ask "Who am I in lazyit?" → the model calls
   `session_context`. Try one write ("create a location called Matrix-test"): write tools carry
   `readOnlyHint: false`, so claude.ai should ask before running it — record what it does.
5. **Check the instance.** Account → AI → *Connected apps* shows the Claude row; the bell shows *New AI
   agent connected* once; the admin view (Settings → AI) lists it.
6. **Revoke.** Revoke the row → the next claude.ai tool call fails and asks to reconnect.

Expected failure modes: the connector reports it cannot reach the server (not public, split-horizon DNS,
private or IPv6-only address, internal CA); consent refused `INVALID_REDIRECT` (the `claude-ai` default
removed from the allowlist).

### 4.2 Cursor

**`lan` — personal token.** Create a token (Account → AI → *Personal tokens*). In `~/.cursor/mcp.json`
(or the project's `.cursor/mcp.json`):

```json
{ "mcpServers": { "lazyit": { "url": "http://<host>:<port>/mcp",
  "headers": { "Authorization": "Bearer lzit_pat_…" } } } }
```

Expected: Cursor's MCP settings show `lazyit` enabled with its tool list (record the exact screen); an agent chat can call
`session_context`. Wrong or revoked token → the server shows an error; the lazyit API log shows 401.

**HTTPS — OAuth.** Same file with only `"url": "https://<host>/mcp"`. Internal CA: trust the root in the
operating system store (Cursor is a desktop app; `NODE_EXTRA_CA_CERTS` is not the documented path).
Expected: Cursor asks to sign in, the browser opens the consent page with the redirect shown as
`cursor:// (anysphere.cursor-mcp)`, approval returns to Cursor, the tools list. Record the redirect URI
Cursor actually registered (Account → AI → *Connected apps* shows its host) — the curated default is
`cursor://anysphere.cursor-mcp/oauth/callback`; if Cursor registers something else, registration fails
with `invalid_redirect_uri` and the curated list needs updating (report it).

### 4.3 Claude Code — `real` (public CA and internal CA) and `local`

1. Internal CA only: `export NODE_EXTRA_CA_CERTS=/path/to/caddy-local-root.crt` (or the `env` block of
   `~/.claude/settings.json`, or the OS store). Verified here: without it the server shows `failed`.
2. `claude mcp add --transport http lazyit https://<host>/mcp`, start `claude`, run `/mcp`, choose
   `lazyit` → *Authenticate*. The browser opens the consent page; approve.
3. Expected: `/mcp` shows `lazyit` connected; "Who am I in lazyit?" calls `session_context`. Account →
   AI → *Connected apps* shows Claude Code with redirect host `localhost` or `127.0.0.1` (any port).
4. Registration: until CIMD ships (W3-3) the metadata does not advertise
   `client_id_metadata_document_supported`, so Claude Code registers with DCR. After W3-3, re-run and
   check the row is **verified** (the `claude-code-cimd` default).
5. Refresh: leave the session past one hour (access tokens live 3600 s) and call a tool again — it must
   work without a new sign-in.
6. Revoke the row, call a tool → Claude Code reports it needs authentication.

### 4.4 Claude Code plugin — the `userConfig` re-verify item

Verified here: the `lan` plugin (`${user_config.token}` in the MCP `headers`) connects when the value
is set, both as `lazyit@skills-dir` (a folder in `~/.claude/skills/lazyit/`) and with
`--plugin-dir lazyit-plugin.zip`; without the value the MCP server is simply absent in `-p` mode.
Still open: whether an **interactive** session **prompts** for the token.

1. `lan`: download the plugin from Account → AI → *Claude Code*, unzip into `~/.claude/skills/lazyit/`.
2. Start `claude`. Expected: a prompt for *lazyit personal MCP token* (sensitive, required). Paste a
   token. Then `/mcp` shows `plugin:lazyit:lazyit` connected and the `lazyit` skill is listed.
3. If there is **no prompt**: record it, look for a way to set the value from `/plugin`, and report it so
   the Manual page `ai-assistant-claude-code-mcp` can say so. For a scripted or headless session the value
   can be passed with `--settings '{"pluginConfigs":{"lazyit@skills-dir":{"options":{"token":"lzit_pat_…"}}}}'`
   (verified here; mind the shell history).
4. HTTPS on a **non-loopback** name: `claude plugin marketplace add https://<fqdn>/api/ai/claude-code/marketplace.json`,
   then `claude plugin install lazyit@<marketplace name>`. Expected: installed; the server is `needs-auth`
   until the sign-in of §4.3. On `localhost` this fails by Claude Code's own rule (finding F3).

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/mcp` answers 404 | MCP is off (Settings → AI), or the API runs in shim mode | Turn MCP on; shim mode never serves MCP |
| 401 `error_description="This instance uses OAuth for AI agents: personal tokens are not accepted…"` | a personal token on an HTTPS instance (or the instance moved from `lan` to HTTPS) | Remove the header; connect with the client's sign-in |
| Claude Code on `lan` shows `failed` / "needs authentication" | no personal token configured — `lan` has no OAuth | Add `--header "Authorization: Bearer lzit_pat_…"` |
| Claude Code keeps showing `needs-auth` after a header was added | Claude Code caches the state per server **name** (`~/.claude/mcp-needs-auth-cache.json`) | `claude mcp remove lazyit` and add it again, or authenticate from `/mcp` |
| Claude Code `failed` on an internal-CA instance | the root is not trusted | `NODE_EXTRA_CA_CERTS` (§4.3 step 1) |
| Registration 400 `invalid_redirect_uri` | the client's callback is not on the allowlist (e.g. the MCP Inspector's `http://127.0.0.1:6276/oauth/callback`) | Add a `redirect_uri` entry in Settings → AI; loopback entries match any port |
| Consent 403 `STEP_UP_REQUIRED` | the client asked for `lazyit.admin` | Enter the password on the consent page, or untick admin actions |
| 403 `The Origin is not allowed.` | a browser-origin request from another host, or `Origin: null` | Expected; agents do not send a foreign `Origin` |
| 400 "Send the token in the Authorization header, never in the URL." | a token in `?access_token=` / `?token=` | The token is **revoked** on sight; create a new one and use the header |
| An SDK-v2 client on `lan` fails with `Unexpected token '<'` | finding F1 — it tried OAuth on plain HTTP | Use a personal token; OAuth needs HTTPS |
| `claude plugin install` — "Archive URLs must use https:// and must not point at a loopback…" | a `localhost` instance | Use `--plugin-dir` with the downloaded zip, or a real host name |
| Another reverse proxy in front of Caddy, and older (2025-era) clients time out | the 2025-era leg answers `text/event-stream` (one event, then closes); a buffering proxy can hold it | Do not buffer or compress `text/event-stream` ([[deploy-self-hosted]] §7a) |

---

## 6. Findings from the 2026-09-25 run

Reported on the W4-3 PR for the owning lanes; none was fixed here.

- **F1 — OIDC discovery answers HTML on every mode (routing).** `/.well-known/openid-configuration` (and
  the path-suffixed forms) is not in the Caddyfile's agent routes, so it reaches the web app, whose auth
  proxy 302s to `/login`, which answers 200 `text/html`. An MCP client probing OIDC discovery — the
  SDK-v2 client does, after RFC 8414 answers 404 on `lan` — follows the redirect and fails with
  `SyntaxError: Unexpected token '<'` instead of a clean "no authorization server", and never reaches the
  designed `InsecureTokenEndpointError`. The root fallbacks `/register`, `/token`, `/authorize` behave the
  same way. Repro: `curl -sSL -o /dev/null -w '%{http_code} %{content_type}' http://<lan-host>/.well-known/openid-configuration`
  → `200 text/html`; §3.4's refusal commands. Verified that routing `/.well-known/openid-configuration*`
  to the API (a scratch Caddyfile, not committed) turns the pre-registered case into
  `InsecureTokenEndpointError`. HTTPS clients are not affected today (RFC 8414 answers first).
- **F2 — as-built drift: the 2025-era leg streams.** [[ai-assistant/mcp-and-oauth|MCP]] §14 said
  `responseMode: 'json'` means no streams; it applies to the 2026-07-28 leg only. The 2025-era leg answers
  `text/event-stream` (a single `event: message`, then closes) and 406 when the client does not accept
  `text/event-stream`. Harmless (short-lived, uncompressed through Caddy). §14 is corrected in this change.
- **F3 — the marketplace path cannot work on `localhost`. Fixed (#1315).** Claude Code 2.1.282 refuses a
  plugin archive on a loopback, link-local or cloud-metadata host. `/api/ai/status` now reports
  `mcp.marketplaceUrl: null` when the pinned origin's host is loopback (`localhost`, `*.localhost`,
  `127.0.0.0/8`, `::1`), and the Manual says to install from the downloaded plugin there. Untested: private
  LAN addresses; link-local and metadata hosts are not special-cased (not a plausible `WEB_ORIGIN`).
- **F4 — CIMD not advertised yet.** Expected until W3-3 ships (§12 of the MCP note); Claude Code and
  claude.ai register through DCR meanwhile. Re-run §4.3 step 4 after W3-3.
- **F5 — the MCP Inspector is not a curated client.** Its fixed callback needs an admin entry (§3.3). By
  design (ADR-0097 decision 13); listed so the next person does not read it as a bug.

### Run log

| Date | Cell | Versions | Result | By |
| --- | --- | --- | --- | --- |
| 2026-09-25 | §1b all rows; Claude Code `lan`, `local` up to sign-in; plugin `lan` / `--plugin-dir` | §2 | as in §1 | W4-3 (#1315) |

---

Related: [[deploy-self-hosted]] · [[ai-assistant/mcp-and-oauth|MCP and OAuth]] ·
[[ai-assistant/_synthesis|AI assistant synthesis]] · [[0097-ai-assistant-mcp-and-headless-api]] ·
[[0087-plain-http-lan-deployment-axis]] · [[0026-reverse-proxy-tls]]
