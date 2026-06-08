import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  WorkflowTriggerV1Schema,
  type ManualInputField,
  type WorkflowTrigger,
} from '@lazyit/shared';
import type { WorkflowMappingContext } from '../handlers/step-handler';
import type { TransitionTaken } from '../run/workflow-run.types';

/**
 * C4 — DRY-RUN request + result contracts (ADR-0054 §11 / frontend §8, §10). The dry-run is a PURE
 * payload-resolution preview: it walks the pinned/latest version's DAG, resolves each step's data
 * mapping against a real sample grant, and returns the would-be requests + the traversal in the SAME
 * step-shaped data the run timeline renders — making NO real external call and writing NO ledger rows.
 *
 * The request body is an api-internal shape (no shared schema yet — like the connection PATCH /
 * secret ROTATE DTOs), defined here as a strict zod object so unknown keys are rejected at the edge.
 */

/**
 * Identify the workflow EITHER by `workflowId` OR by `applicationId` + `trigger` (the live binding for
 * that app+event); a `sampleAccessGrantId` supplies the real context to resolve against; an optional
 * `simulate` forces ONE step's outcome to FAILURE so the operator can preview its failure edge
 * (escalation / compensation / stop) without provoking a real error.
 */
export const WorkflowDryRunRequestSchema = z
  .strictObject({
    workflowId: z.cuid().optional(),
    applicationId: z.cuid().optional(),
    trigger: WorkflowTriggerV1Schema.optional(),
    sampleAccessGrantId: z.cuid(),
    // v1 only previews a forced FAILURE (the success path is the default happy-path traversal).
    simulate: z
      .strictObject({
        stepKey: z.string().trim().min(1).max(100),
        outcome: z.literal('FAILURE'),
      })
      .optional(),
  })
  .refine(
    (v) => Boolean(v.workflowId) || Boolean(v.applicationId && v.trigger),
    {
      error:
        'Provide either workflowId, or both applicationId and trigger, to identify the workflow',
    },
  );
export type WorkflowDryRunInput = z.infer<typeof WorkflowDryRunRequestSchema>;
export class WorkflowDryRunDto extends createZodDto(
  WorkflowDryRunRequestSchema,
) {}

/** The per-step preview status, mirroring the run-timeline `WorkflowStepRunStatus` subset a step can show. */
export type DryRunStepStatus = 'SUCCEEDED' | 'FAILED' | 'AWAITING_INPUT';

/** The terminal the dry-run traversal ended on (the four ADR-0054 §8 transition terminals). */
export type DryRunEndState =
  | 'END_SUCCESS'
  | 'STOP_FAIL'
  | 'ESCALATE_TO_MANUAL'
  | 'COMPENSATE';

/**
 * The REDACTED would-be outbound request for a REST / WEBHOOK_OUT step (INV-6). The body is resolved
 * PURELY from the frozen mapping context (which never carries a secret); a secret-backed header value
 * is shown as a `‹secret:label›` placeholder — NEVER the real credential.
 */
export interface DryRunRequestPreview {
  kind: 'REST' | 'WEBHOOK_OUT';
  method: string;
  /** Fixed host (connection baseUrl/url) + rendered, percent-encoded relative path. Never templatable. */
  url: string;
  /** Resolved headers; any credential value is a `‹secret:label›` placeholder. */
  headers: Record<string, string>;
  /** Resolved JSON body leaves (the data mapping), for the body-carrying verbs. */
  body?: Record<string, string>;
  /** Whether the payload WOULD be HMAC-signed (WEBHOOK_OUT). */
  signed?: boolean;
}

/**
 * One step in the dry-run traversal — the SAME shape the run-timeline renders (stepKey/kind/status/
 * transitionTaken/mappedFields) plus the dry-run preview (`request` / `manual`) and any `warnings`.
 */
export interface DryRunStep {
  stepIndex: number;
  stepKey: string;
  kind: 'REST' | 'WEBHOOK_OUT' | 'MANUAL';
  name: string | null;
  /** The status this preview assumed: SUCCEEDED (happy path), FAILED (simulated), AWAITING_INPUT (manual). */
  status: DryRunStepStatus;
  /** True when this step's outcome was FORCED by the request's `simulate`. */
  simulated: boolean;
  /** The edge that WOULD be taken — the exact `transitionTaken` shape the timeline draws. */
  transitionTaken: TransitionTaken | null;
  /** The NAMES of the mapped fields (never their values — values live in `request.body`). */
  mappedFields: string[];
  /** The would-be request for a REST/WEBHOOK_OUT step; null for MANUAL. */
  request: DryRunRequestPreview | null;
  /** The rendered prompt + input form for a MANUAL step; null otherwise. */
  manual: { prompt: string; inputFields: ManualInputField[] } | null;
  /** Non-secret advisories (e.g. a missing credential / connection) the live run would hit. */
  warnings: string[];
}

/**
 * The dry-run result — a pure resolver output (NO rows written, NO external call). Carries the resolved
 * mapping `context` (allowlisted, secret-free by construction), the ordered `steps` traversal, the
 * terminal `endState`, and `wouldPause` (true when a MANUAL step pauses on the happy path). `requestId`
 * is surfaced for correlation (ADR-0031).
 */
export interface DryRunResult {
  dryRun: true;
  workflowId: string;
  /** The pinned WorkflowVersion row id the walk used (the latest version). */
  workflowVersionId: number;
  /** The monotonic version NUMBER (for display). */
  version: number;
  applicationId: string;
  trigger: WorkflowTrigger;
  sampleAccessGrantId: string;
  /** The frozen, allowlisted mapping context the payloads resolved against (no secrets). */
  context: WorkflowMappingContext;
  /** Echo of the forced-outcome request, if any. */
  simulate: { stepKey: string; outcome: 'FAILURE' } | null;
  steps: DryRunStep[];
  endState: DryRunEndState;
  /** True when the happy-path traversal crosses a MANUAL step (the real run would pause AWAITING_INPUT). */
  wouldPause: boolean;
  requestId: string;
}
