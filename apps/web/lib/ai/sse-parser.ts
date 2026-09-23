/**
 * A minimal Server-Sent Events reader for fetch-streamed responses (docs/ai-assistant/_synthesis.md
 * §4.6, frontend.md Fork B). `EventSource` cannot send an `Authorization` header and the API is
 * Bearer-authenticated, so the run event stream is read with `fetch` and parsed here.
 *
 * It follows the WHATWG event-stream interpretation rules: lines end in CRLF, LF or CR (a CRLF split
 * across two chunks counts once); `:` lines are comments, which is how the API's heartbeats arrive;
 * `data:` lines join with `\n`; the last `id:` persists across events and is what a reconnect sends
 * back as `Last-Event-ID`; a trailing event with no blank line after it is discarded. `retry:` is
 * ignored — reconnect timing belongs to the caller.
 */

/** One dispatched event. */
export interface SseMessage {
  /** The `event:` field, or `"message"` when the frame has none. */
  event: string;
  /** Every `data:` line of the frame, joined with `\n`. */
  data: string;
  /** The stream's last event id at dispatch time — `""` until the server sends an `id:`. */
  lastEventId: string;
}

export interface SseParser {
  /** Feeds decoded text and returns the events it completed, in order. */
  push(text: string): SseMessage[];
}

export function createSseParser(): SseParser {
  let buffer = "";
  // A chunk that ended in `\r` may be the first half of a CRLF; the next chunk's `\n` is then skipped.
  let skipLeadingLf = false;
  let data: string[] = [];
  let eventType = "";
  let lastEventId = "";

  function processLine(line: string, out: SseMessage[]): void {
    if (line === "") {
      if (data.length > 0) {
        out.push({ event: eventType || "message", data: data.join("\n"), lastEventId });
      }
      data = [];
      eventType = "";
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") eventType = value;
    else if (field === "id" && !value.includes("\0")) lastEventId = value;
  }

  return {
    push(text) {
      const out: SseMessage[] = [];
      if (text === "") return out;
      if (skipLeadingLf && text.startsWith("\n")) text = text.slice(1);
      skipLeadingLf = false;

      buffer += text;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i];
        if (char !== "\n" && char !== "\r") continue;
        processLine(buffer.slice(start, i), out);
        if (char === "\r") {
          if (i + 1 === buffer.length) skipLeadingLf = true;
          else if (buffer[i + 1] === "\n") i++;
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
  };
}

/**
 * Reads a response body as SSE events. Bytes are decoded as a UTF-8 stream, so a multi-byte character
 * split across chunks survives. Stopping the iteration early (a `break`, or the consumer's own abort)
 * cancels the body so the connection is released.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
