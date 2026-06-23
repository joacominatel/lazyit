---
title: "ADR-0069 REDESIGN: Bulk import — directory people, assisted column mapping, specs passthrough, real models"
tags: [adr, migrator, import, asset, user, directory, backend, frontend, shared, design]
status: proposed
created: 2026-06-18
updated: 2026-06-18
deciders: [Joaquín Minatel]
amends: [ADR-0069 (§11/§12 deferrals), ADR-0038 (JIT linking)]
source: multi-agent design workflow (11 agents, 3 adversarial critique lenses)
---

# lazyit — Rediseño del Import Masivo · Documento de Diseño Maestro (FINAL)

> Estado: propuesta lista para implementación. Marco fijo = decisiones del CEO (§2, no se re-litigan). Mentalidad ponytail: el diff más corto que cumpla las decisiones, sin frameworks especulativos. Todas las referencias `file:line` están verificadas contra el repo (rama `dev`, tip `2cb3c73f`). Este documento incorpora las tres rondas de crítica (dominio, seguridad, simplicidad); donde una crítica estaba equivocada se lo dice explícitamente con justificación.

---

## 0. Adenda — decisiones del CEO sobre las preguntas abiertas (2026-06-18)

Tras presentar este diseño, el CEO cerró las decisiones abiertas (§10). **Estas reglas tienen prioridad sobre el cuerpo del documento donde difieran.**

1. **Clave natural de la persona (§10 #3) → Email o legajo.** Se crea/dedup por email; si falta, por legajo (Employee No.). Filas sin email NI legajo: el asset se importa **sin asignar**, con warning. Nunca por nombre. (El CSV real del CEO asigna por legajo — los emails vienen vacíos.)

2. **Visibilidad (§10 #2) → Mezcladas con los usuarios.** Una persona de directorio **es** un usuario de la app: aparece en `GET /users` y en los selectores junto a las cuentas con login, **con un badge "Directorio"**. **Pero el filtro `directoryOnly` debe existir igual** (poder listar/filtrar solo directorio). → Esto **CIERRA** el bloqueante de Etapa 2: NO se ocultan de reads ni selectores. Cambia el §3.6/§7/§10 #2: en vez de "ocultar", se agrega el flag al read DTO + un badge en la UI + un filtro opcional `directoryOnly` en `GET /users`.

3. **NUEVO requisito — botón "Crear cuenta OIDC" (promoción manual).** Además del auto-claim por login (ADR-0038), un ADMIN debe poder, desde la ficha de una persona de directorio sin cuenta, **crearle la cuenta en el IdP** (write-back a Zitadel) en el momento. Es la promoción explícita: toma la fila existente (`directoryOnly=true`, `externalId=null`), llama `idp.createUser` (zitadel-management.service), setea `externalId` + `directoryOnly=false`. Requiere email (Zitadel lo exige) → el botón se deshabilita / pide email si falta. ADMIN-only, reusa `users.service`. Endpoint nuevo `POST /users/:id/provision-account`. **Va en Etapa 2** (contraparte natural de crear personas sin cuenta).

4. **Entrega → Etapa 1 primero, Etapa 2 detrás** (confirmado).

**Defaults asumidos sin objeción** (reversibles): offboarding = mismo ciclo (libera assignments al soft-borrar); promoción OIDC por login = auto-claim heredando VIEWER; `directoryAttrs` jsonb (no columnas); import ADMIN-only; `managerId` solo si matchea un User vivo no-directory (si no, `managerName` free-text); columnas de dirección de ubicación ignoradas (Location enriquecida fuera de MVP).

---

## 1. Resumen ejecutivo

El sistema de import actual (ADR-0069 "Migrator", ya en `dev`) importa **solo Asset** con un wizard de 6 pasos y un motor de commit robusto (replay de plan congelado, memo de refs, keep-partial, resume idempotente), pero es **inservible para el CSV real del CEO** (export Snipe-IT, ~70 columnas) por tres causas verificadas: (a) `parser.ts:157-168` **rechaza headers duplicados** → el backend aborta y el front muestra el error genérico de parseo (la causa exacta del error que ve el CEO); (b) las ~64 columnas sin hogar nativo se **descartan en silencio** (no hay passthrough a `specs`); (c) **no hay personas, ni asignación, ni Model real** (el "Asignado a" se ignora; Model/Location se crean con defaults pobres). Esta entrega levanta **parcialmente** tres deferrals de ADR-0069 reusando mecanismos ya presentes: la persona de directorio se modela como **`User` en modo directory-only** (un flag + `jsonb`, **no** un modelo `Person` nuevo, para no bifurcar `AssetAssignment.userId` ni los ~20 actor-FKs); las columnas extra van a **`Asset.specs` (jsonb)** vía custom-fields con allow-list anti-mass-assignment; Model gana **fabricante + categoría reales**. **Se parte en DOS etapas mergeables** (Etapa 1: fix parser + samples + specs + model real — desbloquea el CSV hoy, bajo riesgo; Etapa 2: persona directory-only + AssetAssignment — el riesgo de seguridad, con sus propios tests) y **SEC-032 (bound global de specs) se saca de la ruta crítica** a un finding de seguridad propio.

---

## 2. Decisiones del CEO (locked — NO se re-litigan)

| # | Decisión |
|---|---|
| 1 | El **"Asignado a"** del CSV = **persona de directorio SIN login** (nombre, email, legajo/Employee No, cargo, departamento, supervisor). NO una cuenta Zitadel. El import la crea libremente. Si esa persona luego se loguea por OIDC, se **vincula** a una cuenta. La **asignación es el entregable**, no un extra. |
| 2 | Columnas extra sin hogar (RAM, Disco, IMEI, Pulgadas, Costo, EOL, URL…) → **passthrough a `Asset.specs`** (jsonb) como campo personalizado, **solo en filas con valor** (nunca specs vacío). Las que tienen hogar nativo se mapean (Comprado→`purchaseDate`, Vencimiento garantía→`warrantyEnd`). |
| 3 | Mapeo **ASISTIDO** (no el manual actual; **sin presets por origen**): listar las **COLUMNAS** del CSV, cada una con header + **1-4 valores de ejemplo**; por columna el usuario mapea a un campo nuestro o **crea un campo personalizado** al momento (→ specs). Para "Modelo": configurar marca (fabricante) + categoría. Igual para la persona (sub-campos). |
| 4 | Alcance MVP: (a) Personas + asignación; (b) specs passthrough + **arreglar parseo de headers duplicados**; (c) Model + Categoría + Fabricante reales. **Location enriquecida NO entra.** |
| 5 | Implementación: rama **local** basada en `dev`; agentes en **git worktrees** separados; commits locales file-by-file (prefijos `feat`/`fix`/`chore`/`del`/`updt`/`docs`, **sin atribución a Claude**); **merge local**; **NO se usa GitHub (`gh`)** todavía. |

---

## 3. Modelo de dominio: la entidad Persona

### 3.1 Recomendación final única: `User` en modo directory-only (NO modelo `Person`)

Una persona de directorio es **un `User` sin login** — no una entidad nueva. Razones verificadas:

1. **Costo de bifurcar.** `AssetAssignment.userId` es FK dura `@db.Uuid` a `User` con `Restrict` (schema.prisma:530-531). Un modelo `Person` obliga a un segundo FK `personId` nullable + CHECK XOR + duplicar el índice parcial único vivo `(assetId,userId) WHERE releasedAt IS NULL` + reconstruir el matcher de promoción OIDC. Es exactamente la bifurcación genérica multi-entidad que ponytail prohíbe cuando hay un solo `User` real detrás.
2. **El linking ya existe.** El claim-por-email-verificado de JIT (jwt-auth.guard.ts) reclama una fila viva con `externalId IS NULL` por email normalizado verificado e **hereda su role**. Es literalmente la promoción de una persona de directorio.
3. **El riesgo de seguridad se cierra con una cláusula.** Ver §3.5.

### 3.2 Forma de la entidad

Una fila **directory-only** = persona sin login:
- `directoryOnly = true`
- `externalId = null` (nunca aceptado del cliente — SEC-006 intacto)
- `role = VIEWER` **forzado** (el import nunca setea role → cierra role-escalation, deferral de ADR-0069 §12)
- `isActive = true`
- email/legajo → columnas nativas (ya tienen índice parcial único **vivo**, schema.prisma:23-26/43)
- supervisor → `managerName` (free-text, ya existe) por defecto; `managerId` solo si matchea un User vivo **NO directory-only** (ver §3.6)
- cargo/departamento/teléfono → **`directoryAttrs Json?`** (solo en directory-persons)

**`directoryAttrs jsonb` vs 3 columnas reales** (ponytail, **crítica de simplicidad lo confirma**): cargo/departamento/teléfono son nulos en el ~99% de Users con login y **no existen como columnas hoy** (verificado schema.prisma:19-93); meterlos como columnas infla la tabla para todos. **Techo**: sin validación per-campo ni filtro/orden por departamento en SQL. **Upgrade path**: promover a columnas `jobTitle`/`department`/`phone` si un reader necesita queriarlas en SQL.

### 3.3 Cambios de schema Prisma

`model User` (schema.prisma:19-93) gana dos campos. Ningún modelo `Person`, ningún cambio a `AssetAssignment.userId` ni a los ~20 actor-FKs, ningún índice nuevo. `ImportEntity` permanece `{ ASSET }` (persona/model/categoría son **derivadas** de la fila de asset, no targets de import).

```prisma
  // Directory-only person (ADR-0069 amendment / ADR-0038 amendment): a row created by the bulk import
  // for an asset's "assigned to" that has NO login and NO Zitadel mirror (externalId stays null, role
  // stays VIEWER). It IS a User so AssetAssignment.userId (uuid FK) points at it with zero schema churn.
  // EXCLUDED from the bootstrap first-user→ADMIN count (jwt-auth.guard.ts:365) so importing people can
  // never hand ADMIN to a non-login row. Flips to false when the person first signs in via OIDC and the
  // verified-email claim links this row (ADR-0038). HARD RULE: a directoryOnly row is NEVER the subject
  // of an AccessGrant / external provisioning (access-grants.assertUserUsable rejects it) — see INVARIANTS.
  // ponytail: User and a directory person share one table on purpose — a directory person is a User
  // without a login, not a new entity. Ceiling: no per-attribute validation on directoryAttrs, no SQL
  // filter/sort by department. Upgrade path: promote directoryAttrs keys to real columns if a reader needs
  // to query them; fork a Person model only if directory semantics ever truly diverge.
  directoryOnly  Boolean @default(false)
  // Free-form directory attributes for a directory-only person (cargo/jobTitle, departamento, teléfono,
  // and any person sub-field with no native home). Same posture as Asset.specs (ADR-0007): jsonb,
  // optional, only populated on directory rows. NOT validated per-field in this MVP.
  directoryAttrs Json?
```

**Migración** (`apps/api/prisma/migrations/<ts>_user_directory_only/migration.sql`):

```sql
ALTER TABLE "users"
  ADD COLUMN "directoryOnly" boolean NOT NULL DEFAULT false,
  ADD COLUMN "directoryAttrs" jsonb;
```

### 3.4 Cómo apunta AssetAssignment

**Sin cambios de schema.** `AssetAssignment.userId` (uuid FK Restrict) apunta a la fila directory-only como a cualquier User. El commit abre la asignación vía `AssetAssignmentsService.create({ assetId, userId: personId }, principal)`, que emite `ASSIGNED` transaccionalmente. **Idempotencia: ver §4.6** (crítica crítica de dominio — el pre-check 409 corrige la especificación original).

### 3.5 Promoción a User vía OIDC (ADR-0038 amendment)

Cuando la persona se loguea por OIDC con el **mismo email verificado**, el claim-por-email de jwt-auth.guard.ts reclama la fila viva `externalId IS NULL`, setea `externalId = sub` **y `directoryOnly = false`** (un campo extra en el `updateMany` existente), y la persona hereda su role actual (VIEWER → comportamiento ADR-0038, default auto-claim). El match por **email verificado** sigue siendo la **única** clave de linking (INV-2). Personas **sin email** nunca se auto-promocionan → quedan directory-only hasta merge manual (documentado en el Manual).

### 3.6 El riesgo de bootstrap-ADMIN y por qué basta UNA cláusula (para seguridad)

`jwt-auth.guard.ts:365` cuenta `user.count({ includeSoftDeleted: true })` **sin filtro de role** (verificado). En un install fresco, una persona importada quedaría contada → el primer login OIDC real caería a VIEWER → instancia sin admin. **Fix: el conteo de bootstrap pasa a excluir directory-persons** (`where: { directoryOnly: false }`, manteniendo `includeSoftDeleted: true`). Una persona de directorio nunca tiene role administrativo (VIEWER forzado) ni login → excluirla es correcto y barato.

**Los otros `user.count` están naturalmente cubiertos** (verificado, **la crítica de dominio acierta en el matiz**): `config.service.ts:85` y `:121` filtran `role: ADMIN`; `users.service.ts:869` (last-admin) filtra `role: ADMIN`. Una directory-person VIEWER queda excluida sin tocar nada. **La excepción es `users.service.ts:163`** (count de paginación de `GET /users`, sin filtro) → **eso es coherencia de reads, no seguridad** y se resuelve con la decisión de visibilidad (§7 control "Visibilidad", §10 #2). La afirmación "una sola cláusula cierra el único riesgo" es válida **solo para el bootstrap**; se la corrige aquí.

---

## 4. Motor de import (backend)

Seis sub-tareas. Las cuatro primeras (Etapa 1) desbloquean el CSV del CEO sin tocar User/auth; las dos últimas (Etapa 2, §4.5/§4.6) traen el riesgo de seguridad y mergean **detrás** de la Etapa 1, con sus propios tests Jest.

### 4.1 Fix de headers duplicados (`parser.ts:157-168`) — el bug del CEO

Reemplazar el **rechazo** por **de-dup determinístico con unicidad real garantizada**. **Crítica de seguridad acierta (medium)**: el sufijo ingenuo "renombrar el 2.º+" reintroduce data-loss si el CSV ya trae literalmente `Dirección (2)` (el de Snipe-IT tiene `Dirección` ×4 y `Notas` ×2). El de-dup debe verificar contra el **set completo** de headers ya vistos/generados:

```ts
// De-dup duplicate headers DETERMINISTICALLY so each column is addressable by a unique key.
// Suffix " (2)", " (3)", … but skip any candidate that ALREADY exists (a literal "X (2)" in the
// source, or a previously-generated one) so two distinct columns never collapse to one key — that
// would be the silent data-loss the old hard-reject (parser.ts:157) guarded against. Suffixes are
// SERVER-generated (no injection); cell values are preserved verbatim. detected.headers reflects the
// renamed set; rows[].raw is keyed by the SAME renamed headers end-to-end (samples, UI Selects,
// buildMapping all use the renamed header — a mismatch = an unmappable column).
const seen = new Set<string>();
const deduped = headers.map((h) => {
  let candidate = h, n = 1;
  while (seen.has(candidate)) candidate = `${h} (${++n})`;
  seen.add(candidate);
  return candidate;
});
```

El mojibake del export (Dirección con encoding roto) sobrevive intacto — el usuario decide a qué mapear cada columna. Mantener el cap de cantidad de columnas. **Punto end-to-end (crítica de simplicidad, missing)**: `detected.headers`, las keys de `rows[].raw`, los `samples`, el value-map de status y `buildMapping` comparten **exactamente** la forma renombrada.

### 4.2 Sample values (`run-parse-job.ts`)

Al materializar filas (ya en memoria), recolectar hasta **4 valores distintos no vacíos** por columna (vía `coerceAbsent`) en `detected.samples: Record<header, string[]>`. **Techo**: los samples salen solo de las filas materializadas (no exhaustivos en archivos enormes; misma limitación que el value-map de status). **Retención/PII (crítica de seguridad, medium — aceptada con acotación)**: los samples son los **mismos** datos que `rows[].raw`; deben vivir **dentro del mismo `ImportSession.detected`** (mismo owner-scope + mismo GC sweeper, NO un store con TTL distinto) y **nunca** entrar en logs ni en el `ImportRun` ledger (que se mantiene PII-free, import-commit.service.ts:670). El Manual documenta que la pantalla de mapeo muestra datos reales del archivo (incl. PII de empleados). Sin enmascarar en MVP (ponytail).

### 4.3 Descriptor + coerción: campos nativos, specs passthrough, sub-payloads

- **Fechas nativas**: agregar `purchaseDate` y `warrantyEnd` a `assetImportDescriptor.mappableFields` (ya son `DATE_FIELDS` coercibles) → Comprado→`purchaseDate`, Vencimiento garantía→`warrantyEnd` son mapeos nativos, no specs.
- **Custom → specs**: `coerceRow` recorre `mapping.custom` y escribe `payload.specs[key]` **solo** si el valor está presente; **nunca** emite `specs` vacío. `CreateAssetSchema.specs` ya es `record(string, unknown).optional()` → cero cambio de DB. **Defense-in-depth (crítica de seguridad, high)**: el objeto specs se construye con `Object.create(null)` (o se saltean keys `__proto__`/`constructor`/`prototype`) **en el loop de escritura del backend**, no solo en el superRefine de shared — para sobrevivir a un mapping malicioso/corrupto ya persistido.
- **Persona (sub-payload)**: `coerceRow` emite un bucket `person?` con sub-campos coercionados (celdas vacías omitidas), construido **solo si hay clave de identidad presente** (email **o** legajo — §10 #3). El commit revalida `person` contra `CreateDirectoryPersonSchema` (strict).
- **No tocar el tipo `MappableField<keyof TCreate>` (crítica de simplicidad, low — aceptada)**: los campos de Persona/Modelo **NO** entran en `assetImportDescriptor.mappableFields` (romperían el invariante schema↔descriptor, descriptor.ts:43). Se exponen en estructuras separadas (§5.5).

### 4.4 Resolución de refs: Model + Fabricante + Categoría reales (`createReference`)

**Camino corto elegido (crítica de simplicidad, high — aceptada)**: marca + categoría se fijan a nivel **mapping/columna** (no por cada `ConflictResolution`, **no** se toca `conflicts-step.tsx` ni la tupla de conflicto). El operador mapea las columnas "Fabricante"/"Categoría" en el paso de mapeo (§6); se serializan en `ImportMapping` (sección de model-config) y `createReference` las lee del plan congelado.

En `createReference` (import-commit.service.ts:643-654), para un `AssetModel` con outcome `create`:
1. Si hay categoría configurada → **find-or-create `AssetCategory` por name** (mismo patrón idempotente find-first que Model/Location, cierra el window cross-run) → obtener `categoryId`. **Crítica de dominio acierta (medium)**: `CreateAssetModelSchema` toma `categoryId: z.cuid()` (verificado asset-model.ts:38), **no** un name → la resolución name→id es obligatoria.
2. `models.create({ name, manufacturer: <del plan o 'Unknown' fallback>, categoryId })`.

Conservar `IMPORT_MODEL_DEFAULT_MANUFACTURER='Unknown'` solo como último recurso cuando una fila no aporta fabricante. **ponytail**: dos campos planos (`manufacturer`/`categoryName`) en la model-config del mapping, no un sub-descriptor genérico multi-nivel.

**Borde aceptado**: un Model/Categoría *ghost* (soft-deleted) con el mismo name no lo ve el find-first → se crea uno nuevo vivo (mismo patrón ya aceptado para Location/Model en ADR-0069).

### 4.5 Commit multi-entidad: crear/resolver la persona

`commitRow` (import-commit.service.ts:450-535) hoy está acotado a un solo entity (asset). **Orden de commit por fila FIJADO (crítica de dominio acierta, low — contradicción resuelta): asset PRIMERO, luego persona, luego assignment.** Razón: `CreateAssetSchema.safeParse` (línea 502) puede fallar y abortar la fila **barato**, sin crear nada — una fila con asset inválido **no** deja persona huérfana. (La crítica de seguridad sugería persona-first por el dedup; se rechaza ese orden: el asset-first evita el huérfano y el dedup de persona funciona igual en cualquier orden.)

Tras `assets.create()` exitoso y si la fila tiene `person` resuelta:
1. **Resolver/crear la persona**, dedup por email/legajo **vivo** (`findFirst` filtrado por soft-delete, **NO `includeSoftDeleted`** — **crítica de seguridad acierta, critical**: una persona soft-deleted NO se debe resucitar ni linkear, mismo razonamiento que el linking-por-email de jwt-auth.guard.ts). Si no existe, crear vía `users.service.create(person, actorId, { skipIdpWriteBack: true, createdPayload: { source:'import', sessionId, rowIndex } })` con `directoryOnly: true`, **sin role**, **sin password**.
   - **`skipIdpWriteBack` es una rama server-side NUEVA, no una reutilización del path BYOI** (**crítica de simplicidad acierta, medium — redacción original corregida**). Verificado users.service.ts:513-529: con `supportsManagement=true` el flujo entra al `try`, llama `idp.createUser` y **retorna temprano** (528-529) — nunca cae al BYOI (543-549). El opt **debe ramificar ANTES del bloque IdP (486-539)** e ir directo a `recordHistory(this.prisma, …)` + `search.upsert` + `return`. La firma pública del controller no cambia (`skipIdpWriteBack` jamás del cliente). El opt actual es `{ createdPayload? }` (verificado :457) → se extiende a `{ createdPayload?; skipIdpWriteBack? }`.
   - **Provenance de la persona (crítica de dominio/seguridad, missing — aceptada, gratis)**: pasar `createdPayload: { source:'import', sessionId, rowIndex }` (ya soportado) → el `UserHistory` CREATED queda correlacionado con la sesión que la creó (auditabilidad/reversibilidad).

### 4.6 Commit multi-entidad: AssetAssignment idempotente + resume probe

2. **Abrir la AssetAssignment** vía `AssetAssignmentsService.create({ assetId, userId: personId }, principal)`.
   - **Idempotencia CORREGIDA (crítica de dominio, critical — la spec original estaba MAL)**: el diseño anterior decía "tratar P2002 del índice parcial como no-op". **Verificado: ese P2002 NUNCA se dispara** — `AssetAssignmentsService.create` hace un **pre-check explícito** `findFirst({assetId,userId,releasedAt:null})` y lanza `ConflictException` (409) **antes** del insert (asset-assignments.service.ts:84-91). Ese 409 caería al catch de `commitRow` y marcaría la fila **FAILED** → un re-import marcaría toda fila buena como fallida. **Fix**: en `commitRow`, envolver la llamada y tratar `ConflictException` (no P2002) como **no-op idempotente** (la assignment activa ya existe → fila COMMITTED, no FAILED). Comentario ponytail citando asset-assignments.service.ts:84-91.
   - **`assertUserUsable` (asset-assignments.service.ts:252) NO chequea `directoryOnly`** → permite asignar a una directory-person recién creada (correcto: ese es el caso de uso). **No se toca** ese guard.

3. **Resume probe extendido (crítica de dominio, critical — el hueco silencioso viola CEO #1)**: hoy `assetExistsForRow` (import-commit.service.ts:689-705) solo conoce el **CREATED del asset** por provenance. Si el proceso crashea entre `assets.create` y la assignment, el resume marca la fila COMMITTED y la **assignment nunca se crea, en silencio** — inaceptable bajo CEO #1 (la asignación es el entregable). **Fix (~5 líneas, sin transacción compartida)**: cuando el resume detecta que el asset existe **y la fila tenía persona**, en vez de marcar COMMITTED a ciegas, verificar también la **assignment activa** (`findFirst({ assetId, userId, releasedAt:null })`); si falta, **completar la assignment** (reusando el mismo path idempotente) y recién entonces marcar COMMITTED. Marcar techo ponytail.

**ponytail sobre atomicidad**: NO meter la assignment en la `$transaction` del asset (exigiría refactorizar `assets.create`, que abre/cierra su propia tx). La assignment se crea en una segunda llamada; el resume-probe extendido (arriba) cierra la ventana de crash. **Techo**: atomicidad fila-completa total. **Upgrade path**: tx compartida si el CEO no tolera la ventana entre los dos probes.

**Provenance de la assignment**: el evento `ASSIGNED` cuelga del asset que **sí** tiene provenance import → correlación **indirecta** suficiente para MVP. **NO** se agrega un campo de provenance a `AssetAssignment` (YAGNI / ponytail — **crítica lo confirma**).

---

## 5. Contratos shared (zod)

Todos los cambios son **aditivos**. **Ningún `Create*Schema` de Asset se modifica** (CreateAssetSchema sigue `strictObject` = garantía anti-mass-assignment). El commit revalida cada payload contra su `Create*Schema` sin aflojarlo.

### 5.1 `mapping.ts` — mapping jerárquico + custom fields + allow-list de seguridad

```ts
// Custom field → Asset.specs binding. The user names the key; the value is the cell.
export const CustomFieldMappingSchema = z.object({
  column: z.string().min(1),
  key: z.string().trim().min(1).max(100),
});

// Person sub-mapping: directory-person sub-fields the operator binds columns to.
export const PersonSubMappingSchema = z.object({
  fields: z.array(ColumnFieldMappingSchema).default([]),
});

// Model config: brand + category for newly-created AssetModels (CEO #3 "model configuration").
// Bound at the MAPPING level (session/column), NOT per ConflictResolution — read by createReference.
export const ModelConfigSchema = z.object({
  manufacturerColumn: z.string().optional(),  // column → manufacturer of created model
  manufacturerConst: z.string().trim().min(1).optional(),
  categoryColumn: z.string().optional(),       // column → category name (find-or-create)
  categoryConst: z.string().trim().min(1).optional(),
}).optional();

export const ImportMappingSchema = z.object({
  columns: z.array(ColumnFieldMappingSchema),
  enums: z.array(EnumFieldMappingSchema).default([]),
  references: z.array(FkFieldMappingSchema).default([]),
  custom: z.array(CustomFieldMappingSchema).default([]),   // → Asset.specs
  person: PersonSubMappingSchema.optional(),               // → directory person
  modelConfig: ModelConfigSchema,                          // → created AssetModel brand+category
}).superRefine((m, ctx) => {
  // Anti mass-assignment + anti prototype-pollution: a custom.key must NOT collide with any native
  // Asset mappable field (name/serial/assetTag/status/modelId/locationId/specs/id/deletedAt/...) nor
  // with __proto__/constructor/prototype. Custom keys go EXCLUSIVELY to specs, never the top level
  // (ADR-0069 §11). Also reject duplicate custom.key. (Defense-in-depth: the backend specs writer ALSO
  // guards these keys — §4.3 — so a persisted/corrupt mapping can't bypass this refine.)
});
```

> **Cap local de specs (crítica de simplicidad, medium — aceptada)**: en lugar de acoplar el bound global de `AssetSpecsSchema` (SEC-032) a este MVP, el superRefine **capa el nº de `custom` por sesión** (≤64) y la blacklist de keys. El hardening estructural global de specs se **saca a un finding propio** (ver §7/§11).

### 5.2 `resolution.ts`

**Sin cambios** (corrección vs. diseño original): la marca/categoría de un Model creado **no** viajan por `ConflictResolution` sino por `ImportMapping.modelConfig` (§4.4/§5.1). Esto evita tocar `conflicts-step.tsx` y la tupla de conflicto (crítica de simplicidad, high).

### 5.3 `wire.ts` — sample values

`ImportSessionViewSchema`/`ImportDetectedShapeSchema` gana:
```ts
  samples: z.record(z.string(), z.array(z.string())).default({}), // header → 1-4 distinct non-empty examples
```

### 5.4 `coerce-row.ts` — `CoercedRow` extendido

```ts
export interface CoercedRow {
  payload: Record<string, unknown>;
  references: Record<string, string>;
  enumMisses: { field: string; value: string }[];
  specs?: Record<string, unknown>;   // custom fields, omit-empty, NEVER {}; built with null-proto
  person?: Record<string, unknown>;  // directory-person sub-payload, omit-empty, only if identity present
}
```

`coerceRow` agrega: (a) custom→specs (omit-empty + omit-empty-record + null-proto/guard de keys reservadas); (b) `person` (omit-empty, solo si email **o** legajo presente). **Tests `bun test`** (`coerce-row.test.ts`): custom con valor→`specs[key]`; custom vacío→sin specs; `specs:{}` nunca emitido; person omit-empty; person sin clave de identidad→`undefined`; key `__proto__`/nativa→rechazada/saltada.

### 5.5 `descriptor.ts` + catálogo de targets de UI (NO inflar el descriptor de asset)

- `assetImportDescriptor.mappableFields` += `purchaseDate`, `warrantyEnd` (son keys reales de `CreateAsset` → respetan el invariante de tipo).
- **Grupos de UI Asset/Modelo/Persona (crítica de simplicidad, low — aceptada)**: un **catálogo de targets de UI separado** (no se toca `MappableField<keyof TCreate>`):
  ```ts
  export const IMPORT_UI_TARGETS = {
    asset:  assetImportDescriptor.mappableFields,                  // from the typed descriptor
    model:  [{ field: 'manufacturer', i18nKey: '…' }, { field: 'category', i18nKey: '…' }],
    person: [{ field: 'name' }, { field: 'email' }, { field: 'legajo' },
             { field: 'jobTitle' }, { field: 'department' }, { field: 'supervisor' }],
  } as const;
  ```
  La UI lee este catálogo para los `SelectGroup`. El descriptor de asset **no** se contamina.
- Nuevo `CreateDirectoryPersonSchema` (en `user.ts`): `strictObject`, mismo patrón SEC-006 → **nunca** acepta `role` ni `externalId`; email vía `EmailSchema`; identidad mínima = email **o** legajo (superRefine).
- `UserSchema` (read) gana `directoryOnly: z.boolean()` y `directoryAttrs` opcional. **NO** se tocan `CreateUserSchema`/`UpdateUserSchema` del path HTTP normal.

---

## 6. Frontend / UX

### 6.1 Decisión de alcance: inversión column-centric vs. inversión mínima (§10 #9)

La crítica de simplicidad (low) propone una **inversión mínima** (mantener field-centric + lista de columnas sin mapear + crear-custom + samples) en vez del rewrite total. **La decisión CEO #3 pide explícitamente "listar las COLUMNAS … por columna el usuario elige"** → la **inversión column-centric es requisito MVP**, no mejora opcional. Se mantiene el rewrite, pero el documento lo marca como la pieza de mayor superficie y la pone **al final de la cadena de dependencias** (§9).

### 6.2 El paso de mapeo invertido (field-centric → column-centric)

`mapping-step.tsx` se reescribe: **una tarjeta por columna del CSV** (no por nuestro campo).

- **`<details>` nativo por `session.headers`** (a11y gratis: teclado, `aria-expanded`, sin dep nueva). `<summary>`: nombre de columna + badge (campo destino / "campo personalizado" / "ignorado") + 1.º valor de ejemplo inline. Al expandir: hasta 4 valores de `session.samples[header]` (backend, §4.2) o derivados localmente de `rows[].raw[header]`.
- **Un `Select` por columna, agrupado por entidad** (`SelectGroup`/`SelectLabel`, Radix ya importado): `Ignorar` (default para columnas vacías/irrelevantes) → grupos **Asset / Modelo / Persona** (de `IMPORT_UI_TARGETS`) → ítem **"Crear campo personalizado…"** (revela un `Input` para el nombre → specs).
- **Status**: las sub-filas value→enum se mueven **dentro** de la tarjeta de la columna mapeada a status.
- **Model-config + Persona = más filas en la lista plana** (ponytail), no formularios anidados: mapear "Fabricante"→Modelo·manufacturer, "Categoría"→Modelo·category; igual los sub-campos de persona. (Fallback por **constante** — "todos los modelos son marca X" — vía `ModelConfigSchema.*Const`, §5.1.)
- **Seed**: invertir el auto-suggest fuzzy a per-columna (mejor campo para cada columna) → el operador **confirma** sugerencias, nunca un drop silencioso.
- **Estado mínimo**: `Record<header, { target: string; customName: string }>` con `target` ∈ `__ignore__` | `__custom__` | token `entity:field`; más el `statusMap`. `buildMapping()` rutea tokens a `columns`/`references`/`enums`/`custom`/`person`/`modelConfig`. **Todos los headers son la forma renombrada** (§4.1).
- **Validación**: requerido = `name` + `status` mapeados a alguna columna; identidad de persona requerida **solo si** alguna columna de persona está mapeada ("empezaste a mapear una persona, dale email o legajo"). Disable Continue + `role=alert`.

Props/`onMapped`/`onBack` y el flujo `setMapping→dryRun` **sin cambios**.

> **Dependencia dura**: la UI agrupada NO se construye hasta que SHARED exponga `IMPORT_UI_TARGETS` + `samples` en wire, y BACKEND pueble `samples`. El lane SHARED/BACKEND aterriza antes que esta reescritura.

### 6.3 i18n

`messages/{en,es}/imports.json` (paridad 1:1): `mapping.*` (`columnLabel`, `sampleValues`, `showSamples`/`hideSamples`/`noSamples`, `targetIgnore`, `targetCustom`, `customNameLabel`/`customNamePlaceholder`, `group.asset`/`group.model`/`group.person`, `statusInColumnNote`, `personIdentityRequired`, `modelConfig.*`); expandir `mapping.field.*` con labels Modelo/Persona/fecha; revisar `mapping.title`/`description` al framing column-centric.

### 6.4 Manual (`/help`, regla CLAUDE.md #7, ADR-0062)

`content/manual/{en,es}/assets-bulk-import.md`: reescribir "3. Map your columns" (el importador lista cada columna con valores de ejemplo; por cada una elegís un campo de lazyit, creás un campo personalizado guardado en `specs`, o la ignorás; documentar agrupación Asset/Modelo/Persona, config de modelo marca+categoría, campos de persona, columnas vacías default a ignorar). Documentar el flujo de **persona de directorio**: se crea sin login; se **vincula** a una cuenta si esa persona se loguea por OIDC con el **mismo email verificado**; **advertir** que personas **sin email** nunca se auto-promocionan. **Advertir** que la pantalla de mapeo muestra **datos reales del archivo (incl. PII)**. Actualizar el "flow at a glance".

---

## 7. Seguridad & RBAC — controles mínimos finales

| Control | Mecanismo (reusa lo existente) |
|---|---|
| **Mass-assignment cerrado** | `CreateAssetSchema` sigue `strictObject`. Custom keys van **exclusivamente** a `payload.specs`. El superRefine de `mapping.ts` rechaza colisión con campo nativo / `__proto__`/`constructor`/`prototype` / dup keys (§5.1). El código de import **nunca** hace `{...row}`/`Object.assign` al nivel del Create-schema. |
| **Prototype-pollution (defense-in-depth)** | **NUEVO (crítica seguridad, high)**: además del refine de shared (1.ª capa, UX), el **backend construye `specs` con `Object.create(null)`** y/o saltea keys reservadas **en el loop de escritura** (coerce-row.ts/commit) → sobrevive a un mapping malicioso/corrupto persistido. 1 línea, sin librería. |
| **Bootstrap ADMIN protegido** | `jwt-auth.guard.ts:365` → `where: { directoryOnly: false }` (manteniendo `includeSoftDeleted: true`). Un import de 200 filas no puede regalar ADMIN. Los otros counts ya filtran `role: ADMIN` (§3.6). |
| **Role-escalation cerrado** | El import **fuerza `role=VIEWER`** y nunca acepta role del payload (`CreateDirectoryPersonSchema` strict, sin `role`). `externalId` jamás del cliente (SEC-006). |
| **Directory-person NUNCA sujeto de AccessGrant / provisioning** | **NUEVO (crítica seguridad, critical)**: `AccessGrantsService.assertUserUsable` (access-grants.service.ts:512-522, hoy liveness-only) gana 1 cláusula: `select { directoryOnly }` + `if (user.directoryOnly) → 400` ("una persona de directorio no tiene cuenta; no se le puede otorgar acceso hasta que se loguee"). AssetAssignment **sí** permite directory-only (caso de uso). Invariante en INVARIANTS.md. Sin esto, el ahorro de "es un User" abre acceso huérfano irrevocable. |
| **AND-check de commit — persona/assignment explícitos, fail-closed** | **NUEVO (crítica seguridad, high)**: `assertActorCanCommit` (import-commit.service.ts:182-214) suma al required-set: si el plan implica crear personas/assignments, exigir explícitamente los verbos del catálogo (reutilizando `hasAll` con lo que un ADMIN ya tiene; **sin enum nuevo** si el catálogo no lo tiene). Hoy `import:run` es ADMIN-only y un ADMIN tiene todo, pero el check de profundidad **se agrega AHORA** para que abrir el import a MEMBER (futuro, §10 #8) no deje crear Users/assignments sin gate. Category resuelta vía model → `assetModel:write` (ADMIN-only lo cubre en MVP; ver §11). |
| **Dedup de persona seguro** | **CORREGIDO (crítica seguridad, critical)**: dedup por email/legajo **vivo** (NO `includeSoftDeleted` — no resucitar/linkear personas borradas). Filas **sin email NI legajo** NO crean persona (asset se importa sin assignment + warning). **Nunca** deduplicar por nombre (match inseguro → fuga de inventario a la persona equivocada). §10 #3 cierra el contrato con el CEO. |
| **De-dup de headers sin data-loss** | While-until-unique contra el set completo (§4.1) → no colapsa dos columnas en una key. Sufijos del servidor; celdas verbatim. |
| **PII en samples acotada** | Samples viven en el mismo `ImportSession.detected` (mismo owner-scope + GC + retención que `rows`); nunca en logs ni en el `ImportRun` ledger; Manual lo advierte (§4.2). |
| **SEC-032 (bound global de specs) — DESACOPLADO** | **CORREGIDO (crítica simplicidad+seguridad)**: el hardening estructural de `AssetSpecsSchema` (depth/keys/escalares) **sale de la ruta crítica del import** a un finding propio (`lazyit-remediator`), porque toca el schema de Asset **globalmente** y arrastra una decisión abierta (no romper specs ya en DB). **Además** ese finding debe incluir un **depth-guard propio en `jsonDeepEqual`** (apps/api/src/common/deep-equal.ts, recursivo sin límite, corre en CADA update con SPECS_CHANGED): el bound de **entrada** no protege un comparador que recorre datos **ya persistidos**. Para el MVP del import basta el cap local de §5.1. |
| **DoS multi-entidad** | Cap de filas (50.000) + `MAX_IMPORT_SIZE_MB` (5) + commit chunked (1000) + concurrency 1 + cap de ≤64 custom keys/fila ya acotan el peor caso. Sin cap nuevo de entidades. |

---

## 8. ADRs a escribir / enmendar

**Enmiendas (no ADRs nuevos — ponytail):**

1. **ADR-0069 (Migrator)** — levanta parcialmente §11/§12: specs passthrough (allow-list controlada por el usuario; mapeo per-category sigue esperando ADR-0007); Model+Categoría+Fabricante reales; **persona de directorio + AssetAssignment** (acotado a directory-only: sin write-back Zitadel, role VIEWER forzado, externalId/password rechazados). Documentar: custom keys **SOLO** a `specs`; el dedup de persona es **vivo**; el **ciclo de vida de offboarding** aplica a directory-persons (§10 #1).
2. **ADR-0038 (JIT provisioning)** — amendment: el linking-por-email-verificado **promueve** una persona de directorio (`directoryOnly → false` al claimar). Email verificado sigue siendo la única clave (INV-2).
3. **`docs/02-domain/entities/user.md`** — campos `directoryOnly`/`directoryAttrs` + modo directorio + reglas de capability.
4. **`docs/06-security/INVARIANTS.md`** — dos invariantes: (a) `directoryOnly=true` ⇒ nunca login ni role administrativo ⇒ fuera del bootstrap count y del last-admin; (b) `directoryOnly=true` ⇒ **nunca sujeto de AccessGrant / provisioning IdP** (enumerado contra todos los FKs a User que implican capability).
5. **`docs/06-security/issues/SEC-NNN` (nuevo)** — el bound de `AssetSpecsSchema` + depth-guard de `jsonDeepEqual`, **desacoplado** de esta entrega (lo abre `lazyit-sentinel`, lo cierra `lazyit-remediator`).

**Ningún ADR nuevo** salvo que el CEO rechace directory-only y elija un modelo `Person` separado (desaconsejado por el costo de bifurcar `AssetAssignment.userId` + ~20 FKs).

---

## 9. Plan de implementación — LANES en git worktrees, en DOS etapas

**Setup (CEO #5)**: rama **local** `feat/import-directory-people` basada en `dev`; cada lane en su **worktree**; commits **file-by-file** (prefijos, **sin atribución a Claude**); **merge local**; **NO `gh`**.

### Estrategia de etapas (crítica de simplicidad, high — aceptada)

```
ETAPA 1 (bajo riesgo, NO toca User/auth — desbloquea el CSV del CEO HOY):
  parser fix + samples + custom→specs + model/categoría/fabricante reales
ETAPA 2 (riesgo de seguridad, tests propios — mergea DETRÁS de Etapa 1):
  persona directory-only + AssetAssignment idempotente + skipIdpWriteBack + filtro bootstrap +
  guard de access-grants + AND-check explícito
```
**Las dos etapas NO se mezclan en un merge local.** Etapa 1 entrega valor de inmediato; Etapa 2 lleva el ciclo de tests del riesgo.

### Cadena de dependencias entre lanes

```
LANE SHARED ─┬─→ LANE BACKEND ─→ LANE FRONTEND
             └─→ (IMPORT_UI_TARGETS + samples wire desbloquean la UI agrupada)
LANE DOCS corre en paralelo; merge final cuando el comportamiento esté fijo
```
SHARED primero (zod + catálogo UI). BACKEND depende de SHARED. FRONTEND depende de SHARED (catálogo+wire) y BACKEND (samples poblados + persona en commit). DOCS en paralelo, merge final.

---

### LANE 1 — SHARED (`packages/shared`) · sin dependencias

| # | Archivo | Tarea | Etapa |
|---|---|---|---|
| 1.1 | `src/schemas/import/mapping.ts` | `CustomFieldMappingSchema`, `PersonSubMappingSchema`, `ModelConfigSchema`; `ImportMappingSchema` += `custom`/`person`/`modelConfig`; superRefine anti-mass-assignment (key reservada/nativa/prototype + dup + cap ≤64 custom). | 1+2 |
| 1.2 | `src/schemas/import/coerce-row.ts` | `CoercedRow` += `specs?`/`person?`; `coerceRow` rutea custom→specs (omit-empty, **null-proto**) y person→sub-payload (omit-empty, solo con identidad). | 1+2 |
| 1.3 | `src/schemas/import/coerce-row.test.ts` | `bun test`: custom→specs, vacío→sin specs, `{}` nunca, person omit-empty/sin-identidad, key reservada saltada. | 1+2 |
| 1.4 | `src/schemas/import/wire.ts` | `ImportSessionViewSchema`/`ImportDetectedShapeSchema` += `samples`. | 1 |
| 1.5 | `src/schemas/import/descriptor.ts` | `mappableFields` += `purchaseDate`/`warrantyEnd`; **`IMPORT_UI_TARGETS`** (asset/model/person) SIN tocar `MappableField<keyof TCreate>`. | 1+2 |
| 1.6 | `src/schemas/user.ts` | `UserSchema` (read) += `directoryOnly`/`directoryAttrs`; `CreateDirectoryPersonSchema` (strict, sin role/externalId, identidad=email∨legajo). **NO** tocar Create/UpdateUserSchema. | 2 |

> **Riesgo cruzado (memoria shared-changes-need-web-typecheck)**: tocar `user.ts` puede romper maps exhaustivos del web → correr `tsc` del web + CI real antes de mergear el lane.

### LANE 2 — BACKEND (`apps/api`) · depende de LANE 1

| # | Archivo | Tarea | Etapa |
|---|---|---|---|
| 2.1 | `src/import/parser.ts` | De-dup determinístico **while-until-unique** (155-168); renombrado reflejado en detected; cap de columnas. | 1 |
| 2.2 | `src/import/run-parse-job.ts` | Recolectar ≤4 valores no vacíos por columna en `detected.samples`. | 1 |
| 2.3 | `src/import/import-commit.service.ts` (createReference) | `AssetModel` create usa `manufacturer`/`category` de `mapping.modelConfig`; **find-or-create `AssetCategory` name→id** (idempotente find-first); `'Unknown'` solo fallback. Construir `specs` null-proto. | 1 |
| 2.4 | `src/import/dry-run.service.ts` | Resolver `AssetCategory`; propagar model-config al plan/preview; poblar `samples` si aplica. | 1 |
| 2.5 | Tests Jest (import Etapa 1) | createReference con marca/categoría reales + find-or-create category idempotente; parser de-dup sin colisión; specs omit-empty. | 1 |
| 2.6 | `prisma/schema.prisma` | `User` += `directoryOnly Boolean @default(false)` + `directoryAttrs Json?` (comentario §3.3). | 2 |
| 2.7 | `prisma/migrations/<ts>_user_directory_only/migration.sql` | `ALTER TABLE "users" ADD COLUMN …` (§3.3). | 2 |
| 2.8 | `src/users/users.service.ts` | `create()` opt → `{ createdPayload?; skipIdpWriteBack? }`; **rama NUEVA**: si `skipIdpWriteBack`, saltar TODO el bloque IdP (486-539) e ir directo a `recordHistory(this.prisma,…)` + `search.upsert` + `return`; setear `directoryOnly`/`directoryAttrs` en createData. Firma del controller intacta. | 2 |
| 2.9 | `src/auth/jwt-auth.guard.ts` | (a) bootstrap count (365) += `where:{ directoryOnly:false }` (mantener `includeSoftDeleted`); (b) claim-por-email: setear `directoryOnly=false` en el `updateMany` del bind. | 2 |
| 2.10 | `src/access-grants/access-grants.service.ts` | `assertUserUsable` (512-522): `select { directoryOnly }` + `if (directoryOnly) → 400`. | 2 |
| 2.11 | `src/import/import-commit.service.ts` (commitRow) | Orden **asset→persona→assignment**; persona dedup **vivo** (email∨legajo, sin includeSoftDeleted) → `users.service.create(skipIdpWriteBack+directoryOnly, createdPayload provenance)`; AssetAssignment con **ConflictException tratada como no-op idempotente** (cita asset-assignments.service.ts:84-91). | 2 |
| 2.12 | `src/import/import-commit.service.ts` (assetExistsForRow + resume) | **Resume probe extendido**: si asset existe y la fila tenía persona, verificar assignment activa; si falta, completarla antes de marcar COMMITTED. | 2 |
| 2.13 | `src/import/import-commit.service.ts` (assertActorCanCommit) | AND-check explícito fail-closed para crear personas/assignments (verbos del catálogo vía `hasAll`, sin enum nuevo). | 2 |
| 2.14 | Tests Jest (import Etapa 2) | `users.service` `skipIdpWriteBack` con **`supportsManagement=TRUE`** (combinación que hoy no existe → NO se llama `idp.createUser`); persona+assignment idempotente (re-import no marca FAILED); resume completa assignment faltante; dedup vivo no resucita ghost; fila sin email/legajo → sin persona + warning; bootstrap count excluye directory-person; access-grant a directory-person → 400. | 2 |

### LANE 3 — FRONTEND (`apps/web`) · depende de LANE 1 (catálogo+wire) y LANE 2 (samples poblados / persona en commit)

| # | Archivo | Tarea | Etapa |
|---|---|---|---|
| 3.1 | `app/(app)/imports/_components/steps/mapping-step.tsx` | Reescritura column-centric (§6.2): `<details>` por columna, `Select` agrupado (`IMPORT_UI_TARGETS`) + Ignorar + Crear-custom, samples expandibles, status column-scoped, model-config+persona como filas planas, seed invertido, `buildMapping` reescrito, validación + person-identity guard. Headers = forma renombrada end-to-end. | 1 (asset/model/custom) → 2 (persona) |
| 3.2 | `messages/en/imports.json` | Claves nuevas (§6.3). | 1+2 |
| 3.3 | `messages/es/imports.json` | Espejo 1:1. | 1+2 |
| 3.4 | `content/manual/en/assets-bulk-import.md` | Reescritura "3. Map your columns" + flujo persona/promoción + warning PII (§6.4). | 1+2 |
| 3.5 | `content/manual/es/assets-bulk-import.md` | Espejo. | 1+2 |
| 3.6 | (decisión §10 #2) | Si las directory-persons se **ocultan** de `GET /users`/selectores → filtro `directoryOnly` en `users.service` list/count (2.x backend) **y** en el owner-selector de AssetAssignment. **Bloqueante de Etapa 2** — resolver con el CEO antes. | 2 |

### LANE 4 — DOCS (`docs/`) · paralelo, merge final

| # | Archivo | Tarea |
|---|---|---|
| 4.1 | `docs/03-decisions/0069-migrator-import.md` | Amendment (§8.1). |
| 4.2 | `docs/03-decisions/0038-jit-user-provisioning.md` | Amendment (§8.2). |
| 4.3 | `docs/02-domain/entities/user.md` | directoryOnly/directoryAttrs + reglas de capability. |
| 4.4 | `docs/06-security/INVARIANTS.md` | Invariantes (a)+(b) (§8.4). |
| 4.5 | `docs/06-security/issues/SEC-NNN.md` | Finding nuevo: bound `AssetSpecsSchema` + depth-guard `jsonDeepEqual` (desacoplado). |

### Puntos de integración / merge local

1. **Merge SHARED** (lane 1) tras `tsc` web + CI verde.
2. **Merge BACKEND Etapa 1** (2.1-2.5) → **smoke con `prueba-import.csv`** (§9 DoD).
3. **Merge FRONTEND Etapa 1** (3.1 parcial + 3.2-3.5) → wizard end-to-end con specs+model real.
4. **→ Etapa 1 lista; el CSV del CEO ya importa con specs+model+samples, sin personas.**
5. **Merge BACKEND Etapa 2** (2.6-2.14) tras tests Jest verdes.
6. **Merge FRONTEND Etapa 2** (3.1 persona + 3.6 visibilidad).
7. **Merge DOCS** (lane 4) en lockstep.

### Definition of Done — test de integración del CSV real (crítica de simplicidad, missing — aceptada)

Smoke documentado (o test de integración) que toma `prueba-import.csv` y pasa parseo→mapping→dry-run→commit verificando: (a) **no aborta** por headers duplicados; (b) RAM/Disco/Procesador caen en `specs` **solo** cuando hay valor; (c) Model creado con fabricante (Apple) + categoría (Laptop) reales; (d) [Etapa 2] el asset queda **asignado** a la persona de directorio creada (con provenance), y un **re-import no marca filas FAILED** ni duplica la assignment.

---

## 10. Decisiones abiertas para el CEO

1. **Offboarding de directory-persons (crítica dominio, high)**: ¿una persona de directorio participa del **mismo** ciclo de offboarding que un User (al soft-borrarse libera sus AssetAssignments, users.service.ts:879+) o se la **excluye**? *Default propuesto: mismo ciclo (libera assignments)* — confirmar.
2. **Visibilidad (crítica dominio+simplicidad, bloqueante Etapa 2)**: ¿las directory-persons aparecen en `GET /users` y en los selectores de asignación/grants, o se **ocultan** (solo vista "Directorio")? Un import de 200 filas infla la lista y los dropdowns si **no** se filtran. *Opciones: (a) filtrar `directoryOnly` en reads+selectores; (b) mostrar pero etiquetar.* **No asumible** — define si se toca `users.service` list/count + selectores.
3. **Clave natural de la persona (crítica seguridad, critical)**: filas reales vienen con email **y** legajo vacíos. *Opciones: (a) exigir email **o** legajo para crear persona+assignment, resto importa sin assignment + warning [recomendado]; (b) dedup por nombre [RECHAZADO: match inseguro]; (c) una persona por fila sin dedup [duplica].* **Recomiendo (a).**
4. **Personas sin email**: ¿se importan igual (directory-only no-promocionable) o se rechaza la fila? *Recomiendo importar con warning (nunca se auto-promocionan por email).*
5. **Promoción al loguearse**: ¿hereda su role (VIEWER) y queda User normal (ADR-0038 auto-claim) o requiere acción de admin? *Default ADR-0038 = auto-claim.*
6. **Model config: columna vs constante**: marca+categoría ¿por columna (Fabricante/Categoría del CSV) o pinned como constante? *Recomiendo ambos (columna primario, constante fallback) — ya en `ModelConfigSchema`.*
7. **directoryAttrs jsonb vs columnas reales**: cargo/departamento/teléfono → jsonb [recomendado] **o** columnas `jobTitle`/`department`/`phone` (solo si se quiere filtrar/ordenar por departamento en SQL).
8. **¿Abrir import a MEMBER?** Hoy `import:run` ADMIN-only. *MVP: queda ADMIN-only; el AND-check explícito (§7) ya queda listo para sumar un verbo cuando se abra.*
9. **Manager directory-person (crítica seguridad, missing)**: ¿una directory-person puede ser `manager` de otra y entrar en la jerarquía de aprobación de `AccessRequest`? Si una request enruta a un manager sin login, queda colgada. *Recomiendo: `managerId` solo si el supervisor matchea un User vivo **NO directory-only**; si no, `managerName` free-text.* Confirmar.

---

## 11. Lo que DIFERIMOS deliberadamente (ponytail)

- **Modelo `Person` separado** — descartado: bifurcaría `AssetAssignment.userId` + ~20 FKs + el matcher de promoción. Techo: User y directory-person comparten tabla. Upgrade: forkear solo si las semánticas divergen.
- **Location enriquecida** (ciudad/provincia/país/CP) — fuera de MVP (CEO #4). Location sigue find-or-create por name; las columnas de dirección duplicadas se ignoran (opción barata: concatenar a `Location.address` free-text — confirmar, no inventar campos).
- **Bound global de `AssetSpecsSchema` + depth-guard de `jsonDeepEqual` (SEC-032)** — **desacoplado** a un finding de seguridad propio; el MVP usa el cap local del superRefine (§5.1). No en la ruta crítica del import.
- **Validación per-campo de specs / per-category** — `directoryAttrs` y `Asset.specs` sin schema por campo (solo el cap estructural). Espera ADR-0007.
- **Atomicidad fila-completa total** (asset+persona+assignment en una tx) — diferida; cubierta por el resume-probe extendido (§4.6). Upgrade: tx compartida (refactor de `assets.create`).
- **Provenance directo en `AssetAssignment`** — no se agrega campo; la correlación es vía el asset (que sí lo tiene). YAGNI.
- **Reversibilidad / rollback masivo de un import de personas (crítica seguridad, missing)** — sin "deshacer" dedicado en MVP; el soft-delete manual de las personas creadas (correlacionadas por el provenance del UserHistory) es la vía. **Riesgo documentado**: una persona mal-creada con email real puede auto-promocionarse por OIDC y heredar un rol, cerrando la ventana de limpieza segura → el operador debe revisar antes de que la persona se loguee. *Upgrade: un endpoint "revertir sesión" que soft-borra los Users `directoryOnly` creados por una `sessionId` — solo si el CEO lo pide.*
- **Presets por origen (Snipe-IT)** — explícitamente NO (CEO #3): mapeo asistido genérico por columna.
- **Type hints en custom fields** (string/number/date) — diferido; custom key = free-text string.
- **Toggle "ocultar columnas ignoradas"** — diferido (YAGNI), default = mostrar todas.

---

**Notas finales sobre las críticas:**
- **Aceptadas (corrigen el diseño)**: pre-check 409 de assignment (no P2002); resume-probe ciego al crash persona/assignment; `skipIdpWriteBack` es rama nueva (no reuse del BYOI); `AssetCategory` necesita find-or-create name→id; access-grant a directory-person; dedup vivo (no `includeSoftDeleted`); de-dup de headers while-until-unique; defense-in-depth de prototype-pollution en el backend; AND-check explícito; SEC-032 + depth-guard desacoplados; partición en dos etapas; no inflar `MappableField<keyof TCreate>`; model-config por mapping (no por ConflictResolution); orden asset-first; provenance de la persona; offboarding/visibilidad/manager como decisiones bloqueantes.
- **Crítica matizada (parcialmente equivocada)**: "una sola cláusula cierra el único riesgo" — **correcto para el bootstrap-ADMIN** (verificado: los demás counts filtran `role: ADMIN`), pero **incompleto** para coherencia de reads (`users.service.ts:163` sin filtro) → se separa explícitamente seguridad (§3.6) de visibilidad (§10 #2).
- **Crítica rechazada**: el orden de commit **persona-first** que sugería la crítica de seguridad para el dedup — se elige **asset-first** porque la validación strict del asset puede abortar la fila barato sin dejar persona huérfana, y el dedup funciona igual en cualquier orden.
