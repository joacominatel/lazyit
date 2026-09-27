---
paths:
  - "apps/agent/**"
---

# The lazyit agent

`@lazyit/agent` is the inventory agent operators install on their machines. It is compiled with
`bun build --compile` into standalone binaries for linux x64, linux x64-baseline, linux arm64,
windows x64, and windows x64-baseline, and shipped inside the API image.

## Typecheck it explicitly

**`bun build --compile` does not typecheck.** A type error here reaches the released binary
silently unless someone runs it:

```sh
bunx tsc --noEmit -p apps/agent/tsconfig.json
```

CI runs it for exactly this reason. → `docs/03-decisions/0074-*` §7

## It ships to machines you do not control

An agent binary runs on an operator's estate, on a version they chose, reporting to an API that
may be newer or older than it. That makes compatibility a hard constraint, not a preference:

- What the agent reports must stay readable by an API that has already moved on, and by one
  that has not yet.
- A new field is additive. Removing or repurposing one strands every deployed binary until the
  operator updates, which may be never.
- Agent-sourced data arrives from the field already imperfect. The API keeps its read schema
  tolerant and self-heals on the next report rather than rejecting — see the IPAM precedent in
  `docs/04-development/claude-workflow.md` §7.

## Baselines exist for a reason

The `-baseline` targets serve CPUs without the newer instruction sets. Do not drop them to
simplify the build matrix; some operator hardware needs them.

## Tests and checksums

`bun test`. `bun run checksums` regenerates the release checksums — the release flow depends on
them, so do not hand-edit the output.
