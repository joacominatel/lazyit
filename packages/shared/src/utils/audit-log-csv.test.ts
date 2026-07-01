import { describe, expect, test } from "bun:test";
import type { AuditLogItem } from "../schemas/audit-log-query";
import {
  AUDIT_LOG_CSV_HEADER,
  auditLogCsvRow,
  auditLogToCsv,
} from "./audit-log-csv";

/**
 * Unit spec for the audit-log CSV util (issue #871). Focuses on the output-boundary security guard
 * reused from `recent-activity-csv.ts` (RFC-4180 + spreadsheet formula-injection) and the fact that
 * a secret row carries ONLY metadata — there is no value/ciphertext column at all (INV-10).
 */

function row(overrides: Partial<AuditLogItem>): AuditLogItem {
  return {
    id: 1,
    source: "secret",
    occurredAt: "2026-06-30T12:00:00.000Z",
    action: "ITEM_REVEALED",
    actorId: null,
    actorName: null,
    serviceAccountId: null,
    serviceAccountName: null,
    vaultId: null,
    vaultName: null,
    itemId: null,
    itemLabel: null,
    targetUserId: null,
    targetUserName: null,
    targetServiceAccountId: null,
    targetServiceAccountName: null,
    role: null,
    permission: null,
    detail: null,
    ...overrides,
  };
}

describe("auditLogCsvRow — output-boundary guards", () => {
  test("defuses a spreadsheet formula-injection in a resolved name", () => {
    const line = auditLogCsvRow(row({ actorName: "=cmd|/c calc" }));
    // Leading '=' neutralized with a single quote (then quote-wrapped is not needed — no comma/quote).
    expect(line).toContain("'=cmd|/c calc");
  });

  test("RFC-4180 quote-wraps a cell with comma/quote/newline", () => {
    const line = auditLogCsvRow(row({ vaultName: 'a,b "q"\nz' }));
    expect(line).toContain('"a,b ""q""\nz"');
  });

  test("a null metadata field serializes to an empty cell (no crash)", () => {
    const line = auditLogCsvRow(row({ vaultName: null, itemLabel: null }));
    expect(line.startsWith("2026-06-30T12:00:00.000Z,secret,ITEM_REVEALED,")).toBe(
      true,
    );
  });
});

describe("auditLogToCsv — document shape (INV-10)", () => {
  test("header lists metadata columns only — no value/ciphertext column exists", () => {
    expect(AUDIT_LOG_CSV_HEADER).toBe(
      "occurredAt,source,action,actorName,serviceAccountName,vaultName,itemLabel,targetUserName,targetServiceAccountName,role,permission,detail",
    );
    // No column can ever carry a secret value: the header has no such field.
    expect(AUDIT_LOG_CSV_HEADER).not.toContain("value");
    expect(AUDIT_LOG_CSV_HEADER).not.toContain("ciphertext");
  });

  test("emits a header line + one line per row", () => {
    const doc = auditLogToCsv([
      row({ vaultName: "Prod DB", itemLabel: "root pw" }),
      row({ source: "permission", action: "GRANT", role: "MEMBER", permission: "asset:read" }),
    ]);
    const lines = doc.split("\n");
    expect(lines[0]).toBe(AUDIT_LOG_CSV_HEADER);
    expect(lines).toHaveLength(3);
  });
});
