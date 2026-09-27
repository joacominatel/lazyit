---
name: lazyit-decisions
description: The lazyit decision record — an index of every ADR by number, title, and status, plus how to find the one that governs an area and how to add or supersede one. Use before changing behavior in an area you have not worked in, when you need to know why something is the way it is, or when a change would contradict an existing decision.
---

# lazyit decisions

96 accepted, proposed, and superseded ADRs live in `docs/03-decisions/`, MADR-lite and numbered.
They are the answer to "why is it like this", and they are binding: a change that contradicts an
accepted decision is escalated to the CEO, never made quietly.

**The full index is in [references/index.md](references/index.md)** — number, title, and status
for every record.

## Finding the one that governs your change

1. Scan the index for the area you are touching. Titles are descriptive; the number tells you
   roughly when it was decided.
2. Read the record, not just its title. The consequences section is where the cost lives, and
   it is usually the part that constrains you.
3. Follow its `[[wiki-links]]` — decisions reference the entity notes and runbooks they affect.
4. When two records seem to conflict, the higher number wins and the older one should already
   be marked `superseded`. If it is not, that is a defect worth reporting.

`docs/03-decisions/_MOC.md` is the vault's own index with grouping and context. This skill is
the flat lookup; the MOC is the guided tour.

## Status

| Status | Means |
| --- | --- |
| `accepted` | In force. Do not contradict it without escalating. |
| `proposed` | Written, not settled. Check with the CEO before building on it. |
| `superseded` | Historical. Read it for context; follow the record that replaced it. |

`0000` is the template, not a decision.

## Adding one

Record a decision when it will still matter in six months and someone will ask why:
architecture boundaries, security posture, the data model or deletion and migration semantics,
operations, a cross-module contract, compatibility and the upgrade path.

Do not record implementation detail visible in the code, a choice with no alternative worth
naming, or something an existing record already covers.

Take the next free number, follow the template, link it from `_MOC.md` in the same change, and
give it a consequences section that names a real cost. `_MOC.md` is a **shared critical file** —
the numbering collides there, so a unit adding an ADR runs serially.

## Superseding one

Never silently. Propose it, escalate to the CEO, and on approval write the new record, mark the
old one `superseded`, and point each at the other. Conventions are in
`docs/04-development/code-conventions.md`.
