---
paths:
  - "docs/**"
  - "apps/web/content/manual/**"
---

# Writing documentation

Two surfaces with different audiences. Do not confuse them.

- **`docs/`** — the internal vault. Written for whoever builds lazyit next.
- **`apps/web/content/manual/`** — the public Manual at `/help`. Written for the operator
  running lazyit. → `docs/04-development/manual-authoring.md`

A change that is both core and user-facing updates both.

## Vault conventions

Obsidian-friendly: YAML frontmatter on every note (`title`, `tags`, `status`, `created`,
`updated`), `[[wiki-links]]` for internal references, and one `_MOC.md` index per folder. A new
note is linked from its folder's MOC in the same change, or nobody will find it.

`status` is one of `draft`, `accepted`, `proposed`, `superseded`.

## Decision records

`docs/03-decisions/`, MADR-lite, numbered sequentially. `_MOC.md` is a **shared critical file**
because the numbering collides there — a unit adding an ADR forces serial execution.

Record a decision when it will still matter in six months and someone will ask why: architecture
boundaries, security posture, the data model or deletion and migration semantics, operations,
a cross-module contract, compatibility and the upgrade path.

Every record needs a consequences section that names a real cost. One without it is usually a
rationalization rather than a decision.

**Never supersede an accepted ADR silently.** Propose it and escalate — that is the CEO's call.

## Before committing

Grep for what you removed. A note that references a deleted file, a renamed path, or a
philosophy the change just altered is the same class of defect as a dangling import — and it is
worse, because the next agent will believe it.

## The Manual

Both languages, always, and `_nav.ts` wired for a new page. Write for an operator who does not
know how lazyit is built and does not need to. The parity check is blocking:

```sh
(cd apps/web && bun run check:manual-parity)
```
