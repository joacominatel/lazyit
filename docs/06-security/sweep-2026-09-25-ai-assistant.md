---
title: Sweep 2026-09-25 — AI assistant, MCP and OAuth (W4-2 integrated review)
tags: [security, sweep, ai, mcp, oauth]
status: draft
created: 2026-09-25
updated: 2026-09-25
---

# Sweep 2026-09-25 — AI assistant, MCP and OAuth (epic #1315, W4-2)

The W4-2 unit of [[ai-assistant/_synthesis|the synthesis]] §10: security gates G1–G4
([[ai-assistant/security|security]] §12) re-run over the **integrated** feature on `origin/dev` at
`8012f468`, plus a `lazyit-sentinel` sweep of `apps/api/src/{ai,oauth,mcp}/**` and the web surfaces that
render model or untrusted content. Method: `.claude/skills/lazyit-sentinel/SKILL.md`. **The API was not
run**, so every PoC is reasoned from the code, not executed.

**Result: 4 new findings. [[SEC-080-untrusted-source-provenance-inert-for-real-read-tools|SEC-080]] is
Medium; [[SEC-081-sa-mutation-cap-counts-batch-as-one|SEC-081]],
[[SEC-082-oauth-consent-admin-step-up-no-backoff|SEC-082]] and
[[SEC-083-mcp-query-token-scan-unbounded-before-gates|SEC-083]] are Low.** No Critical and no High. Risks
that ADR-0097 and security.md already accept (the cross-turn auto-approve residual, web-search query
exfiltration, OpenAI `open_page`, literal credentials in workflow templates) are not re-filed.

## Method

1. Read the gate list (security.md §12), the invariants (synthesis §7 INV-AI-1…14, security.md §6.9
   INV-AI-15/16), the auto-approve, bulk-approve, web-search and input-form sections, and ADR-0097's
   amendments.
2. Traced end to end the flows merged most recently: CIMD (#1413), `asset_update_batch` and the
   pending-limit / deferred logic (#1412), `request_input` (#1393/#1408), provider web search (#1401),
   tag-scheme tools (#1397), taxonomy tools (#1392), auto-approve (#1376), paged bulk approve
   (#1411/#1416), personal tokens, and the logout/MCP decoupling.
3. For each gate item, found the enforcing line and checked it against the documented behaviour. Where a
   runtime test backs it, checked that the test uses real tools rather than a fixture that could hide a
   gap (this is how SEC-080 was found).
4. Re-grepped the cheap invariants: no `$queryRaw`/`$executeRaw`, no `child_process` or `eval`, and no
   `fs` write in `ai`/`oauth`/`mcp`. Logger calls in these modules carry no token, password, key or
   request body. The only token-shaped log is the SA id in `mcp.token_in_query`.

## Gate results

| Gate | Verdict | Notes |
| --- | --- | --- |
| **G1** Provider / runtime | **Pass** | Key custody, egress, gating and context hygiene hold. Consumption limits hold per call, but see SEC-081 for how the per-SA cap counts. |
| **G2** Tools / execution | **Pass with findings** | Route equivalence, approval, step-up, catalog exclusions and the ledger hold. The untrusted-source provenance that auto-approve and the bulk-approve decision rely on is inert for real tools (SEC-080, Medium). |
| **G3** MCP / OAuth | **Pass with findings** | AS hygiene, tokens, epochs, CIMD and transport hold. The consent step-up has no backoff (SEC-082). The pre-authentication query-token scan is unbounded (SEC-083). |
| **G4** Frontend | **Pass** | The renderer, links, sources, preview cards, bulk exclusions and consent page hold. |

### G1 — Provider / runtime

- **Key custody.** The key is encrypted under `AI_SECRET_KEY`, and the GET shape carries only `apiKeySet`
  (`ai/settings/ai-settings.service.ts:560-573`). A provider or base-URL change clears the key
  (`:317-332`). The connection test reuses the stored key only for the same destination (`:250-252`).
- **Egress.** Every provider call goes through `guardedFetch` with `maxRedirects: 0`, and private targets
  need `allowPrivateNetwork` for the configured host only (`ai/providers/provider-fetch.ts:129-203`).
  Web search adds no lazyit egress (the provider runs it).
- **Consumption.** Steps, tool calls per run (`AI_MAX_TOOL_CALLS_PER_RUN`), pending per step (5, #1409),
  the persisted daily budget (`ai/runtime/limits.ts:176`), 8 SSE streams per principal
  (`ai/runs/run-event-stream.ts:34`) and the event-bus bound (`ai/runtime/run-event-bus.ts:14`) are all
  enforced. A deferred proposal does not count toward the tool-call cap, but it always comes with 5
  pending proposals that pause the run, so it cannot loop. **SEC-081:** the per-SA mutation cap counts
  calls, so one batch counts as a single change.
- **Gating.** The assistant is off in shim mode (`ai-settings.service.ts:120-122`), and so is `/mcp`
  (`mcp/mcp-auth.guard.ts:115`). The OAuth config is null in shim mode or without a pinned HTTPS origin
  (`oauth/oauth-config.ts:21`).

### G2 — Tools / execution

- **Route equivalence.** `rt.call` refuses any handler outside the tool's `bindings`
  (`ai/core/tool-executor.ts:151-160`). Parity, coverage and catalog golden tests exist
  (`ai/core/tool-route-parity.spec.ts`, `tool-coverage.spec.ts`, `tool-catalog.golden.spec.ts`), and
  boot validation fails closed.
- **Approval.** The claim is atomic and single-use, bound to owner and expiry
  (`ai/core/ai-tool.service.ts:458-485`). Only a human chat session can decide (`:370`, `:932-955`). The
  stored input hash, the tool schema hash, re-authorization and `STALE` are checked at execute
  (`:750-816`). A decision carries no arguments.
- **Step-up and bulk approve (#1411/#1416).** The server never trusts the client for step-up. The
  decision endpoint derives it from the stored preview (`ai/runtime/approval.service.ts:146-153`), and
  core re-derives it from the stored preview and the fresh one before the claim (`ai-tool.service.ts:386-445`,
  `STEP_UP_REQUIRED` when a warning appeared). An unreadable stored preview fails closed (`:752-758`).
  `STALE` is terminal and decided at execute. There is no batch endpoint: "Approve all" sends one
  decision per action, so each is authorized, stepped-up and version-checked on its own. The web
  excludes step-up, elevated and previously refused changes (`apps/web/lib/ai/approval-pages.ts:192-206`)
  and stops on `notAwaiting`/`aiDisabled`/`forbidden`. Keeping elevated actions without step-up out of
  "Approve all" is a client-side UX rule. The server still approves one action per request, which is
  the documented "one action per approval". This is not a finding.
- **Auto-approve (#1376).** Eligibility requires class `write`, not elevated, no step-up and no
  untrusted source, on both the stored and fresh previews (`ai-tool.service.ts:96-108`, `:419-433`). The
  mode is re-checked inside the claim's transaction under the conversation row lock (`:467-482`).
  **SEC-080:** the "no untrusted source" condition is almost never true, because real read tools return
  no `entityRefs`.
- **Tool classes and channels.** The nine workflow-authoring tools are `elevated` and
  `channels: ['CHAT']`, and core refuses them on other channels (`ai-tool.service.ts:212`), so INV-AI-15
  holds. `assertChannelAllows` covers critical applications on application create/update, grant, revoke,
  request decide, user offboard, workflow retry/replay/task resolve and authoring
  (`ai/tools/access.tools.ts:442-462`, `:771`; `users.tools.ts:990`; `workflows.tools.ts:929`;
  `workflow-authoring.tools.ts:240`). `asset_update_batch` refuses step-up rows, pins the newest
  `updatedAt` as its precondition, and re-plans at execute.
- **Headless.** Per-SA off / read-only / read-write and the `infra:report` refusal
  (`ai/runtime/principal-context.ts:113`) are enforced. The mutation cap works per call (SEC-081).
- **Audit.** `ai_action_log` is append-only by trigger
  (`prisma/migrations/20260806000000_add_ai_assistant_and_oauth/migration.sql:489-506`), with an
  exclusive-actor check. It is written before execution, and an approval that cannot be logged is not
  executed (`ai-tool.service.ts:502-532`).
- **Input forms (#1388).** A form is chat-only and never shares a step with a write. Credential-asking
  forms are refused. The answer is validated against the stored form, and values from lazyit lists are
  wrapped as untrusted (`ai/runtime/input.service.ts:246-310`). *Observation, not filed:* a form answer's
  wrapped labels do not add to the run's untrusted set on resume. This is a narrower form of SEC-080 and
  is covered by its fix if the marker is derived from the tag.

### G3 — MCP / OAuth

- **Authorization server.** Redirects never happen before the client and redirect are proven
  (`oauth/authorization.service.ts:258-282`). Redirect matching is exact, with the loopback port ignored,
  and userinfo and fragments are refused (`oauth/client-policy.ts:143-155`). PKCE is S256 only
  (`authorization.service.ts:293-300`), and a missing verifier is refused (`oauth-token.service.ts:136-140`).
  `iss` is returned on every redirect. The issuer is pinned configuration (`oauth-config.ts`). No OIDC
  surface exists (INV-AI-13).
- **Codes and tokens.** A code is single-use through an atomic update before any other check
  (`oauth-token.service.ts:148-156`). Refresh tokens rotate, and reuse outside the 30 s grace window
  revokes the grant (`:280-292`). Tokens are opaque, prefixed and hashed. `/mcp` takes only
  `lzit_oat_` (HTTPS), `lzit_pat_` (lan) and `lzit_sa_` with `ai:connect`, never a session JWT
  (`mcp/mcp-auth.guard.ts:176-296`).
- **Epochs (logout decoupling).** MCP credentials are bound to `mcpCredentialEpoch`
  (`auth/principal-loader.service.ts:63-77`). A web logout does not bump it
  (`auth/local/login.service.ts:148`). Password change or reset, admin reset, deactivation, offboarding
  and directory offboarding do (`users.service.ts`, `password-lifecycle.service.ts`,
  `reset-admin-password.ts`, `directory-reconcile.service.ts`).
- **CIMD (#1413).** The fetch goes through `guardedFetch`: https only, no userinfo, no redirects, no
  private allowlist, a total deadline covering DNS, and a size cap (`oauth/cimd/cimd-fetcher.ts:123-206`).
  The client id is canonical (`client-id-url.ts:231-249`). Fetches are rate-limited per user and audited.
  The allowlist decides admission (`isClientAllowed` needs every redirect admitted).
- **Personal tokens.** Personal tokens exist only on `lan`, never with `lazyit.admin`, have a mandatory
  expiry and a cap of 20 live tokens, and are managed by humans only.
- **Transport.** Origin and Host are validated against the pinned host (`mcp-auth.guard.ts:310-322`). A
  query-string token is refused and revoked on sight. **SEC-083:** that scan is unbounded and runs before
  the MCP-off 404 and the IP limiter.
- **Consent.** `lazyit.admin` is never a default and needs a step-up (`authorization.service.ts:172-174`).
  **SEC-082:** that step-up has only a 10-per-minute window, no backoff and no audit. `frame-ancestors
  'none'` is set (`apps/web/next.config.ts:46`).
- **Abuse.** DCR, token and revoke endpoints are rate-limited per IP. Refused MCP authentications are
  limited per IP (30/min). The first use of a connection sends a notice to its owner.

### G4 — Frontend

- `apps/web/components/ai/ai-markdown.tsx:124-129` runs `rehype-sanitize` over the default schema, with
  no raw HTML and no `dangerouslySetInnerHTML`. Images render as their alt text, and
  `<untrusted_content>` wrappers are stripped to plain text. GFM autolinks are rendered as plain text,
  and an explicit external link shows its full URL (`apps/web/lib/ai/chat-links.ts:17-43`).
- Web sources accept `http(s)` only and drop userinfo, the title is plain text, and links use
  `noopener noreferrer` (`apps/web/lib/ai/web-sources.ts`). Every internal href is built by the web with
  encoded segments and re-checked by `safeInternalPath` (`apps/web/lib/ai/entity-href.ts:73-78`).
- The consent page follows a `redirectTo` only when it points back to the registered redirect
  (`app/(auth)/oauth/authorize/_lib/consent.ts:117-140`).
- The bulk exclusions are verified in the G2 bullet on step-up and bulk approve. The web grep found no
  `dangerouslySetInnerHTML`, `innerHTML` or `window.open` in `components/ai`, `lib/ai`, `account/ai` or
  the consent page.

## Invariants

| Invariant | Result | Evidence (at `8012f468`) |
| --- | --- | --- |
| INV-AI-1 One real principal | Pass | Delegated identity is re-loaded on every call (`auth/delegated-identity.ts`, `ai-tool.service.ts` `loadPrincipal`). MCP authority = permissions ∩ scope ceiling (`mcp/mcp-caller.ts`). |
| INV-AI-2 Route-equivalent, fail-closed | Pass | `tool-executor.ts:151-160`, parity, coverage and catalog golden specs, `boot-validation.ts`. |
| INV-AI-3 Bound single-use approval (+ auto) | **Partial** | The claim and step-up hold (`ai-tool.service.ts:365-485`). The auto-approve untrusted-source condition is inert (**SEC-080**). |
| INV-AI-4 Untrusted is data | **Partial** | Content never changes tool availability, approval requirements or tool metadata. The provenance marker built on it does not fire (**SEC-080**). |
| INV-AI-5 No secrets in context | Pass | Exclusions in `ai/core/exclusions.ts`. Ledger redaction in `ai/core/redaction.ts`. Forms refuse credentials. The step-up password is never stored. |
| INV-AI-6 Key custody | Pass | `ai-settings.service.ts:317-332`, `:560-573`. |
| INV-AI-7 Egress guarded | Pass | `provider-fetch.ts:164-203`; `cimd-fetcher.ts:130-142`. |
| INV-AI-8 Sanitized rendering | Pass | `ai-markdown.tsx:124-129`, `chat-links.ts`. |
| INV-AI-9 Tokens audience-bound, isolated | Pass | `mcp-auth.guard.ts:176-296`, `oauth-token.service.ts:148-174`, `:280-301`, `principal-loader.service.ts:63-77`. |
| INV-AI-10 Permanent audit | Pass | Trigger at `migration.sql:489-506`; write-ahead at `ai-tool.service.ts:502-532`. |
| INV-AI-11 Consumption bounded | **Partial** | The limits exist and fail closed. The per-SA cap is per call, not per change (**SEC-081**). The pre-auth query scan is unbounded (**SEC-083**). |
| INV-AI-12 Off by default, gated | **Partial** | 404 while off in `mcp-auth.guard.ts:115-117`, but the query-token scan runs first (**SEC-083**). |
| INV-AI-13 No OIDC | Pass | No `id_token`, userinfo or `openid-configuration` in `oauth/`. |
| INV-AI-14 Structural exclusions | Pass | `exclusions.ts` prefixes and handlers; the tag-scheme routes need `settings:manage` (SA-ungrantable). |
| INV-AI-15 No unattended outbound integration | Pass | `workflow-authoring.tools.ts` `channels: ['CHAT']` ×9; `ai-tool.service.ts:212`. |
| INV-AI-16 Workflow secrets reference-only | Pass | The `workflow-secrets` prefix is excluded. Header values are redacted (SEC-075, closed). |

INV-MCP-1…7 are absorbed into INV-AI-1, 7, 9, 13 and 14 (synthesis §7) and pass with them.

## Recommendations for closing the epic

- **SEC-080 should be fixed before ADR-0097 is accepted (W4-4).** INV-AI-3 as amended, and the CEO's
  #1409 bulk-approve decision, depend on the untrusted-source banner, and today it only appears for web
  search and the three `workflow_*_get` tools. The fix is small (a synthetic ref when the tag is present)
  and needs a test with a real tool.
- SEC-081, SEC-082 and SEC-083 are Low hardening items. They do not block the epic, but SEC-081 changes
  what the Settings copy promises, so that copy should be corrected at the same time.

Related: [[summary]] · [[INVARIANTS]] · [[ai-assistant/security|AI security]] ·
[[ai-assistant/_synthesis|synthesis]] · [[0097-ai-assistant-mcp-and-headless-api]]
