---
title: "ADR-0100: Money as 64-bit integer minor units"
tags: [adr, money, data-model, validation, contract, migration]
status: accepted
created: 2026-10-01
updated: 2026-10-02
deciders: [Joaquín Minatel]
---

# ADR-0100: Money as 64-bit integer minor units

## Status

**accepted** — 2026-10-01 (epic #1465, issue #1466). Part of the Purchases package the CEO approved
"con la ampliación de montos" (including the money widening) — see
[[0099-purchases-scope-model-and-optionality]] and [[purchases/decisions]]. **Built 2026-10-02 (#1469)** for
the three existing money columns, and for the Purchases money column (`PurchaseOrderLine.unitPrice`) in
#1472. Amends [[0036-int4-bounded-integers]] (money columns are no longer `Int`) and
[[0088-application-license-seat-tracking]] (`costPerSeat` widens with the rest). **Amended 2026-10-02**:
§5 (display) records the CEO's decision that currency is free text (D-C of
[[0099-purchases-scope-model-and-optionality]]). **Amended again 2026-10-02** (#1469): §3 records how the
conversion is built, §4 the dependency check, and §5 a provisional CTO decision on `costPerSeat`.
**Amended 2026-10-02 (#1470)**: §5 (input) — the web reads amounts in the viewer's locale, and an amount
with more than two decimals is refused on input instead of rounded (a CTO decision, provisional, pending
CEO confirmation); the frontend follow-up below is built.

## Context

Money is stored as **integer minor units** (hundredths: `formatMoney` divides by 100) in Postgres `int4`
columns, validated by the shared `int4({ min: 0 })` primitive ([[0036-int4-bounded-integers]], #954).
Three columns hold money today: `Asset.purchaseCost`, `Asset.salvageValue` and
`Application.costPerSeat`.

The `int4` ceiling is **2,147,483,647 minor units = 21,474,836.47 major units per stored value**. That is
enough in USD or EUR, and not enough in currencies with large nominal amounts: in ARS, CLP or COP an
ordinary server or a year of licences crosses it. Purchases makes this concrete — the research persona
buys in ARS, a single laptop line already reaches 1,412,500.00, and
[[0099-purchases-scope-model-and-optionality]] copies a line's unit price onto an asset's
`purchaseCost`. A purchase money column cannot be wider than the asset column it copies into.

Prisma maps a `BigInt` field to a PostgreSQL `bigint` and to a JavaScript **`bigint`** in the client.
Prisma's own documentation (ORM v7, *Special fields and types → Working with BigInt*) notes that
`JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` on a record that contains one,
so a `BigInt` column cannot reach the wire without an explicit conversion.

## Considered options

1. **Keep `int4` and derive totals in the app.** No migration. Rejected: the per-value ceiling is the
   problem, not only totals — one ARS unit price can exceed it.
2. **`Decimal` / `numeric`.** Rejected: a second money convention (Prisma returns `Decimal` objects,
   usually serialized as strings), float-shaped input on the wire, and [[0088-application-license-seat-tracking]]
   explicitly refused a second convention.
3. **`bigint` in the database, a string on the wire.** Exact to 2^63−1. Rejected: a breaking change to
   every money field of the contract (web, import, AI tools, MCP clients) to buy a range nobody needs.
4. **`bigint` in the database, a bounded JSON number on the wire** *(chosen)*. The contract keeps its
   shape; only the upper bound moves.
5. **Widen only the new purchase columns.** Rejected: copy-on-confirm would move a purchase price into an
   asset column that cannot hold it.

## Decision

### 1. Storage

Every money amount is a **64-bit integer of minor units**: Prisma `BigInt` → PostgreSQL `bigint`.

- Existing columns: `Asset.purchaseCost`, `Asset.salvageValue`, `Application.costPerSeat`.
- Every new money column, starting with the Purchases ones ([[purchase-order-line]]`.unitPrice`).
- Non-money integers (counts, quantities, months, positions) stay `Int` / `int4()`
  ([[0036-int4-bounded-integers]] is unchanged for them).

The **scale is unchanged**: one minor unit is one hundredth of the major unit, as today, whatever the
currency label says. There are no per-currency minor-unit exponents: currency is a free-text label with
no semantics ([[0099-purchases-scope-model-and-optionality]] §5).

### 2. Wire contract

- Money stays a **JSON `number`** (an integer), never a string and never a `bigint`. The web, the import,
  the AI tools and MCP clients keep the shape they have.
- A shared zod primitive **`money()`** in `packages/shared/src/schemas/primitives.ts` replaces
  `int4({ min: 0 })` on every money field: `z.number().int()`, bounded to
  **`[0, Number.MAX_SAFE_INTEGER]`** (9,007,199,254,740,991 minor units ≈ 90 trillion major units) by
  default, narrowable like `int4()` and never widened past it.
- `money()` **always carries an `example`** in its OpenAPI metadata. Without one, Swagger UI autofills the
  schema `maximum` into optional fields — the exact defect [[0036-int4-bounded-integers]] fixed — and
  since `MAX_SAFE_INTEGER` is now a *valid* value it would be stored instead of rejected.
- The `bigint` column's own range (2^63−1) is wider than the wire bound, so the zod bound is the binding
  one: no value written through the API can exceed `Number.MAX_SAFE_INTEGER`, and every legacy value
  (≤ int4) is far below it.

### 3. Conversion at the API boundary

- **Reads:** the service or mapper that turns a Prisma row into a contract shape converts each money
  `bigint` with `Number(value)` before the response is serialized. Safe by construction: every stored
  value is within the wire bound.
- **Writes:** the validated `number` is passed to Prisma as `BigInt(value)`.
- **No global `BigInt.prototype.toJSON` patch.** A missed conversion must fail loudly in a test, not
  serialize silently as a string.
- **Derived amounts** (book value, line and purchase totals) are computed so that no intermediate value
  exceeds `Number.MAX_SAFE_INTEGER` — divide before multiplying, or use `bigint` arithmetic — and a write
  that would make a line total or a purchase total exceed the bound is rejected with a `400`.
- The web's major/minor helpers (`apps/web/lib/utils/money.ts`) bound their input to the same maximum so
  a value the server will reject is caught in the form.

**As built (2026-10-02, #1469).** One mapper pair per entity in `apps/api/src/common/money.ts`:
`assetMoneyToWire` / `applicationMoneyToWire` convert a row's money columns to numbers, and
`assetMoneyToDb` / `applicationMoneyToDb` convert a validated body's amounts to `bigint`. Each converts only
the keys it names and only when they hold the type it expects, so a partial `select`, an absent key or a
`null` passes through unchanged.

- **Where it runs.** `AssetsService` and `ApplicationsService` are the only code that puts these columns
  on the wire. Every other module reads `assets` and `applications` through a narrow `select` that names
  no money column (the inventory CSV, assignments, infra, the import's existence checks), or through a
  whole-row read consumed only by the search projectors (`projectAsset` / `projectApplication`), which
  copy no money field. Each method of the two services that returns a row converts it before returning. The AI tools and MCP
  dispatch to the same controller handlers, so they receive the converted row too.
- **Why not a Prisma extension.** A `result` extension that overrides the three fields would convert at
  runtime, but `PrismaService` is typed as the base client, so the generated types would keep saying
  `bigint` while the value is a `number`: types and runtime would disagree on every read. It would also
  be as implicit as the `toJSON` patch this section rejects. The explicit mapper keeps the types true and
  stays visible at each call site.
- **The guard.** HTTP-level tests boot the real controller and service over a fake client that returns
  `bigint` exactly as Prisma does for a `BigInt` column: create, read, update, list, delete and restore of
  an asset and an application with an amount above the old `int4` ceiling, plus the AI dispatch path. A
  missed conversion makes `JSON.stringify` throw and the test fail.

### 4. Upgrade path

- One migration widens the three existing columns: `ALTER TABLE "assets" ALTER COLUMN "purchaseCost" TYPE
  BIGINT` (and `"salvageValue"`; and `"applications"."costPerSeat"`). **Non-destructive**: every `int4`
  value is a valid `bigint`, `NULL` stays `NULL`, and no row changes meaning. No backfill.
- The change is **not binary-compatible**, so PostgreSQL **rewrites each table** under an `ACCESS
  EXCLUSIVE` lock for the duration. At lazyit's scale (thousands of assets, hundreds of applications)
  that is seconds, during `prisma migrate deploy`, while the operator is already restarting the stack.
  No index covers these columns, and no view, function or trigger depends on them: the
  `recent_activity` view joins `assets` and `applications` on other columns only (checked against
  `pg_depend` on Postgres 18, #1469), so nothing has to be dropped and recreated around the change.
- Narrowing back to `int4` is not a supported downgrade once a value above the old ceiling is stored.
- The contract change is **widening only**: a client that sent values within `int4` still sends valid
  values; an older client reading a value above `int4` receives a correct JSON number.

### 5. Display (amended 2026-10-02)

Currency is a free-text label the user types, with no meaning to lazyit
([[0099-purchases-scope-model-and-optionality]] §5, CEO decision D-C: "Las monedas son texto libre del
usuario, no elige una moneda, no hacemos cotizaciones, guardamos valores nada mas. Depende como los
cargue el usuario"). So nothing about how an amount looks is derived from its currency:

- An amount is **displayed as entered**: the number with the viewer's locale grouping, and the currency
  label next to it exactly as typed (nothing when the label is blank). No symbol lookup, no per-currency
  decimal places.
- **Decimals appear only as the user entered them.** A whole amount is never padded: 1500 shows as
  "1.500" (es) / "1,500" (en), not "1.500,00". An amount with a fraction shows it at the stored scale:
  "1.500,50".
- Storage is §1's, unchanged: the amount is kept as integer hundredths.
- **Input follows the viewer's UI locale** (#1470): `1.234,56` or `1234,56` in es, `1,234.56` or
  `1234.56` in en — thousands grouping in threes, the locale's decimal separator, at most two
  decimals. Anything else is **refused inline, never guessed**: the other locale's separators, a minus
  sign, letters or currency signs, and a third decimal. **CTO decision, 2026-10-02 — provisional,
  pending CEO confirmation (#1470):** the third decimal is refused rather than rounded because it is
  almost always a mistyped grouping separator (`1,234` typed in es), and rounding it would store a
  thousandth of the intended amount without a word.
- The one accepted shape the two locales read differently — a single separator followed by exactly three
  digits (`1.150` in es, `1,150` in en) — is read as a thousands group, and the field **echoes the
  reading** under the input once it is left ("Read as 1150"). No other entry is echoed.
- This governs purchase amounts and the asset's purchase cost and salvage value, which carry the label.
- Totals are grouped by label (trimmed, case-insensitive) and never summed across labels.
- **CTO decision, 2026-10-02 — provisional, pending CEO confirmation (#1469):** the "as entered" rule
  applies to **every money amount in the app**, `Application.costPerSeat` included, so lazyit has one
  display rule for money. `costPerSeat` carries no currency label, so it shows the grouped number alone.

## Consequences

- **Positive:** one money convention again, now wide enough for large-nominal currencies (≈ 90 trillion
  major units per value). Totals stay derived, never stored. The wire shape of every client is unchanged.
- **Negative / trade-offs:**
  - An amount genuinely typed with three decimals (as some currencies use) is refused; the operator
    enters it at two. Accepted: lazyit stores values, it does not model currencies.
  - Every reader of a money column must convert explicitly; a forgotten one throws at serialization.
    Tests on each read path are the guard.
  - A table rewrite with a short exclusive lock on `assets` and `applications` at upgrade time.
  - The usable range stops at `Number.MAX_SAFE_INTEGER`, not at the column's 2^63−1 — deliberately.
- **Follow-ups (Phase 1, frontend lane):** *done in #1470* — `formatMoney` follows the §5 display rule
  and takes the optional label, for every money amount including `Application.costPerSeat` (§5 CTO
  decision); `parseMoneyInput` (replacing `majorToMinor`) reads amounts in the viewer's locale, bounded
  to `MONEY_MAX` (`Number.MAX_SAFE_INTEGER`, §3), on every money input (asset cost and salvage value, bulk
  receive, application cost per seat). Both live in `apps/web/lib/utils/money.ts`.
- **Follow-ups (Phase 1, backend lane):** ~~add `money()`; move the three columns and every money field of
  the shared schemas (asset, asset receive, application, the import descriptor, the AI tool inputs) to
  it; convert at the read boundary; cover each read and write path with a test above the old ceiling;
  update [[code-conventions]] when the code lands.~~ Done 2026-10-02 (#1469). ~~The Purchases money
  columns use `money()` and the same boundary when they are built.~~ Done 2026-10-02 (#1472):
  [[purchase-order-line]]`.unitPrice` is a Postgres `BIGINT`, converted by
  `purchaseOrderLineMoneyToWire` / `purchaseOrderLineMoneyToDb` in `apps/api/src/common/money.ts`; the
  purchase totals are derived in `bigint` and never stored, and a line whose quantity × price exceeds
  `MONEY_MAX` is refused on write.

## Related

[[0099-purchases-scope-model-and-optionality]] · [[0036-int4-bounded-integers]] ·
[[0088-application-license-seat-tracking]] · [[asset]] · [[application]] · [[purchase-order-line]] ·
[[shared-package]] · [[code-conventions]] · #954 · #1465 · #1466 · #1469
