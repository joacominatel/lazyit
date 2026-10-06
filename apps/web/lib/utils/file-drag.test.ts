import { describe, expect, test } from "bun:test";
import {
  FILE_DRAG_STALE_MS,
  type FileDrag,
  type FileDragInput,
  isFileDragging,
  NO_FILE_DRAG,
  nextFileDrag,
} from "./file-drag";

const file = (kind: FileDragInput["kind"], at: number): FileDragInput => ({ kind, files: true, at });

function run(inputs: FileDragInput[], from: FileDrag = NO_FILE_DRAG): FileDrag {
  return inputs.reduce(nextFileDrag, from);
}

describe("the page-level file drag (#1516)", () => {
  test("a file entering shows the target and leaving hides it", () => {
    const entered = run([file("enter", 0)]);
    expect(isFileDragging(entered, 10)).toBe(true);
    expect(isFileDragging(nextFileDrag(entered, file("leave", 20)), 20)).toBe(false);
  });

  test("crossing nested elements keeps it steady until the last leave", () => {
    const inner = run([file("enter", 0), file("enter", 10), file("leave", 11)]);
    expect(isFileDragging(inner, 12)).toBe(true);
    expect(isFileDragging(nextFileDrag(inner, file("leave", 20)), 20)).toBe(false);
  });

  test("a drag of text or a link is ignored", () => {
    const state = run([{ kind: "enter", files: false, at: 0 }, { kind: "over", files: false, at: 5 }]);
    expect(state).toEqual(NO_FILE_DRAG);
  });

  test("dragover keeps a held file alive however long it rests", () => {
    const state = run([file("enter", 0), file("over", 500), file("over", 1050)]);
    expect(isFileDragging(state, 1050 + FILE_DRAG_STALE_MS - 1)).toBe(true);
  });

  test("an element removed under the pointer never sends its leave, and the target still goes away", () => {
    // Two enters, one leave: the second element was unmounted mid-drag.
    const stuck = run([file("enter", 0), file("enter", 10), file("over", 20), file("leave", 30)]);
    expect(stuck.depth).toBe(1);
    expect(isFileDragging(stuck, 20 + FILE_DRAG_STALE_MS)).toBe(false);
    // The next drag starts clean: one leave is enough again.
    const next = run([file("enter", 5000), file("leave", 5010)], stuck);
    expect(isFileDragging(next, 5010)).toBe(false);
  });

  test("a drop resets it, however deep the count", () => {
    const state = run([file("enter", 0), file("enter", 1), file("enter", 2), file("drop", 3)]);
    expect(state).toEqual(NO_FILE_DRAG);
    expect(isFileDragging(state, 3)).toBe(false);
  });
});
