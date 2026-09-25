import { describe, expect, test } from "bun:test";
import type { AiApprovalRequest, AiMessagePart } from "@lazyit/shared";
import {
  bulkExclusion,
  bulkPlan,
  clampPage,
  EMPTY_PAGER_STATE,
  initialPage,
  nextUndecided,
  planMessageParts,
  recordDecision,
  refusedDetails,
  stopsBulk,
  type ApprovalPart,
  type PlannedItem,
} from "./approval-pages";
import { approval } from "./test-fixtures";

type ToolPart = Extract<AiMessagePart, { type: "tool" }>;

const tool = (
  id: string,
  status: ToolPart["status"] = "AWAITING_APPROVAL",
  cls: ToolPart["class"] = "write",
  name = "asset_update",
  message?: string,
): ToolPart => ({
  type: "tool",
  toolCallId: id,
  name: name as ToolPart["name"],
  class: cls,
  status,
  ...(message
    ? {
        result: {
          toolCallId: id,
          kind: "mutation" as const,
          status: "error" as const,
          mutated: false,
          entityRefs: [],
          error: { code: "RATE_LIMITED", message },
        },
      }
    : {}),
});

const card = (
  id: string,
  outcome: ApprovalPart["outcome"] = null,
  overrides: Partial<AiApprovalRequest> = {},
  auto?: boolean,
): ApprovalPart => ({
  type: "approval",
  request: approval(id, overrides),
  outcome,
  ...(auto ? { auto } : {}),
});

const text = (t: string): AiMessagePart => ({ type: "text", text: t });

/** A compact picture of the plan: one token per item. */
const shape = (items: PlannedItem[]) =>
  items.map((item) => {
    switch (item.kind) {
      case "approvals":
        return `pager[${item.parts.map((p) => p.request.toolCallId).join(",")}]@${item.index}`;
      case "refused":
        return `refused×${item.parts.length}@${item.index}`;
      case "tools":
        return `tool:${item.parts.map((p) => p.toolCallId).join(",")}@${item.index}`;
      default:
        return item.part.type === "approval"
          ? `card:${item.part.request.toolCallId}@${item.index}`
          : `${item.part.type}@${item.index}`;
    }
  });

/** One step that proposed `n` changes (tool line + card each) and had `refused` more refused. */
function step(n: number, refused = 0): AiMessagePart[] {
  const parts: AiMessagePart[] = [];
  for (let i = 1; i <= n; i++) parts.push(tool(`w${i}`), card(`w${i}`));
  for (let i = 1; i <= refused; i++)
    parts.push(tool(`r${i}`, "FAILED", "write", "asset_update", "Propose at most 5 changes at a time"));
  return parts;
}

describe("planMessageParts", () => {
  test("a single card keeps today's look: its tool line and its own card", () => {
    expect(shape(planMessageParts([text("ok"), ...step(1)]))).toEqual(["text@0", "tool:w1@1", "card:w1@2"]);
  });

  test("several cards of one step become ONE pager at the first card; their tool lines go", () => {
    expect(shape(planMessageParts([text("Here:"), ...step(3), text("Done?")]))).toEqual([
      "text@0",
      "pager[w1,w2,w3]@2",
      "text@7",
    ]);
  });

  test("refused writes collapse into one line — the CEO's 5 cards + 20 failures", () => {
    const plan = planMessageParts(step(5, 20));
    expect(shape(plan)).toEqual(["pager[w1,w2,w3,w4,w5]@1", "refused×20@10"]);
  });

  test("a single refused write keeps its own line", () => {
    expect(shape(planMessageParts(step(0, 1)))).toEqual(["tool:r1@0"]);
  });

  test("refusals across the whole message collapse at the first one", () => {
    const parts: AiMessagePart[] = [
      tool("r1", "FAILED"),
      text("retrying"),
      tool("r2", "DENIED", "elevated"),
    ];
    expect(shape(planMessageParts(parts))).toEqual(["refused×2@0", "text@1"]);
  });

  test("failed reads and a card's failed execution are not refusals", () => {
    const parts: AiMessagePart[] = [
      tool("s1", "FAILED", "read", "asset_search"),
      tool("s2", "FAILED", "read", "asset_search"),
      tool("w1", "FAILED"),
      card("w1", "approved"),
    ];
    expect(shape(planMessageParts(parts))).toEqual(["tool:s1,s2@0", "tool:w1@2", "card:w1@3"]);
  });

  test("text between cards splits the steps: two single cards stay single", () => {
    const parts: AiMessagePart[] = [...step(1), text("next"), tool("w9"), card("w9")];
    expect(shape(planMessageParts(parts))).toEqual(["tool:w1@0", "card:w1@1", "text@2", "tool:w9@3", "card:w9@4"]);
  });

  test("auto-approved records stay as they are and are never paged", () => {
    const parts: AiMessagePart[] = [
      tool("a1", "SUCCEEDED"),
      card("a1", "approved", {}, true),
      tool("a2", "SUCCEEDED"),
      card("a2", "approved", {}, true),
    ];
    expect(shape(planMessageParts(parts))).toEqual(["tool:a1@0", "card:a1@1", "tool:a2@2", "card:a2@3"]);
  });

  test("an auto record among waiting cards stays in place beside the pager", () => {
    const parts: AiMessagePart[] = [
      tool("w1"),
      card("w1"),
      tool("a1", "SUCCEEDED"),
      card("a1", "approved", {}, true),
      tool("w2"),
      card("w2"),
    ];
    expect(shape(planMessageParts(parts))).toEqual(["pager[w1,w2]@1", "tool:a1@2", "card:a1@3"]);
  });

  test("repeated reads still collapse around a pager (#1377)", () => {
    const parts: AiMessagePart[] = [
      tool("s1", "SUCCEEDED", "read", "asset_search"),
      tool("s2", "SUCCEEDED", "read", "asset_search"),
      ...step(2),
    ];
    expect(shape(planMessageParts(parts))).toEqual(["tool:s1,s2@0", "pager[w1,w2]@3"]);
  });
});

describe("paging", () => {
  const parts = [card("w1", "approved"), card("w2"), card("w3", "rejected"), card("w4")];

  test("opens on the first change still waiting, or the first page when all are decided", () => {
    expect(initialPage(parts)).toBe(1);
    expect(initialPage([card("a", "approved"), card("b", "expired")])).toBe(0);
  });

  test("advances to the next waiting change, wrapping, and skips accepted decisions", () => {
    expect(nextUndecided(parts, 1, EMPTY_PAGER_STATE)).toBe(3);
    expect(nextUndecided(parts, 3, EMPTY_PAGER_STATE)).toBe(1);
    const after = recordDecision(EMPTY_PAGER_STATE, "w4", "approve", { ok: true });
    expect(nextUndecided(parts, 3, after)).toBe(1);
    const both = recordDecision(after, "w2", "reject", { ok: true });
    expect(nextUndecided(parts, 1, both)).toBe(-1);
  });

  test("a refused decision leaves the change waiting and marks it for review", () => {
    const state = recordDecision(EMPTY_PAGER_STATE, "w2", "approve", { ok: false, error: { kind: "stale" } });
    expect(nextUndecided(parts, 0, state)).toBe(1);
    expect(state.errors.w2).toEqual({ kind: "stale" });
    // An accepted decision later clears it.
    expect(recordDecision(state, "w2", "reject", { ok: true }).errors.w2).toBeUndefined();
  });

  test("clampPage keeps the page inside the pages", () => {
    expect(clampPage(-1, 3)).toBe(0);
    expect(clampPage(7, 3)).toBe(2);
    expect(clampPage(2, 0)).toBe(0);
  });
});

describe("bulk eligibility", () => {
  const preview = approval("x").preview;

  test("an ordinary waiting change is eligible", () => {
    expect(bulkExclusion(card("w1"), EMPTY_PAGER_STATE)).toBeNull();
  });

  test("never a change that needs the password or touches a critical application", () => {
    expect(bulkExclusion(card("w1", null, { stepUpRequired: true }), EMPTY_PAGER_STATE)).toBe("stepUp");
    expect(
      bulkExclusion(card("w1", null, { preview: { ...preview, stepUpRequired: true } }), EMPTY_PAGER_STATE),
    ).toBe("stepUp");
    for (const code of ["CRITICAL_APPLICATION", "ROLE_CHANGE", "PRIVILEGE_GRANT"]) {
      expect(
        bulkExclusion(card("w1", null, { preview: { ...preview, warnings: [code] } }), EMPTY_PAGER_STATE),
      ).toBe("stepUp");
    }
  });

  test("never a sensitive change (G4) or one based on other people's content", () => {
    expect(bulkExclusion(card("w1", null, { elevated: true }), EMPTY_PAGER_STATE)).toBe("elevated");
    expect(
      bulkExclusion(card("w1", null, { preview: { ...preview, class: "elevated" } }), EMPTY_PAGER_STATE),
    ).toBe("elevated");
    expect(
      bulkExclusion(
        card("w1", null, { untrustedSources: [{ type: "article", id: "k1", op: "navigate" }] }),
        EMPTY_PAGER_STATE,
      ),
    ).toBe("untrusted");
  });

  test("never a STALE one (or any change whose last decision was refused)", () => {
    const state = recordDecision(EMPTY_PAGER_STATE, "w1", "approve", { ok: false, error: { kind: "stale" } });
    expect(bulkExclusion(card("w1"), state)).toBe("needsReview");
  });

  test("the plan counts only waiting changes and says why the rest are left out", () => {
    const parts = [
      card("w1"),
      card("w2", null, { stepUpRequired: true }),
      card("w3", "approved"),
      card("w4"),
      card("w5", null, { elevated: true }),
      card("w6"),
    ];
    const state = recordDecision(EMPTY_PAGER_STATE, "w6", "approve", { ok: true });
    expect(bulkPlan(parts, state)).toEqual({
      eligible: ["w1", "w4"],
      excluded: [
        { reason: "stepUp", count: 1 },
        { reason: "elevated", count: 1 },
      ],
      waiting: 4,
    });
  });

  test("a run-wide refusal stops the rest of a bulk action; a per-change one does not", () => {
    expect(stopsBulk({ kind: "notAwaiting" })).toBe(true);
    expect(stopsBulk({ kind: "aiDisabled" })).toBe(true);
    expect(stopsBulk({ kind: "stale" })).toBe(false);
    expect(stopsBulk({ kind: "expired" })).toBe(false);
  });
});

describe("refusedDetails", () => {
  test("groups the refusals by tool and reason, most frequent first", () => {
    const parts = [
      tool("r1", "FAILED", "write", "asset_update", "Propose at most 5 changes at a time"),
      tool("r2", "FAILED", "write", "asset_update", "Propose at most 5 changes at a time"),
      tool("r3", "FAILED", "write", "asset_create", "Invalid input"),
      tool("r4", "FAILED", "write", "asset_update", "Propose at most 5 changes at a time"),
    ];
    expect(refusedDetails(parts)).toEqual([
      { name: "asset_update", message: "Propose at most 5 changes at a time", count: 3 },
      { name: "asset_create", message: "Invalid input", count: 1 },
    ]);
  });
});
