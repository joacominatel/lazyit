import { describe, expect, test } from "bun:test";
import { UserHistoryEventTypeSchema } from "./user-history";

// ADR-0058 — MANAGER_CHANGED joins the UserHistory event-type enum (lowercased → the recent_activity
// feed verb `manager_changed`). Mirrors ROLE_CHANGED (payload `{ from, to }`, each side a user-id |
// external-name | null).
describe("UserHistoryEventTypeSchema (ADR-0058)", () => {
  test("includes MANAGER_CHANGED alongside the existing verbs", () => {
    expect(UserHistoryEventTypeSchema.options).toEqual([
      "CREATED",
      "UPDATED",
      "ROLE_CHANGED",
      "MANAGER_CHANGED",
      "DELETED",
      "RESTORED",
      "PASSWORD_RESET_SENT",
    ]);
  });

  test("accepts MANAGER_CHANGED and rejects an unknown verb", () => {
    expect(UserHistoryEventTypeSchema.safeParse("MANAGER_CHANGED").success).toBe(
      true,
    );
    expect(UserHistoryEventTypeSchema.safeParse("MANAGER_SET").success).toBe(
      false,
    );
  });
});
