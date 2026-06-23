---
title: "ADR-0069 PLAN: Plan de ejecución del rediseño del import masivo (worktrees, lanes, etapas)"
tags: [adr, migrator, import, plan, execution, worktrees, backend, frontend, shared, docs]
status: superseded
superseded-by: "[[0069-migrator-import]]"
created: 2026-06-18
updated: 2026-06-23
deciders: [Joaquín Minatel]
companion: 0069-migrator-import.REDESIGN.md
note: "EN EJECUCIÓN desde 2026-06-20. El CEO respondió §9 (Q1-Q6) y dio GO a la Etapa 1 completa. Cambios vs. el plan original: ahora SÍ se usa gh/push/PR a dev (Q1); worktrees solo para los fixes chicos paralelos, la cadena core va serial (Q4, decisión de CTO); username pasa a 3ª clave de identidad fallback (Q5)."
---

> **Archived working draft.** Execution plan for the import redesign; the work shipped and this
> plan is **superseded by** the accepted [[0069-migrator-import]] (its Amendment — Etapa 2
> section records the as-built outcome). Retained for auditability only.

# Plan de ejecución — Rediseño del Import Masivo

> **Estado: EN EJECUCIÓN (2026-06-20).** El CEO respondió §9 y dio GO a la **Etapa 1 completa** (no MVP-recortado: la cocinamos entera, después la Etapa 2). El "qué/por qué" técnico vive en su compañero [[0069-migrator-import.REDESIGN]] (§0 = decisiones del CEO ya cerradas).
>
> **Respuestas del CEO a §9 (2026-06-20):**
> - **Q1 →** `gh` habilitado (cuenta `joacominatel`). Trabajamos con ramas, **push y PR a `dev`**. (Anula el "merge local sin gh" del plan original.)
> - **Q2 →** `prueba-import.csv` va a `.gitignore` (hecho). Fixture anonimizado para el test de §8 sigue siendo el plan.
> - **Q3 →** Defaults reversibles del REDESIGN §0 **confirmados**.
> - **Q4 →** Preferencia general = worktrees; **delega en el CTO** la mecánica anti-colisión. **Decisión CTO:** cadena `SHARED→BACKEND→FRONTEND` **serial sobre la rama de integración** (dependencia dura + directorios disjuntos = sin colisión); **worktrees solo para los fixes/feats chicos paralelos**.
> - **Q5 →** `username` se suma como **3ª clave de identidad** (email ∨ legajo ∨ username), como fallback.
> - **Q6 →** **Etapa 1 completa** de una; luego Etapa 2 para dejar todo cocinado.

---

## 1. Dónde estamos (estado real)

| Hecho | Detalle |
|---|---|
| ✅ Investigación completa | 3 agentes Explore mapearon backend / frontend / dominio del import actual (ADR-0069 "Migrator"). |
| ✅ Causa del error de parseo confirmada | `parser.ts:157-168` **rechaza headers duplicados**; el CSV Snipe-IT del CEO los tiene → el front muestra el genérico `imports.errors.parse`. |
| ✅ Workflow de diseño (11 agentes, 3 lentes de crítica) | Produjo el documento maestro [[0069-migrator-import.REDESIGN]]. |
| ✅ Decisiones del CEO cerradas | 1ª tanda (4 preguntas) + 2ª tanda (3 preguntas) → REDESIGN §0 y §2. |
| ✅ Rama base creada | `feat/import-directory-people` (desde `dev`), con el REDESIGN commiteado (`docs:`). |
| ⏸️ **Implementación: NO iniciada** | Worktree de prueba creado y **retirado**. Cero código de feature. |

**Branch viva:** `feat/import-directory-people` (local, sin push, sin `gh`). Contiene: `REDESIGN.md` + este `PLAN.md`.

---

## 2. Decisiones ya tomadas (no se re-litigan)

Resumen — el detalle está en REDESIGN §0/§2.

- **Persona de directorio = `User` con flag `directoryOnly`** (+ `directoryAttrs` jsonb), NO un modelo `Person` nuevo. Cero churn en `AssetAssignment.userId` ni en los ~20 FKs a User.
- **Identidad de la persona = email ∨ legajo.** Sin email NI legajo → asset importa sin asignar + warning. Nunca dedup por nombre.
- **Columnas extra → `Asset.specs`** (passthrough con allow-list anti-mass-assignment), solo en filas con valor.
- **Mapeo asistido column-centric**: listar columnas con 1-4 valores de ejemplo; mapear a campo nuestro o crear campo personalizado; config de modelo (marca+categoría) y de persona como filas.
- **Visibilidad**: personas de directorio **mezcladas** con los usuarios + badge "Directorio" + filtro `directoryOnly` en `GET /users`.
- **Botón "Crear cuenta OIDC"** (promoción manual a cuenta Zitadel) → Etapa 2.
- **Entrega en 2 etapas**, Etapa 1 primero.
- Defaults reversibles asumidos: offboarding = mismo ciclo; promoción por login = auto-claim VIEWER; `directoryAttrs` jsonb; import ADMIN-only; `managerId` solo si matchea User vivo no-directory.

---

## 3. Modelo de ejecución (worktrees + merge local, sin `gh`)

Mecánica que **iba** a usar, alineada con la instrucción del CEO ("cada agente en un worktree separado, commitean local, yo mergeo local, vos revisás la rama").

### 3.1 Topología de ramas

```
dev
 └─ feat/import-directory-people        (rama BASE; integra todo; la revisa el CEO)
     ├─ feat/idp-shared      (worktree: packages/shared)
     ├─ feat/idp-backend     (worktree: apps/api)
     ├─ feat/idp-frontend    (worktree: apps/web)
     └─ feat/idp-docs        (worktree: docs/)
```

- Worktrees en `/Users/jminat01/dev/lazyit-wt/<lane>` (hermano del repo, nunca anidado).
- Cada agente trabaja **solo dentro de su worktree**; edita por ruta absoluta; commitea con `git -C <worktree>`.
- Commits **file-by-file**, prefijos `feat`/`fix`/`chore`/`del`/`updt`/`docs`, **sin atribución a Claude**.
- **Merge LOCAL** a `feat/import-directory-people` (`git merge --no-ff`), revisado por el CEO, en el orden de dependencias (§5).
- **NUNCA** `gh`, push, PR, `--amend`, `rebase`, `reset`, `add -A`/`add .`.

### 3.2 Comandos de setup por lane (referencia)

```sh
# crear el worktree + rama de un lane desde el estado ACTUAL de la base
git worktree add /Users/jminat01/dev/lazyit-wt/<lane> -b feat/idp-<lane> feat/import-directory-people
# cada worktree necesita su propio node_modules (git no copia lo gitignored):
( cd /Users/jminat01/dev/lazyit-wt/<lane> && bun install )   # ver Riesgo R1 (tarball bun)

# … el agente implementa y commitea aquí …

# merge local a la base (tras revisión del CEO):
git -C /Users/jminat01/dev/lazyit checkout feat/import-directory-people
git -C /Users/jminat01/dev/lazyit merge --no-ff feat/idp-<lane>
git worktree remove /Users/jminat01/dev/lazyit-wt/<lane>
```

> **Idea / decisión de mecánica (ponytail):** como la cadena SHARED→BACKEND→FRONTEND es **secuencial por dependencia dura**, el worktree de BACKEND se crea *después* de mergear SHARED a la base (así BACKEND ya ve los contratos nuevos sin merges cruzados frágiles). El único lane genuinamente paralelo es DOCS. → El aislamiento por worktree aporta sobre todo **revisión por rama**, no paralelismo (que las dependencias limitan).

### 3.3 El `node_modules` por worktree (decisión pendiente — ver §9 Q4)

Un worktree fresco no tiene `node_modules`. Opciones:
- **(A) `bun install` por worktree** — correcto, ~40s, reusa la caché global de bun. Simple. *(default propuesto)*
- (B) Symlink del `node_modules` raíz — frágil con workspaces, descartado.
- (C) Lanes secuenciales en la **misma** rama base sin worktrees — más simple aún, pero pierde la "revisión por rama" que el CEO pidió.

---

## 4. Etapas

### Etapa 1 — desbloquea el CSV del CEO HOY (bajo riesgo, NO toca User/auth)

`parser` fix (headers duplicados) · sample values · custom→`specs` · Model+Categoría+Fabricante reales · fechas nativas (`purchaseDate`/`warrantyEnd`) · UI de mapeo invertida (asset/model/custom, sin persona).

### Etapa 2 — personas + asignación (el riesgo de seguridad, con tests propios)

`User.directoryOnly`+`directoryAttrs` (schema+migración) · `skipIdpWriteBack` (rama nueva en `users.service`) · crear persona + `AssetAssignment` idempotente en el commit · resume-probe extendido · filtro bootstrap-ADMIN · guard de access-grants · AND-check explícito · UI de persona en el mapeo · badge "Directorio" + filtro `directoryOnly` · **botón "Crear cuenta OIDC"** (`POST /users/:id/provision-account`).

> **Las dos etapas NO se mezclan en un merge.** Etapa 1 entrega valor solo; Etapa 2 lleva el ciclo de tests del riesgo.

---

## 5. Cadena de dependencias y orden

```
LANE SHARED ──→ LANE BACKEND ──→ LANE FRONTEND
                                  (UI agrupada necesita IMPORT_UI_TARGETS + samples wire de SHARED,
                                   y samples poblados + persona en commit de BACKEND)
LANE DOCS  ── corre en paralelo; merge al final de cada etapa, con el comportamiento ya fijo
```

**Orden de merges (por etapa):** SHARED → smoke → BACKEND → smoke con `prueba-import.csv` → FRONTEND → DOCS.

---

## 6. Lanes y tareas (checklist operativo)

Detalle técnico de cada tarea: REDESIGN §9. Aquí, el checklist marcable con archivo y etapa.

### LANE 1 — SHARED (`packages/shared`) · sin dependencias

- [ ] **1.1** `schemas/import/mapping.ts` — `CustomFieldMappingSchema`, `ModelConfigSchema` (+ `PersonSubMappingSchema` en E2); `ImportMappingSchema` += `custom`/`modelConfig` (+ `person` E2); `superRefine` anti-mass-assignment (key reservada/nativa/`__proto__`/dup + cap ≤64). · E1 (+E2 persona)
- [ ] **1.2** `schemas/import/coerce-row.ts` — `CoercedRow` += `specs?` (+ `person?` E2); rutea custom→specs (omit-empty, **null-proto**). · E1 (+E2)
- [ ] **1.3** `schemas/import/coerce-row.test.ts` — `bun test`: custom→specs, vacío→sin specs, `{}` nunca, key reservada saltada (+ persona E2). · E1 (+E2)
- [ ] **1.4** `schemas/import/wire.ts` — `ImportSessionViewSchema`/`ImportDetectedShapeSchema` += `samples`. · E1
- [ ] **1.5** `schemas/import/descriptor.ts` — `mappableFields` += `purchaseDate`/`warrantyEnd`; **`IMPORT_UI_TARGETS`** (asset/model; +person E2) SIN tocar `MappableField<keyof TCreate>`. · E1 (+E2)
- [ ] **1.6** `schemas/user.ts` — `UserSchema` (read) += `directoryOnly`/`directoryAttrs`; `CreateDirectoryPersonSchema` (strict, sin role/externalId, identidad=email∨legajo). **NO** tocar Create/UpdateUserSchema. · **E2**

> ⚠️ **Riesgo cruzado (memoria `shared-changes-need-web-typecheck`):** tocar `user.ts` puede romper maps exhaustivos del web → correr `tsc` del web + CI real antes de mergear.

### LANE 2 — BACKEND (`apps/api`) · depende de SHARED

- [ ] **2.1** `import/parser.ts` — de-dup determinístico **while-until-unique** (155-168); renombrado reflejado en `detected`; mantener cap de columnas. · E1
- [ ] **2.2** `import/run-parse-job.ts` — recolectar ≤4 valores no vacíos por columna en `detected.samples`. · E1
- [ ] **2.3** `import/import-commit.service.ts` (createReference) — `AssetModel` create usa `manufacturer`/`category` de `mapping.modelConfig`; **find-or-create `AssetCategory` name→id** idempotente; `'Unknown'` solo fallback; `specs` null-proto. · E1
- [ ] **2.4** `import/dry-run.service.ts` — resolver `AssetCategory`; propagar model-config al plan/preview; poblar samples. · E1
- [ ] **2.5** Tests Jest E1 — createReference marca/categoría reales + find-or-create idempotente; parser de-dup sin colisión; specs omit-empty. · E1
- [ ] **2.6** `prisma/schema.prisma` — `User` += `directoryOnly Boolean @default(false)` + `directoryAttrs Json?`. · E2
- [ ] **2.7** `prisma/migrations/<ts>_user_directory_only/migration.sql` — `ALTER TABLE "users" ADD COLUMN …`. · E2
- [ ] **2.8** `users/users.service.ts` — `create()` opt `{ createdPayload?; skipIdpWriteBack? }`; **rama NUEVA**: si `skipIdpWriteBack`, saltar TODO el bloque IdP (486-539) → `recordHistory` + `search.upsert` + `return`; setear `directoryOnly`/`directoryAttrs`. Firma del controller intacta. · E2
- [ ] **2.9** `auth/jwt-auth.guard.ts` — (a) bootstrap count (365) += `where:{ directoryOnly:false }`; (b) claim-por-email: setear `directoryOnly=false` en el bind. · E2
- [ ] **2.10** `access-grants/access-grants.service.ts` — `assertUserUsable` (512-522): `select { directoryOnly }` + `if (directoryOnly) → 400`. · E2
- [ ] **2.11** `import/import-commit.service.ts` (commitRow) — orden **asset→persona→assignment**; persona dedup **vivo** (email∨legajo, sin `includeSoftDeleted`) → `users.service.create(skipIdpWriteBack+directoryOnly, provenance)`; AssetAssignment con **`ConflictException` tratada como no-op idempotente** (cita asset-assignments.service.ts:84-91). · E2
- [ ] **2.12** `import/import-commit.service.ts` (assetExistsForRow + resume) — **resume probe extendido**: si asset existe y la fila tenía persona, verificar assignment activa; completarla antes de marcar COMMITTED. · E2
- [ ] **2.13** `import/import-commit.service.ts` (assertActorCanCommit) — AND-check explícito fail-closed para crear personas/assignments. · E2
- [ ] **2.14** `users/users.controller.ts` + service — **endpoint `POST /users/:id/provision-account`** (botón Crear cuenta OIDC): ADMIN-only; toma directory-person existente, exige email, `idp.createUser`, setea `externalId`+`directoryOnly=false`; compensación en fallo (no deja split-brain). · E2
- [ ] **2.15** Tests Jest E2 — `skipIdpWriteBack` con `supportsManagement=TRUE`; persona+assignment idempotente; resume completa assignment faltante; dedup vivo no resucita ghost; sin email/legajo → sin persona + warning; bootstrap excluye directory-person; access-grant a directory-person → 400; provision-account feliz + sin email → 400. · E2

### LANE 3 — FRONTEND (`apps/web`) · depende de SHARED + BACKEND

- [ ] **3.1** `imports/_components/steps/mapping-step.tsx` — reescritura **column-centric** (REDESIGN §6.2): `<details>` por columna, `Select` agrupado (`IMPORT_UI_TARGETS`) + Ignorar + Crear-custom, samples expandibles, status column-scoped, model-config (+persona E2) como filas, seed invertido, `buildMapping` reescrito, validación. Headers = forma renombrada end-to-end. · E1 (asset/model/custom) → E2 (persona)
- [ ] **3.2** `messages/en/imports.json` — claves nuevas (REDESIGN §6.3). · E1+E2
- [ ] **3.3** `messages/es/imports.json` — espejo 1:1. · E1+E2
- [ ] **3.4** `content/manual/en/assets-bulk-import.md` — reescribir "Map your columns" + flujo persona/promoción + warning PII. · E1+E2
- [ ] **3.5** `content/manual/es/assets-bulk-import.md` — espejo. · E1+E2
- [ ] **3.6** Usuarios — badge "Directorio" + filtro `directoryOnly` en la lista; botón "Crear cuenta OIDC" en la ficha (llama 2.14). · E2

### LANE 4 — DOCS (`docs/`) · paralelo, merge al final de cada etapa

- [ ] **4.1** `03-decisions/0069-migrator-import.md` — amendment (specs passthrough, Model real, persona directory-only + assignment). · E1(parcial)+E2
- [ ] **4.2** `03-decisions/0038-jit-user-provisioning.md` — amendment (linking promueve directory-person). · E2
- [ ] **4.3** `02-domain/entities/user.md` — `directoryOnly`/`directoryAttrs` + reglas de capability. · E2
- [ ] **4.4** `06-security/INVARIANTS.md` — invariantes (a) directoryOnly ⇒ sin login/role admin; (b) directoryOnly ⇒ nunca sujeto de AccessGrant/provisioning. · E2
- [ ] **4.5** `06-security/issues/SEC-NNN.md` — finding desacoplado: bound `AssetSpecsSchema` + depth-guard `jsonDeepEqual`. · cualquiera

---

## 7. Cómo iba a orquestar los agentes

| Lane | Subagente propuesto | Contrato (qué se le pasa) |
|---|---|---|
| SHARED | `lazyit-navigator` / general | REDESIGN §5; scope exacto de la etapa; "trabajá solo en `<worktree>`, commit file-by-file, `bun test` verde, ponytail, no toques otros lanes". |
| BACKEND | `lazyit-backend` (+ `lazyit-sentinel` para revisar E2) | REDESIGN §3-§4-§7; migración Prisma; Jest verde; el contrato de `skipIdpWriteBack`/idempotencia citado con file:line. |
| FRONTEND | `lazyit-frontend` (+ skill `impeccable`/`frontend-design` para el paso de mapeo) | REDESIGN §6; consumir `IMPORT_UI_TARGETS` + `samples`; i18n paridad en+es; `tsc` web verde. |
| DOCS | `lazyit-devops`/`navigator` | REDESIGN §8; amendments; INVARIANTS. |

**Checkpoints de revisión (CEO):** tras cada lane mergeado → el CEO revisa la rama base antes del siguiente. Smoke obligatorio tras BACKEND E1 (§8).

**Política de tests/CI (memoria `merge-on-green-skip-heavy-review`):** confiar en el CI/`tsc`/Jest como gate (leyendo el conclusion real), sin review adversarial multi-agente por defecto — salvo Etapa 2, que SÍ pasa por `lazyit-sentinel` por el riesgo de auth.

---

## 8. Definition of Done — smoke con el CSV real

Test de integración (o smoke documentado) que toma `prueba-import.csv` y recorre parseo→mapping→dry-run→commit verificando:
- [ ] (a) **No aborta** por headers duplicados.
- [ ] (b) RAM/Disco/Procesador caen en `specs` **solo** cuando hay valor.
- [ ] (c) Model creado con fabricante (Apple) + categoría (Laptop) **reales**.
- [ ] (d) **[E2]** el asset queda **asignado** a la persona de directorio creada (por legajo, con provenance), y un **re-import NO marca filas FAILED** ni duplica la assignment.

---

## 9. Preguntas abiertas / pendientes (para el CEO)

Operativas y de modelo que quedaron sin cerrar:

1. **Q1 — ¿Estos docs (REDESIGN/PLAN) viven en la rama `feat/import-directory-people` o se promueven a `dev` ya?** Si el feature se repiensa, conviene tenerlos en `dev` como registro; si seguimos, quedan en la rama. *(Recomiendo: mover a `dev` ahora — son análisis, no código riesgoso.)*
2. **Q2 — `prueba-import.csv`** (con PII de empleados) está untracked en el working tree. ¿Lo agregamos a `.gitignore`, lo convertimos en un fixture **anonimizado** para el test de §8, o lo borramos? *(Recomiendo: fixture anonimizado en `apps/api/test/fixtures/`.)*
3. **Q3 — ¿Confirmás los defaults reversibles** del REDESIGN §0 (offboarding, auto-claim VIEWER, `directoryAttrs` jsonb, import ADMIN-only, manager-match)? Cualquiera que quieras cambiar, ahora es barato.
4. **Q4 — Mecánica de worktrees:** ¿`bun install` por worktree (default §3.3-A), o preferís lanes secuenciales en la misma rama base sin worktrees (más simple, pierde "revisión por rama")?
5. **Q5 — Username como 3ª clave:** se descartó `username` (joaquin.minatel) como clave de identidad de persona (solo email∨legajo). ¿Lo dejamos así o lo sumamos como fallback? *(Recomiendo: dejarlo fuera del MVP — legajo ya cubre tu CSV.)*
6. **Q6 — Alcance del primer arranque:** ¿implementamos **Etapa 1 completa** de una, o solo el **fix del parser** (1 commit, desbloquea tu CSV para verlo hoy) y después el resto? *(Recomiendo: Etapa 1 completa; el parser solo deja el CSV importable pero pobre.)*

---

## 10. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | `bun install` falla por extracción de tarball (transitorio, ya pasó con `@prisma/studio-core`) | auto-reintento **Docker-side** (3 intentos + backoff) en los Dockerfiles api/web/migrate — issue #642, PR #643. El install local por worktree sigue siendo un caso aparte (reintentar a mano). |
| R2 | Cambios en `packages/shared/user.ts` rompen maps exhaustivos del web | `tsc` del web + CI **antes** de mergear el lane SHARED (memoria `shared-changes-need-web-typecheck`). |
| R3 | Etapa 2 toca auth/bootstrap/access-grants (superficie de seguridad) | merge separado, tests Jest dedicados, pase por `lazyit-sentinel`. |
| R4 | Mass-assignment vía custom fields/specs | allow-list en `superRefine` (shared) **y** null-proto en el writer backend (defense-in-depth). |
| R5 | PII de empleados en `samples`/preview y en `prueba-import.csv` | samples dentro de `ImportSession.detected` (mismo owner-scope+GC); nunca en logs ni en el ledger `ImportRun`; CSV real → fixture anonimizado (Q2). |
| R6 | Persona mal-creada con email real se auto-promociona por OIDC antes de limpiarla | documentado en REDESIGN §11; el operador revisa antes del primer login; upgrade: endpoint "revertir sesión". |

---

## 11. Checklist global (estado)

- [x] Investigación del import actual
- [x] Diagnóstico del error de parseo
- [x] Workflow de diseño + documento maestro (REDESIGN)
- [x] Decisiones del CEO (2 tandas)
- [x] Rama base `feat/import-directory-people` + REDESIGN commiteado
- [x] **Este plan de ejecución**
- [ ] Respuestas a §9 (Q1-Q6)
- [ ] Etapa 1: SHARED → BACKEND → FRONTEND → DOCS
- [ ] Smoke con `prueba-import.csv` (§8 a-c)
- [ ] Etapa 2: persona + asignación + provisión OIDC + seguridad
- [ ] Smoke §8 (d) + tests Etapa 2
- [ ] Merge `dev` (lo promueve el CEO)

---

> **Para retomar:** responder §9, luego ejecutar §6 lane por lane en el orden de §5 con la mecánica de §3. Nada de `gh` hasta que el CEO lo habilite.
