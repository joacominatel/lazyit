import {
  type HttpSuccessCriteria,
  WORKFLOW_END_SUCCESS,
  WORKFLOW_ESCALATE_TO_MANUAL,
  WORKFLOW_STOP_FAIL,
  type WorkflowStep,
} from "@lazyit/shared";

/**
 * Pure form model for the workflow builder's per-step transition controls (frontend.md §3d). The
 * shared `WorkflowStep` carries the persisted edges (`onSuccess`/`onFailure` as raw step-key/terminal
 * strings + the legacy `onError`); the builder exposes them as a small CLOSED set of opinionated
 * choices. These helpers translate between the two, so the UI never has to reason about raw edge
 * strings and the round-trip (read a saved step → choices → write it back) is unit-testable. There is
 * NO business-condition primitive here — the closed choice set IS the guardrail.
 */

export type StepKind = "REST" | "WEBHOOK_OUT" | "MANUAL";

/** The success edge, as a builder choice. NEXT = the degenerate fall-through (no edge drawn). */
export type SuccessChoice = "NEXT" | "END" | "GOTO";

/** The failure edge, as a builder choice (the opinionated set: continue/escalate/compensate/stop). */
export type FailureChoice = "STOP" | "CONTINUE" | "ESCALATE" | "COMPENSATE";

/** Generate a stable, unique step key (`step-N`) not colliding with existing keys. */
export function nextStepKey(existing: readonly WorkflowStep[]): string {
  const used = new Set(existing.map((s) => s.key));
  let n = existing.length + 1;
  let key = `step-${n}`;
  while (used.has(key)) {
    n += 1;
    key = `step-${n}`;
  }
  return key;
}

/** Create a new step of `kind` with sensible defaults (a degenerate linear node, no explicit edges). */
export function createStep(
  kind: StepKind,
  key: string,
  connectionId: string,
): WorkflowStep {
  switch (kind) {
    case "REST":
      return {
        kind: "REST",
        key,
        connectionId,
        method: "POST",
        path: "/",
        idempotent: false,
        onError: "fail",
      };
    case "WEBHOOK_OUT":
      return {
        kind: "WEBHOOK_OUT",
        key,
        connectionId,
        onError: "fail",
      };
    case "MANUAL":
      return {
        kind: "MANUAL",
        key,
        prompt: "",
        inputFields: [
          { name: "value", label: "Value", type: "text", required: true },
        ],
      };
  }
}

/** Read a step's success edge back into a builder choice. */
export function successChoiceOf(step: WorkflowStep): SuccessChoice {
  if (step.onSuccess === WORKFLOW_END_SUCCESS) return "END";
  if (step.onSuccess) return "GOTO";
  return "NEXT";
}

/** Read a step's failure edge back into a builder choice. */
export function failureChoiceOf(step: WorkflowStep): FailureChoice {
  if (step.onFailure === WORKFLOW_ESCALATE_TO_MANUAL) return "ESCALATE";
  if (step.onFailure === WORKFLOW_STOP_FAIL) return "STOP";
  // A step-key failure target = jump to a compensation/error-handler step.
  if (step.onFailure) return "COMPENSATE";
  // No explicit onFailure: fall back to the legacy onError (REST/WEBHOOK only).
  if ("onError" in step) {
    if (step.onError === "continue") return "CONTINUE";
    if (step.onError === "manual") return "ESCALATE";
  }
  return "STOP";
}

/** The compensation target step key when the failure choice is COMPENSATE, else undefined. */
export function compensationKeyOf(step: WorkflowStep): string | undefined {
  return failureChoiceOf(step) === "COMPENSATE"
    ? (step.onFailure ?? undefined)
    : undefined;
}

/** The explicit GOTO target step key when the success choice is GOTO, else undefined. */
export function gotoKeyOf(step: WorkflowStep): string | undefined {
  return successChoiceOf(step) === "GOTO" ? (step.onSuccess ?? undefined) : undefined;
}

/** Apply a success-edge choice onto a step, returning the `onSuccess` patch. */
export function applySuccessChoice(
  choice: SuccessChoice,
  gotoKey?: string,
): { onSuccess: string | undefined } {
  switch (choice) {
    case "NEXT":
      return { onSuccess: undefined };
    case "END":
      return { onSuccess: WORKFLOW_END_SUCCESS };
    case "GOTO":
      return { onSuccess: gotoKey };
  }
}

/**
 * Apply a failure-edge choice onto a step. Returns the `onFailure` value plus, for REST/WEBHOOK steps,
 * the legacy `onError` (CONTINUE is expressed via `onError: "continue"` with `onFailure` unset, since
 * the shared resolver maps that to "take the success edge"). MANUAL steps have no `onError`.
 */
export function applyFailureChoice(
  choice: FailureChoice,
  compensateKey?: string,
): { onFailure: string | undefined; onError?: "fail" | "continue" } {
  switch (choice) {
    case "STOP":
      return { onFailure: WORKFLOW_STOP_FAIL, onError: "fail" };
    case "ESCALATE":
      return { onFailure: WORKFLOW_ESCALATE_TO_MANUAL, onError: "fail" };
    case "COMPENSATE":
      return { onFailure: compensateKey, onError: "fail" };
    case "CONTINUE":
      return { onFailure: undefined, onError: "continue" };
  }
}

/** Parse a comma/space separated status-code list (e.g. "200, 201 204") into a sorted unique array. */
export function parseStatusCodes(input: string): number[] {
  const codes = input
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599);
  return [...new Set(codes)].sort((a, b) => a - b);
}

/** Format a step's success criteria's explicit statuses back into the input string. */
export function formatStatusCodes(criteria: HttpSuccessCriteria | undefined): string {
  return (criteria?.statuses ?? []).join(", ");
}

/**
 * Build the `successCriteria` value from a status-code input: an explicit `{ statuses }` when codes are
 * given, else `undefined` (the engine applies its 2xx default). Ranges are not authored in v1.
 */
export function buildSuccessCriteria(
  input: string,
): HttpSuccessCriteria | undefined {
  const statuses = parseStatusCodes(input);
  return statuses.length > 0 ? { statuses } : undefined;
}
