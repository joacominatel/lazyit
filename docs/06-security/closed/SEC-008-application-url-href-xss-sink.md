---
id: SEC-008
title: Application.url is stored unvalidated and can carry a javascript:/data: scheme (href XSS sink)
severity: low
status: open
cwe: CWE-79
discovered: 2026-05-25
module: applications
tags: [xss, stored-xss, url, latent, frontend-sink]
---

# SEC-008 — `Application.url` as a `javascript:`/`data:` href sink (latent stored XSS)

## Summary

`Application.url` is stored as a lenient free string with no scheme restriction. A frontend that renders
it as a link (`<a href={app.url}>`) — the obvious use — will happily emit `href="javascript:…"` /
`href="data:text/html,…"`, giving stored, click-triggered XSS. Latent today (no frontend), same class as
[[SEC-003-markdown-sanitizer-bypass-asymmetric|SEC-003]] but a distinct field and sink.

## Description

`ApplicationUrlSchema` is `z.string().trim().min(1).max(2048)` — deliberately **not** `z.url()`, so that
scheme-less internal hosts (`vpn.corp.local`) are accepted (`packages/shared/src/schemas/application.ts:21`,
ADR-0023). The value is persisted verbatim (`applications.service.ts:29-39`). The leniency that allows
`vpn.corp.local` equally allows `javascript:alert(document.cookie)` and `data:text/html;base64,…`. ADR-0023
notes the scheme-less rationale but does **not** acknowledge the dangerous-scheme risk, so it is not
"accepted debt" — it is simply unhandled.

The dangerous step is at the render sink (the planned web app), which doesn't exist yet — so this is
**latent**, not live. It is filed against the backend because the backend is where the unsafe value is
accepted and stored, and because the fix (reject dangerous schemes on write) belongs here as much as at
render time.

## Impact

Stored XSS once a frontend renders an application's `url` as a link without scheme-filtering. An
application entry is team-visible, so a single poisoned `url` runs script in any viewer's session →
session/identity theft once auth exists. Latent today → **escalates to High** when the web app renders
application links. Same latent-XSS theme as SEC-003 (KB markdown) — together they argue for one
"untrusted-string → web sink" policy.

## Proof of concept

Reasoned, **not executed**:

```sh
curl -X POST http://localhost:3001/applications -H 'content-type: application/json' \
  -d '{"name":"Evil","url":"javascript:alert(document.cookie)"}'
# stored as-is; a naive <a href={app.url}> on the frontend executes it on click.
```

## Affected

- `packages/shared/src/schemas/application.ts:21` — `ApplicationUrlSchema` (no scheme restriction).
- `apps/api/src/applications/applications.service.ts:29-53` — stored/updated verbatim.

## Recommendation

- On write, reject non-http(s) schemes while still allowing scheme-less hosts: accept a value that is
  either scheme-less (`^[\w.-]+(/.*)?$`, optionally normalized to `https://`) or has an `http`/`https`
  scheme; reject `javascript:`/`data:`/`vbscript:`/`file:` explicitly.
- At render time, the frontend must additionally allow-list the href scheme (defense in depth) — fold
  into the same Phase-3 frontend sanitization decision as SEC-003.

## Prevention

One policy for "untrusted strings that reach a web sink": KB markdown (render-sanitize), URL fields
(scheme allow-list). Capture it as an ADR so every new free-text/URL field is covered by default. Add
tests with `javascript:`/`data:` vectors.

## References

- CWE-79: Improper Neutralization of Input During Web Page Generation (XSS). CWE-84 (encoded-URI in attribute).
- OWASP XSS Prevention Cheat Sheet (URL contexts) · ADR-0023 (Application; lenient `url`) · SEC-003.

## Resolution

**Status**: fixed
**Fixed in**: commit `4418945` (`fix: reject dangerous url schemes on Application.url (SEC-008)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-05-25

### Changes

- `packages/shared/src/schemas/application.ts`: `ApplicationUrlSchema` now `.refine()`s with a new
  exported `isSafeApplicationUrl(value)` predicate — a value is accepted only if it is scheme-less
  (an internal host/path, including `host:port`) or uses `http`/`https`; any other scheme
  (`javascript:`, `data:`, `vbscript:`, `file:`, …) is rejected. The check normalizes the value the
  way a browser does before reading the scheme (strips TAB/LF/CR anywhere and drops a leading
  non-alphanumeric run), so `java\tscript:` or a leading control byte can't hide the scheme. The
  predicate is **exported** so the future web render layer can reuse the same policy. Applies to
  create and update (both go through `ApplicationUrlSchema`).
- docs: ADR-0023 and the [[application]] entity note now state the scheme allow-list.

### Tests added

- `packages/shared/src/schemas/application.test.ts` — `isSafeApplicationUrl` allows http(s) +
  scheme-less hosts (incl. `host:port`) and rejects `javascript:`/`data:`/`vbscript:`/`file:` plus
  obfuscations (case, embedded TAB/LF, leading whitespace, a leading control byte). Schema-level:
  `CreateApplicationSchema` rejects a `javascript:` url and accepts a scheme-less host / https url.
  Fails without the refine (the lenient string accepted everything).

### Verification

`bun test src/` in packages/shared → 13 pass (9 prior + 4). Shared `tsc` build clean; api typecheck
against the rebuilt shared dist clean.

### Residual risk

This is the **write-side** half. The authoritative defense is still **render-time** scheme
allow-listing on the web app (deferred — no frontend yet); `isSafeApplicationUrl` is exported so the
render layer reuses it. The `host:port` carve-out means a contrived `javascript:<digits>` (no call
payload) would pass — harmless, no script executes. Same latent-XSS theme as
[[SEC-003-markdown-sanitizer-bypass-asymmetric|SEC-003]] (open/escalated); together they are the
"untrusted string → web sink" policy the frontend phase should formalize.
