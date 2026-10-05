// Browsers fire dragover every 350 ms ±200 ms for a still pointer (HTML spec, DnD processing model), so a
// shorter silence than this would flicker the target while someone holds the file still.
export const FILE_DRAG_STALE_MS = 700;

export interface FileDrag {
  depth: number;
  seenAt: number;
}

export const NO_FILE_DRAG: FileDrag = { depth: 0, seenAt: 0 };

export interface FileDragInput {
  kind: "enter" | "over" | "leave" | "drop";
  files: boolean;
  at: number;
}

export function isFileDragging(state: FileDrag, now: number): boolean {
  return state.depth > 0 && now - state.seenAt < FILE_DRAG_STALE_MS;
}

// Enter and leave pair up per element crossed; an element removed mid-drag never sends its leave, so a stale
// count is dropped on the next enter and the silence check hides the target meanwhile.
export function nextFileDrag(state: FileDrag, input: FileDragInput): FileDrag {
  if (!input.files) return state;
  switch (input.kind) {
    case "enter":
      return { depth: (isFileDragging(state, input.at) ? state.depth : 0) + 1, seenAt: input.at };
    case "over":
      return { depth: Math.max(state.depth, 1), seenAt: input.at };
    case "leave":
      return state.depth <= 1 ? NO_FILE_DRAG : { depth: state.depth - 1, seenAt: state.seenAt };
    case "drop":
      return NO_FILE_DRAG;
  }
}
