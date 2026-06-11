import { describe, expect, test } from "bun:test";
import { CloneUserSchema, ManagerInputSchema } from "../index";
import {
  type ManagerFormValue,
  dedupeIds,
  managerDescriptorToFormValue,
  toManagerInput,
} from "./clone-user-payload";

describe("toManagerInput — the XOR mirror of users_manager_at_most_one", () => {
  test("'none' clears the manager (null, never an empty object)", () => {
    expect(toManagerInput({ kind: "none" })).toBeNull();
  });

  test("'user' with an id emits { managerId } only", () => {
    const out = toManagerInput({
      kind: "user",
      managerId: "9f1d8e2a-0000-4000-8000-000000000001",
    });
    expect(out).toEqual({ managerId: "9f1d8e2a-0000-4000-8000-000000000001" });
    // Never carries a managerName — the XOR is structural, not just validated.
    expect(out && "managerName" in out).toBe(false);
  });

  test("'user' with a blank id collapses to null (nothing picked)", () => {
    expect(toManagerInput({ kind: "user", managerId: "   " })).toBeNull();
  });

  test("'external' trims and emits { managerName } only", () => {
    const out = toManagerInput({
      kind: "external",
      managerName: "  Ana Pérez (HR)  ",
    });
    expect(out).toEqual({ managerName: "Ana Pérez (HR)" });
    expect(out && "managerId" in out).toBe(false);
  });

  test("'external' with a blank name collapses to null", () => {
    expect(toManagerInput({ kind: "external", managerName: "   " })).toBeNull();
  });

  test("every output is accepted by ManagerInputSchema (never both keys)", () => {
    const cases: ManagerFormValue[] = [
      { kind: "none" },
      { kind: "user", managerId: "9f1d8e2a-0000-4000-8000-000000000001" },
      { kind: "external", managerName: "Ana" },
    ];
    for (const c of cases) {
      const out = toManagerInput(c);
      // null is the "clear" arm (nullable on the payload); a value must pass the input refine.
      if (out !== null) {
        expect(ManagerInputSchema.safeParse(out).success).toBe(true);
      }
    }
  });
});

describe("managerDescriptorToFormValue — round-trips the read descriptor for the edit form", () => {
  test("null → 'none'", () => {
    expect(managerDescriptorToFormValue(null)).toEqual({ kind: "none" });
  });

  test("a linked user (even offboarded) → 'user' keeping the id", () => {
    expect(
      managerDescriptorToFormValue({
        type: "user",
        id: "9f1d8e2a-0000-4000-8000-000000000002",
      }),
    ).toEqual({
      kind: "user",
      managerId: "9f1d8e2a-0000-4000-8000-000000000002",
    });
  });

  test("an external manager → 'external' keeping the name", () => {
    expect(
      managerDescriptorToFormValue({ type: "external", name: "Ana Pérez (HR)" }),
    ).toEqual({ kind: "external", managerName: "Ana Pérez (HR)" });
  });
});

describe("dedupeIds — checklist selections are unique + blank-free", () => {
  test("drops duplicates and blanks, preserves first-seen order", () => {
    expect(dedupeIds(["a", "b", "a", "  ", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("the result satisfies the CloneUserSchema uniqueness refine", () => {
    const ids = dedupeIds(["cl000000000000000000000001", "cl000000000000000000000001"]);
    const parsed = CloneUserSchema.safeParse({
      profile: { email: "new@x.dev", firstName: "New", lastName: "Hire" },
      cloneAssetAssignments: ids,
    });
    expect(parsed.success).toBe(true);
  });
});
