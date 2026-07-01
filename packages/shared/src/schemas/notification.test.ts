import { describe, expect, test } from "bun:test";
import {
  MarkReadResultSchema,
  NOTIFICATION_TYPES,
  NotificationPageSchema,
  NotificationSchema,
  NotificationTypeSchema,
  UnreadCountSchema,
} from "./notification";

// In-app notification bell (ADR-0056). These guard the WIRE shapes `api` (emit) and `web` (render)
// agree on: the closed type catalog, the per-item shape (incl. the per-caller `read` flag), the
// Page<Notification> envelope, the unread-count and the mark-read result.

describe("Notification type catalog (catalog-as-code)", () => {
  test("the enum mirrors NOTIFICATION_TYPES exactly", () => {
    expect(NotificationTypeSchema.options).toEqual([...NOTIFICATION_TYPES]);
  });

  test("the v1 triggers are present", () => {
    for (const t of [
      "critical_app_access",
      "admin_granted",
      "low_stock",
      "workflow.manual_task",
      "workflow.run_failed",
    ]) {
      expect(NOTIFICATION_TYPES).toContain(t as (typeof NOTIFICATION_TYPES)[number]);
    }
  });

  test("the targeted vault-setup nudge type is present (ADR-0056 amendment, #453)", () => {
    expect(NOTIFICATION_TYPES).toContain("secret.vault_setup");
  });

  test("the sensitive-audit alert types are present (ADR-0056 amendment, #852)", () => {
    expect(NOTIFICATION_TYPES).toContain("permission_widened");
    expect(NOTIFICATION_TYPES).toContain("infra.agent_offline");
  });

  test("rejects an unknown type literal", () => {
    expect(NotificationTypeSchema.safeParse("nope").success).toBe(false);
    expect(NotificationTypeSchema.safeParse("workflow.unknown").success).toBe(
      false,
    );
  });
});

describe("NotificationSchema (one bell row)", () => {
  const base = {
    id: "ckxnotif0001",
    type: "low_stock" as const,
    severity: "warning" as const,
    title: "HDMI cables are low",
    summary: "3 left (minimum 5)",
    entityType: "consumable" as const,
    entityId: "ckxcons0001",
    targetUserId: null,
    recipientUserId: null,
    metadata: { name: "HDMI cable", currentStock: 3 },
    read: false,
    createdAt: "2026-06-09T12:00:00.000Z",
  };

  test("accepts a well-formed row", () => {
    expect(NotificationSchema.safeParse(base).success).toBe(true);
  });

  test("allows null entity link, summary, target user and metadata (a no-deep-link nudge)", () => {
    const result = NotificationSchema.safeParse({
      ...base,
      summary: null,
      entityType: null,
      entityId: null,
      targetUserId: null,
      recipientUserId: null,
      metadata: null,
    });
    expect(result.success).toBe(true);
  });

  test("carries a targeted recipientUserId (a per-user nudge — ADR-0056 amendment, #453)", () => {
    const recipientUserId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    const result = NotificationSchema.safeParse({
      ...base,
      type: "secret.vault_setup" as const,
      recipientUserId,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.recipientUserId).toBe(recipientUserId);
  });

  test("carries the per-caller read flag", () => {
    expect(
      NotificationSchema.safeParse({ ...base, read: true }).success,
    ).toBe(true);
    // read is required — it is folded in by the list endpoint, never absent.
    const { read: _omit, ...withoutRead } = base;
    expect(NotificationSchema.safeParse(withoutRead).success).toBe(false);
  });

  test("rejects an unknown type / severity / entityType", () => {
    expect(
      NotificationSchema.safeParse({ ...base, type: "nope" }).success,
    ).toBe(false);
    expect(
      NotificationSchema.safeParse({ ...base, severity: "fatal" }).success,
    ).toBe(false);
    expect(
      NotificationSchema.safeParse({ ...base, entityType: "asset" }).success,
    ).toBe(false);
  });

  test("rejects a non-uuid targetUserId", () => {
    expect(
      NotificationSchema.safeParse({ ...base, targetUserId: "not-a-uuid" })
        .success,
    ).toBe(false);
  });

  test("rejects a non-uuid recipientUserId", () => {
    expect(
      NotificationSchema.safeParse({ ...base, recipientUserId: "not-a-uuid" })
        .success,
    ).toBe(false);
  });
});

describe("envelope + count shapes", () => {
  test("NotificationPageSchema is the Page<Notification> envelope (not a bare array)", () => {
    const page = {
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    };
    expect(NotificationPageSchema.safeParse(page).success).toBe(true);
    // A bare array is NOT a valid page.
    expect(NotificationPageSchema.safeParse([]).success).toBe(false);
  });

  test("UnreadCountSchema requires a non-negative integer", () => {
    expect(UnreadCountSchema.safeParse({ unread: 0 }).success).toBe(true);
    expect(UnreadCountSchema.safeParse({ unread: -1 }).success).toBe(false);
    expect(UnreadCountSchema.safeParse({ unread: 1.5 }).success).toBe(false);
  });

  test("MarkReadResultSchema carries marked + the fresh unread count", () => {
    expect(
      MarkReadResultSchema.safeParse({ marked: 1, unread: 4 }).success,
    ).toBe(true);
    // Idempotent: marking an already-read item is marked: 0, still valid.
    expect(
      MarkReadResultSchema.safeParse({ marked: 0, unread: 4 }).success,
    ).toBe(true);
    expect(
      MarkReadResultSchema.safeParse({ marked: -1, unread: 0 }).success,
    ).toBe(false);
  });
});
