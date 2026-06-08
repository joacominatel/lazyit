import type { WorkflowRunStatus, WorkflowStepRunStatus } from "@lazyit/shared";
import type { StatusTone } from "@/components/ui/status-badge";

/**
 * Pure status → tone mappings for the Applications Workflow Engine surfaces (ADR-0049 §4 — the five
 * AA-safe `StatusBadge` tones are the only place a status colour is decided). Kept framework-free and
 * label-free: components translate the enum value via the `workflow` i18n namespace
 * (`t(\`runStatus.${status}\`)`), these helpers only decide the colour, so the mapping is unit-testable.
 */

/** Run-level state → badge tone. AWAITING_INPUT is "needs a human" (warning), FAILED is danger. */
export const RUN_STATUS_TONE: Record<WorkflowRunStatus, StatusTone> = {
  PENDING: "neutral",
  RUNNING: "info",
  AWAITING_INPUT: "warning",
  SUCCEEDED: "success",
  FAILED: "danger",
  COMPENSATED: "warning",
};

/** Per-attempt step-run state → badge tone. */
export const STEP_STATUS_TONE: Record<WorkflowStepRunStatus, StatusTone> = {
  SUCCEEDED: "success",
  FAILED: "danger",
  AWAITING_INPUT: "warning",
  SKIPPED: "neutral",
  COMPENSATED: "warning",
};

export function runStatusTone(status: WorkflowRunStatus): StatusTone {
  return RUN_STATUS_TONE[status];
}

export function stepStatusTone(status: WorkflowStepRunStatus): StatusTone {
  return STEP_STATUS_TONE[status];
}

/** The three derived states the grant↔run cross-link chip (§7c) collapses a run status into. */
export type GrantRunState = "provisioned" | "provisioning" | "needsAttention";

/**
 * Collapse a run status into the grant chip's three states: a SUCCEEDED run is "provisioned ✓", a
 * FAILED/COMPENSATED run "needs attention ✗", and an in-flight (PENDING/RUNNING/AWAITING_INPUT) run is
 * "provisioning…". Pure so the chip and its test agree.
 */
export function grantRunState(status: WorkflowRunStatus): GrantRunState {
  switch (status) {
    case "SUCCEEDED":
      return "provisioned";
    case "FAILED":
    case "COMPENSATED":
      return "needsAttention";
    default:
      return "provisioning";
  }
}

/** Tone for each derived grant-chip state. */
export const GRANT_RUN_STATE_TONE: Record<GrantRunState, StatusTone> = {
  provisioned: "success",
  provisioning: "info",
  needsAttention: "danger",
};

export function grantRunTone(status: WorkflowRunStatus): StatusTone {
  return GRANT_RUN_STATE_TONE[grantRunState(status)];
}
