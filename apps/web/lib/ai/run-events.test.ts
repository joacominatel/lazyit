import { describe, expect, test } from "bun:test";
import { eventSeq, isTerminalRunStatus, parseRunEvent, streamClosesOn } from "./run-events";
import { createSseParser } from "./sse-parser";

describe("parseRunEvent", () => {
  test("parses a known event", () => {
    const event = parseRunEvent({
      event: "run.status",
      data: JSON.stringify({ v: 1, type: "run.status", status: "RUNNING" }),
      lastEventId: "r:1",
    });
    expect(event).toEqual({ v: 1, type: "run.status", status: "RUNNING" });
  });

  test("skips unknown types, newer versions and malformed frames — never throws", () => {
    const frame = (data: string) => ({ event: "x", data, lastEventId: "" });
    expect(parseRunEvent(frame(JSON.stringify({ v: 1, type: "run.telemetry", x: 1 })))).toBeNull();
    expect(parseRunEvent(frame(JSON.stringify({ v: 2, type: "run.status", status: "RUNNING" })))).toBeNull();
    expect(parseRunEvent(frame("{not json"))).toBeNull();
    expect(parseRunEvent(frame("null"))).toBeNull();
  });

  test("drops an entity ref of an unknown type instead of the whole result", () => {
    const event = parseRunEvent({
      event: "tool.result",
      data: JSON.stringify({
        v: 1,
        type: "tool.result",
        toolCallId: "c1",
        kind: "mutation",
        status: "ok",
        mutated: true,
        entityRefs: [{ type: "asset", id: "a", op: "created" }, { type: "hologram", id: "h", op: "created" }],
      }),
      lastEventId: "",
    });
    expect(event?.type === "tool.result" && event.entityRefs).toEqual([{ type: "asset", id: "a", op: "created" }]);
  });

  test("end to end through the SSE parser: heartbeats ignored, split chunks joined", () => {
    const parser = createSseParser();
    const data = JSON.stringify({ v: 1, type: "message.delta", messageId: "m", text: "hé" });
    const wire = `: connected\n\n: hb\n\nid: run1:17\nevent: message.delta\ndata: ${data}\n\n`;
    const out = [...parser.push(wire.slice(0, 40)), ...parser.push(wire.slice(40))];
    expect(out).toHaveLength(1);
    expect(out[0]!.lastEventId).toBe("run1:17");
    expect(parseRunEvent(out[0]!)).toEqual({ v: 1, type: "message.delta", messageId: "m", text: "hé" });
  });
});

describe("eventSeq", () => {
  test("reads the sequence of this run's ids only", () => {
    expect(eventSeq("run1:42", "run1")).toBe(42);
    expect(eventSeq("run1:0", "run1")).toBe(0);
    expect(eventSeq("run2:42", "run1")).toBeNull();
    expect(eventSeq("run1:x", "run1")).toBeNull();
    expect(eventSeq("run1:", "run1")).toBeNull();
    expect(eventSeq("", "run1")).toBeNull();
    expect(eventSeq(null, "run1")).toBeNull();
  });
});

describe("stream closing", () => {
  test("closes on waiting and terminal statuses", () => {
    for (const s of ["AWAITING_APPROVAL", "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"]) {
      expect(streamClosesOn(s)).toBe(true);
    }
    expect(streamClosesOn("RUNNING")).toBe(false);
    expect(streamClosesOn(null)).toBe(false);
    expect(isTerminalRunStatus("AWAITING_APPROVAL")).toBe(false);
    expect(isTerminalRunStatus("SUCCEEDED")).toBe(true);
  });
});
