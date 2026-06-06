---
id: SEC-051
title: isSafeApplicationUrl host:port carve-out is bypassable — "javascript:1/<payload>" passes the SEC-008 scheme guard
severity: medium
status: fixed
cwe: CWE-79
discovered: 2026-06-06
module: applications
tags: [xss, stored-xss, url, sec-008-regression, filter-bypass, frontend-sink]
---

# SEC-051 — SEC-008 url scheme guard bypass via the `host:port` carve-out

## Summary

The `host:port` carve-out in `isSafeApplicationUrl` (the SEC-008 fix) accepts any scheme as long as
what follows the first colon starts with digits and a slash. `javascript:1/alert(document.cookie)`
matches that pattern and is accepted, so the executable-scheme guard SEC-008 added is bypassable —
and JS division (`1/alert(...)`) still runs the payload at a render-time href sink.

## Description

SEC-008 (closed) added `isSafeApplicationUrl` to reject `javascript:`/`data:`/`vbscript:`/`file:` on
`Application.url`. To keep allowing scheme-less internal hosts written as `host:port`
(`vpn.corp.local:8080`), the predicate treats a "scheme" whose colon is followed by digits as a port:

```ts
const afterColon = normalized.slice(match[0].length);
return /^\d+(\/.*)?$/.test(afterColon);   // packages/shared/src/schemas/application.ts:44-45
```

The flaw is the `(\/.*)?` tail: after the leading digits, a single `/` is allowed followed by `.*` —
**anything**. So a `javascript:` value passes whenever it is shaped `javascript:<digits>/<rest>`:

- input `javascript:1/alert(document.cookie)`
- normalized unchanged; `match[1]` = `javascript` (not http/https)
- `afterColon` = `1/alert(document.cookie)` → `\d+` matches `1`, `(\/.*)` matches `/alert(document.cookie)`
- → returns `true` (ACCEPTED)

SEC-008's own residual note conceded that a payload-less `javascript:<digits>` is harmless ("no script
executes"). That reasoning misses the `/<rest>` tail: `javascript:1/alert(document.cookie)` is the JS
expression `1 / alert(document.cookie)`, and evaluating the division **calls** `alert(document.cookie)`
as the right operand. The side effect fires. The same shape works for `vbscript:1/...`.

This is symmetric across create AND update (both go through `ApplicationUrlSchema`,
`application.ts:78` and `:92`), and the bypass is not covered by the SEC-008 tests
(`application.test.ts` only checks `javascript:alert(...)`, case, TAB/LF, leading whitespace, and a
leading control byte — never the `digits/` tail).

The dangerous step is still the render sink (a frontend that emits `<a href={app.url}>`), which does
not exist yet — so today it is **latent**, exactly like SEC-008. It is rated up to Medium rather than
Low because (a) it is a working bypass of an already-"closed" control, and (b) `isSafeApplicationUrl`
is deliberately EXPORTED for the render layer to reuse (SEC-008 Resolution), so the flaw is primed to
ship straight to the live XSS sink and become High the moment the web app renders application links.

## Impact

Defeats the write-side half of the SEC-008 defense for a crafted payload, and — because the same
predicate is the intended render-time guard — will become a **stored, click-triggered XSS** (session/
identity theft once auth UI exists) the moment the frontend reuses it. An application entry is
team-visible, so one poisoned `url` runs script in any viewer's session. Latent today (no frontend) →
escalates to High when the web app renders application links. Same latent-XSS theme as SEC-003 / SEC-008.

## Proof of concept

Reasoned, **not executed**:

```sh
# accepted by the backend scheme guard (should be rejected):
curl -X POST http://localhost:3001/applications -H 'content-type: application/json' \
  -H 'X-User-Id: <member-uuid>' \
  -d '{"name":"Evil","url":"javascript:1/alert(document.cookie)"}'    # 201

# at the future render sink: <a href="javascript:1/alert(document.cookie)">  ->
#   clicking evaluates  1 / alert(document.cookie)  -> alert(document.cookie) is CALLED
```

Predicate-level (also not executed): `isSafeApplicationUrl("javascript:1/alert(document.cookie)")`
returns `true`; `"vbscript:1/msgbox(document.cookie)"` returns `true`.

## Affected

- `packages/shared/src/schemas/application.ts:44-45` — the `^\d+(\/.*)?$` carve-out accepts a
  dangerous scheme followed by `digits/<anything>`.
- `packages/shared/src/schemas/application.ts:78`, `:92` — applied to create and update.
- `packages/shared/src/schemas/application.test.ts` — SEC-008 tests miss the `digits/` tail vector.
- Regression against `docs/06-security/closed/SEC-008-application-url-href-xss-sink.md`.

## Recommendation

Don't infer "scheme-less host:port" from "the regex matched a scheme followed by digits". Instead:

- If a scheme is present and it is not `http`/`https`, **reject** — full stop. Recognize `host:port`
  only when the part BEFORE the colon is a valid host label and the part after is purely a port
  (`^\d{1,5}(\/|$)`), e.g. parse with the URL/host grammar rather than re-using the `scheme:` match.
- Equivalently: require the port carve-out to also verify there is **no** path char that could form a
  JS expression — but a host-grammar check is cleaner and not fragile.
- Add tests for `javascript:1/alert(1)`, `javascript:0//x`, `vbscript:1/msgbox(1)`,
  `data:1/...` (already blocked) so the tail vector is covered.

## Prevention

Treat URL-scheme allow-listing as parse-don't-validate: normalize with a real URL/host parser and
allow-list the resulting scheme, instead of regex-sniffing the prefix. Fold the same policy into the
Phase-3 frontend render guard (the one "untrusted string → web sink" policy shared with SEC-003 /
SEC-008), and make the shared predicate the single tested source of truth for both sides.

## References

- CWE-79: Improper Neutralization of Input During Web Page Generation (XSS) · CWE-84.
- OWASP XSS Prevention Cheat Sheet (URL contexts) · SEC-008 (closed) · SEC-003 (open) · ADR-0023.

## Resolution

**Status**: fixed
**Fixed in**: commit `d1f5e2b` (`fix: tighten isSafeApplicationUrl host:port carve-out to a bare port (SEC-051)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-06-06

### Changes
- `packages/shared/src/schemas/application.ts`: tightened the `host:port` carve-out from
  `^\d+(\/.*)?$` to `^\d{1,5}$` — a bare port with NO path. The `/<rest>` tail is what let
  `javascript:1/alert(document.cookie)` (the JS expression `1 / alert(...)`, whose division *calls*
  alert) pass the scheme guard. A non-`http(s)` scheme followed by anything but pure digits is now
  rejected. A scheme-less host that needs a path can always be written `http(s)://host:port/path`.

### Tests added
- `packages/shared/src/schemas/application.test.ts`::"rejects the host:port carve-out bypass" — fails
  without the fix (the old regex returns `true` for `javascript:1/alert(1)`, `javascript:0//x`,
  `vbscript:1/msgbox(1)`, `data:1/text`, and obfuscated variants), passes with it. The existing
  `vpn.corp.local:8080` / IP-with-port cases still pass (the bare-port shape is preserved).

### Verification
`bun test packages/shared/src/schemas/application.test.ts` → 5 pass / 0 fail. Predicate-level:
`isSafeApplicationUrl("javascript:1/alert(document.cookie)") === false`.

### Residual risk
The render-time half stays latent until the frontend renders application links (no frontend yet —
same posture as SEC-008). `isSafeApplicationUrl` remains exported so the render layer reuses this one
tested predicate. A payload-less `javascript:<digits>` (e.g. `javascript:12345`) is still accepted but
is inert (no call, no side effect), as SEC-008's residual note already conceded.
