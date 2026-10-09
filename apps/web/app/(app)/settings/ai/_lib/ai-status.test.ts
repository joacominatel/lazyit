import { describe, expect, test } from "bun:test";
import {
  AI_SETTINGS_DEFAULTS,
  type AiSettings,
  MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS,
} from "@lazyit/shared";
import { AI_TABS, aiStatusTiles, egressNeedsConsent } from "./ai-status";

const BASE: AiSettings = {
  ...AI_SETTINGS_DEFAULTS,
  enabled: false,
  provider: null,
  model: null,
  baseUrl: null,
  apiKeySet: false,
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

const ON: AiSettings = { ...BASE, enabled: true, provider: "anthropic", model: "claude-opus-5" };

describe("aiStatusTiles", () => {
  test("a fresh instance: nothing configured, everything off", () => {
    const tiles = aiStatusTiles(BASE);
    expect(tiles.provider).toEqual({ state: "none", label: null });
    expect(tiles.webSearch).toBe(false);
    expect(tiles.documents).toBe(false);
    expect(tiles.agents.on).toBe(false);
  });

  test("a saved provider with the assistant off reads as a draft, named", () => {
    expect(aiStatusTiles({ ...BASE, provider: "openai" }).provider).toEqual({
      state: "draft",
      label: "OpenAI",
    });
  });

  test("the assistant on reads as on, with the provider's name", () => {
    expect(aiStatusTiles(ON).provider).toEqual({ state: "on", label: "Anthropic" });
  });

  test("web search counts as on only where the provider can search", () => {
    expect(aiStatusTiles({ ...ON, webSearchEnabled: true }).webSearch).toBe(true);
    expect(
      aiStatusTiles({ ...ON, provider: "openai-compatible", model: "llama", webSearchEnabled: true })
        .webSearch,
    ).toBe(false);
  });

  test("document reading needs the switch AND the assistant on", () => {
    expect(aiStatusTiles({ ...ON, documentExtractionEnabled: true }).documents).toBe(true);
    expect(aiStatusTiles({ ...BASE, documentExtractionEnabled: true }).documents).toBe(false);
  });

  test("the client count is the built-ins kept plus the admin's own", () => {
    const all = MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS.length;
    expect(aiStatusTiles({ ...BASE, mcpEnabled: true }).agents).toEqual({ on: true, clients: all });
    const first = MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS[0]!;
    expect(
      aiStatusTiles({
        ...BASE,
        mcpClientAllowlistRemovedDefaults: [first.id, "gone-from-this-version"],
        mcpClientAllowlistAdded: [
          { id: "zed", label: "Zed", match: { kind: "redirect_uri", pattern: "http://127.0.0.1/cb" } },
        ],
      }).agents.clients,
    ).toBe(all - 1 + 1);
  });

  test("the tabs, in order", () => {
    expect([...AI_TABS]).toEqual(["connection", "limits", "capabilities", "agents"]);
  });
});

describe("egressNeedsConsent", () => {
  test("only turning a data-egress switch ON asks for consent", () => {
    expect(egressNeedsConsent(false, true)).toBe(true);
    expect(egressNeedsConsent(true, false)).toBe(false);
    expect(egressNeedsConsent(true, true)).toBe(false);
    expect(egressNeedsConsent(false, false)).toBe(false);
  });
});
