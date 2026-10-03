import { describe, expect, test } from "bun:test";
import { AI_SETTINGS_DEFAULTS, type AiSettings } from "@lazyit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import common from "@/messages/en/common.json";
import messages from "@/messages/en/aiSettings.json";
import { AiDocumentExtractionSection } from "./ai-document-extraction-section";

/**
 * The Settings → AI document extraction card (#1477), rendered to static markup (ADR-0012: no DOM runner):
 * off by default, the disclosure of what is sent to the provider on the card, and the switch disabled with
 * the reason while the assistant is off or its provider reads no documents — but usable while on, to turn
 * it off.
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
        <AiDocumentExtractionSection settings={{ ...BASE, ...settings }} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** Text as React writes it into markup (apostrophes and quotes escaped). */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
}

function switchOf(html: string): string {
  return /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";
}

const copy = messages.documentExtraction;

describe("AiDocumentExtractionSection", () => {
  test("off by default, usable with the assistant on, with what is sent spelled out on the card", () => {
    const html = render({});
    const toggle = switchOf(html);
    expect(toggle).toContain('aria-checked="false"');
    expect(toggle).not.toContain(' disabled=""');
    expect(html).toContain(esc(copy.off));
    expect(html).toContain(esc(copy.disclosure.egress));
    expect(html).toContain(esc(copy.disclosure.review));
  });

  test("an older API without the field reads as off", () => {
    const settings: Partial<AiSettings> = { ...BASE };
    delete settings.documentExtractionEnabled;
    expect(switchOf(render(settings))).toContain('aria-checked="false"');
  });

  test("on reads as on", () => {
    const html = render({ documentExtractionEnabled: true });
    expect(switchOf(html)).toContain('aria-checked="true"');
    expect(html).toContain(esc(copy.on));
  });

  test("with the assistant off the switch is disabled and says why", () => {
    const html = render({ enabled: false });
    expect(switchOf(html)).toContain(' disabled=""');
    expect(html).toContain(esc(copy.availability.aiOff));
  });

  test("a provider that reads no documents disables it; while on it stays usable, to turn it off", () => {
    const off = render({ provider: "openai-compatible", model: "llama" });
    expect(switchOf(off)).toContain(' disabled=""');
    expect(off).toContain(esc(copy.availability.providerUnsupported));
    const on = render({ provider: "openai-compatible", model: "llama", documentExtractionEnabled: true });
    expect(switchOf(on)).not.toContain(' disabled=""');
    expect(on).toContain(esc(copy.off));
  });
});
