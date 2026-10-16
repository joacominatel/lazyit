import { describe, expect, test } from "bun:test";
import { AUDIT_LOG_CSV_HEADER } from "./audit-log-csv";

describe("the audit-log CSV header (INV-10)", () => {
  test("lists metadata columns only — no value/ciphertext column exists", () => {
    expect(AUDIT_LOG_CSV_HEADER).toBe(
      "occurredAt,source,action,actorName,serviceAccountName,vaultName,itemLabel,targetUserName,targetServiceAccountName,role,permission,detail",
    );
    expect(AUDIT_LOG_CSV_HEADER).not.toContain("value");
    expect(AUDIT_LOG_CSV_HEADER).not.toContain("ciphertext");
  });
});
