import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AiStatus } from "@lazyit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@/lib/api/client";
import { aiKeys } from "@/lib/api/hooks/use-ai-status";
import messages from "@/messages/en/ai.json";
import { AiAssistantRoot } from "./ai-assistant-root";
import { AiChatLauncher, isAiChatShortcut } from "./ai-chat-launcher";
import { AiChatPanelSlot } from "./ai-chat-panel-slot";

/**
 * The AI shell as the `(app)` layout mounts it — root, launcher in the header, panel slot beside the
 * column — rendered against each state of `GET /ai/status`. There is no DOM runner in this repo
 * (ADR-0012), so the tree is rendered to static markup with the status query's cache seeded, which is
 * exactly the state the first client render sees. Fail closed means: every state but "available"
 * produces the markup of a shell without the assistant, with nothing logged to the console.
 */

type Seed =
  | { kind: "pending" }
  | { kind: "error"; error: Error; data?: AiStatus }
  | { kind: "success"; data: unknown };

const status = (chatAvailable: boolean): AiStatus => ({
  chat: { available: chatAvailable },
  mcp: { available: false, auth: "oauth" },
  configRevision: "rev-1",
  retentionDays: 90,
});

function render(seed: Seed): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed.kind === "success") {
    client.setQueryData(aiKeys.status(), seed.data);
  } else if (seed.kind === "error") {
    const query = client.getQueryCache().build(client, { queryKey: aiKeys.status() });
    query.setState({
      ...query.state,
      status: "error",
      error: seed.error,
      data: seed.data,
      dataUpdatedAt: seed.data ? Date.now() : 0,
      errorUpdatedAt: Date.now(),
    });
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ ai: messages }}>
        <AiAssistantRoot>
          <div id="column">
            <header>
              <AiChatLauncher />
            </header>
            <main />
          </div>
          <AiChatPanelSlot />
        </AiAssistantRoot>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** The layout's markup with no assistant at all. */
const SHELL_WITHOUT_AI = '<div id="column"><header></header><main></main></div>';

let consoleError: ReturnType<typeof spyOn>;
let consoleWarn: ReturnType<typeof spyOn>;
beforeEach(() => {
  consoleError = spyOn(console, "error");
  consoleWarn = spyOn(console, "warn");
});
afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled();
  expect(consoleWarn).not.toHaveBeenCalled();
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe("the AI shell fails closed", () => {
  test.each<[string, Seed]>([
    ["while the status is loading", { kind: "pending" }],
    [
      "when the API predates the assistant (404)",
      { kind: "error", error: new ApiError(404, "Cannot GET /ai/status") },
    ],
    ["when the session expired (401)", { kind: "error", error: new ApiError(401, "Unauthorized") }],
    ["when the server fails (500)", { kind: "error", error: new ApiError(500, "Internal error") }],
    ["when the network fails", { kind: "error", error: new TypeError("Failed to fetch") }],
    [
      "when a refetch fails after an earlier 'available' answer",
      { kind: "error", error: new ApiError(503, "Unavailable"), data: status(true) },
    ],
    ["when the chat is off for the caller", { kind: "success", data: status(false) }],
    ["when the body is not recognized", { kind: "success", data: { chat: { available: "yes" } } }],
  ])("renders the shell unchanged %s", (_label, seed) => {
    expect(render(seed)).toBe(SHELL_WITHOUT_AI);
  });
});

describe("the AI shell when the chat is available", () => {
  test("renders the launcher in the header and keeps the panel closed", () => {
    const html = render({ kind: "success", data: status(true) });

    expect(html).toContain('aria-label="Open the AI assistant"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-keyshortcuts="Meta+J Control+J"');
    // The launcher sits inside the header; the closed panel adds nothing after the column.
    expect(html.indexOf("<button")).toBeGreaterThan(html.indexOf("<header>"));
    expect(html.indexOf("<button")).toBeLessThan(html.indexOf("</header>"));
    expect(html.endsWith("<main></main></div>")).toBe(true);
    expect(html).not.toContain("<aside");
  });
});

describe("isAiChatShortcut", () => {
  const key = (overrides: Partial<Parameters<typeof isAiChatShortcut>[0]>) => ({
    key: "j",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  });

  test("matches ⌘J and Ctrl+J, in either case", () => {
    expect(isAiChatShortcut(key({ metaKey: true }))).toBe(true);
    expect(isAiChatShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isAiChatShortcut(key({ ctrlKey: true, key: "J" }))).toBe(true);
  });

  test("ignores plain J, other modifiers, other keys and IME composition", () => {
    expect(isAiChatShortcut(key({}))).toBe(false);
    expect(isAiChatShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isAiChatShortcut(key({ metaKey: true, altKey: true }))).toBe(false);
    expect(isAiChatShortcut(key({ ctrlKey: true, key: "k" }))).toBe(false);
    expect(isAiChatShortcut(key({ ctrlKey: true, isComposing: true }))).toBe(false);
  });
});
