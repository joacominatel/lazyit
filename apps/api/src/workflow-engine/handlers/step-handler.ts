import type {
  ManualInputField,
  WorkflowConnectionConfig,
  WorkflowConnectionKind,
  WorkflowStep,
  WorkflowStepRunStatus,
  WorkflowTrigger,
} from '@lazyit/shared';

/**
 * The StepHandler contract — the executor leaf the engine CORE (Phase 1b-B) calls per step
 * (ADR-0054 §7, `docs/workflow-engine/integrations-connectors.md` §2.1).
 *
 * This file is the *contract surface* between the outbound EXECUTION PRIMITIVES (Phase 1b-A: this
 * package — handlers, secrets, mapper) and the engine CORE (Phase 1b-B: the run orchestrator, the
 * BullMQ worker, the AccessGrant trigger, the HTTP controllers). The core resolves+validates the
 * connection config, builds a frozen mapping context, supplies a `revealSecret()` accessor, then
 * calls {@link StepHandler.execute}; it consumes the returned {@link StepResult} to advance / pause /
 * fail the run and to write the append-only `WorkflowStepRun` ledger.
 *
 * Design rules baked into the contract:
 *  - **The handler is stateless and effectively-once by key.** Durability, retry SCHEDULING, step
 *    ordering and run state live in the CORE, never here. A handler signals retryability via
 *    {@link StepResult.retryable}; it never sleeps, loops or re-enqueues.
 *  - **No secret ever leaves through a result.** A handler authenticates with the revealed secret in
 *    memory for the duration of the call and returns only REDACTED outcome metadata (INV-6, ADR-0031):
 *    status code, duration, error class, mapped field NAMES, target host — never bodies, credentials
 *    or mapped PII values.
 *  - **A MANUAL step does not call out.** It returns `status: 'AWAITING_INPUT'` plus a
 *    {@link ManualTaskSpec}, signalling the CORE to create a ManualTask and PAUSE the run in Postgres
 *    (no held worker, no BullMQ job in flight).
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The frozen mapping context (`ctx`) — the ONLY data a data mapping may read
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The frozen, allowlisted context a data mapping renders against (ADR-0054 §scope; the connectors
 * design §5). The CORE assembles this server-side from the run and FREEZES it
 * ({@link freezeMappingContext}) before constructing a {@link StepContext}. The mapper can read ONLY
 * from here — there is no path to `process`, env, the DB or globals.
 *
 * SCOPE GUARDRAIL (ADR-0054 §6c → resolved by ADR-0058): exposes `grantee.{id,email,firstName,lastName}`
 * + the ADR-0058 identity fields (`legajo`, `username`, and a redaction-safe `manager` descriptor) +
 * `application` + grant context + prior step outputs. `role` / `team` / AD groups remain OUT — they pull
 * toward Identity-Governance (the anti-goal, ADR-0058 §Decision Q3). Every value here is UNTRUSTED (a
 * display name / free-form accessLevel / manual input is user-influenced), so the mapper
 * context-aware-encodes every interpolation.
 */
export interface WorkflowMappingContext {
  /** The access-lifecycle event that started the run (ACCESS_GRANTED | ACCESS_REVOKED in v1). */
  event: WorkflowTrigger;
  /**
   * The granted user — the identity fields the mapper surfaces (ADR-0058 §3). All untrusted strings.
   * `legajo` / `username` are the ADR-0058 directory fields (null when not recorded); `manager` is a
   * redaction-safe descriptor (display name + offboarded flag only — never a manager's PII beyond the
   * display name + email, INV-6).
   */
  grantee: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    /** Employee/file number (ADR-0058), or null when not recorded. */
    legajo: string | null;
    /** Directory/display handle (ADR-0058), or null when not recorded. */
    username: string | null;
    /**
     * The grantee's manager, projected to SCALAR display leaves so a connector can map e.g.
     * `{{ grantee.manager.name }}` / `{{ grantee.manager.email }}` (the dotted path resolves a scalar;
     * the object itself is never interpolated). INV-6 / ADR-0058 §3:
     *  - linked & LIVE manager  → `name` = "firstName lastName", `email` = the manager's email;
     *  - free-text fallback     → `name` = the `managerName` string, `email` = null;
     *  - no manager recorded OR the linked manager is soft-deleted (offboarded) → `name`/`email` empty
     *    (null) — never a dangling/secret leak — and `isOffboarded` flags the soft-deleted case so the
     *    builder can warn the token will render blank.
     */
    manager: {
      name: string | null;
      email: string | null;
      isOffboarded: boolean;
    };
  };
  /** The application the access is for. */
  application: {
    id: string;
    name: string;
  };
  /** The AccessGrant context. `accessLevel` is free-form/untrusted; dates are ISO-8601 strings. */
  grant: {
    id: string;
    accessLevel: string | null;
    grantedAt: string;
    expiresAt: string | null;
  };
  /**
   * Outputs of earlier steps IN THIS run, keyed by step key — e.g. a resumed MANUAL step's typed
   * input feeding a later REST step (ADR-0054: "on resume the typed input feeds later steps"). Values
   * are scalars and untrusted. Empty for the first step.
   */
  steps: Record<string, Record<string, unknown>>;
}

/**
 * Deep-freeze a mapping context so a handler / mapper cannot mutate it (defense in depth around the
 * "frozen, allowlisted ctx" rule). Returns the same object, frozen recursively. The CORE should call
 * this before handing the ctx to a handler.
 */
export function freezeMappingContext(
  ctx: WorkflowMappingContext,
): Readonly<WorkflowMappingContext> {
  const freezeDeep = (value: unknown): void => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const v of Object.values(value as Record<string, unknown>)) {
        freezeDeep(v);
      }
    }
  };
  freezeDeep(ctx);
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Inputs to a handler
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Per-attempt request metadata for correlation + bounded execution (no secrets). The CORE fills this
 * from the run/step it is advancing so a handler's redacted log/metadata can be joined to the
 * originating request (ADR-0031, `X-Request-Id`).
 */
export interface StepRequestMeta {
  /** The owning WorkflowRun id. */
  runId: string;
  /** The pinned version's stable step node key. */
  stepKey: string;
  /** The step's position in the pinned version's step list. */
  stepIndex: number;
  /** 1-based attempt number (a retry is a new WorkflowStepRun row with attempt+1). */
  attempt: number;
  /** The originating admin request id, for log correlation (ADR-0031). */
  requestId?: string;
  /** Per-attempt outbound timeout override (ms). The handler applies a sane default when omitted. */
  timeoutMs?: number;
}

/**
 * Reveal the connection's credential PLAINTEXT at call time, in memory only (INV-6). Returns `null`
 * when the connection has no credential configured (e.g. an unauthenticated REST target, or a
 * WEBHOOK_OUT with no signing secret). The CORE wires this to
 * `SecretService.revealById`. NEVER returned across an API boundary.
 */
export type RevealSecret = () => Promise<string | null>;

/**
 * Everything a handler needs to EXECUTE one step. Generic over the connection config + step shapes so
 * a concrete handler narrows them to its own kind (the CORE always pairs the right config/step with
 * the right handler via the `ConnectorRegistry`).
 */
export interface StepContext<
  TConfig extends WorkflowConnectionConfig = WorkflowConnectionConfig,
  TStep extends WorkflowStep = WorkflowStep,
> {
  /** The validated (zod-parsed) connector-instance config for this step's connection. */
  connection: TConfig;
  /** The validated step definition (from the pinned WorkflowVersion's `steps` jsonb). */
  step: TStep;
  /** Reveal the connection's credential in memory for authentication (INV-6). */
  revealSecret: RevealSecret;
  /** The frozen, allowlisted mapping context the data mapping renders against. */
  data: Readonly<WorkflowMappingContext>;
  /** Per-attempt request metadata (correlation, timeout). */
  meta: StepRequestMeta;
  /** Optional abort signal so the CORE can cancel a long outbound call. */
  signal?: AbortSignal;
}

/**
 * Inputs to a connector-level {@link StepHandler.testConnection} probe — connection config + the
 * credential accessor only (no step / no mapping ctx; a test is side-effect-free and step-agnostic).
 */
export interface TestConnectionContext<
  TConfig extends WorkflowConnectionConfig = WorkflowConnectionConfig,
> {
  connection: TConfig;
  revealSecret: RevealSecret;
  meta: Pick<StepRequestMeta, 'requestId' | 'timeoutMs'>;
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Outputs from a handler
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The terminal-or-pause outcome a handler returns. SKIPPED / COMPENSATED (the other
 * {@link WorkflowStepRunStatus} members) are CORE concerns (effectively-once short-circuit / saga
 * rollback), never returned by a handler.
 */
export type StepOutcomeStatus = Extract<
  WorkflowStepRunStatus,
  'SUCCEEDED' | 'FAILED' | 'AWAITING_INPUT'
>;

/**
 * REDACTED outcome metadata ONLY (INV-6, ADR-0031). This is persisted verbatim to
 * `WorkflowStepRun.metadata`, so it must NEVER contain request/response bodies, credentials or mapped
 * PII values — only non-secret shape/diagnostics.
 */
export interface RedactedStepMetadata {
  /** HTTP method of the outbound call, if any. */
  method?: string;
  /** Target HOST (never the full URL with query — which can carry secrets). */
  targetHost?: string;
  /** HTTP status code of the outbound call, if any. */
  statusCode?: number;
  /** Wall-clock duration of the call in ms. */
  durationMs?: number;
  /** A coarse, non-secret failure class (e.g. `http-4xx`, `http-5xx`, `network`, `egress-blocked`). */
  errorClass?: string;
  /** A short, non-secret human reason (status line / guard reason). Never a body / secret. */
  reason?: string;
  /** The NAMES (keys) of the mapped fields that were sent — never their values. */
  mappedFields?: string[];
  /** Whether an outbound payload was signed (WEBHOOK_OUT HMAC). */
  signed?: boolean;
}

/**
 * The spec a MANUAL step returns so the CORE can create a `ManualTask` and PAUSE the run
 * (`AWAITING_INPUT`). Carries the prompt, the typed input SCHEMA the human must fill (with STATIC,
 * admin-typed suggestions only — never a directory lookup, ADR-0054 §6c), and an optional cohort.
 */
export interface ManualTaskSpec {
  /** The pinned version's step node key this task corresponds to. */
  stepKey: string;
  /** The (already ctx-rendered) human-facing prompt. */
  prompt: string;
  /** The typed input form. Completion is validated against this by the CORE as untrusted input. */
  inputFields: ManualInputField[];
  /** Optional cohort the task is offered to when not directly assigned (a role/team label). */
  cohort?: string;
}

/**
 * The result of executing one step.
 *
 *  - `SUCCEEDED` — the external operation completed; `externalCorrelationId` may carry the created
 *    external id (so a later revoke deprovisions the EXACT account).
 *  - `FAILED` — the operation failed; `retryable` tells the CORE whether a transient failure may be
 *    re-attempted (mirrors the zitadel-management posture: 4xx permanent, 5xx/429/network transient —
 *    AND only when the step is idempotent, so a non-idempotent create is single-shot).
 *  - `AWAITING_INPUT` — a MANUAL step: `manualTask` is set and the run pauses in Postgres.
 */
export interface StepResult {
  status: StepOutcomeStatus;
  /** The captured external correlation id (e.g. created Jira account id). Null when none. */
  externalCorrelationId?: string | null;
  /** REDACTED outcome metadata only (INV-6). */
  metadata?: RedactedStepMetadata;
  /** Only meaningful when `status === 'FAILED'`: may the CORE retry this transient failure? */
  retryable?: boolean;
  /** Only present when `status === 'AWAITING_INPUT'` (MANUAL): the task spec the CORE must create. */
  manualTask?: ManualTaskSpec;
}

/** The outcome of a side-effect-free {@link StepHandler.testConnection} probe (redacted). */
export interface TestConnectionResult {
  ok: boolean;
  /** HTTP status of the probe, if applicable. */
  statusCode?: number;
  /** Round-trip latency in ms. */
  latencyMs?: number;
  /**
   * The non-secret PATH the probe actually targeted (the configured health path, or `/`) — surfaced so
   * the operator sees WHICH path was hit (#344). Never the host, never a credential.
   */
  probedPath?: string;
  /** A short, non-secret diagnostic reason. */
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The contract itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One connector type's executor. Selected by {@link kind} from the `ConnectorRegistry`
 * (capability-by-key, mirroring the in-tree `IdentityProvider` factory — not `instanceof`). Stateless
 * and effectively-once by key.
 */
export interface StepHandler<
  TConfig extends WorkflowConnectionConfig = WorkflowConnectionConfig,
  TStep extends WorkflowStep = WorkflowStep,
> {
  /** The connector kind this handler implements (the registry discriminator). */
  readonly kind: WorkflowConnectionKind;
  /** Perform the step and return its outcome (never throws for an expected failure — returns FAILED). */
  execute(ctx: StepContext<TConfig, TStep>): Promise<StepResult>;
  /** Optional side-effect-free connectivity/credential probe (synchronous use by the CORE). */
  testConnection?(
    ctx: TestConnectionContext<TConfig>,
  ): Promise<TestConnectionResult>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared outcome classification (the zitadel-management retry posture, mirrored)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * HTTP statuses worth a bounded retry: a transient upstream blip, NOT a permanent client error
 * (mirrors `zitadel-management.service.ts` `RETRYABLE_STATUSES`). `408` request-timeout, `429`
 * too-many-requests, and the `5xx` family. Any other `4xx` (esp. `400/401/403/404/409`) is permanent.
 */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

/** Whether a non-2xx HTTP status is a TRANSIENT upstream failure (vs a permanent client error). */
export function isTransientStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}
