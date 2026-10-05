---
id: SEC-086
title: InfraShortcut.url accepts executable schemes (javascript:, data:, vbscript:)
severity: low
status: fixed
cwe: CWE-79
discovered: 2026-10-05
module: infra
tags: [stored-xss, url-scheme, shared-schema, sec-008-class]
---

# SEC-086 — InfraShortcut.url accepts executable schemes (javascript:, data:, vbscript:)

## Summary

An infra node shortcut stores any URL `z.url()` parses, including `javascript:alert(1)`, and the node
detail modal renders it as a link `href`.

## Description

`InfraShortcutSchema.url` is `z.url().max(2000)`. `z.url()` checks that the value parses as a URL, and
`javascript:`, `data:` and `vbscript:` values all parse. `CreateInfraNodeSchema` and
`UpdateInfraNodeSchema` both reuse the schema, so `POST /infra/nodes` and `PATCH /infra/nodes/:id` store
the value. `ShortcutsSection` in the node detail modal renders each shortcut as
`<a href={shortcut.url} target="_blank">`.

This is the SEC-008 / SEC-051 class on a field the `isSafeApplicationUrl` guard never covered. It was
found while remediating SEC-051 (#1320, PR #1323) and tracked as #1327.

## Impact

A holder of the infra manage permission can store a link that runs script in the browser of whoever
clicks it in the node detail modal. React 19 refuses to render a `javascript:` href, which blunts the
live sink today, but a `data:` URL still opens, nothing stops the value on write, and any other consumer
of the stored value (search documents, exports, AI read tools, a future renderer) inherits it. The
attacker already needs a write permission on the infra graph, so the intrinsic exploitability is low.
ADR-0097 AI tools will be able to write shortcuts once infra writes ship, which turns this into a
prompt-injection-reachable sink.

## Proof of concept

Executed against the shared schema on `origin/dev` aef4b812 (the API was not run):

```ts
UpdateInfraNodeSchema.safeParse({ shortcuts: [{ label: "x", url: "javascript:alert(1)" }] }).success; // true
UpdateInfraNodeSchema.safeParse({ shortcuts: [{ label: "x", url: "data:text/html,<script>alert(1)</script>" }] }).success; // true
UpdateInfraNodeSchema.safeParse({ shortcuts: [{ label: "x", url: "vbscript:x" }] }).success; // true
```

## Affected

- `packages/shared/src/schemas/infra.ts:72-75` — `InfraShortcutSchema.url` is `z.url().max(2000)`, used
  by the read shape and both write shapes.
- `apps/web/app/(app)/assets/diagram/_components/node-detail-modal.tsx:1548` — `href={shortcut.url}`.

## Recommendation

Refuse executable schemes on the create and update schemas only, so stored rows keep reading, and gate
the href at render time so an unsafe legacy value renders as plain text instead of a link.

## Prevention

Every stored URL that reaches an `href` goes through a scheme guard on write and an allow-list at render,
as `Application.url` and `Supplier.website` already do.

## References

- CWE-79. SEC-008 and SEC-051 (`docs/06-security/closed/`).
- `docs/03-decisions/0070-infra-topology-graph.md`, `docs/02-domain/entities/infra-node.md`.
- GitHub #1327.

## Triage note

🚨 Escalated on 2026-10-05: the planned http/https-only guard conflicts with the documented feature.
ADR-0070, the `infra-node` entity note and the Manual all describe shortcuts as SSH, web UI and console
links (`ssh://host` is a fixture in `node-detail-keys.test.ts` and `search.documents.spec.ts`), and the
web saves the whole `shortcuts` array on every edit. An http/https-only write guard would drop the SSH
use case, and every node that already holds an `ssh://` or `rdp://` shortcut would get a `400` on any
later shortcut edit until the operator deleted that link.
Options: (1) http/https only, and amend ADR-0070, the entity note and the Manual to drop SSH and console
links. (2) Refuse the browser-interpreted schemes on write (`BROWSER_INTERPRETED_SCHEMES` from
`application.ts`: `javascript`, `vbscript`, `data`, `file`, `blob`, `filesystem`, `about`,
`view-source`, also checked on the decoded value as `isSafeApplicationUrl` does), keep `z.url()`, and
render a link only when the scheme is outside that set. · Recommendation: (2). It closes the executable
class, keeps the documented SSH and console links, needs no doc or Manual change, and leaves existing
rows editable.

Resolved on 2026-10-05 with option (2): the coordinator confirmed that ADR-0070, the entity note and the
Manual are binding, and they define SSH and console shortcuts.

## Resolution

**Status**: fixed
**Fixed in**: commit `fa59637e` (`fix(shared): refuse executable schemes in infra shortcut URLs on write (#1327)`)
and commit `48cbbf2f` (`fix(web): render unsafe legacy shortcut URLs as plain text in the node modal (#1327)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-10-05

### Changes
- `packages/shared/src/schemas/application.ts`: new `hasBrowserInterpretedScheme(value)`. It is the
  denylist half of `isSafeApplicationUrl`: `BROWSER_INTERPRETED_SCHEMES`, checked on the raw value and on
  its character-reference / percent-decoded form, after the same TAB/LF/CR and leading control-char
  normalization. `isSafeApplicationUrl` itself is unchanged and shares the normalization helper.
- `packages/shared/src/schemas/infra.ts`: new `InfraShortcutWriteSchema` (the read shape plus the
  scheme refinement). `CreateInfraNodeSchema` and `UpdateInfraNodeSchema` take shortcuts through it.
  `InfraShortcutSchema` and `InfraNodeSchema` (reads) are unchanged.
- `apps/web/app/(app)/assets/diagram/_components/shortcut-href.ts`: `shortcutHref(url)` returns `null`
  for an executable scheme.
- `apps/web/app/(app)/assets/diagram/_components/node-detail-modal.tsx`: `ShortcutsSection` renders a
  link only when `shortcutHref` returns one, and the label as plain text otherwise. `ShortcutsEditor`
  validates against `InfraShortcutWriteSchema`, so the error shows before the round-trip.
- `docs/03-decisions/0070-infra-topology-graph.md` (a "Decisions while building" note) and
  `docs/02-domain/entities/infra-node.md`: why this is a denylist and not http(s)-only.

### Tests added
- `packages/shared/src/schemas/infra.test.ts` › `InfraShortcut url scheme guard (SEC-086)`:
  - Refuses `javascript:` (including mixed case, a TAB inside the scheme, and `&#58;`), `data:`,
    `vbscript:`, `file:` and `blob:` on the write schema, on create and on update. The PoC above shows
    that every one was accepted on `origin/dev` aef4b812.
  - Keeps `https`, `http`, `ssh`, `rdp` and `vnc` links valid.
  - Still rejects unknown keys.
  - The read shape still loads a legacy `javascript:` shortcut.
- `packages/shared/src/schemas/application.test.ts` › `hasBrowserInterpretedScheme (SEC-086)`:
  - Flags disguised executable schemes: control-char prefix, LF inside the scheme, `&#58;`, `&colon;`,
    `%6A`.
  - Leaves web, SSH, console and scheme-less values alone.
- `apps/web/app/(app)/assets/diagram/_components/shortcut-href.test.ts`: links web, SSH and console
  shortcuts, and returns `null` for legacy executable-scheme URLs.

### Verification
Charter validation on the branch:
- Shared build, and `tsc --noEmit` for shared, api, web and agent: all clean.
- `bun test`: shared 2401 pass / 0 fail; web 2039 pass / 0 fail.
- api jest under node: 296 suites, 6624 tests, all pass.
- `next build` succeeds.
- Agent `bun test`: 560 pass. The 2 failures are the pwsh-dependent `install-ps1` cases ("no pwsh on this
  machine"), and `apps/agent` is untouched by this change.

### Existing data
The validation is write-only, and no migration is needed.
- A node that already stores an executable-scheme shortcut still loads, lists, searches and exports.
- The node modal shows that shortcut's label as plain text, with the URL in its tooltip, instead of
  a link.
- A `PATCH` that leaves out `shortcuts` is unaffected.
- Saving the shortcuts editor re-sends the whole array, so it shows the invalid-shortcut error until
  that row is fixed or removed.
- Existing `ssh://`, `rdp://` and other non-web links keep working and stay editable.

### Residual risk
- The denylist is closed-world: a new browser-executable scheme would need adding to
  `BROWSER_INTERPRETED_SCHEMES`. It is the same set `Application.url` and the MCP redirect URIs rely on.
- An unknown non-web scheme (for example `ms-settings:`) can still be stored and linked. A browser
  hands it to the OS protocol handler only after the user clicks, and the author already holds
  `infra:manage`.
