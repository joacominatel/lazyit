import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import common from "@/messages/en/common.json";
import { HelpTip } from "./help-tip";

/**
 * The "?" help tip (#1407), rendered to static markup (ADR-0012: no DOM runner): a real, named,
 * collapsed button, and no tip text in the page until it is opened — so a closed tip adds nothing a
 * screen reader would read twice.
 */
function render(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ common }}>
      <HelpTip topic="Base URL" href="/help/ai-assistant-setup">
        <p>The long explanation.</p>
      </HelpTip>
    </NextIntlClientProvider>,
  );
}

describe("HelpTip", () => {
  test("renders a focusable button named after its topic, collapsed", () => {
    const html = render();
    const button = /<button[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-label="More about Base URL"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-haspopup="dialog"');
  });

  test("keeps the explanation and the Manual link out of the page while closed", () => {
    const html = render();
    expect(html).not.toContain("The long explanation.");
    expect(html).not.toContain("/help/ai-assistant-setup");
  });
});
