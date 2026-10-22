import { describe, expect, test } from "bun:test";
import {
  GRANT_PROVISIONING_STATUSES,
  GrantProvisioningSchema,
  MyAccessGrantSchema,
} from "./access-grant";
import { MyAccessGrantListPageSchema } from "./access-grant-list";
import { MyAccessRequestSchema } from "./access-request-list";

// The coarse requester-facing provisioning status (#1700, CEO decision Q2 on #1344).

const grant = {
  id: "clh1abc0000xyz0000000abcd",
  userId: "11111111-1111-4111-8111-111111111111",
  applicationId: "clh1abc0000xyz0000000abce",
  accessLevel: null,
  grantedAt: "2026-01-01T00:00:00.000Z",
  revokedAt: null,
  expiresAt: null,
  grantedById: null,
  revokedById: null,
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const request = {
  id: "clh1abc0000xyz0000000abcf",
  requesterId: "11111111-1111-4111-8111-111111111111",
  applicationId: "clh1abc0000xyz0000000abce",
  accessLevel: null,
  justification: null,
  status: "APPROVED",
  decidedById: null,
  decidedAt: "2026-01-02T00:00:00.000Z",
  deniedReason: null,
  grantId: "clh1abc0000xyz0000000abcd",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("GrantProvisioningSchema", () => {
  test("has exactly the four coarse values", () => {
    expect([...GRANT_PROVISIONING_STATUSES]).toEqual([
      "NONE",
      "IN_PROGRESS",
      "DONE",
      "WAITING_ON_IT",
    ]);
  });

  test("rejects a raw run status (no workflow detail leaks through the contract)", () => {
    for (const raw of ["FAILED", "AWAITING_INPUT", "SUCCEEDED", "RUNNING"]) {
      expect(GrantProvisioningSchema.safeParse(raw).success).toBe(false);
    }
  });
});

describe("MyAccessGrantSchema", () => {
  test("accepts a grant with a provisioning status", () => {
    expect(
      MyAccessGrantSchema.parse({ ...grant, provisioning: "DONE" }).provisioning,
    ).toBe("DONE");
  });

  test("tolerates an API that predates the field (absent)", () => {
    expect(MyAccessGrantSchema.parse(grant).provisioning).toBeUndefined();
  });

  test("parses a /mine page", () => {
    const page = MyAccessGrantListPageSchema.parse({
      items: [{ ...grant, provisioning: "WAITING_ON_IT" }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(page.items[0]?.provisioning).toBe("WAITING_ON_IT");
  });
});

describe("MyAccessRequestSchema", () => {
  test("accepts an approved request with a provisioning status", () => {
    expect(
      MyAccessRequestSchema.parse({ ...request, provisioning: "IN_PROGRESS" })
        .provisioning,
    ).toBe("IN_PROGRESS");
  });

  test("accepts null (nothing to provision) and absent (older API)", () => {
    expect(
      MyAccessRequestSchema.parse({
        ...request,
        status: "PENDING",
        grantId: null,
        provisioning: null,
      }).provisioning,
    ).toBeNull();
    expect(MyAccessRequestSchema.parse(request).provisioning).toBeUndefined();
  });
});
