/**
 * Regression tests for the user-form → wire-payload glue (issue #410).
 *
 * Verified claim: the "Create user" flow with no manager selected does NOT silently fail or
 * produce an invalid payload. The no-manager path (`manager: { kind: 'none' }`) maps to
 * `manager: null`, which `CreateUserSchema` accepts as valid. These tests lock that contract so
 * the no-manager arm can never silently regress.
 *
 * Coverage: toResolverInput (all three manager arms) × CreateUserSchema.safeParse validation.
 * The individual `toManagerInput` and schema primitives are already covered in packages/shared;
 * the one previously untested link was this composite glue in the web form.
 */

import { expect, describe, test } from "bun:test";
import { CreateUserSchema } from "@lazyit/shared";
import { toResolverInput } from "./user-form-payload";

// Minimal required fields for a valid create payload (email + names mandatory; rest optional).
const BASE = {
  email: "ada@lazyit.dev",
  firstName: "Ada",
  lastName: "Lovelace",
  legajo: "",
  username: "",
} as const;

// ── issue #410 regression ────────────────────────────────────────────────────────────────────────
// "Create user" button did nothing when no manager / responsable was selected. Root cause analysis
// confirmed the path is already valid: { kind: 'none' } → null → accepted by CreateUserSchema.
// The missing piece was a unit test locking this specific composite glue.
describe("toResolverInput — no-manager arm (issue #410 regression)", () => {
  test("manager: { kind: 'none' } serializes to null in the wire payload", () => {
    const result = toResolverInput({ ...BASE, manager: { kind: "none" } });
    expect(result.manager).toBeNull();
  });

  test("CreateUserSchema accepts the resulting payload (manager: null is valid)", () => {
    const payload = toResolverInput({ ...BASE, manager: { kind: "none" } });
    const parsed = CreateUserSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  test("empty legajo / username are omitted from the payload (not passed as '')", () => {
    const payload = toResolverInput({ ...BASE, manager: { kind: "none" } });
    expect("legajo" in payload).toBe(false);
    expect("username" in payload).toBe(false);
  });
});

// ── with-manager (linked user) arm ──────────────────────────────────────────────────────────────
describe("toResolverInput — linked-user manager arm", () => {
  const MGR_ID = "11111111-1111-4111-8111-111111111111";

  test("manager: { kind: 'user', managerId } emits { managerId } in the payload", () => {
    const result = toResolverInput({
      ...BASE,
      manager: { kind: "user", managerId: MGR_ID },
    });
    expect(result.manager).toEqual({ managerId: MGR_ID });
  });

  test("CreateUserSchema accepts the resulting payload", () => {
    const payload = toResolverInput({
      ...BASE,
      manager: { kind: "user", managerId: MGR_ID },
    });
    const parsed = CreateUserSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  test("a blank managerId collapses to null (no selection)", () => {
    const result = toResolverInput({
      ...BASE,
      manager: { kind: "user", managerId: "   " },
    });
    expect(result.manager).toBeNull();
  });
});

// ── external (free-text name) arm ───────────────────────────────────────────────────────────────
describe("toResolverInput — external manager arm", () => {
  test("manager: { kind: 'external', managerName } emits { managerName } in the payload", () => {
    const result = toResolverInput({
      ...BASE,
      manager: { kind: "external", managerName: "  Ana Pérez (HR)  " },
    });
    expect(result.manager).toEqual({ managerName: "Ana Pérez (HR)" });
  });

  test("CreateUserSchema accepts the resulting payload", () => {
    const payload = toResolverInput({
      ...BASE,
      manager: { kind: "external", managerName: "Ana Pérez (HR)" },
    });
    const parsed = CreateUserSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  test("a blank managerName collapses to null", () => {
    const result = toResolverInput({
      ...BASE,
      manager: { kind: "external", managerName: "   " },
    });
    expect(result.manager).toBeNull();
  });
});

// ── optional directory fields forwarding ────────────────────────────────────────────────────────
describe("toResolverInput — optional directory fields", () => {
  test("non-empty legajo / username are forwarded to the payload", () => {
    const payload = toResolverInput({
      ...BASE,
      legajo: "  EMP-001  ",
      username: "ada.lovelace",
      manager: { kind: "none" },
    });
    // forwarded as-is (schema does the trim); present in the payload
    expect(payload.legajo).toBe("  EMP-001  ");
    expect(payload.username).toBe("ada.lovelace");
  });

  test("isActive is forwarded when present (edit mode)", () => {
    const payload = toResolverInput({
      ...BASE,
      manager: { kind: "none" },
      isActive: false,
    });
    expect(payload.isActive).toBe(false);
  });

  test("isActive is absent when not passed (create mode)", () => {
    const payload = toResolverInput({ ...BASE, manager: { kind: "none" } });
    expect("isActive" in payload).toBe(false);
  });
});
