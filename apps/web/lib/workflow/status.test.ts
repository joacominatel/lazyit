import { expect, test } from "bun:test";
import {
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STEP_RUN_STATUSES,
} from "@lazyit/shared";
import {
  grantRunState,
  grantRunTone,
  RUN_STATUS_TONE,
  runStatusTone,
  STEP_STATUS_TONE,
  stepStatusTone,
} from "./status";

/**
 * The status → tone maps must be TOTAL over the shared enums: a new run/step status added to the
 * contract (`@lazyit/shared`) without a tone here would render an undefined badge tone. These tests
 * fail the build the moment the catalog drifts.
 */
test("every run status maps to a tone", () => {
  for (const status of WORKFLOW_RUN_STATUSES) {
    expect(RUN_STATUS_TONE[status]).toBeDefined();
    expect(runStatusTone(status)).toBe(RUN_STATUS_TONE[status]);
  }
});

test("every step-run status maps to a tone", () => {
  for (const status of WORKFLOW_STEP_RUN_STATUSES) {
    expect(STEP_STATUS_TONE[status]).toBeDefined();
    expect(stepStatusTone(status)).toBe(STEP_STATUS_TONE[status]);
  }
});

test("grant chip collapses run status into the three derived states", () => {
  expect(grantRunState("SUCCEEDED")).toBe("provisioned");
  expect(grantRunState("FAILED")).toBe("needsAttention");
  expect(grantRunState("COMPENSATED")).toBe("needsAttention");
  expect(grantRunState("PENDING")).toBe("provisioning");
  expect(grantRunState("RUNNING")).toBe("provisioning");
  expect(grantRunState("AWAITING_INPUT")).toBe("provisioning");
});

test("grantRunTone is danger for needs-attention and success for provisioned", () => {
  expect(grantRunTone("FAILED")).toBe("danger");
  expect(grantRunTone("SUCCEEDED")).toBe("success");
  expect(grantRunTone("RUNNING")).toBe("info");
});
