import { describe, expect, test } from "bun:test";
import {
  AI_CHANNELS,
  AI_PREVIEW_WARNING_CODES,
  AI_TOOL_CLASSES,
  AiActionPreviewSchema,
  AiEntityRefListSchema,
  AiEntityRefSchema,
  AiToolManifestSchema,
  AiToolNameSchema,
  AiToolResultSchema,
} from "./ai-tools";

// The AI tool contract (ADR-0097 decision 3; synthesis §4.1, §4.3; R3, R4).

describe("Tool names (R4: ^[a-z][a-z0-9_]{0,39}$)", () => {
  test.each(["a", "session_context", "lazyit_search", "asset_update_2", "a".repeat(40)])(
    "accepts %s",
    (name) => {
      expect(AiToolNameSchema.safeParse(name).success).toBe(true);
    },
  );

  test.each([
    "",
    "1asset",
    "_asset",
    "Asset",
    "asset-update",
    "asset.update",
    "asset update",
    "a".repeat(41),
  ])("rejects %p", (name) => {
    expect(AiToolNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("Vocabularies", () => {
  test("the four tool classes and three channels", () => {
    expect([...AI_TOOL_CLASSES]).toEqual(["read", "write", "elevated", "navigate"]);
    expect([...AI_CHANNELS]).toEqual(["CHAT", "MCP", "HEADLESS"]);
  });
});

describe("Entity refs", () => {
  const ref = { type: "asset", id: "ckasset0000000000000000000", op: "updated", label: "LAP-042" };

  test("accepts a ref with a parent", () => {
    expect(
      AiEntityRefSchema.safeParse({
        type: "assetAssignment",
        id: "a1",
        op: "created",
        parent: { type: "asset", id: "x1" },
      }).success,
    ).toBe(true);
  });

  test("the strict schema rejects an unknown type or op", () => {
    expect(AiEntityRefSchema.safeParse({ ...ref, type: "spaceship" }).success).toBe(false);
    expect(AiEntityRefSchema.safeParse({ ...ref, op: "teleported" }).success).toBe(false);
  });

  test("the read-tolerant list drops the refs it does not understand and keeps the rest", () => {
    const parsed = AiEntityRefListSchema.parse([ref, { ...ref, type: "spaceship" }, "junk"]);
    expect(parsed).toEqual([ref]);
  });
});

describe("Tool result (discriminated on ok)", () => {
  test("accepts a successful read with truncation", () => {
    const parsed = AiToolResultSchema.safeParse({
      ok: true,
      kind: "read",
      data: { items: [] },
      mutated: false,
      truncated: { shown: 20, total: 57, nextOffset: 20 },
      entityRefs: [],
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts a failure and defaults its entity refs", () => {
    const parsed = AiToolResultSchema.parse({
      ok: false,
      kind: "mutation",
      error: { code: "STALE", message: "The asset changed since the preview" },
      mutated: false,
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.entityRefs).toEqual([]);
  });

  test("a failed call can never claim a mutation", () => {
    expect(
      AiToolResultSchema.safeParse({
        ok: false,
        kind: "mutation",
        error: { code: "INTERNAL", message: "x" },
        mutated: true,
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown discriminant and an unknown tool error code", () => {
    expect(
      AiToolResultSchema.safeParse({ ok: "maybe", kind: "read", mutated: false, entityRefs: [] })
        .success,
    ).toBe(false);
    expect(
      AiToolResultSchema.safeParse({
        ok: false,
        kind: "read",
        error: { code: "EXPLODED", message: "x" },
        mutated: false,
      }).success,
    ).toBe(false);
  });
});

describe("Action preview", () => {
  const preview = {
    toolName: "asset_update",
    class: "write",
    target: { type: "asset", id: "a1", op: "updated" },
    changes: [{ field: "status", before: "IN_STOCK", after: "DEPLOYED", valueKind: "text" }],
    warnings: ["LEDGER_APPEND", "SOMETHING_NEWER"],
    elevated: false,
    stepUpRequired: false,
    precondition: {
      entity: { type: "asset", id: "a1", op: "updated" },
      updatedAt: "2026-09-23T10:00:00.000Z",
    },
  };

  test("accepts a write preview; warnings stay open so a newer code renders generically", () => {
    const parsed = AiActionPreviewSchema.parse(preview);
    expect(parsed.impacted).toEqual([]);
    expect(parsed.untrustedSources).toEqual([]);
  });

  test("only write and elevated tools have a preview", () => {
    expect(AiActionPreviewSchema.safeParse({ ...preview, class: "read" }).success).toBe(false);
  });

  test("an impacted sample holds at most five refs", () => {
    const sample = Array.from({ length: 6 }, (_, i) => ({ type: "asset", id: `a${i}`, op: "updated" }));
    expect(
      AiActionPreviewSchema.safeParse({
        ...preview,
        impacted: [{ type: "asset", count: 6, sample }],
      }).success,
    ).toBe(false);
  });
});

describe("Preview warning codes", () => {
  test("carry the step-up warnings (CEO decision 2026-09-24, #1315)", () => {
    for (const code of ["ROLE_CHANGE", "IDENTITY_CHANGE", "PRIVILEGE_GRANT", "CREDENTIAL_DELIVERY"]) {
      expect(AI_PREVIEW_WARNING_CODES).toContain(code);
    }
  });

  test("carry the workflow-engine warnings (ADR-0097 decision 3, amended 2026-09-24)", () => {
    expect(AI_PREVIEW_WARNING_CODES).toContain("OUTBOUND_INTEGRATION");
    expect(AI_PREVIEW_WARNING_CODES).toContain("CRITICAL_APPLICATION");
    const parsed = AiActionPreviewSchema.safeParse({
      toolName: "workflow_update",
      class: "elevated",
      changes: [{ field: "enabled", before: false, after: true }],
      warnings: ["OUTBOUND_INTEGRATION", "CRITICAL_APPLICATION"],
      elevated: true,
      stepUpRequired: true,
    });
    expect(parsed.success).toBe(true);
  });

  test("the list is additive: every earlier code is still accepted", () => {
    for (const code of [
      "EXTERNAL_PROVISIONING",
      "EXTERNAL_DEPROVISIONING",
      "CASCADE_RELEASES_ASSIGNMENTS",
      "CASCADE_REVOKES_GRANTS",
      "LEDGER_APPEND",
      "SOFT_DELETE",
      "PUBLISHES_TO_READERS",
      "VISIBILITY_CHANGE",
      "NOTIFIES_USERS",
      "IRREVERSIBLE",
    ]) {
      expect(AI_PREVIEW_WARNING_CODES).toContain(code);
    }
  });

  test("a preview carrying the new codes parses", () => {
    const parsed = AiActionPreviewSchema.safeParse({
      toolName: "access_grant_create",
      class: "elevated",
      changes: [],
      warnings: ["PRIVILEGE_GRANT", "CREDENTIAL_DELIVERY"],
      elevated: true,
      stepUpRequired: true,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("Tool manifest", () => {
  test("carries a catalog permission and rejects an unknown one", () => {
    const manifest = {
      name: "asset_get",
      title: "Get an asset",
      description: "Read one asset",
      inputSchema: { type: "object" },
      class: "read",
      permission: "asset:read",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    };
    expect(AiToolManifestSchema.safeParse(manifest).success).toBe(true);
    expect(AiToolManifestSchema.safeParse({ ...manifest, permission: "asset:fly" }).success).toBe(
      false,
    );
  });
});
