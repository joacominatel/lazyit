import { describe, expect, mock, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/messages/en/ai.json";
import { AiComposer } from "./ai-composer";

/**
 * "Ask AI to fill" (#1478): the prepared message is typed into the box and never sent by itself. There is no
 * DOM runner in this repo (ADR-0012), so the composer is rendered to static markup: the render that takes
 * the prepared message is the one a person sees.
 */
function render(prefill: { text: string; seq: number } | null) {
  const onSend = mock(async () => true);
  const onPrefillTaken = mock(() => {});
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ ai: en }}>
      <AiComposer
        busy={false}
        running={false}
        stopping={false}
        blockedByApproval={false}
        onSend={onSend}
        onStop={() => {}}
        prefill={prefill}
        onPrefillTaken={onPrefillTaken}
      />
    </NextIntlClientProvider>,
  );
  return { html, onSend };
}

describe("AiComposer prefill (#1478)", () => {
  test("a prepared message fills the box and is not sent", () => {
    const { html, onSend } = render({ text: "Read the document “invoice.pdf” and fill in the purchase.", seq: 1 });
    expect(html).toMatch(/<textarea[^>]*>Read the document “invoice.pdf” and fill in the purchase.<\/textarea>/);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("without one the box starts empty", () => {
    const { html, onSend } = render(null);
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(onSend).not.toHaveBeenCalled();
  });
});
