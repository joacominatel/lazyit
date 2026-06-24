import { describe, expect, test } from "bun:test";
import {
  CreateInfraEdgeSchema,
  CreateInfraNodeSchema,
  InfraShortcutSchema,
  isPlausibleEdge,
} from "./infra";

/**
 * Infra topology contract (ADR-0070). The two non-trivial bits worth a runnable check: the
 * shortcuts URL validation (a bad link must be a clean 400, not a broken canvas anchor) and the
 * edge-create DTO (required ids/kind + the self-loop refinement). The plausibility table is data
 * the API only WARNS on, so a couple of assertions pin the "absent kind / unlisted source = always
 * plausible" semantics that keep the model generic.
 */

const CUID = "clinfranode0000000000000a"; // a valid-shaped cuid for the DTO ids

describe("InfraShortcutSchema (url validation)", () => {
  test("accepts a well-formed link", () => {
    expect(
      InfraShortcutSchema.safeParse({ label: "Web UI", url: "https://nas.local:5001" }).success,
    ).toBe(true);
  });

  test("rejects a bad url", () => {
    const r = InfraShortcutSchema.safeParse({ label: "broken", url: "not a url" });
    expect(r.success).toBe(false);
  });

  test("rejects an empty label", () => {
    expect(
      InfraShortcutSchema.safeParse({ label: "", url: "https://ok.example" }).success,
    ).toBe(false);
  });
});

describe("CreateInfraNodeSchema", () => {
  test("kind + label are enough (everything else DB-defaulted)", () => {
    expect(CreateInfraNodeSchema.safeParse({ kind: "VM", label: "pve1-vm-100" }).success).toBe(
      true,
    );
  });

  test("a bad shortcut url fails the whole node create", () => {
    const r = CreateInfraNodeSchema.safeParse({
      kind: "VM",
      label: "pve1",
      shortcuts: [{ label: "ssh", url: "://nope" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("CreateInfraEdgeSchema", () => {
  test("validates a well-formed edge", () => {
    expect(
      CreateInfraEdgeSchema.safeParse({
        sourceId: CUID,
        targetId: "clinfranode0000000000000b",
        kind: "RUNS_ON",
      }).success,
    ).toBe(true);
  });

  test("rejects a self-loop (source === target)", () => {
    expect(
      CreateInfraEdgeSchema.safeParse({ sourceId: CUID, targetId: CUID, kind: "RUNS_ON" }).success,
    ).toBe(false);
  });

  test("rejects an unknown edge kind", () => {
    expect(
      CreateInfraEdgeSchema.safeParse({
        sourceId: CUID,
        targetId: "clinfranode0000000000000b",
        kind: "NOPE",
      }).success,
    ).toBe(false);
  });
});

describe("isPlausibleEdge (warn-only data)", () => {
  test("a mapped, listed pair is plausible (VM RUNS_ON PHYSICAL_HOST)", () => {
    expect(isPlausibleEdge("RUNS_ON", "VM", "PHYSICAL_HOST")).toBe(true);
  });

  test("a mapped, UNlisted target is implausible (CONTAINER RUNS_ON NETWORK_DEVICE)", () => {
    expect(isPlausibleEdge("RUNS_ON", "CONTAINER", "NETWORK_DEVICE")).toBe(false);
  });

  test("an unmapped source within a mapped kind is treated as plausible", () => {
    // PHYSICAL_HOST has no RUNS_ON entry → not flagged.
    expect(isPlausibleEdge("RUNS_ON", "PHYSICAL_HOST", "CLUSTER")).toBe(true);
  });

  test("an unmapped kind (DEPENDS_ON/BACKS_UP_TO/CONNECTS_TO) is always plausible", () => {
    expect(isPlausibleEdge("DEPENDS_ON", "CONTAINER", "NETWORK_DEVICE")).toBe(true);
    expect(isPlausibleEdge("CONNECTS_TO", "VM", "STORAGE")).toBe(true);
  });
});
