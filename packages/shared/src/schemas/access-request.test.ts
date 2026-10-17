import { describe, expect, test } from "bun:test";
import { AccessRequestSchema, CreateAccessRequestSchema } from "./access-request";

const APP_ID = "ckq0000000000000000000001";
const PERSON = "11111111-1111-4111-8111-111111111111";

describe("CreateAccessRequestSchema", () => {
  test("accepts a self-service request with no requesterId", () => {
    expect(CreateAccessRequestSchema.safeParse({ applicationId: APP_ID }).success).toBe(true);
  });

  test("accepts a requesterId to file on someone's behalf (#1645)", () => {
    const parsed = CreateAccessRequestSchema.parse({ applicationId: APP_ID, requesterId: PERSON });
    expect(parsed.requesterId).toBe(PERSON);
  });

  test("rejects a requesterId that is not a uuid", () => {
    expect(
      CreateAccessRequestSchema.safeParse({ applicationId: APP_ID, requesterId: "ana" }).success,
    ).toBe(false);
  });
});

describe("AccessRequestSchema", () => {
  const row = {
    id: "ckq0000000000000000000002",
    requesterId: PERSON,
    applicationId: APP_ID,
    accessLevel: null,
    justification: null,
    status: "PENDING",
    decidedById: null,
    decidedAt: null,
    deniedReason: null,
    grantId: null,
    createdAt: "2026-10-17T00:00:00.000Z",
  };

  test("parses a row from an API that predates filedById", () => {
    expect(AccessRequestSchema.safeParse(row).success).toBe(true);
  });

  test("carries filedById when a request was filed on someone's behalf", () => {
    const filer = "22222222-2222-4222-8222-222222222222";
    expect(AccessRequestSchema.parse({ ...row, filedById: filer }).filedById).toBe(filer);
  });
});
