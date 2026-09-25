import { describe, expect, test } from "bun:test";
import { AI_SETTINGS_DEFAULTS, type AiSettings } from "@lazyit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import common from "@/messages/en/common.json";
import messages from "@/messages/en/aiSettings.json";
import { AiWebSearchSection } from "./ai-web-search-section";

/**
 * The Settings → AI web search card (#1389), rendered to static markup (ADR-0012: no DOM runner): the
 * switch reflects the setting, says what leaves lazyit, and is disabled with the reason where the
 * configured provider or model has no native search — but stays usable while on, to turn it off.
 */
const BASE: AiSettings = {
  ...AI_SETTINGS_DEFAULTS,
  enabled: true,
  provider: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
  apiKeySet: true,
  keyConfigured: true,
  effort: null,
  providerOptions: null,
  instructions: null,
  dailyTokenLimitPerPrincipal: 2_000_000,
  mcpClientAllowlistAdded: [],
  mcpClientAllowlistRemovedDefaults: [],
  disclosureAcknowledgedAt: null,
  verifiedAt: null,
  updatedAt: null,
};

function render(settings: Partial<AiSettings>): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ aiSettings: messages, common }}>
        <AiWebSearchSection settings={{ ...BASE, ...settings }} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** Text as React writes it into markup (apostrophes and quotes escaped). */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
}

/** The `<button role="switch">` of the card. */
function switchOf(html: string): string {
  return /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";
}

describe("AiWebSearchSection", () => {
  test("off by default, usable on a supported provider, with the egress disclosure", () => {
    const html = render({});
    const toggle = switchOf(html);
    expect(toggle).toContain('aria-checked="false"');
    expect(toggle).not.toContain(" disabled=\"\"");
    expect(html).toContain(esc(messages.webSearch.disclosure.egress));
    expect(html).toContain(esc(messages.webSearch.off));
  });

  test("says once searched, nothing in the conversation is auto-approved; OpenAI gets its own note", () => {
    const html = render({});
    expect(html).toContain(esc(messages.webSearch.disclosure.untrusted));
    expect(html).not.toContain(esc(messages.webSearch.disclosure.openai));
    expect(render({ provider: "openai", model: "gpt-6-sol" })).toContain(
      esc(messages.webSearch.disclosure.openai),
    );
  });

  test("a configuration card: the long explanations sit behind help tips, the egress stays shown", () => {
    const html = render({});
    // #1407: the description, the switch detail and the per-step cap explanation are not on the card…
    expect(html).not.toContain(esc(messages.webSearch.description));
    expect(html).not.toContain(esc(messages.webSearch.switch.description));
    expect(html).not.toContain(esc(messages.webSearch.maxUses.description));
    // …they are one focusable "?" away, each named after what it explains…
    expect(html).toContain(`aria-label="More about ${messages.webSearch.title}"`);
    expect(html).toContain(`aria-label="More about ${messages.webSearch.switch.label}"`);
    // …and what leaves lazyit is still spelled out on the card itself.
    expect(html).toContain(esc(messages.webSearch.disclosure.title));
    expect(html).toContain(esc(messages.webSearch.disclosure.egress));
  });

  test("on reads as on", () => {
    const toggle = switchOf(render({ webSearchEnabled: true }));
    expect(toggle).toContain('aria-checked="true"');
  });

  test("an unsupported provider disables the switch and says why", () => {
    const html = render({ provider: "openai-compatible", model: "llama" });
    expect(switchOf(html)).toContain(" disabled=\"\"");
    expect(html).toContain(esc(messages.webSearch.availability.providerUnsupported));
  });

  test("an unsupported model says why; the switch stays usable while on, to turn it off", () => {
    const html = render({ provider: "google", model: "gemini-2.5-flash", webSearchEnabled: true });
    expect(html).toContain(esc(messages.webSearch.availability.modelUnsupported));
    expect(switchOf(html)).not.toContain(" disabled=\"\"");
    expect(html).toContain(esc(messages.webSearch.off));
  });
});
