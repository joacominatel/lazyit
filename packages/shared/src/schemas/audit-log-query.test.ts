import { describe, expect, test } from "bun:test";
import {
  AUDIT_ACTIONS_BY_SOURCE,
  AUDIT_LOG_SOURCES,
  AuditLogFiltersSchema,
} from "./audit-log-query";
import { DATA_EXPORT_RESOURCES } from "./data-export";

describe("the export audit source (ADR-0103)", () => {
  test("is a source whose actions are the export resources", () => {
    expect(AUDIT_LOG_SOURCES).toContain("export");
    expect(AUDIT_ACTIONS_BY_SOURCE.export).toEqual(DATA_EXPORT_RESOURCES);
  });

  test("filters by resource, actor and service account", () => {
    const parsed = AuditLogFiltersSchema.safeParse({
      source: "export",
      action: "ACCESS_GRANTS",
      actorId: "11111111-1111-4111-8111-111111111111",
      serviceAccountId: "sa1",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects another source's action and the secret-only filters", () => {
    expect(
      AuditLogFiltersSchema.safeParse({ source: "export", action: "GRANT" })
        .success,
    ).toBe(false);
    expect(
      AuditLogFiltersSchema.safeParse({ source: "export", vaultId: "v1" })
        .success,
    ).toBe(false);
    expect(
      AuditLogFiltersSchema.safeParse({ source: "secret", action: "USERS" })
        .success,
    ).toBe(false);
  });
});
