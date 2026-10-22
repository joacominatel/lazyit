import { describe, expect, test } from "bun:test";
import type { AssetAssignment, AssetListItem } from "@lazyit/shared";
import {
  assignWithReleases,
  heldAssetRows,
  markedRows,
  NO_RELEASE_MARKS,
  releaseMarksReducer,
  releaseReport,
} from "./assign-with-releases";

/**
 * The swap step of assigning an asset (#1726): what the person holds, the marks, and the order and
 * reporting of "assign, then release". Pure logic, no DOM (ADR-0012).
 */
const USER = "11111111-1111-4111-8111-111111111111";
const NEW_ASSET = "ckasset00000000000000new";
const OLD_LAPTOP = "ckasset00000000000000old";
const MONITOR = "ckasset0000000000000mon1";

function assignment(id: string, assetId: string, releasedAt: string | null = null): AssetAssignment {
  return {
    id,
    assetId,
    userId: USER,
    assignedAt: "2026-01-10T00:00:00.000Z",
    releasedAt,
    assignedById: null,
    releasedById: null,
    notes: null,
    createdAt: "2026-01-10T00:00:00.000Z",
    updatedAt: "2026-01-10T00:00:00.000Z",
  } as AssetAssignment;
}

function asset(id: string, name: string, assetTag: string | null): AssetListItem {
  return { id, name, assetTag, status: "OPERATIONAL" } as AssetListItem;
}

const assignments = [
  assignment("as-old", OLD_LAPTOP),
  assignment("as-mon", MONITOR),
  // The asset being assigned right now (a second owner case) — never offered for release.
  assignment("as-new", NEW_ASSET),
  // Defensive: a released row is never listed even if the read returned it.
  assignment("as-gone", "ckasset000000000000gone1", "2026-02-01T00:00:00.000Z"),
];
const assets = [
  asset(OLD_LAPTOP, "ThinkPad T14", "LZ-0042"),
  asset(MONITOR, "Dell U2723", null),
  asset(NEW_ASSET, "ThinkPad T16", "LZ-0099"),
];

describe("heldAssetRows", () => {
  test("lists the person's active assignments, joined to their assets, without the asset being assigned", () => {
    const rows = heldAssetRows(assignments, assets, NEW_ASSET);
    expect(rows.map((r) => r.assignmentId)).toEqual(["as-old", "as-mon"]);
    expect(rows[0]?.asset?.name).toBe("ThinkPad T14");
  });

  test("on the new-asset form nothing is excluded, and an unresolved asset keeps its row", () => {
    const rows = heldAssetRows(assignments, [assets[0]!], undefined);
    expect(rows.map((r) => r.assignmentId)).toEqual(["as-old", "as-mon", "as-new"]);
    expect(rows[1]?.asset).toBeUndefined();
  });

  test("no data yet is an empty list", () => {
    expect(heldAssetRows(undefined, undefined, NEW_ASSET)).toEqual([]);
  });
});

describe("release marks", () => {
  test("toggling marks and unmarks; a note is shared by all marks", () => {
    let state = releaseMarksReducer(NO_RELEASE_MARKS, { type: "toggle", assignmentId: "as-old" });
    state = releaseMarksReducer(state, { type: "toggle", assignmentId: "as-mon" });
    state = releaseMarksReducer(state, { type: "toggle", assignmentId: "as-mon" });
    state = releaseMarksReducer(state, { type: "note", note: "returned" });
    expect(state).toEqual({ marked: ["as-old"], note: "returned" });
  });

  test("picking another person drops the marks — they only apply to the person shown", () => {
    const state = releaseMarksReducer(
      { marked: ["as-old"], note: "returned" },
      { type: "pick" },
    );
    expect(state).toEqual(NO_RELEASE_MARKS);
  });

  test("a mark that no longer names a listed row is never released", () => {
    const rows = heldAssetRows(assignments, assets, NEW_ASSET);
    expect(markedRows(rows, ["as-stale", "as-mon"]).map((r) => r.assignmentId)).toEqual(["as-mon"]);
  });
});

/** A fake API that records every call in order and can fail chosen ones. */
function fakeApi({ failAssign = false, failRelease = [] as string[] } = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  return {
    calls,
    bodies,
    assign: async () => {
      calls.push("assign");
      if (failAssign) throw new Error("This person is already assigned to this asset");
    },
    release: async (id: string, data: { notes?: string }) => {
      calls.push(`release:${id}`);
      bodies[id] = data;
      if (failRelease.includes(id)) throw new Error("Assignment already released");
    },
  };
}

describe("assign, then release", () => {
  const rows = heldAssetRows(assignments, assets, NEW_ASSET);

  test("Cancel sends nothing: closing drops the marks, so a later Assign sends only the assignment", async () => {
    let marks = releaseMarksReducer(NO_RELEASE_MARKS, { type: "toggle", assignmentId: "as-old" });
    marks = releaseMarksReducer(marks, { type: "toggle", assignmentId: "as-mon" });
    marks = releaseMarksReducer(marks, { type: "close" });
    const api = fakeApi();
    await assignWithReleases({ ...api, releases: markedRows(rows, marks.marked), note: marks.note });
    expect(api.calls).toEqual(["assign"]);
  });

  test("the new assignment is created first, then each marked release in order", async () => {
    const api = fakeApi();
    const outcome = await assignWithReleases({
      ...api,
      releases: markedRows(rows, ["as-mon", "as-old"]),
    });
    expect(api.calls).toEqual(["assign", "release:as-old", "release:as-mon"]);
    expect(outcome).toEqual({
      kind: "assigned",
      released: [
        { assignmentId: "as-old", assetId: OLD_LAPTOP },
        { assignmentId: "as-mon", assetId: MONITOR },
      ],
      failed: [],
    });
  });

  test("when the assignment fails, no release is sent", async () => {
    const api = fakeApi({ failAssign: true });
    const outcome = await assignWithReleases({ ...api, releases: rows });
    expect(api.calls).toEqual(["assign"]);
    expect(outcome.kind).toBe("assign-failed");
  });

  test("one failed release does not stop the others, and each is reported", async () => {
    const api = fakeApi({ failRelease: ["as-old"] });
    const outcome = await assignWithReleases({ ...api, releases: rows });
    expect(api.calls).toEqual(["assign", "release:as-old", "release:as-mon"]);
    if (outcome.kind !== "assigned") throw new Error("expected the assignment to land");
    expect(outcome.released.map((r) => r.assignmentId)).toEqual(["as-mon"]);
    expect(outcome.failed.map((r) => r.assignmentId)).toEqual(["as-old"]);

    const report = releaseReport(outcome, rows, "Asset", "couldn't release it");
    expect(report.failed).toEqual([
      { key: "as-old", label: "LZ-0042 · ThinkPad T14", message: "Assignment already released" },
    ]);
    expect(report.released).toEqual([{ key: "as-mon", label: "Dell U2723" }]);
  });

  test("the shared note is trimmed and sent with every release; a blank note sends none", async () => {
    const withNote = fakeApi();
    await assignWithReleases({ ...withNote, releases: rows, note: "  returned for a T16  " });
    expect(withNote.bodies).toEqual({
      "as-old": { notes: "returned for a T16" },
      "as-mon": { notes: "returned for a T16" },
    });

    const blank = fakeApi();
    await assignWithReleases({ ...blank, releases: rows, note: "   " });
    expect(blank.bodies).toEqual({ "as-old": {}, "as-mon": {} });
  });
});
