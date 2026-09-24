import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import type { InputPart } from "@/lib/ai/stream-reducer";
import { inputForm, inputRequest } from "@/lib/ai/test-fixtures";
import common from "@/messages/en/common.json";
import en from "@/messages/en/ai.json";
import es from "@/messages/es/ai.json";
import shared from "@/messages/en/shared.json";
import { AiInputCard, PENDING_INPUT_ATTR } from "./ai-input-card";

/** React escapes `'` in text: compare catalog copy the way it lands in the markup. */
const esc = (text: string) => text.replace(/'/g, "&#x27;");

function render(part: InputPart, locale: "en" | "es" = "en"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={{ ai: locale === "en" ? en : es, shared, common }}
      timeZone="UTC"
    >
      <AiInputCard part={part} onAnswer={async () => ({ ok: true })} />
    </NextIntlClientProvider>,
  );
}

const pending = (form = inputForm()): InputPart => ({
  type: "input",
  request: inputRequest("tc", form),
  outcome: null,
});

describe("AiInputCard", () => {
  test("pending: title, reason, importance markers, the group's row and the three actions", () => {
    const html = render(pending());
    expect(html).toContain(PENDING_INPUT_ATTR);
    expect(html).toContain("Details for the new laptops");
    expect(html).toContain("I need the model and the site to register them.");
    expect(html).toContain(en.input.requiredLegend);
    expect(html).toContain(en.input.importance.recommended);
    expect(html).toContain("Laptops");
    expect(html).toContain("Row 1");
    expect(html).toContain(en.input.addRow);
    expect(html).toContain("Options from lazyit: locations");
    // Optional fields start collapsed.
    expect(html).toContain("More details (4 optional fields)");
    expect(html).not.toContain(">Arrival<");
    expect(html).toContain(en.input.submit);
    expect(html).toContain(en.input.skip);
    expect(html).toContain(esc(en.input.decline));
  });

  test("model-authored text is escaped, never markup", () => {
    const html = render(
      pending(inputForm({ title: "<b>Bold</b> **md**", reason: "<img src=x onerror=alert(1)>" })),
    );
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; **md**");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });

  test("submitted: the answer read-only, options by label, no actions", () => {
    const html = render({
      ...pending(),
      outcome: "submitted",
      answer: { values: { site: "loc2", count: 3, urgent: true }, groups: { items: [{ serial: "SN9" }] } },
    });
    expect(html).not.toContain(PENDING_INPUT_ATTR);
    expect(html).toContain(en.input.yourAnswer);
    expect(html).toContain("Warehouse");
    expect(html).not.toContain(">loc2<");
    expect(html).toContain("SN9");
    expect(html).toContain(en.input.states.submitted);
    expect(html).not.toContain(en.input.submit + "<");
  });

  test("skipped, declined and expired show their note; Spanish renders", () => {
    expect(render({ ...pending(), outcome: "skipped" })).toContain(esc(en.input.notes.skipped));
    expect(render({ ...pending(), outcome: "declined" })).toContain(esc(en.input.notes.declined));
    expect(render({ ...pending(), outcome: "expired" }, "es")).toContain(esc(es.input.notes.expired));
    expect(render(pending(), "es")).toContain(es.input.skip);
  });
});
