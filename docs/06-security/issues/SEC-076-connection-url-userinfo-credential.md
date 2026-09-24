---
id: SEC-076
title: Connection URLs accept userinfo (https://user:pass@host) — a plain-config credential outside the secret store and CSEC-1
severity: low
status: open
cwe: CWE-522
discovered: 2026-09-24
module: workflow-engine (connections) · shared
tags: [credential-exposure, url-validation, csec-1, workflow-engine]
---

# SEC-076 — `publicHttpsUrl` accepts userinfo, and Node sends it as `Authorization: Basic`

## Summary

The shared `publicHttpsUrl` schema accepts `https://user:pass@host/…` as a REST `baseUrl` or a
WEBHOOK_OUT `url`. At call time Node's `https.request` turns the userinfo into
`Authorization: Basic …`. The result is a credential stored in plain connection config, returned on
read, and outside the CSEC-1 separation of `workflow:manage` and `workflow:secrets`.

## Description

`publicHttpsUrl` (`packages/shared/src/schemas/workflow.ts:166-175`) is `z.url()` plus an `https://`
prefix check. It does not reject a username or password. The egress guard parses the URL and checks
only scheme and host (`egress-guard.ts:83-130`). The default transport then calls
`mod.request(url, …)` with the parsed `URL` (`egress-guard.ts:252`). Node's `urlToHttpOptions` sets
`auth` from `url.username:url.password`, and `ClientRequest` sends `Authorization: Basic <base64>`
unless an `Authorization` header is already set.

This gives a credential channel that:

- lives in `WorkflowConnection.config` and is returned to `workflow:read` holders by
  `GET /workflow-connections[/:id]`, and echoed in the dry-run preview `url`
  (`workflow-dry-run.service.ts:354`);
- is not a `secretId`, so the CSEC-1 gate does not see it. For a host change the password goes with the
  new URL string, so re-pointing needs the attacker to know it, and they can read it (above). Changing
  the path on the same host keeps the credential, and a relative same-origin redirect keeps the
  userinfo (`new URL(location, base)` inherits it, `egress-guard.ts:401`).

The AI authoring tools already refuse userinfo (`ai/tools/workflow-authoring.tools.ts:191`, `:212`,
`:1274`). The route and the shared schema accept it (`docs/ai-assistant/security.md` "Userinfo in URLs").

## Impact

Low to Medium. The exposure is the same as SEC-075 (a `workflow:read` holder reads a live Basic-auth
credential), but it needs an operator to type a password into a URL, which is less common than pasting
a header, and there is no re-point step the attacker can take without already knowing the password.
Rated **Low**. It becomes Medium on instances that grant `workflow:read` beyond ADMIN (it is
service-account-grantable).

## Proof of concept

Reasoned from the code, **not executed**.

```sh
curl -X POST /api/workflow-connections -H "Authorization: Bearer <admin>" \
  -d '{"applicationId":"…","kind":"REST","name":"x","config":{"kind":"REST","baseUrl":"https://svc:hunter2@api.example.com"}}'
# -> 201 (accepted)
curl /api/workflow-connections/$C -H "Authorization: Bearer lzit_sa_<workflow:read>"
# -> "baseUrl": "https://svc:hunter2@api.example.com"
# At run/test time api.example.com receives "Authorization: Basic c3ZjOmh1bnRlcjI="
```

## Affected

At `origin/dev` 62aa1e53.

- `packages/shared/src/schemas/workflow.ts:166-175` (`publicHttpsUrl`), used by `:215` (REST `baseUrl`) and `:234` (WEBHOOK_OUT `url`).
- `apps/api/src/common/egress/egress-guard.ts:252`: `mod.request(url, …)` converts userinfo into Basic auth.
- `apps/api/src/workflow-engine/definitions/workflow-connections.service.ts:85-123`: create/read carry it.

## Recommendation

Minimal fix: refuse userinfo **on write** in `publicHttpsUrl`, using the same regex style the schema
already uses (the shared package has no `URL` global):

```ts
.refine(
  (value) => !/^https:\/\/[^/?#]*@/i.test(value.trim()),
  "Must not contain credentials (user:pass@) — store them as a connection secret",
)
```

The write schemas must stay separate from the read-shape `WorkflowConnectionSchema`, or a
`publicHttpsUrlRead` must be kept, so an existing row with userinfo still parses on read (upgrade-safe:
tolerant on read). As defence in depth, the egress guard can refuse a URL with
`url.username || url.password` (a new `EgressError('userinfo-not-allowed')`). That makes legacy rows
fail with a clear config error rather than send the credential. It is a behaviour change for such rows,
so the PR should say so and the Manual should tell operators to move them to a secret.

## Prevention

- One helper for "outbound URL" validation, shared by the AI tool refusal and the route schema, so the
  two cannot drift again.
- Add a schema test in `workflow.test.ts`: `https://u:p@host` and `https://u@host` are rejected for
  both connection kinds.

## References

- CWE-522, CWE-598 (credentials in a URL). RFC 3986 §3.2.1 (userinfo is deprecated for passwords).
- `docs/ai-assistant/security.md` "Userinfo in URLs" · [[SEC-075-connection-default-headers-credential-unprotected|SEC-075]] · epic #1315, PR #1354.
