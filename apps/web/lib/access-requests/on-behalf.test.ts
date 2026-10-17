import { describe, expect, test } from "bun:test";
import type { Permission } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import {
  accessRequestErrorKind,
  buildAccessRequestPayload,
  canFileOnBehalf,
  filedByOther,
} from "./on-behalf";

const APP = "ckq0000000000000000000001";
const ME = "11111111-1111-4111-8111-111111111111";
const ANA = "22222222-2222-4222-8222-222222222222";

describe("canFileOnBehalf", () => {
  test("only a caller who can decide requests sees the field", () => {
    const holds = (granted: Permission[]) => (p: Permission) => granted.includes(p);
    expect(canFileOnBehalf(holds(["accessGrant:grant", "accessRequest:create"]))).toBe(true);
    expect(canFileOnBehalf(holds(["accessRequest:create", "accessRequest:read"]))).toBe(false);
  });
});

describe("buildAccessRequestPayload", () => {
  test("a request for yourself carries no requesterId", () => {
    expect(buildAccessRequestPayload({ applicationId: APP }, ME)).toEqual({ applicationId: APP });
    expect(buildAccessRequestPayload({ applicationId: APP, requesterId: "" }, ME)).toEqual({
      applicationId: APP,
    });
    expect(buildAccessRequestPayload({ applicationId: APP, requesterId: ME }, ME)).toEqual({
      applicationId: APP,
    });
    expect(buildAccessRequestPayload({ applicationId: APP, requesterId: ME }, ME.toUpperCase())).toEqual({
      applicationId: APP,
    });
  });

  test("a request for someone else names them", () => {
    expect(buildAccessRequestPayload({ applicationId: APP, requesterId: ANA }, ME)).toEqual({
      applicationId: APP,
      requesterId: ANA,
    });
    const upper = ANA.toUpperCase();
    expect(buildAccessRequestPayload({ applicationId: APP, requesterId: upper }, ME).requesterId).toBe(upper);
  });

  test("blank optionals are dropped and the rest trimmed", () => {
    expect(
      buildAccessRequestPayload(
        { applicationId: APP, accessLevel: " admin ", justification: "   " },
        ME,
      ),
    ).toEqual({ applicationId: APP, accessLevel: "admin" });
  });
});

describe("accessRequestErrorKind", () => {
  test("maps the on-behalf codes and the duplicate", () => {
    expect(
      accessRequestErrorKind(new ApiError(403, "x", { code: "ACCESS_REQUEST_ON_BEHALF_FORBIDDEN" })),
    ).toBe("onBehalfForbidden");
    expect(
      accessRequestErrorKind(new ApiError(400, "x", { code: "ACCESS_REQUEST_TARGET_UNAVAILABLE" })),
    ).toBe("targetUnavailable");
    expect(accessRequestErrorKind(new ApiError(409, "x"))).toBe("alreadyPending");
  });

  test("anything else keeps the server's message", () => {
    expect(accessRequestErrorKind(new ApiError(400, "Application not found"))).toBeNull();
    expect(accessRequestErrorKind(new ApiError(403, "x", { code: "OTHER" }))).toBeNull();
    expect(accessRequestErrorKind(new Error("network"))).toBeNull();
  });
});

describe("filedByOther", () => {
  test("names the filer only when someone else filed it", () => {
    expect(filedByOther({ requesterId: ANA, filedById: ME })).toBe(ME);
    expect(filedByOther({ requesterId: ANA, filedById: null })).toBeNull();
    expect(filedByOther({ requesterId: ANA, filedById: ANA })).toBeNull();
    expect(filedByOther({ requesterId: ANA })).toBeNull();
  });
});
