import { describe, expect, test } from "bun:test";
import { AI_SETTINGS_DEFAULTS, type AiSettings } from "@lazyit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import common from "@/messages/en/common.json";
import messages from "@/messages/en/aiSettings.json";
import { AiWebSearchSection, WebSearchDisclosure } from "./ai-web-search-section";

/**
 * The Settings → AI web search card (#1389), rendered to static markup (ADR-0012: no DOM runner): the
 * switch reflects the setting and is disabled with the reason where the configured provider or model has
 * no native search — but stays usable while on, to turn it off. What leaves lazyit lives in the switch's
 * "?" tip and in the consent dialog turning it on opens (#1540) — both render `WebSearchDisclosure`.
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

function wrap(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ aiSettings: messages, common }}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

function render(settings: Partial<AiSettings>): string {
  return wrap(<AiWebSearchSection settings={{ ...BASE, ...settings }} />);
}

function disclosure(provider: AiSettings["provider"]): string {
  return wrap(<WebSearchDisclosure provider={provider} />);
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
  test("off by default, usable on a supported provider", () => {
    const html = render({});
    const toggle = switchOf(html);
    expect(toggle).toContain('aria-checked="false"');
    expect(toggle).not.toContain(" disabled=\"\"");
    expect(html).toContain(esc(messages.webSearch.off));
  });

  test("the disclosure says what leaves, that results are untrusted; OpenAI gets its own note", () => {
    const html = disclosure("anthropic");
    expect(html).toContain(esc(messages.webSearch.disclosure.title));
    expect(html).toContain(esc(messages.webSearch.disclosure.egress));
    expect(html).toContain(esc(messages.webSearch.disclosure.untrusted));
    expect(html).not.toContain(esc(messages.webSearch.disclosure.openai));
    expect(disclosure("openai")).toContain(esc(messages.webSearch.disclosure.openai));
  });

  test("a configuration card: the explanations and the disclosure sit behind help tips", () => {
    const html = render({});
    // #1407/#1540: the description, the switch detail, the disclosure and the cap explanation are not
    // on the card…
    expect(html).not.toContain(esc(messages.webSearch.description));
    expect(html).not.toContain(esc(messages.webSearch.switch.description));
    expect(html).not.toContain(esc(messages.webSearch.maxUses.description));
    expect(html).not.toContain(esc(messages.webSearch.disclosure.egress));
    // …they are one focusable "?" away, each named after what it explains (the switch's tip holds the
    // disclosure; turning the switch on shows it again in the consent dialog).
    expect(html).toContain(`aria-label="More about ${messages.webSearch.title}"`);
    expect(html).toContain(`aria-label="More about ${messages.webSearch.switch.label}"`);
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
