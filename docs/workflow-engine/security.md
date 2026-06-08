---
title: "Workflow Engine — Security & Threat Model"
tags: [workflow-engine, security, threat-model, ssrf, secrets, rbac, audit, sandboxing]
status: proposed
created: 2026-06-07
---

# Workflow Engine — Security & Threat Model

> Scope: the security design for the **Applications workflow engine** — the opt-in, per-application
> automation that provisions/deprovisions users in *external* systems when an `AccessGrant` changes
> inside lazyit ([[0023-access-management-design]]). This document is the **threat model**: it does
> NOT specify code, schema, or migrations. It defines the trust boundaries, the controls, the new
> permission catalog entries, the new invariants, and an explicit answer to the execution-substrate
> question **from the security lens**.
>
> Companion area docs (substrate, data model, connectors, UX) live alongside this file under
> `docs/workflow-engine/`. Where this doc depends on another area, it says so.

---

## 0. TL;DR for the CEO

- **The engine is, by construction, an admin-operated SSRF cannon and a secrets vault.** Two threats
  dominate everything else: (1) the server makes outbound calls to **admin-configured arbitrary URLs**
  → a direct Server-Side Request Forgery (SSRF) vector into the internal network, cloud metadata, and
  `localhost`; (2) it stores **per-app credentials** (Jira tokens, OAuth secrets) that must never leak.
  Everything else is important but secondary.
- **Reuse, don't reinvent.** Encrypt per-app secrets with the **ADR-0052 `SecretEncryptionService`**
  (AES-256-GCM, `SETTINGS_ENCRYPTION_KEY`) and the redacted-audit pattern; attribute runs with the
  **ADR-0048 at-most-one-actor** pattern; gate the whole engine behind a **new `workflow` permission
  domain** in the ADR-0046 catalog; surface manual tasks and run status through the **ADR-0052
  Notifications + bell + SSE** stack.
- **The hard, non-obvious tension:** the product *legitimately* needs to call **internal self-hosted
  targets** (`vpn.corp.local`, an on-prem AD/LDAP), but the SSRF defense wants to **block all private
  IPs**. The resolution is the crux of the design: **deny private/loopback/link-local/metadata by
  default, and require an admin to explicitly, consciously allowlist each internal target host** — turning
  an implicit SSRF vector into an explicit, audited configuration choice. This needs a CEO ruling (§3.4).
- **A failing external call must NOT roll back or block the local `AccessGrant`** — the deliberate
  *opposite* of the Zitadel strong-coupling contract (INV-5 / [[0043-zitadel-source-of-truth]]).
- **Substrate verdict (security lens): BullMQ on Valkey, as already decided in
  [[0053-async-workers-bullmq-valkey]] — but the security reason is the *sandboxed (forked-child)
  processor* and the *async decoupling*, not queueing per se.** Synchronous execution is rejected
  (DoS + coupling); Temporal and n8n are rejected (a second, un-integrated credential/audit/RBAC
  surface + infra weight that breaks the one-command operator constraint). **SSRF is
  substrate-independent** and must be solved at the HTTP-client layer regardless of which broker wins.

---

## 1. System model, trust boundaries, and assumptions

### 1.1 What the engine does (security-relevant shape)

```
 lazyit (single host, single org)                          OUTSIDE
 ┌──────────────────────────────────────────────┐
 │  AccessGrant create/revoke  (ADR-0023)         │
 │        │  (trigger, async, decoupled)          │
 │        ▼                                        │
 │  Workflow Engine                               │
 │   • resolves the app's workflow + version      │
 │   • maps lazyit data → external payload        │  outbound HTTP / SDK / MCP
 │   • reads per-app encrypted credential ────────┼───────────────►  External app
 │   • (optional) MANUAL step: a human enters data│                   (Jira, AD, …)
 │   • writes an append-only WorkflowRun log      │  ◄───────────────  inbound webhook
 └──────────────────────────────────────────────┘   (later phase, signed)
```

The engine sits **between** a local domain event (`AccessGrant` open/revoke) and an arbitrary external
system. It holds three classes of trust-sensitive state: **(a)** per-app **credentials**; **(b)** per-app
**connection config including arbitrary outbound URLs**; **(c)** the **data mapping** that turns lazyit
fields into an external payload (possibly via a templating/expression language).

### 1.2 Trust boundaries

| # | Boundary | Direction | Primary threats |
|---|----------|-----------|-----------------|
| B1 | lazyit API → external system | outbound | **SSRF**, credential exfiltration, payload injection into the target |
| B2 | Admin UI → engine config | inbound | privilege misuse (who may define workflows / enter secrets / run), mass-assignment |
| B3 | External system → lazyit (inbound webhook) | inbound | **forged triggers**, replay, unauthenticated DoS |
| B4 | Engine → datastore (secrets, run log) | internal | secret-at-rest exposure, log tampering, secret leakage into logs |
| B5 | Engine → executor process (mapping/connector code) | internal | **template/expression injection (SSTI→RCE)**, memory/CPU exhaustion |
| B6 | Manual task assignee → task | inbound | **task authorization / IDOR**, untrusted human-entered data into a payload |

### 1.3 Assumptions carried from existing decisions (do not re-litigate)

- **Single-org, single-host, self-hosted** ([[0015-deployment-model]], product-vision-tech). No
  multi-tenant isolation requirement *today*; the host's internal network is the SSRF blast radius.
- **Authorization is DB-first** (INV-1, [[INVARIANTS]]); permissions resolve from `RolePermission` /
  `ServiceAccountPermission` rows, never a token claim (INV-8, INV-SA-1..4).
- **Auditability by default; never hard-delete; append-only logs are immutable**
  ([[0006-soft-delete-and-auditing]]).
- **Secrets are never plaintext-in-image / never logged** (INV-6; ADR-0031 logs metadata only, never
  bodies).
- **`SecretEncryptionService` exists** on the unmerged `feat/settings_notifications_smtp` branch
  (ADR-0052) — `apps/api/src/settings/secret-encryption.service.ts`, AES-256-GCM keyed by
  `SETTINGS_ENCRYPTION_KEY`, with a `SystemSecret` table (`system_secrets`) and a redacted
  `SettingAuditLog`. **The workflow engine depends on this landing on `dev` first** (§8).

---

## 2. Credential storage (per-app secrets) — INV-6, ADR-0052 reuse

**Threat.** Each app's connection needs a secret (Jira API token, OAuth client secret, a webhook
signing key). A leak — at rest, in an API response, in a log line, in the run audit, or to another
operator who shouldn't see it — hands an attacker write access to the external system *and* whatever the
external system protects.

### 2.1 Controls (v1)

1. **Encrypt at rest with the ADR-0052 pattern, not a bespoke crypto path.** Per-app connector secrets
   are stored as ciphertext using the existing `SecretEncryptionService`
   (`apps/api/src/settings/secret-encryption.service.ts`): AES-256-GCM, random 12-byte IV per value,
   auth tag, `v1:` versioned envelope, key from `SETTINGS_ENCRYPTION_KEY`. The engine MUST reuse this
   service (or a thin wrapper over it), so there is **one** at-rest crypto implementation and **one** key
   to manage and back up. Store secrets in a dedicated table (mirroring `system_secrets`, keyed per
   connector) — *not* in the workflow-definition JSON (so a definition export / run log can never carry
   the secret).
2. **Write-only API shape.** The connector-config API accepts a secret on write and returns only a
   **`configured: boolean`** (and a non-secret prefix/hint at most) on read — never the cleartext, never
   the ciphertext. This mirrors the SMTP form's `passwordConfigured` boolean
   (`apps/api/src/settings/settings.service.ts`) and the Service-Account "shown once" rule
   ([[0048-service-accounts]]).
3. **Never log a secret (INV-6).** Secrets MUST NOT appear in Pino lines, run-step request snapshots, or
   the audit `detail`. Reuse the **`redactedDiff`** pattern (`settings.service.ts`) so a config-change
   audit row records *that* a secret changed, never its value. The outbound HTTP client MUST redact
   `Authorization` / token headers from any captured request metadata (extend ADR-0031 redaction to the
   engine's structured run logs).
4. **Secrets are decrypted only at the moment of the outbound call**, inside the executor, and never
   returned across the API boundary. The decrypted value lives only in process memory for the duration
   of the call.

### 2.2 Key management

- The recovery linchpin becomes **two** keys: `ZITADEL_MASTERKEY` (existing) and
  `SETTINGS_ENCRYPTION_KEY` (ADR-0052). Both must be in the operator backup runbook
  ([[backups]]) — losing `SETTINGS_ENCRYPTION_KEY` = losing every stored connector credential
  (recoverable by re-entering them, but the runbook must say so). **Flag for DevOps:** the existing
  `.env.prod` (chmod 600, gitignored — INV-6) is the right home; do not introduce a third secret store.
- **Key rotation is a known gap.** ADR-0052's envelope is `v1:`-versioned, which *enables* rotation but
  no rotation procedure exists. v1 of the engine inherits this debt; a rotation runbook (re-encrypt all
  `system_secrets` + connector secrets under a new key) is a **follow-up** — flagged, not built now.

### 2.3 OAuth tokens (Jira-style)

OAuth refresh tokens are higher-value than a static API token (they mint access tokens). Same at-rest
encryption; additionally the engine must store the **minimum scope** the connector needs and surface the
granted scope to the admin. Token refresh happens inside the executor; a refresh failure is a run
failure (notification + retry), never a silent fallback to a wider-scoped credential.

---

## 3. SSRF — the dominant threat (B1)

**Threat.** The admin configures arbitrary outbound URLs and the **server** makes the request. Without
egress controls this is a textbook SSRF: an attacker (or a careless/compromised admin, or a malicious
prebuilt-connector template later) points a workflow at `http://169.254.169.254/…` (cloud metadata /
IMDS), `http://127.0.0.1:6379` (the co-located Valkey — [[0053-async-workers-bullmq-valkey]]),
`http://127.0.0.1:5432` (Postgres), the internal Zitadel admin API, or any host on the host's LAN, and
uses the engine as a confused deputy to read internal services or exfiltrate the engine's own
credentials. This echoes the URL-guard history on `Application.url`
([[SEC-008-application-url-href-xss-sink|SEC-008]], [[SEC-051-application-url-scheme-guard-port-carveout-bypass|SEC-051]]):
a regex that "sniffs" a URL prefix is repeatedly bypassable — **parse, don't sniff**.

> **SSRF is substrate-independent.** It is a property of the HTTP client, not the queue. BullMQ,
> Temporal, pg-boss, or synchronous all have the identical exposure. The control lives in a single,
> tested **egress guard** that every outbound connector MUST route through.

### 3.1 The egress guard (v1, mandatory, single source of truth)

A central guard that EVERY outbound request passes through. Defense in depth, in order:

1. **Scheme allowlist.** Only `https` (and `http` for an explicitly-allowlisted internal host, §3.4).
   Reject everything else — `file:`, `gopher:`, `ftp:`, `data:`, `dict:`, `javascript:`, … — by
   **parse-and-allowlist**, never by blocklist-regex (the SEC-008/SEC-051 lesson). Use a real URL
   parser (`new URL()`), read the resulting `protocol`, and compare to the allowlist.
2. **Resolve DNS ourselves and block by resolved IP**, not by hostname string. Reject if **any** resolved
   address falls in a denied range:
   - loopback `127.0.0.0/8`, `::1`
   - private `10/8`, `172.16/12`, `192.168/16`, IPv6 ULA `fc00::/7`
   - link-local `169.254.0.0/16` (**includes `169.254.169.254` cloud metadata / IMDS**), `fe80::/10`
   - `0.0.0.0/8`, broadcast, multicast, reserved/`100.64/10` CGNAT
   - IPv4-mapped/`-compatible` IPv6 forms of the above (normalize before checking)
3. **Defeat DNS rebinding (TOCTOU).** A hostname can resolve to a public IP at validation time and a
   private IP at connect time. Mitigation: **pin the validated IP** — resolve once, validate the
   resolved address, then connect to **that exact IP** (e.g. a custom `lookup`/agent that returns the
   pinned address), so the value checked is the value dialed. Re-validate on every attempt; never trust a
   cached "this hostname is safe".
4. **Block/whitelist redirects.** Either disable HTTP redirects entirely, or re-run the full guard on
   **every** redirect `Location` (a `302 → http://169.254.169.254` is the classic bypass). v1: follow at
   most a small bounded number of redirects, each re-validated; default to *not* following.
5. **Hard timeouts + response-size cap** on every call (also a DoS control — §7).
6. **Port sanity.** Optionally restrict to standard ports for external HTTPS; at minimum, do not let a
   workflow reach `:6379`/`:5432`/`:9300` etc. on a private host unless that host is an explicitly
   allowlisted target (§3.4).

### 3.2 Why not "just block private IPs"

The product **legitimately calls internal hosts**: ADR-0023 deliberately allows `vpn.corp.local` as an
`Application.url`, and the feature brief lists "a self-hosted target" and on-prem AD as first-class
integration types. A blanket private-IP block would break the product's own use case.

### 3.3 Resolution — explicit, audited internal-target allowlist

**Deny-by-default for private/loopback/link-local/metadata, with a per-connector explicit allowlist that
an admin must consciously add.** An admin configuring a connector that targets `vpn.corp.local:8080` must
**add that host (and port) to an internal-targets allowlist**, acknowledging a "this target is on your
internal network" warning (neutral-tone consequential confirm, mirroring the RBAC v2 "admin-level"
delegation UX in [[0046-roles-permissions-v2]] §P7). This converts an *implicit* SSRF vector into an
*explicit, audited* configuration decision:

- The allowlist is an **allowlist of specific host[:port] entries**, never "allow all private".
- **`localhost`/`127.0.0.1`/`::1` and the metadata IP `169.254.169.254` are NEVER allowlistable** (they
  protect the engine's own co-located secrets/datastore — Valkey, Postgres, Zitadel — and the cloud
  IMDS); the allowlist UI must refuse them outright.
- Each allowlist add/remove is an audited config event (§5).

### 3.4 Open question for the CEO (the crux)

Pick the default egress posture:

- **(A) Deny private + per-connector internal allowlist (recommended).** Most secure; the operator pays a
  one-time "add your internal host" step per internal connector. Fits "errors are loud, defaults are
  safe" (product-vision-tech).
- **(B) Allow any non-loopback/non-metadata, block only the engine's own services.** Lower friction,
  materially weaker (the whole LAN stays reachable). Not recommended.

The recommendation is **(A)**, with `localhost`/IMDS permanently un-allowlistable regardless.

---

## 4. RBAC — new permission catalog entries (ADR-0046 / ADR-0048)

**Threat.** Workflow management is high-privilege: defining a workflow means configuring outbound URLs
(SSRF surface), referencing secrets, and authoring the data mapping. Triggering/replaying a run causes
real external side effects. These must be gated by their **own** permissions, separated by sensitivity.

### 4.1 New `workflow` domain + literals (extends the frozen catalog)

Add `workflow` to `PERMISSION_DOMAINS` and these literals to `PERMISSIONS`
(`packages/shared/src/schemas/permission.ts`), following the existing `domain:action` + coarse-verb
convention:

| Permission | Grants | Default seed |
|------------|--------|--------------|
| `workflow:read` | View workflow definitions, run history, the manual-task inbox | **ADMIN-only** (treat like `logs:read` — run history reveals who-gets-provisioned-where + external payload shapes; it is sensitive). Configurable. |
| `workflow:manage` | Create / edit / delete / enable workflow **definitions** (the automation logic, incl. the outbound URL + mapping) | **ADMIN-only**, configurable (⚠ "admin-level" delegation, like the existing coarse verbs) |
| `workflow:secrets` | Configure / enter / rotate per-app connector **credentials** | **ADMIN-only**, configurable — **kept distinct from `workflow:manage`** to allow separation of duties (who writes the logic ≠ who holds the Jira token) |
| `workflow:run` | Manually trigger / replay a run | **ADMIN-only**, configurable |
| `workflow:action` | Claim / complete a **manual task** step | **ADMIN-only** by default, but expected to be delegated to MEMBERs who do operational provisioning (§6) |

- **ADMIN stays immutable/full** (INV-8) — ADMIN holds all of the above automatically via the resolver's
  complete-catalog short-circuit; the seed never writes ADMIN rows.
- **Catalog-as-code** (INV-8): adding the domain + literals is a `@lazyit/shared` change + golden-test
  update; CI fails on an unknown literal. (Note: a shared-catalog change must be re-typechecked against
  the web's exhaustive permission maps — see the project memory note on `@lazyit/shared` changes.)
- **`workflow:secrets` ≠ `settings:manage`** (CEO call, §9): folding connector secrets into the existing
  `settings:manage` is simpler but loses separation of duties and makes "who can read the Jira token"
  identical to "who can edit SMTP". Recommend the distinct permission.

### 4.2 Service accounts (ADR-0048)

A `ServiceAccount` MAY be granted `workflow:run` (e.g. an external scheduler kicks a re-certification
run) and is **fail-closed** (INV-SA-2): it passes only routes whose `@RequirePermission` it fully holds.
**Recommend operationally NOT granting `workflow:manage`/`workflow:secrets` to SAs** (definition + secret
authoring is a human-admin act) — but the catalog permits it; the guardrail is the ⚠ delegation UX, not a
server prohibition (consistent with ADR-0046's "friction, not blocks"). A SA must never reach an
unannotated engine route (INV-SA-2) — every engine endpoint MUST carry an explicit
`@RequirePermission`.

### 4.3 Who executes the external action (attribution vs authority)

The **principal who triggered** the run (the human who granted access, or the SA) is the run's *actor*
for audit (§5). The **identity presented to the external system** is the per-app connector credential
(§2), NOT the triggering user's identity — the engine acts as a service principal toward the outside,
exactly as the Zitadel write-back uses a dedicated SA credential ([[0043-zitadel-source-of-truth]] §3).
Do not propagate end-user identity outward.

---

## 5. Audit — append-only run log, attributed human XOR ServiceAccount

**Threat.** Without an honest, tamper-evident record, "who provisioned this person into Jira, when, and
did it succeed?" is unanswerable — and an attacker could deny actions or frame a user.

### 5.1 Controls

1. **Append-only `WorkflowRun` + `WorkflowRunStep` log** (autoincrement id per [[0005-id-strategy]];
   `createdAt` only, **no `deletedAt`** — append-only per [[0006-soft-delete-and-auditing]], same class
   as `AccessGrant` / `ConsumableMovement`). Immutable once written.
2. **At-most-one-actor attribution** (INV-SA-4 / [[0048-service-accounts]]): each run carries a nullable
   `triggeredById` (User) XOR `triggeredBySaId` (ServiceAccount), enforced by a DB **CHECK** so a run can
   never be attributed to two principals (or fabricate a human for a bot's action). An automatic
   trigger fired by the engine itself with no initiating principal records **neither** (honest "system",
   like an absent `grantedById`, ADR-0023). Reuse `ActorService.resolveActor`
   (`apps/api/src/common/actor.service.ts`).
3. **Link the run to its cause:** the triggering `AccessGrant` id + the workflow definition **version**
   that ran (so a later edit to the workflow doesn't rewrite history — the run records the version it
   executed).
4. **Record outcome metadata, never bodies/secrets** (INV-6, ADR-0031): per step, the connector type,
   target host (not full URL with query secrets), HTTP status, latency, attempt count, error class, and
   the **redacted** request/response shape. The external response body is summarized/capped, never stored
   verbatim if it may contain secrets/PII. Correlate every run-step log line with the originating
   `X-Request-Id` (ADR-0031, AsyncLocalStorage) so a run is joinable to the admin action that started it.
5. **Manual-task completion is audited** to the completing human (the actor who clicked, not the workflow
   author).
6. **Config changes are audited** (reuse the ADR-0052 `SettingAuditLog` shape / a workflow-scoped
   equivalent): create/edit/delete a workflow, add/remove an egress-allowlist host, set/rotate a secret
   (redacted), enable/disable a connector — append-only, attributed.

---

## 6. Manual-task authorization (B6)

**Threat.** A manual step asks a human to perform an action or type data ("which team?", possibly with
role/team suggestions). Two risks: **(a)** an unauthorized user actions a task that isn't theirs (IDOR /
authorization bypass); **(b)** the human-entered value flows into an external payload — an
injection/validation sink.

### 6.1 Controls

1. **`workflow:action` is required** to complete any manual task (§4). Beyond the permission, the
   completer must be a **valid assignee for *this* task** — a task assigned to a specific user or to a
   role/permission cohort is completable only by a matching principal. **Do not** look the task up by id
   and complete it on permission alone (that is the IDOR trap, cf. the Sentinel "mentally swap ids"
   rule): verify `task.assignee` matches `request.principal` (or the principal is in the assigned cohort)
   *before* allowing completion.
2. **Validate human-entered data with a zod schema** declared on the manual step
   ([[0007-flexible-asset-specs-jsonb]] pattern — jsonb validated by zod in `@lazyit/shared`). The
   collected value is **untrusted input** even though a human typed it: bound its length/shape, and treat
   it as data, never as an expression (§7). "Suggestions by role/team" are *hints only* — never trust the
   suggestion list to constrain authorization or skip validation.
3. **Surface the task via the ADR-0052 Notifications + bell + SSE** stack (in-app inbox + realtime
   status), reusing the existing transport rather than a new channel. The SSE route stays
   `@RequirePermission()`-gated (decision-history 2026-06-07).
4. **A pending manual task is a paused run, not an open hole.** It must time out / be cancellable and
   never auto-complete; an abandoned task is a notification, not a silent success.

### 6.2 Scope-creep flag (Identity Governance)

The "which team? / manager / AD lookup" manual steps **edge toward Identity Governance / HR onboarding**,
which is an explicit anti-goal (product-vision-tech: "Not an HR system"). **Keep v1 strictly to
Access-pillar provisioning:** a manual step collects a free-text/selected value and maps it into the
external call. Do **not** build an org-hierarchy / manager / AD-sync model into lazyit now (see §9 /
Future). Flag any drift in that direction to the CEO.

---

## 7. Template / expression injection + sandboxing (B5)

**Threat.** The data mapping turns lazyit fields into an external payload, plausibly via a templating or
expression language. If that evaluator is (or wraps) `eval` / `new Function` / unescaped JS template
literals over admin- or human-supplied strings, it is **Server-Side Template Injection → RCE** on the
single host — the highest-impact bug class possible here, sitting right next to the decrypted secrets.

### 7.1 Controls

1. **No arbitrary code execution. Ever.** v1 ships a **logic-less / restricted** mapping: variable
   substitution from a **fixed, explicit context** (the granted `User`'s exposed fields, the
   `Application`, run metadata) with a closed set of safe transforms (e.g. `lowercase`, `default`,
   `concat`). No host access — no `process.env`, `fs`, `require`, network globals, prototype access. If a
   real expression language is ever needed, choose a **sandboxed, non-Turing-complete** evaluator
   (e.g. a JSONata/Liquid-style logic-less engine), never a JS `Function`.
2. **Run untrusted/heavy mapping + connector code in the BullMQ sandboxed (forked-child) processor**
   ([[0053-async-workers-bullmq-valkey]]) with a Node heap cap (`--max-old-space-size`). A
   runaway/malicious mapping crashes the **child**, not the API — the same isolation ADR-0053 adopted for
   the `.docx` decompression bomb (SEC-002). This is the security-decisive property of the substrate
   (§10).
3. **The mapping context is allowlisted**, not "the whole object graph": only the fields a connector is
   declared to need are exposed to the template, so a mapping cannot read an unrelated user's data or an
   internal field.
4. **Output encoding per connector.** A value mapped into a downstream system can carry injection into
   *that* system (LDAP/SQL/command meta-characters for an AD/self-hosted target). The connector MUST
   encode/parameterize for its target; the engine treats every mapped value as hostile to the target.

---

## 8. Abuse / DoS — loops, retry storms, payloads, rate limits (B1/B3)

**Threat.** On a single self-hosted host, a runaway workflow can exhaust CPU/memory/connections, hammer
the external API (getting lazyit's token rate-limited or banned), or storm the network.

### 8.1 Controls

1. **Re-entrancy / loop guard.** A workflow fires on `AccessGrant` change; a workflow step might itself
   change a grant → **infinite loop**. Mitigations: engine-initiated grant changes carry a flag that
   does **not** re-trigger workflows (or a per-causal-chain depth cap), plus a hard **max-steps /
   max-fan-out per run** and a per-run wall-clock timeout. A run that hits the cap fails and dead-letters
   (notification), never spins.
2. **Bounded retry, mirroring the hardened Zitadel client.** Reuse the ADR-0043 #196 retry shape:
   exponential backoff + jitter, ≤ a small N attempts, capped total added latency, honour `Retry-After`,
   **never retry a permanent `4xx`**, and **single-shot non-idempotent writes** (a create-user call must
   not duplicate the user on a lost-response retry — use an idempotency key where the target supports it).
   After max attempts → **dead-letter + manual notification**, not endless requeue.
3. **Per-app concurrency + global engine concurrency caps** (BullMQ queue concurrency / rate-limiter) so
   one misconfigured workflow can't (a) exhaust the host or (b) DoS the external vendor. This is a
   first-class reason the substrate needs a real queue (§10).
4. **Payload size limits, both directions.** Cap the outbound request body, cap the **ingested** external
   response size (a malicious/buggy target returning gigabytes), and cap manual-task input length.
5. **Hard timeouts on every outbound call** (also the SSRF slow-loris guard, §3).
6. **No unbounded list endpoints** — run-history / task lists use the ADR-0030 `Page<T>` contract
   (default 50, max 200).

---

## 9. Inbound webhook authenticity (B3)

**Threat.** If the engine ever exposes an **inbound** endpoint (an external system calls *into* lazyit to
trigger a workflow), that endpoint is a **public, pre-auth surface** — like `POST /config/setup`
(INV-3). An unauthenticated/forgeable inbound trigger is a free DoS and a way to drive provisioning side
effects.

### 9.1 Controls (design now, build in a later phase)

1. **HMAC signature verification** over the raw body using a per-connector signing secret (stored
   encrypted, §2), **constant-time compared** (`crypto.timingSafeEqual`, the same primitive as the
   SA-token compare, INV-SA-1). Reject unsigned/mismatched with a **generic 401** (no oracle).
2. **Replay protection:** require a signed timestamp (+ optional nonce); reject outside a small clock
   skew window; reject a seen nonce.
3. **Body-size cap + rate-limit per source** before any parsing/work (reuse the ADR-0043/INV-3 per-IP
   limiter pattern; do not trust a spoofable `X-Forwarded-For`, cf. [[SEC-010]] — closed).
4. **The inbound webhook only *enqueues* a job; it never executes synchronously in the request** — so a
   flood can't tie up the API, and the signed payload is treated as untrusted input downstream.

**Recommendation:** **v1 = outbound + manual triggers only** (access granted / revoked). Defer inbound
webhooks to a later phase, but **fix the signature/replay contract now** so the table stakes are set.

---

## 10. Substrate verdict — from the security lens

The CEO question: BullMQ + Valkey, or overkill (Temporal / n8n), or simpler (pg-boss / synchronous)?
**Security answer: BullMQ on Valkey — already decided in [[0053-async-workers-bullmq-valkey]] — and the
security justification is specifically the sandboxed processor and the async decoupling, not queueing.**

| Option | Security read |
|--------|---------------|
| **Synchronous (in the request)** | **Rejected.** (a) A slow/hostile external system ties up the API request thread → trivial DoS; the SSRF slow-loris becomes an API outage. (b) It forces the external call into the `AccessGrant` transaction, coupling a third-party failure to the local grant — the **exact opposite** of the required INV-WF-3 (the grant must commit regardless). (c) No process isolation for untrusted mapping/connector code (SSTI blast radius = the API). |
| **pg-boss (Postgres, zero new infra)** | Tempting for the operator constraint and "boring tech", but **no first-class flows and no sandboxed/forked execution** — untrusted mapping + memory-heavy connectors would run **in the API process**. Security-acceptable *only* if we forbid all code/expression eval AND isolate elsewhere; we'd rebuild the isolation BullMQ already gives us. ADR-0053 already rejected it for the workflow engine on capability grounds; security agrees. |
| **Temporal** | Strong durability + clean orchestration/activity isolation, **but** a separate server + its own datastore + UI = a large new attack surface and operational weight that **breaks the one-command, IT-generalist operator constraint** (product-vision-tech). Overkill for a 5–20-person single-host tool. Rejected. |
| **n8n (separate product)** | **Rejected on security grounds specifically.** It brings its **own** credential vault, its **own** RBAC, and its **own** audit log — none integrated with lazyit's `SystemSecret`/INV-6, the ADR-0046 permission catalog, or the at-most-one-actor audit (INV-SA-4). It would **fork** the three trust-sensitive subsystems we just hardened, doubling the secret-leak and authz surface, and it still doesn't solve SSRF for us. |
| **BullMQ + Valkey (chosen)** | **Sandboxed (forked-child) processors with a heap cap** give us OS-level isolation to run untrusted mapping/connector code (SSTI/OOM → child dies, API survives — §7). **Async decoupling** removes the synchronous DoS/coupling vector and lets the grant commit independently (INV-WF-3). **Native concurrency + rate-limiting** are the DoS controls (§8). Cost: one more container/secret-surface (Valkey on `127.0.0.1:6379`, never public — [[0053-async-workers-bullmq-valkey]]) — which is itself an SSRF target the egress guard must protect (§3.3). |

**Two caveats the verdict does not waive:**
1. **SSRF is substrate-independent.** No broker prevents it; it MUST be solved at the egress layer (§3)
   no matter what.
2. **The worker is co-located in the `api` container for now** ([[0053-async-workers-bullmq-valkey]]),
   so the sandboxed child + heap cap is the isolation boundary today; **a dedicated worker container**
   (already a documented ADR-0053 follow-up) is the right hardening once volume justifies it, and matters
   *more* here than for the docx job because connectors run untrusted-ish logic and hold decrypted
   secrets.

---

## 11. Proposed new invariants (for [[INVARIANTS]] once accepted)

- **INV-WF-1 — Connector secrets are encrypted at rest (ADR-0052) and never returned or logged.** Stored
  via `SecretEncryptionService`; the API returns only `configured: boolean`; no secret reaches a log
  line, a run-step snapshot, or an audit `detail` (INV-6).
- **INV-WF-2 — Every outbound request passes the egress guard.** Scheme-allowlisted; resolved-IP checked
  against the deny ranges (private/loopback/link-local/`169.254.169.254`/reserved); DNS-rebinding-pinned;
  redirects re-validated. Internal targets reachable only via an explicit, audited per-connector
  allowlist; `localhost`/IMDS are never allowlistable.
- **INV-WF-3 — A failing external provisioning call NEVER rolls back or blocks the local `AccessGrant`.**
  The grant is the source of truth; provisioning is best-effort, observable, retryable. (Deliberate
  *contrast* with INV-5 / [[0043-zitadel-source-of-truth]] strong coupling.)
- **INV-WF-4 — Every run is append-only and attributed to a human XOR a ServiceAccount** (or neither),
  DB-CHECK-enforced (INV-SA-4); the run records the workflow **version** it executed.
- **INV-WF-5 — No arbitrary code execution.** Mapping/expression evaluation is logic-less or sandboxed,
  runs in a forked child with no ambient authority, over an allowlisted context.
- **INV-WF-6 — Inbound webhooks (when added) are HMAC-verified + replay-protected before any work**, and
  only enqueue (never execute synchronously).
- **INV-WF-7 — Manual tasks are completable only by an authorized matching assignee** (`workflow:action`
  AND assignee/cohort match), and human-entered values are zod-validated untrusted input.

---

## 12. Phased, v1-first plan

**Phase 0 — prerequisites (not this engine, but blocking).**
- Land **ADR-0052** (`SecretEncryptionService` + `SystemSecret` + Notifications/bell/SSE) on `dev` — it
  is currently only on `feat/settings_notifications_smtp`. The engine reuses all of it.
- Land **ADR-0053** (BullMQ + Valkey, sandboxed processors).

**Phase 1 — v1: outbound REST + manual, opt-in, two triggers.**
- New `workflow` permission domain + literals in `@lazyit/shared` (+ golden test; re-typecheck web maps).
- The **egress guard** (§3) — the single most important deliverable; build + test it first, with the
  SEC-008/SEC-051 bypass vectors as test cases.
- Per-app connector config + **encrypted secrets** (reuse `SecretEncryptionService`); write-only API.
- **Outbound REST connector** + **logic-less mapping** (no expression eval) running in a **sandboxed
  processor**.
- **Manual-step** connector + manual-task inbox (reuse Notifications/bell/SSE); `workflow:action` +
  assignee check.
- **WorkflowRun/Step append-only audit** (at-most-one-actor); config-change audit.
- Triggers: **access granted / access revoked**, fired **async via BullMQ, fully decoupled** from the
  grant transaction (INV-WF-3).
- DoS guards: per-app concurrency, bounded retry, timeouts, payload caps, re-entrancy/loop guard.

**Phase 2 — breadth.**
- Scheduled/timer triggers (N-days-after-grant, periodic re-certification) via BullMQ
  delayed/repeatable jobs.
- More connector types (vendor SDK, MCP server), prebuilt connectors for famous apps.
- **Inbound webhooks** with the §9 signature/replay contract (designed in Phase 1).
- Key-rotation runbook for `SETTINGS_ENCRYPTION_KEY`; consider a dedicated worker container.

**Phase 3 — flag/defer (NOT designed now).**
- Richer identity fields (role / team / manager / boss / AD integration). **Identity-Governance-adjacent
  — separate ADR, do NOT pull into Access provisioning** (§6.2, §9). These do not exist in the model
  today; keep them out of v1.

---

## 13. Single-org tenancy assumptions

lazyit is single-org / single-host ([[0015-deployment-model]]); workflows are **global to the org** and
there is no per-tenant isolation requirement today. The practical consequence: the **egress guard is the
effective tenancy boundary** — any `workflow:manage` admin can point the engine at the host's internal
network, so §3 + §4 (deny-by-default egress + permission gating + audit) *are* the isolation. **When/if a
SaaS multi-tenant mode arrives** (product-vision-tech: additive, not a refactor), **per-tenant credential
isolation and per-tenant egress isolation become mandatory** — a tenant's workflow must never reach
another tenant's network or read another tenant's secret. Out of scope now; flagged so it isn't
forgotten.

---

## 14. Open questions for the CEO

1. **Egress default posture (§3.4):** (A) deny-private + explicit per-connector internal allowlist
   *(recommended)*, or (B) allow-any-non-loopback? `localhost`/IMDS stay un-allowlistable either way.
2. **`workflow:secrets` as a distinct permission (§4.1)** for separation of duties, or fold connector
   secrets into the existing `settings:manage`?
3. **Mapping language (§7):** ship **logic-less templating only** for v1 *(recommended)*, or commit to a
   sandboxed expression evaluator now?
4. **Inbound webhooks (§9):** confirm **defer to Phase 2** (v1 = outbound + manual), with the
   signature/replay contract fixed now.
5. **Default seed for `workflow:read`/`workflow:action`:** ADMIN-only like `logs:read`, or open
   `workflow:read` to MEMBER so operational staff can see run status?

---

Related: [[0023-access-management-design]] · [[0046-roles-permissions-v2]] · [[0048-service-accounts]] ·
[[0043-zitadel-source-of-truth]] · [[0053-async-workers-bullmq-valkey]] · [[0031-logging-strategy]] ·
[[0030-list-pagination-contract]] · [[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] ·
[[0005-id-strategy]] · [[INVARIANTS]] · [[SEC-008-application-url-href-xss-sink]] ·
[[SEC-051-application-url-scheme-guard-port-carveout-bypass]] · [[SEC-002-docx-decompression-bomb]] ·
`apps/api/src/settings/secret-encryption.service.ts` · `apps/api/src/access-grants/access-grants.service.ts` ·
`apps/api/src/common/actor.service.ts` · `packages/shared/src/schemas/permission.ts`
