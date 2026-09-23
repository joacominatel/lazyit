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
**Fixed in**: commit `856b4a6d` (`fix(shared): close the host:port carve-out bypass in isSafeApplicationUrl (#1320)`), tests in `3dd1c420`
**Fixed by**: lazyit-remediator
**Date**: 2026-09-23

### Confirmed live

On `dev` at `cef9f2d8`, `isSafeApplicationUrl` returned `true` for every vector in this finding and
its siblings: `javascript:1/alert(document.cookie)`, `javascript:0//x`, `vbscript:1/msgbox(1)`,
`data:1/…`, `file:1/…`, the same shapes with mixed case / embedded TAB / leading whitespace / a
leading control byte, and percent- or character-reference-encoded schemes (`javascript%3A…`,
`%6Aavascript:…`, `&#106;avascript:…`, `javascript&#58;…`, `javascript&colon;…`, `java&Tab;script:…`).

### Why not the host-grammar check the Recommendation suggests

`javascript` **is** a valid single-label host and `1` a valid port, so "valid host label + `^\d{1,5}(\/|$)`"
still accepts `javascript:1/alert(1)`. Requiring a dotted host instead would reject legitimate
single-label internal hosts (`jenkins:8080`) that existing rows may hold, and those would lose their
link in the web. The ambiguity only exists when the "host" token is itself a scheme a browser gives
meaning to, so that is what the carve-out now refuses. Everything outside the carve-out is still an
allow-list (`http`/`https` or no scheme).

### Changes

- `packages/shared/src/schemas/application.ts`:
  - The `host:port` carve-out never applies when the pre-colon token is a browser-interpreted scheme
    (`javascript`, `vbscript`, `data`, `file`, `blob`, `filesystem`, `about`, `view-source`), so those
    are rejected regardless of what follows the colon.
  - `isSafeApplicationUrl` runs the scheme check on the raw value **and** on a decoded form (HTML
    numeric character references with or without `;`, `&colon;` / `&tab;` / `&newline;`, and `%XX`
    escapes), so a scheme only revealed by a decoding sink (an HTML attribute, a markdown link
    destination) is rejected too.
  - Create and update both go through `ApplicationUrlSchema`, so both are covered. The read schema
    (`ApplicationSchema.url`) is unchanged: `z.string().nullable()`.

### Tests added

`packages/shared/src/schemas/application.test.ts`:

- `isSafeApplicationUrl — host:port carve-out bypass (SEC-051)` › rejects a dangerous scheme shaped
  like host:port/path; › rejects the same shape under case, whitespace and control-char obfuscation;
  › rejects percent- and character-reference-encoded dangerous schemes — all three fail on `dev`
  (every listed value returned `true`), pass with the fix.
- › still allows scheme-less host:port (single-label and dotted) and encoded http(s) urls — the
  no-regression guard (`jenkins:8080`, `localhost:3000`, `javascript.corp.local:8080`, `%20` paths,
  `https://…?q=a%3Ab`).
- `Application url schemas — SEC-051 on write, tolerant on read` › `CreateApplicationSchema` and
  `UpdateApplicationSchema` reject the bypass (both fail on `dev`); › `ApplicationSchema` still loads a
  legacy row holding `javascript:1/alert(document.cookie)` (upgrade-safety).

### Verification

`bun test src/schemas/application.test.ts` in `packages/shared`: 14 pass / 5 fail on `dev`, 19 pass /
0 fail with the fix. Full charter validation (shared build, the four `tsc --noEmit`, shared/web/agent
`bun test`, api jest) green — numbers in PR #1320's body.

### Render sink

The only href sink is `apps/web/app/(app)/applications/[id]/_components/application-detail-view.tsx`,
which gates the link on `isSafeApplicationUrl` (imported from the built `@lazyit/shared`, so it picks up
this fix with no web change) and then prefixes any non-`http(s)` value with `https://` before using it
as `href`. So even before this fix the detail view emitted `https://javascript:1/alert(1)`, not a
`javascript:` href, and React 19 additionally blocks `javascript:` hrefs. The quick-view presenter
(`apps/web/components/quick-view-fields.ts`) renders the url as plain text only.

### Existing data

Write-only validation. A row already holding a now-rejected value still loads (read schema
unchanged; covered by a test); the detail view shows it as plain text instead of a link and the
quick view omits it. A `PATCH` that does not include `url` is unaffected; saving the edit form, which
re-sends `url`, surfaces a field error until the value is corrected. No migration.

### Residual risk

- The deny set inside the carve-out is closed-world: a new browser-executable scheme would need to be
  added. Outside the carve-out the policy remains an allow-list.
- Sibling, out of scope here: `InfraShortcutSchema.url` (`packages/shared/src/schemas/infra.ts`) is
  `z.url()`, which accepts `javascript:alert(1)`, and
  `apps/web/app/(app)/assets/diagram/_components/node-detail-modal.tsx` renders it as a raw `href`.
  React 19 blocks `javascript:` hrefs at render, but there is no write-side scheme allow-list. Flagged
  for a sentinel finding of its own; not fixed here.
