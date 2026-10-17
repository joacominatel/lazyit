import { describe, expect, test } from "bun:test";
import type { Permission } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import {
  ceilingExceededMessage,
  ceilingExceededPermissions,
  offeredPermissions,
} from "./permission-ceiling";

const memberCan = (p: Permission) => p === "asset:read" || p === "asset:write";
const candidates: Permission[] = ["asset:read", "asset:write", "asset:delete", "infra:report", "secret:fetch"];

describe("offeredPermissions — the picker offers only what the caller's role holds (SEC-088)", () => {
  test("a delegate is offered their own verbs plus infra:report, never secret:fetch", () => {
    expect(offeredPermissions(candidates, memberCan, new Set())).toEqual([
      "asset:read",
      "asset:write",
      "infra:report",
    ]);
  });

  test("a verb the account already holds beyond the caller stays listed, so it can be removed", () => {
    expect(offeredPermissions(candidates, memberCan, new Set<Permission>(["asset:delete", "secret:fetch"]))).toEqual(
      candidates,
    );
  });

  test("an admin, holding everything, is offered everything", () => {
    expect(offeredPermissions(candidates, () => true, new Set())).toEqual(candidates);
  });

  test("nothing but the exemption is offered while the caller's permissions are unknown", () => {
    expect(offeredPermissions(candidates, () => false, new Set())).toEqual(["infra:report"]);
  });
});

const ceiling = (permissions: unknown) =>
  new ApiError(403, "A service account can only hold permissions your own role holds.", {
    statusCode: 403,
    code: "PERMISSION_CEILING_EXCEEDED",
    permissions,
  });

describe("ceilingExceededPermissions", () => {
  test("reads the refused verbs off the ceiling 403", () => {
    expect(ceilingExceededPermissions(ceiling(["asset:delete", "secret:fetch"]))).toEqual([
      "asset:delete",
      "secret:fetch",
    ]);
  });

  test("other failures are not the ceiling", () => {
    expect(ceilingExceededPermissions(new ApiError(403, "Forbidden resource"))).toBeNull();
    expect(ceilingExceededPermissions(new ApiError(403, "x", { code: "ADMIN_REQUIRED" }))).toBeNull();
    expect(ceilingExceededPermissions(new ApiError(409, "x", { code: "PERMISSION_CEILING_EXCEEDED" }))).toBeNull();
    expect(ceilingExceededPermissions(new Error("Failed to fetch"))).toBeNull();
  });
});

describe("ceilingExceededMessage", () => {
  const t = (key: string, values?: Record<string, string | number>) =>
    key === "serviceAccounts.errors.ceilingExceeded" ? `lacks: ${values?.permissions}` : `[${key}]`;

  test("names each refused verb by its label, and an unknown one by its id", () => {
    expect(ceilingExceededMessage(ceiling(["asset:delete", "future:verb"]), t)).toBe(
      "lacks: [permissionMeta.permissions.asset:delete.label], future:verb",
    );
  });

  test("is null for any other failure, which keeps the server's message", () => {
    expect(ceilingExceededMessage(new ApiError(403, "Forbidden resource"), t)).toBeNull();
  });
});
