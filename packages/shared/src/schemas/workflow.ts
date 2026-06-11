import { z } from "zod";
import { int4 } from "./primitives";

/**
 * Applications Workflow Engine contracts (ADR-0054, epic #248) — Phase 1a foundation.
 *
 * Single source of truth shared by `api` (validate / persist / execute) and `web` (the workflow
 * builder + run views) for the engine's enums, the per-connector and per-step config discriminated
 * unions, and the entity wire shapes. NO engine runtime lives here — these are pure contracts.
 *
 * Conventions: closed enums as `as const` arrays + `z.enum` (the permission-catalog precedent); write
 * DTOs are `z.strictObject` (reject unknown keys / mass assignment); Int-backed fields use `int4`
 * (ADR-0036); dates are ISO-8601 strings on the wire (ADR-0018). The variable per-kind config is
 * zod-validated jsonb (ADR-0007). Secrets are NEVER carried on a wire shape (INV-6, ADR-0031).
 *
 * SCOPE (ADR-0054): v1 connectors/steps = REST + WEBHOOK_OUT + MANUAL, PUBLIC destinations only. SDK /
 * MCP / PREBUILT / CUSTOM and the timer triggers are RESERVED enum slots with no behavior. Manual
 * steps collect typed input + STATIC suggestions only — role/team/manager/AD are a future model-first
 * ADR, NOT this engine.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Enums (closed catalogs — mirror the Prisma enums exactly)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What access-lifecycle event starts a workflow. v1 builds the two AccessGrant-derived triggers; the
 * timer-based ones are RESERVED (no behavior in Phase 1a). {@link WORKFLOW_TRIGGERS_V1} is the subset
 * a definition may currently be created against.
 */
export const WORKFLOW_TRIGGERS = [
  "ACCESS_GRANTED",
  "ACCESS_REVOKED",
  // RESERVED (Phase 3): N days after a grant; cron-like; periodic re-run + report (never IGA).
  "TIMER_AFTER_GRANT",
  "SCHEDULED",
  "RECERTIFICATION",
] as const;
export const WorkflowTriggerSchema = z.enum(WORKFLOW_TRIGGERS);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

/** The trigger subset a workflow may be CREATED against in v1 (the two grant-derived events). */
export const WORKFLOW_TRIGGERS_V1 = ["ACCESS_GRANTED", "ACCESS_REVOKED"] as const;
export const WorkflowTriggerV1Schema = z.enum(WORKFLOW_TRIGGERS_V1);
export type WorkflowTriggerV1 = z.infer<typeof WorkflowTriggerV1Schema>;

/**
 * Multi-grant deprovision semantics for an ACCESS_REVOKED workflow (CEO Q1). Default LAST_ACTIVE_GRANT
 * (safer — never cuts off a user who still holds legitimate access). Enforcement is Phase 1b.
 */
export const WORKFLOW_DEPROVISION_POLICIES = [
  "LAST_ACTIVE_GRANT",
  "EACH_GRANT",
] as const;
export const WorkflowDeprovisionPolicySchema = z.enum(
  WORKFLOW_DEPROVISION_POLICIES,
);
export type WorkflowDeprovisionPolicy = z.infer<
  typeof WorkflowDeprovisionPolicySchema
>;
export const DEFAULT_DEPROVISION_POLICY = "LAST_ACTIVE_GRANT" as const;

/**
 * The connector kind discriminator. v1 = REST + WEBHOOK_OUT + MANUAL; SDK / MCP / PREBUILT / CUSTOM
 * are RESERVED (no executor in Phase 1a). {@link WORKFLOW_CONNECTION_KINDS_V1} is the configurable
 * subset.
 */
export const WORKFLOW_CONNECTION_KINDS = [
  "REST",
  "WEBHOOK_OUT",
  "MANUAL",
  // RESERVED — code-backed tiers shipped IN THE IMAGE, never runtime-loaded.
  "SDK",
  "MCP",
  "PREBUILT",
  "CUSTOM",
] as const;
export const WorkflowConnectionKindSchema = z.enum(WORKFLOW_CONNECTION_KINDS);
export type WorkflowConnectionKind = z.infer<
  typeof WorkflowConnectionKindSchema
>;

/** The connector kinds configurable in v1. */
export const WORKFLOW_CONNECTION_KINDS_V1 = [
  "REST",
  "WEBHOOK_OUT",
  "MANUAL",
] as const;

/** The run-level state machine. AWAITING_INPUT = paused in Postgres, no BullMQ job in flight. */
export const WORKFLOW_RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "AWAITING_INPUT",
  "SUCCEEDED",
  "FAILED",
  "COMPENSATED",
] as const;
export const WorkflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

/** The per-attempt status of a step run (one append-only row per attempt). */
export const WORKFLOW_STEP_RUN_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "AWAITING_INPUT",
  "SKIPPED",
  "COMPENSATED",
] as const;
export const WorkflowStepRunStatusSchema = z.enum(WORKFLOW_STEP_RUN_STATUSES);
export type WorkflowStepRunStatus = z.infer<typeof WorkflowStepRunStatusSchema>;

/** The lifecycle of a manual task (no soft delete — these are statuses). */
export const MANUAL_TASK_STATUSES = ["PENDING", "COMPLETED", "CANCELLED"] as const;
export const ManualTaskStatusSchema = z.enum(MANUAL_TASK_STATUSES);
export type ManualTaskStatus = z.infer<typeof ManualTaskStatusSchema>;

/** Outbound HTTP methods a REST step may use. */
export const WORKFLOW_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export const WorkflowHttpMethodSchema = z.enum(WORKFLOW_HTTP_METHODS);
export type WorkflowHttpMethod = z.infer<typeof WorkflowHttpMethodSchema>;

/**
 * The methods the side-effect-free test-connection probe (#344) may use. Restricted to the READ-ONLY
 * verbs by construction — the probe must never provision / mutate (ADR-0054 §9, frontend.md §4c). GET
 * is the default; HEAD lets a target that answers a bodiless probe (or rate-limits GET) still be checked.
 */
export const WORKFLOW_PROBE_METHODS = ["GET", "HEAD"] as const;
export const WorkflowProbeMethodSchema = z.enum(WORKFLOW_PROBE_METHODS);
export type WorkflowProbeMethod = z.infer<typeof WorkflowProbeMethodSchema>;
/** The default probe method when a REST connection omits `healthCheckMethod`. */
export const DEFAULT_PROBE_METHOD = "GET" as const;

/**
 * How a REST connector applies its credential. The credential VALUE never lives in `config` — it is a
 * reference into WorkflowSecret (INV-6). This only says HOW to attach it at call time.
 */
export const WORKFLOW_REST_AUTH_SCHEMES = [
  "NONE",
  "BEARER",
  "BASIC",
  "HEADER",
] as const;
export const WorkflowRestAuthSchemeSchema = z.enum(WORKFLOW_REST_AUTH_SCHEMES);
export type WorkflowRestAuthScheme = z.infer<
  typeof WorkflowRestAuthSchemeSchema
>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared building blocks
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A PUBLIC https URL — v1 egress posture (ADR-0054): public destinations only. The runtime egress
 * guard (parse-not-sniff scheme allowlist, deny resolved private/loopback/link-local/metadata IPs,
 * pin the resolved IP, re-validate redirects) is the real defense; this contract enforces the scheme
 * so a non-https or non-URL value is a clean 400 at the edge. On-prem / internal targets are a
 * near-term roadmap item, NOT v1.
 */
export const publicHttpsUrl = z
  .url()
  .max(2048)
  // `z.url()` already guarantees a structurally valid URL; we only additionally require the https
  // scheme. A regex (not `new URL()`) keeps this framework-agnostic — the shared package's TS lib has
  // no DOM/Node `URL` global.
  .refine(
    (value) => /^https:\/\//i.test(value.trim()),
    "Must be an https:// URL (v1 egress allows public destinations only)",
  );

/**
 * A logic-less data mapping: target field name → a template string over a FROZEN, allowlisted context
 * (`grantee.email`, `application.name`, prior step outputs, manual input). By construction there is NO
 * code execution (no eval / Function / vm); the safe templating + per-destination encoding is the
 * Phase 1b executor's job. v1 keeps the contract a flat string→string map.
 */
export const WorkflowDataMappingSchema = z.record(z.string().min(1).max(200), z.string().max(2000));
export type WorkflowDataMapping = z.infer<typeof WorkflowDataMappingSchema>;

/**
 * A field a MANUAL step asks a human to fill. `suggestions` are STATIC values the admin typed into the
 * step config (CEO scope decision) — NOT a directory/role/team lookup. `options` constrains a select.
 */
export const ManualInputFieldTypeSchema = z.enum([
  "text",
  "number",
  "boolean",
  "select",
]);
export const ManualInputFieldSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  type: ManualInputFieldTypeSchema,
  required: z.boolean().default(false),
  // For `select`: the allowed values. Ignored for other types.
  options: z.array(z.string().min(1).max(200)).max(50).optional(),
  // STATIC suggestions only (admin-typed). Never a directory lookup (anti-IGA, ADR-0054 §scope).
  suggestions: z.array(z.string().min(1).max(200)).max(50).optional(),
});
export type ManualInputField = z.infer<typeof ManualInputFieldSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Connector config — discriminated union on `kind` (WorkflowConnection.config jsonb)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** REST connector: a base URL + how to attach the (separately-stored) credential. */
export const RestConnectionConfigSchema = z.strictObject({
  kind: z.literal("REST"),
  baseUrl: publicHttpsUrl,
  authScheme: WorkflowRestAuthSchemeSchema.default("NONE"),
  // For authScheme HEADER: the header name the credential is sent in (e.g. "X-Api-Key").
  authHeaderName: z.string().trim().min(1).max(100).optional(),
  // Non-secret default headers applied to every call (e.g. Accept). Never carries a credential.
  defaultHeaders: z.record(z.string().min(1).max(100), z.string().max(1000)).optional(),
  // Optional READ-ONLY health/whoami path the test-connection probe targets (#344) — appended to
  // `baseUrl` (joinUrl), falling back to `baseUrl` when unset. The HOST is fixed by `baseUrl` and is
  // NEVER templatable (anti-SSRF, ADR-0054 §6.4); this is a static relative path, not a ctx template.
  // Many targets only 200 on /health, /status, /api/healthz — hitting the root gives false negatives.
  healthCheckPath: z.string().trim().min(1).max(2048).optional(),
  // The probe verb (GET default). Restricted to READ-ONLY methods so the probe stays side-effect-free.
  healthCheckMethod: WorkflowProbeMethodSchema.optional(),
});
export type RestConnectionConfig = z.infer<typeof RestConnectionConfigSchema>;

/** WEBHOOK_OUT connector: a single signed outbound endpoint. The signing secret is a WorkflowSecret. */
export const WebhookOutConnectionConfigSchema = z.strictObject({
  kind: z.literal("WEBHOOK_OUT"),
  url: publicHttpsUrl,
  // The header the HMAC signature is sent in (signing secret lives in WorkflowSecret).
  signatureHeader: z.string().trim().min(1).max(100).optional(),
});
export type WebhookOutConnectionConfig = z.infer<
  typeof WebhookOutConnectionConfigSchema
>;

/** MANUAL connector: no external endpoint (a human performs the step). Kept for a total union. */
export const ManualConnectionConfigSchema = z.strictObject({
  kind: z.literal("MANUAL"),
});
export type ManualConnectionConfig = z.infer<
  typeof ManualConnectionConfigSchema
>;

/** The v1 connector config union (REST | WEBHOOK_OUT | MANUAL), discriminated on `kind`. */
export const WorkflowConnectionConfigSchema = z.discriminatedUnion("kind", [
  RestConnectionConfigSchema,
  WebhookOutConnectionConfigSchema,
  ManualConnectionConfigSchema,
]);
export type WorkflowConnectionConfig = z.infer<
  typeof WorkflowConnectionConfigSchema
>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step config — discriminated union on `kind` (WorkflowVersion.steps jsonb)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Stable per-step node key within a version (referenced by WorkflowStepRun.stepKey / ManualTask). */
const stepKey = z.string().trim().min(1).max(100);

/**
 * LEGACY per-step failure governance (fail / continue / manual). SUPERSEDED by the first-class
 * {@link stepGraphShape} transition model (`onFailure`) below, but kept on the wire for backward
 * compatibility: a version authored before the DAG revision still validates and resolves. The
 * canonical mapping is encoded in {@link resolveStepTransitions}: `fail` → STOP_FAIL,
 * `continue` → take the success edge (fall through), `manual` → ESCALATE_TO_MANUAL. New authoring
 * SHOULD set `onSuccess`/`onFailure`; `onError` is the fallback when `onFailure` is unset.
 */
export const WORKFLOW_STEP_ON_ERROR = ["fail", "continue", "manual"] as const;
export const WorkflowStepOnErrorSchema = z.enum(WORKFLOW_STEP_ON_ERROR);
export type WorkflowStepOnError = z.infer<typeof WorkflowStepOnErrorSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The opinionated error-handling DAG (ADR-0054 §8) — success criteria, retry policy, transitions
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * SUCCESS CRITERIA for an HTTP step (REST / WEBHOOK_OUT). An outbound call is a STEP SUCCESS only when
 * its status matches the criteria — a 500 / 404 outside the set is a step FAILURE, never a silent
 * "succeeded" (the CEO's rule: no error-blind linear flow). When a step omits `successCriteria` the
 * engine applies the default {@link DEFAULT_HTTP_SUCCESS_RANGE} (2xx). The contract carries the policy;
 * the 1b-B orchestrator evaluates it via {@link isHttpStatusSuccess}.
 */
export const HttpStatusRangeSchema = z
  .strictObject({
    from: int4({ min: 100, max: 599 }),
    to: int4({ min: 100, max: 599 }),
  })
  .refine((r) => r.from <= r.to, {
    error: "status range `from` must be ≤ `to`",
    path: ["to"],
  });
export type HttpStatusRange = z.infer<typeof HttpStatusRangeSchema>;

export const HttpSuccessCriteriaSchema = z
  .strictObject({
    // Explicit individual status codes treated as success (e.g. [200, 201, 204]).
    statuses: z.array(int4({ min: 100, max: 599 })).max(20).optional(),
    // Inclusive status-code ranges treated as success (e.g. [{ from: 200, to: 299 }]).
    ranges: z.array(HttpStatusRangeSchema).max(10).optional(),
  })
  .refine(
    (c) => (c.statuses?.length ?? 0) + (c.ranges?.length ?? 0) > 0,
    "successCriteria must list at least one status or range (omit the field for the 2xx default)",
  );
export type HttpSuccessCriteria = z.infer<typeof HttpSuccessCriteriaSchema>;

/** The default success window applied when a step has no explicit {@link HttpSuccessCriteriaSchema}. */
export const DEFAULT_HTTP_SUCCESS_RANGE = { from: 200, to: 299 } as const;

/**
 * Pure predicate: is `status` a SUCCESS under `criteria`? With no criteria, the 2xx default
 * ({@link DEFAULT_HTTP_SUCCESS_RANGE}) applies. Framework-agnostic so `api` (executor) and `web`
 * (builder preview) classify identically.
 */
export function isHttpStatusSuccess(
  status: number,
  criteria?: HttpSuccessCriteria,
): boolean {
  if (!criteria) {
    return (
      status >= DEFAULT_HTTP_SUCCESS_RANGE.from &&
      status <= DEFAULT_HTTP_SUCCESS_RANGE.to
    );
  }
  if (criteria.statuses?.includes(status)) {
    return true;
  }
  return (
    criteria.ranges?.some((r) => status >= r.from && status <= r.to) ?? false
  );
}

/** Backoff shape the BullMQ worker (1b-B) applies between attempts. */
export const WORKFLOW_RETRY_BACKOFF = ["fixed", "exponential"] as const;
export const WorkflowRetryBackoffSchema = z.enum(WORKFLOW_RETRY_BACKOFF);
export type WorkflowRetryBackoff = z.infer<typeof WorkflowRetryBackoffSchema>;

/**
 * RETRY POLICY for a step (after a FAILED outcome, before the `onFailure` edge fires). The contract
 * only CARRIES the policy — the BullMQ worker executes the attempts in 1b-B (mapping `maxAttempts`/
 * `backoff`/`delayMs` onto its `attempts` + `backoff` options). Bounded to keep a misconfiguration from
 * hammering a third party. A retry still only happens when the handler marked the failure `retryable`
 * (transient AND, for a create, idempotent — the zitadel-management posture); `maxAttempts` caps HOW
 * MANY, the handler gates WHETHER. Omitting `retry` ⇒ {@link DEFAULT_RETRY_POLICY} (a single attempt).
 */
export const RetryPolicySchema = z.strictObject({
  // TOTAL attempts including the first (1 = no retry).
  maxAttempts: int4({ min: 1, max: 10 }).default(1),
  backoff: WorkflowRetryBackoffSchema.default("exponential"),
  // Base delay in ms between attempts (the worker scales it per `backoff`). ≤ 1h.
  delayMs: int4({ min: 0, max: 3_600_000 }).default(1000),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/** The engine default when a step omits `retry`: a single attempt (opt in to retries explicitly). */
export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 1,
  backoff: "exponential",
  delayMs: 1000,
} as const satisfies RetryPolicy;

/**
 * Terminal transition targets — a FINITE, opinionated set (NO arbitrary boolean / business
 * conditions; the n8n free-form canvas was explicitly rejected for v1, ADR-0054 §8).
 *
 *  - `END_SUCCESS`  — the success terminal: the run reached its goal → status SUCCEEDED.
 *  - `ESCALATE_TO_MANUAL` — spawn a ManualTask and PAUSE the run (status AWAITING_INPUT).
 *  - `COMPENSATE`   — run the saga compensations for already-succeeded steps (status COMPENSATED).
 *  - `STOP_FAIL`    — terminate the run (status FAILED) and emit the `workflow.run_failed` alert.
 *
 * `onSuccess` may target a step key OR `END_SUCCESS`. `onFailure` may target a step key (an alert /
 * compensation / error-handler step) OR one of the three failure terminals. These tokens are RESERVED
 * — a step `key` may not collide with one (enforced in {@link WorkflowStepsSchema}).
 */
export const WORKFLOW_END_SUCCESS = "END_SUCCESS" as const;
export const WORKFLOW_ESCALATE_TO_MANUAL = "ESCALATE_TO_MANUAL" as const;
export const WORKFLOW_COMPENSATE = "COMPENSATE" as const;
export const WORKFLOW_STOP_FAIL = "STOP_FAIL" as const;

export const WORKFLOW_SUCCESS_TERMINALS = [WORKFLOW_END_SUCCESS] as const;
export const WORKFLOW_FAILURE_TERMINALS = [
  WORKFLOW_ESCALATE_TO_MANUAL,
  WORKFLOW_COMPENSATE,
  WORKFLOW_STOP_FAIL,
] as const;
export const WORKFLOW_TRANSITION_TERMINALS = [
  ...WORKFLOW_SUCCESS_TERMINALS,
  ...WORKFLOW_FAILURE_TERMINALS,
] as const;
/** Tokens a step `key` may NOT equal (they are transition sentinels, not nodes). */
export const WORKFLOW_RESERVED_TRANSITION_TARGETS = WORKFLOW_TRANSITION_TERMINALS;

export const WorkflowSuccessTerminalSchema = z.enum(WORKFLOW_SUCCESS_TERMINALS);
export type WorkflowSuccessTerminal = z.infer<
  typeof WorkflowSuccessTerminalSchema
>;
export const WorkflowFailureTerminalSchema = z.enum(WORKFLOW_FAILURE_TERMINALS);
export type WorkflowFailureTerminal = z.infer<
  typeof WorkflowFailureTerminalSchema
>;
export type WorkflowTransitionTerminal =
  (typeof WORKFLOW_TRANSITION_TERMINALS)[number];

/**
 * The first-class success/failure EDGES every step carries (optional — the degenerate linear case
 * leaves them unset). A target is either another step's `key` or a terminal token (validated as a
 * whole graph in {@link WorkflowStepsSchema}). Resolution of the EFFECTIVE edges (defaults + legacy
 * `onError`) is {@link resolveStepTransitions} — the single source the 1b-B orchestrator implements.
 */
const stepGraphShape = {
  // Success edge: a step `key`, or `END_SUCCESS`. Unset ⇒ the next step in order, else `END_SUCCESS`.
  onSuccess: z.string().trim().min(1).max(100).optional(),
  // Failure edge (after retries): a step `key`, or a failure terminal. Unset ⇒ legacy `onError`, else
  // `STOP_FAIL`.
  onFailure: z.string().trim().min(1).max(100).optional(),
} as const;

/** The HTTP-outbound-only step fields (REST / WEBHOOK_OUT): success window + retry policy. */
const httpOutboundShape = {
  successCriteria: HttpSuccessCriteriaSchema.optional(),
  retry: RetryPolicySchema.optional(),
} as const;

/** A REST step: call the connection's API with a logic-less data mapping. */
export const RestStepSchema = z.strictObject({
  kind: z.literal("REST"),
  key: stepKey,
  name: z.string().trim().min(1).max(200).optional(),
  connectionId: z.cuid(),
  method: WorkflowHttpMethodSchema,
  // Path appended to the connection's baseUrl (templated, logic-less). Keep relative.
  path: z.string().trim().min(1).max(2048),
  dataMapping: WorkflowDataMappingSchema.optional(),
  // Whether the external operation is idempotent (a retried create must not double-provision).
  idempotent: z.boolean().default(false),
  // Per-step success window (default 2xx) + retry policy. See {@link httpOutboundShape}.
  ...httpOutboundShape,
  // First-class success/failure edges (default linear; see {@link stepGraphShape}).
  ...stepGraphShape,
  // LEGACY fallback when `onFailure` is unset (mapped by {@link resolveStepTransitions}).
  onError: WorkflowStepOnErrorSchema.default("fail"),
});
export type RestStep = z.infer<typeof RestStepSchema>;

/** A WEBHOOK_OUT step: fire the connection's signed outbound webhook. */
export const WebhookOutStepSchema = z.strictObject({
  kind: z.literal("WEBHOOK_OUT"),
  key: stepKey,
  name: z.string().trim().min(1).max(200).optional(),
  connectionId: z.cuid(),
  dataMapping: WorkflowDataMappingSchema.optional(),
  // Per-step success window (default 2xx) + retry policy. See {@link httpOutboundShape}.
  ...httpOutboundShape,
  // First-class success/failure edges (default linear; see {@link stepGraphShape}).
  ...stepGraphShape,
  // LEGACY fallback when `onFailure` is unset (mapped by {@link resolveStepTransitions}).
  onError: WorkflowStepOnErrorSchema.default("fail"),
});
export type WebhookOutStep = z.infer<typeof WebhookOutStepSchema>;

/** A MANUAL step: pause the run, ask a human for typed input via the bell/SSE inbox. */
export const ManualStepSchema = z.strictObject({
  kind: z.literal("MANUAL"),
  key: stepKey,
  name: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(2000),
  // The typed input form the human fills. The completion value is validated against this.
  inputFields: z.array(ManualInputFieldSchema).min(1).max(25),
  // Optional cohort the task is offered to (a role/team label) when not directly assigned.
  cohort: z.string().trim().min(1).max(100).optional(),
  // First-class edges: completion → `onSuccess`; cancellation → `onFailure`. A MANUAL step has no
  // HTTP success window / retry; it has no legacy `onError` (unset `onFailure` ⇒ STOP_FAIL).
  ...stepGraphShape,
});
export type ManualStep = z.infer<typeof ManualStepSchema>;

/** The v1 step union (REST | WEBHOOK_OUT | MANUAL), discriminated on `kind`. */
export const WorkflowStepSchema = z.discriminatedUnion("kind", [
  RestStepSchema,
  WebhookOutStepSchema,
  ManualStepSchema,
]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/**
 * Resolve a step's EFFECTIVE success/failure edges — the SINGLE source of truth the 1b-B orchestrator
 * implements (and the same logic {@link WorkflowStepsSchema} uses for acyclicity). Precedence:
 *
 *  - `onSuccess` (explicit) ▸ else the NEXT step's `key` in array order ▸ else `END_SUCCESS` (last).
 *  - `onFailure` (explicit) ▸ else legacy `onError` mapped (`continue` → the success edge,
 *    `manual` → `ESCALATE_TO_MANUAL`, `fail` → `STOP_FAIL`) ▸ else `STOP_FAIL`.
 *
 * The degenerate linear case (no explicit edges, no `onError`) therefore means "onSuccess → next step,
 * onFailure → STOP_FAIL" — a plain ordered sequence is just the degenerate DAG. Targets are returned
 * verbatim (a step `key` or a terminal token); the caller dispatches on the terminals.
 */
export function resolveStepTransitions(
  steps: readonly WorkflowStep[],
  index: number,
): { onSuccess: string; onFailure: string } {
  const step = steps[index];
  if (!step) {
    // Out-of-range index — inert terminals. Never reached in practice (callers iterate in range);
    // present only to satisfy strict index access.
    return { onSuccess: WORKFLOW_END_SUCCESS, onFailure: WORKFLOW_STOP_FAIL };
  }
  const nextStep = steps[index + 1];
  const onSuccess =
    step.onSuccess ?? (nextStep ? nextStep.key : WORKFLOW_END_SUCCESS);

  let onFailure: string;
  if (step.onFailure !== undefined) {
    onFailure = step.onFailure;
  } else if ("onError" in step && step.onError === "continue") {
    // `continue` = ignore the failure and take the success edge (fall through).
    onFailure = onSuccess;
  } else if ("onError" in step && step.onError === "manual") {
    onFailure = WORKFLOW_ESCALATE_TO_MANUAL;
  } else {
    // `onError: "fail"`, or a kind without `onError` (MANUAL): hard-stop the run.
    onFailure = WORKFLOW_STOP_FAIL;
  }
  return { onSuccess, onFailure };
}

/**
 * The step graph embedded in a WorkflowVersion (the immutable, replayable definition) — an OPINIONATED
 * ERROR-HANDLING DAG (ADR-0054 §8). The array ORDER defines the entry node (index 0) and the default
 * linear fall-through; explicit `onSuccess`/`onFailure` edges layer error handling on top. Validation:
 *
 *  1. ≥ 1 step, ≤ 50 steps.
 *  2. step `key`s are UNIQUE within a version (a WorkflowStepRun references a step by key).
 *  3. no step `key` collides with a reserved terminal token (END_SUCCESS / STOP_FAIL / …).
 *  4. every explicit `onSuccess` targets a known `key` or `END_SUCCESS`; every explicit `onFailure`
 *     targets a known `key` or a failure terminal.
 *  5. the EFFECTIVE graph ({@link resolveStepTransitions}) is ACYCLIC — no transition cycle.
 */
export const WorkflowStepsSchema = z
  .array(WorkflowStepSchema)
  .min(1, "A workflow needs at least one step")
  .max(50, "A workflow has at most 50 steps")
  .refine(
    (steps) => new Set(steps.map((s) => s.key)).size === steps.length,
    "Step keys must be unique within a version",
  )
  .superRefine((steps, ctx) => {
    const keys = new Set(steps.map((s) => s.key));
    const reserved = new Set<string>(WORKFLOW_RESERVED_TRANSITION_TARGETS);
    const failureTerminals = new Set<string>(WORKFLOW_FAILURE_TERMINALS);

    // (3) a step key may not be a transition sentinel.
    steps.forEach((s, i) => {
      if (reserved.has(s.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Step key "${s.key}" collides with a reserved transition target`,
          path: [i, "key"],
          input: s.key,
        });
      }
    });

    // (4) explicit edge targets must resolve to a known node or the right kind of terminal.
    steps.forEach((s, i) => {
      if (
        s.onSuccess !== undefined &&
        s.onSuccess !== WORKFLOW_END_SUCCESS &&
        !keys.has(s.onSuccess)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `onSuccess "${s.onSuccess}" is not a known step key or END_SUCCESS`,
          path: [i, "onSuccess"],
          input: s.onSuccess,
        });
      }
      if (
        s.onFailure !== undefined &&
        !failureTerminals.has(s.onFailure) &&
        !keys.has(s.onFailure)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `onFailure "${s.onFailure}" is not a known step key or a failure terminal (${WORKFLOW_FAILURE_TERMINALS.join(" | ")})`,
          path: [i, "onFailure"],
          input: s.onFailure,
        });
      }
    });

    // (5) acyclicity over the EFFECTIVE step-key edges (terminals are sinks, not nodes).
    const indexByKey = new Map(steps.map((s, i) => [s.key, i]));
    const adjacency: number[][] = steps.map((_, i) => {
      const { onSuccess, onFailure } = resolveStepTransitions(steps, i);
      const out: number[] = [];
      for (const target of [onSuccess, onFailure]) {
        const j = indexByKey.get(target);
        if (j !== undefined) {
          out.push(j);
        }
      }
      return out;
    });

    // Iterative DFS three-colour cycle detection (white = 0, gray = 1, black = 2).
    const color = new Array<number>(steps.length).fill(0);
    let hasCycle = false;
    for (let start = 0; start < steps.length && !hasCycle; start++) {
      if (color[start] !== 0) {
        continue;
      }
      const stack: Array<{ node: number; next: number }> = [
        { node: start, next: 0 },
      ];
      color[start] = 1;
      while (stack.length > 0 && !hasCycle) {
        const frame = stack[stack.length - 1];
        if (!frame) {
          break;
        }
        const edges = adjacency[frame.node] ?? [];
        if (frame.next < edges.length) {
          const child = edges[frame.next];
          frame.next += 1;
          if (child === undefined) {
            continue;
          }
          if (color[child] === 1) {
            hasCycle = true;
          } else if (color[child] === 0) {
            color[child] = 1;
            stack.push({ node: child, next: 0 });
          }
        } else {
          color[frame.node] = 2;
          stack.pop();
        }
      }
    }
    if (hasCycle) {
      ctx.addIssue({
        code: "custom",
        message:
          "The workflow step graph must be acyclic — a transition cycle was detected",
        input: steps,
      });
    }
  });
export type WorkflowSteps = z.infer<typeof WorkflowStepsSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entity wire shapes (reads) + write DTOs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** ApplicationWorkflow — the opt-in binding (read shape). */
export const ApplicationWorkflowSchema = z.object({
  id: z.cuid(),
  applicationId: z.cuid(),
  trigger: WorkflowTriggerSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  enabled: z.boolean(),
  deprovisionPolicy: WorkflowDeprovisionPolicySchema,
  // The dedicated least-privilege engine ServiceAccount the workflow executes AS (null until set).
  executedAsServiceAccountId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type ApplicationWorkflow = z.infer<typeof ApplicationWorkflowSchema>;

/** Create an ApplicationWorkflow. v1 trigger subset only; disabled by default until configured. */
export const CreateApplicationWorkflowSchema = z.strictObject({
  applicationId: z.cuid(),
  trigger: WorkflowTriggerV1Schema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().default(false),
  deprovisionPolicy: WorkflowDeprovisionPolicySchema.default(
    DEFAULT_DEPROVISION_POLICY,
  ),
  executedAsServiceAccountId: z.cuid().optional(),
});
export type CreateApplicationWorkflow = z.infer<
  typeof CreateApplicationWorkflowSchema
>;

/** Patch an ApplicationWorkflow (the trigger + application are immutable — recreate to change them). */
export const UpdateApplicationWorkflowSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable(),
    enabled: z.boolean(),
    deprovisionPolicy: WorkflowDeprovisionPolicySchema,
    executedAsServiceAccountId: z.cuid().nullable(),
  })
  .partial();
export type UpdateApplicationWorkflow = z.infer<
  typeof UpdateApplicationWorkflowSchema
>;

/** WorkflowConnection — the per-app connector instance (read shape). `config` is validated per kind. */
export const WorkflowConnectionSchema = z.object({
  id: z.cuid(),
  applicationId: z.cuid(),
  kind: WorkflowConnectionKindSchema,
  name: z.string().min(1),
  config: WorkflowConnectionConfigSchema,
  // Whether a credential is configured (the redacted secret descriptor — NEVER the secret itself).
  secretId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type WorkflowConnection = z.infer<typeof WorkflowConnectionSchema>;

/** Create a WorkflowConnection. `config.kind` must equal the connection `kind` (enforced by refine). */
export const CreateWorkflowConnectionSchema = z
  .strictObject({
    applicationId: z.cuid(),
    kind: z.enum(WORKFLOW_CONNECTION_KINDS_V1),
    name: z.string().trim().min(1).max(120),
    config: WorkflowConnectionConfigSchema,
  })
  .refine((value) => value.config.kind === value.kind, {
    error: "config.kind must match the connection kind",
    path: ["config", "kind"],
  });
export type CreateWorkflowConnection = z.infer<
  typeof CreateWorkflowConnectionSchema
>;

/**
 * WorkflowVersion — the immutable definition snapshot (read shape). `steps` is the validated discriminated
 * step list. Every WorkflowRun pins the `id`/`version` it executed.
 */
export const WorkflowVersionSchema = z.object({
  id: int4({ min: 1 }),
  workflowId: z.cuid(),
  version: int4({ min: 1 }),
  steps: WorkflowStepsSchema,
  createdById: z.uuid().nullable(),
  createdBySaId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>;

/** Author a new WorkflowVersion (the `version` number is allocated server-side, monotonically). */
export const CreateWorkflowVersionSchema = z.strictObject({
  steps: WorkflowStepsSchema,
});
export type CreateWorkflowVersion = z.infer<typeof CreateWorkflowVersionSchema>;

/**
 * WorkflowRun — one row per fired event (read shape). The execution ledger / audit trail; engine-written
 * (no client create DTO). `error` is a REDACTED failure summary (never bodies/secrets/PII).
 */
export const WorkflowRunSchema = z.object({
  id: z.cuid(),
  workflowId: z.cuid(),
  workflowVersionId: int4({ min: 1 }),
  applicationId: z.cuid(),
  trigger: WorkflowTriggerSchema,
  accessGrantId: z.cuid().nullable(),
  idempotencyKey: z.string().min(1),
  // The replay sequence within (trigger, accessGrantId): 0 = the natural grant-derived run; each manual
  // replay-latest (ADR-0057) increments it. The full key is `<trigger>:<accessGrantId>:<replaySeq>`.
  replaySeq: int4({ min: 0 }),
  // Lineage (ADR-0057): the parent run a replay-latest cloned FROM (null for an organic grant run).
  supersedesRunId: z.cuid().nullable(),
  status: WorkflowRunStatusSchema,
  triggeredById: z.uuid().nullable(),
  triggeredBySaId: z.cuid().nullable(),
  executedAsServiceAccountId: z.cuid().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

/**
 * WorkflowStepRun — one append-only row per step ATTEMPT (read shape). `metadata` is REDACTED outcome
 * data only (status code, duration, error class, mapped field names) — never bodies/secrets/PII.
 */
export const WorkflowStepRunSchema = z.object({
  id: int4({ min: 1 }),
  runId: z.cuid(),
  stepIndex: int4({ min: 0 }),
  stepKey: z.string().min(1),
  attempt: int4({ min: 1 }),
  status: WorkflowStepRunStatusSchema,
  externalCorrelationId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});
export type WorkflowStepRun = z.infer<typeof WorkflowStepRunSchema>;

/** ManualTask — human-in-the-loop step (read shape). */
export const ManualTaskSchema = z.object({
  id: z.cuid(),
  runId: z.cuid(),
  stepKey: z.string().min(1),
  assigneeId: z.uuid().nullable(),
  cohort: z.string().nullable(),
  prompt: z.string().min(1),
  // The human-provided values (may contain PII — sensitive, never logged). Null until completed.
  input: z.record(z.string(), z.unknown()).nullable(),
  status: ManualTaskStatusSchema,
  completedById: z.uuid().nullable(),
  completedBySaId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ManualTask = z.infer<typeof ManualTaskSchema>;

/**
 * Complete a ManualTask: the typed `input` the human filled. Validated against the step's `inputFields`
 * by the Phase 1b service; the contract here just bounds the envelope. Treated as UNTRUSTED data — never
 * an expression (no SSTI), redaction-sensitive (may carry PII).
 */
export const CompleteManualTaskSchema = z.strictObject({
  input: z.record(z.string().min(1).max(100), z.unknown()),
});
export type CompleteManualTask = z.infer<typeof CompleteManualTaskSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Retry-after-fix & replay (ADR-0057) — the manual-retry override + the clone-to-new-run contracts
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * OPTION 2 (ADR-0057) — the OPTIONAL, request-scoped payload override for the manual
 * `POST /workflow-runs/:id/retry`. Each entry overrides ONE mapped field on the FAILED step for the
 * NEXT attempt ONLY: the value is a template string over the SAME frozen, allowlisted mapping context
 * the engine already exposes (`{{ grantee.lastName }}`, `application.name`, …) or a literal. It is
 * merged into the failed step's data mapping for ONE render and then DISCARDED.
 *
 * INV-6 HARD BOUNDARY: this is operator-typed input — it is NEVER persisted to `WorkflowStepRun.metadata`
 * / `WorkflowRun` / any log; only the field NAMES are ever recorded, exactly as today. A field name is
 * bounded like a data-mapping key (≤ 200) and its template like a data-mapping value (≤ 2000). The body
 * is OPTIONAL — a no-body retry keeps the unchanged resume-from-failed-step behaviour. `overrides` must
 * carry at least one field when present (an empty override is a no-op, rejected at the edge).
 */
export const RetryRunOverridesSchema = z.record(
  z.string().min(1).max(200),
  z.string().max(2000),
);
export type RetryRunOverrides = z.infer<typeof RetryRunOverridesSchema>;

export const RetryRunRequestSchema = z.strictObject({
  overrides: RetryRunOverridesSchema.refine(
    (o) => Object.keys(o).length > 0,
    "overrides must contain at least one field (omit the field for a plain retry)",
  ).optional(),
});
export type RetryRunRequest = z.infer<typeof RetryRunRequestSchema>;

/**
 * The response of `POST /workflow-runs/:id/retry` (issue #308 + ADR-0057 Option 2). On a successful
 * guarded CAS the FAILED run flips to RUNNING and resumes from the failed step's key at a new attempt;
 * the FE refetches the run detail off this. NO override value is ever echoed back (INV-6).
 */
export const RetryRunResponseSchema = z.strictObject({
  ok: z.literal(true),
  runId: z.cuid(),
  resumeStepKey: z.string().min(1),
  attempt: int4({ min: 1 }),
});
export type RetryRunResponse = z.infer<typeof RetryRunResponseSchema>;

/**
 * The response of `POST /workflow-runs/:id/replay-latest` (ADR-0057 Option 3 — clone-to-new-run from
 * the LATEST workflow version). A NEW run is created on the same (application, accessGrant, trigger) at
 * the latest version, keyed `<trigger>:<accessGrantId>:<replaySeq>` (replaySeq = parent's + 1), with
 * `supersedesRunId` set to the source FAILED run; it is enqueued via the same normal fire path. The
 * source run stays FAILED and immutable. The FE navigates to `runId` (the new run).
 */
export const ReplayLatestResponseSchema = z.strictObject({
  ok: z.literal(true),
  // The id of the NEW run created on the latest version (where the FE should navigate).
  runId: z.cuid(),
  // The source FAILED run this clone supersedes (echoed for the lineage breadcrumb).
  supersedesRunId: z.cuid(),
  // The version the clone pinned (the latest at replay time) + its sequence number.
  workflowVersionId: int4({ min: 1 }),
  replaySeq: int4({ min: 1 }),
});
export type ReplayLatestResponse = z.infer<typeof ReplayLatestResponseSchema>;

/**
 * WorkflowSecret — the engine's own encrypted credential store (REDACTED read shape). The ciphertext /
 * IV / auth tag / cleartext are NEVER on a wire shape (INV-6); the read only confirms a credential is
 * `configured` and shows a recognisable `label`, mirroring the service-account `tokenPrefix` pattern.
 */
export const WorkflowSecretSchema = z.object({
  id: z.cuid(),
  applicationId: z.cuid(),
  connectionId: z.cuid().nullable(),
  label: z.string().min(1),
  keyVersion: int4({ min: 1 }),
  configured: z.literal(true),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type WorkflowSecret = z.infer<typeof WorkflowSecretSchema>;

/**
 * Create / set a WorkflowSecret: the CLEARTEXT `value` (encrypted server-side with AES-256-GCM, never
 * persisted in cleartext, never returned — write-only). The response is the redacted
 * {@link WorkflowSecretSchema}.
 */
export const CreateWorkflowSecretSchema = z.strictObject({
  applicationId: z.cuid(),
  connectionId: z.cuid().optional(),
  label: z.string().trim().min(1).max(120),
  value: z.string().min(1).max(8192),
});
export type CreateWorkflowSecret = z.infer<typeof CreateWorkflowSecretSchema>;
