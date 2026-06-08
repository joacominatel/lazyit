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

/** What to do when a step fails (governance): hard-fail the run, continue, or escalate to a human. */
export const WORKFLOW_STEP_ON_ERROR = ["fail", "continue", "manual"] as const;
export const WorkflowStepOnErrorSchema = z.enum(WORKFLOW_STEP_ON_ERROR);
export type WorkflowStepOnError = z.infer<typeof WorkflowStepOnErrorSchema>;

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
 * The ordered step graph embedded in a WorkflowVersion (the immutable, replayable definition). At
 * least one step; step keys must be UNIQUE within a version (a WorkflowStepRun references a step by
 * its key, so a duplicate would make the timeline ambiguous).
 */
export const WorkflowStepsSchema = z
  .array(WorkflowStepSchema)
  .min(1, "A workflow needs at least one step")
  .max(50, "A workflow has at most 50 steps")
  .refine(
    (steps) => new Set(steps.map((s) => s.key)).size === steps.length,
    "Step keys must be unique within a version",
  );
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
