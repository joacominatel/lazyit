---
paths:
  - "packages/shared/**"
---

# The shared contract

`@lazyit/shared` is the one place `web`, `api`, and `agent` agree. It is a leaf: it depends on
nothing in this repository. → `docs/01-architecture/shared-package.md`

## What belongs here

Only what more than one consumer must agree on: zod schemas, the types inferred from them,
shared constants, and **pure** framework-agnostic utilities.

## What does not

No application dependencies. No framework code — no Nest, no React, no Next. **No Prisma
types**: the ORM's generated types are an implementation detail of the API, and leaking them
here couples the frontend to the database.

If only one side needs it, it goes on that side.

## Changing it is a contract change

Every edit here has at least two consumers. Before changing a schema, check who reads it, say
so in the PR, and update the other side in the same change or in an explicitly sequenced unit.

A widened schema is usually safe. A narrowed one breaks the consumer that was relying on the
old shape, and it breaks stored data that predates it — keep the read path tolerant and enforce
on write.

`src/index.ts` is the barrel and a **shared critical file**: a unit touching it forces serial
execution.

## Build and test

The package must be built before anything consumes it — the API seed and CI both depend on
that ordering:

```sh
bun run --filter @lazyit/shared build
(cd packages/shared && bun test)
bunx tsc --noEmit -p packages/shared/tsconfig.build.json
```

`bun test` here, not Jest. Schema logic is core logic: test it thoroughly.
