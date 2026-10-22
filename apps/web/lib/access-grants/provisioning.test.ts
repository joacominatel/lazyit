import { describe, expect, test } from "bun:test";
import { GRANT_PROVISIONING_STATUSES } from "@lazyit/shared";
import { PROVISIONING_TONE, requestProvisioning } from "./provisioning";

describe("PROVISIONING_TONE", () => {
  test("gives every coarse status a tone", () => {
    for (const status of GRANT_PROVISIONING_STATUSES) {
      expect(PROVISIONING_TONE[status]).toBeDefined();
    }
  });

  test("flags waiting on IT and marks done", () => {
    expect(PROVISIONING_TONE.WAITING_ON_IT).toBe("warning");
    expect(PROVISIONING_TONE.DONE).toBe("success");
  });
});

describe("requestProvisioning", () => {
  test("shows the status of an approved request", () => {
    expect(requestProvisioning({ status: "APPROVED", provisioning: "IN_PROGRESS" })).toBe(
      "IN_PROGRESS",
    );
  });

  test("shows nothing for a pending or denied request", () => {
    expect(requestProvisioning({ status: "PENDING", provisioning: null })).toBeNull();
    expect(requestProvisioning({ status: "DENIED", provisioning: "DONE" })).toBeNull();
  });

  test("shows nothing when the API predates the field", () => {
    expect(requestProvisioning({ status: "APPROVED" })).toBeNull();
  });
});
