import { expect, test } from "bun:test";
import {
  WORKFLOW_END_SUCCESS,
  WORKFLOW_ESCALATE_TO_MANUAL,
  WORKFLOW_STOP_FAIL,
  type WorkflowStep,
} from "@lazyit/shared";
import {
  applyFailureChoice,
  applySuccessChoice,
  buildSuccessCriteria,
  createStep,
  failureChoiceOf,
  nextStepKey,
  parseStatusCodes,
  successChoiceOf,
} from "./step-form";

const CONN = "ckconn00000000000000000000";

test("nextStepKey avoids collisions", () => {
  const a = createStep("REST", "step-1", CONN);
  expect(nextStepKey([a])).toBe("step-2");
  const dense = [
    createStep("REST", "step-1", CONN),
    createStep("REST", "step-2", CONN),
  ];
  expect(nextStepKey(dense)).toBe("step-3");
});

test("createStep produces valid defaults per kind", () => {
  expect(createStep("REST", "s", CONN)).toMatchObject({
    kind: "REST",
    connectionId: CONN,
    method: "POST",
  });
  expect(createStep("MANUAL", "s", CONN).kind).toBe("MANUAL");
});

test("success choice round-trips through apply + read", () => {
  const base = createStep("REST", "s", CONN);
  for (const choice of ["NEXT", "END", "GOTO"] as const) {
    const patched: WorkflowStep = {
      ...base,
      ...applySuccessChoice(choice, "step-9"),
    };
    expect(successChoiceOf(patched)).toBe(choice);
  }
  expect({ ...base, ...applySuccessChoice("END") }.onSuccess).toBe(
    WORKFLOW_END_SUCCESS,
  );
});

test("failure choice round-trips, including CONTINUE via legacy onError", () => {
  const base = createStep("REST", "s", CONN);
  const stop: WorkflowStep = { ...base, ...applyFailureChoice("STOP") };
  expect(stop.onFailure).toBe(WORKFLOW_STOP_FAIL);
  expect(failureChoiceOf(stop)).toBe("STOP");

  const escalate: WorkflowStep = { ...base, ...applyFailureChoice("ESCALATE") };
  expect(escalate.onFailure).toBe(WORKFLOW_ESCALATE_TO_MANUAL);
  expect(failureChoiceOf(escalate)).toBe("ESCALATE");

  const compensate: WorkflowStep = {
    ...base,
    ...applyFailureChoice("COMPENSATE", "step-7"),
  };
  expect(compensate.onFailure).toBe("step-7");
  expect(failureChoiceOf(compensate)).toBe("COMPENSATE");

  const cont: WorkflowStep = { ...base, ...applyFailureChoice("CONTINUE") };
  expect(cont.onFailure).toBeUndefined();
  expect(failureChoiceOf(cont)).toBe("CONTINUE");
});

test("status code parsing is bounded, deduped and sorted", () => {
  expect(parseStatusCodes("201, 200 200 204")).toEqual([200, 201, 204]);
  expect(parseStatusCodes("99, 600, abc, 200")).toEqual([200]);
  expect(buildSuccessCriteria("")).toBeUndefined();
  expect(buildSuccessCriteria("200,201")).toEqual({ statuses: [200, 201] });
});
