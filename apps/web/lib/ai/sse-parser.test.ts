import { describe, expect, test } from "bun:test";
import { createSseParser, readSseStream, type SseMessage } from "./sse-parser";

/** Feeds `chunks` in order through one parser and collects every event. */
function parse(chunks: string[]): SseMessage[] {
  const parser = createSseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

/** A byte stream that yields `chunks` one by one. */
function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<SseMessage>): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const message of stream) out.push(message);
  return out;
}

const FRAME = 'id: run1:1\nevent: run.status\ndata: {"v":1,"type":"run.status","status":"RUNNING"}\n\n';

describe("createSseParser", () => {
  test("dispatches a complete frame with its event type, data and id", () => {
    expect(parse([FRAME])).toEqual([
      {
        event: "run.status",
        data: '{"v":1,"type":"run.status","status":"RUNNING"}',
        lastEventId: "run1:1",
      },
    ]);
  });

  test("yields the same events however the frame is split across chunks", () => {
    const whole = parse([FRAME]);
    for (let cut = 1; cut < FRAME.length; cut++) {
      expect(parse([FRAME.slice(0, cut), FRAME.slice(cut)])).toEqual(whole);
    }
    expect(parse([...FRAME])).toEqual(whole);
  });

  test("does not dispatch until the blank line arrives", () => {
    const parser = createSseParser();
    expect(parser.push("data: partial\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([
      { event: "message", data: "partial", lastEventId: "" },
    ]);
  });

  test("joins multi-line data with newlines", () => {
    expect(parse(["data: first\ndata: second\ndata:\ndata: fourth\n\n"])).toEqual([
      { event: "message", data: "first\nsecond\n\nfourth", lastEventId: "" },
    ]);
  });

  test("accepts CRLF and bare CR line endings, including a CRLF split across chunks", () => {
    const expected = [{ event: "message", data: "a\nb", lastEventId: "" }];
    expect(parse(["data: a\r\ndata: b\r\n\r\n"])).toEqual(expected);
    expect(parse(["data: a\rdata: b\r\r"])).toEqual(expected);
    expect(parse(["data: a\r", "\ndata: b\r", "\n\r", "\n"])).toEqual(expected);
  });

  test("ignores heartbeat comments, even between the lines of a frame", () => {
    expect(parse([": heartbeat\n\n", ":\n", "data: x\n: keep-alive\n", "\n"])).toEqual([
      { event: "message", data: "x", lastEventId: "" },
    ]);
  });

  test("drops frames that carry no data, but keeps their id", () => {
    expect(parse(["id: run1:7\n\n", "event: ping\n\n", "data: next\n\n"])).toEqual([
      { event: "message", data: "next", lastEventId: "run1:7" },
    ]);
  });

  test("the last id persists across events until the server replaces or clears it", () => {
    expect(
      parse(["id: run1:1\ndata: a\n\n", "data: b\n\n", "id: run1:3\ndata: c\n\n", "id\ndata: d\n\n"]).map(
        (message) => message.lastEventId,
      ),
    ).toEqual(["run1:1", "run1:1", "run1:3", ""]);
  });

  test("ignores an id containing NUL, unknown fields and retry", () => {
    expect(parse(["id: good\n\n", "id: bad\0id\nretry: 10\nfoo: bar\ndata: x\n\n"])).toEqual([
      { event: "message", data: "x", lastEventId: "good" },
    ]);
  });

  test("strips exactly one space after the colon", () => {
    expect(parse(["data:no-space\n\n", "data:  two\n\n"]).map((message) => message.data)).toEqual([
      "no-space",
      " two",
    ]);
  });

  test("the event type resets after each dispatch", () => {
    expect(parse(["event: tool.call\ndata: 1\n\ndata: 2\n\n"]).map((message) => message.event)).toEqual([
      "tool.call",
      "message",
    ]);
  });
});

describe("readSseStream", () => {
  test("decodes a multi-byte character split across byte chunks", async () => {
    const bytes = new TextEncoder().encode("data: café ✓\n\n");
    const split = bytes.indexOf(0xc3) + 1; // inside the two-byte "é"
    const messages = await collect(
      readSseStream(byteStream([bytes.slice(0, split), bytes.slice(split)])),
    );
    expect(messages).toEqual([{ event: "message", data: "café ✓", lastEventId: "" }]);
  });

  test("discards a trailing frame the stream never terminated", async () => {
    const encoder = new TextEncoder();
    const messages = await collect(
      readSseStream(byteStream([encoder.encode("data: done\n\ndata: cut off\n")])),
    );
    expect(messages.map((message) => message.data)).toEqual(["done"]);
  });

  test("stopping the iteration early cancels the body", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const message of readSseStream(body)) {
      expect(message.data).toBe("one");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
