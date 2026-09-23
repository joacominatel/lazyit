import { describe, expect, test } from "bun:test";
import {
  AI_SERVICE_ACCOUNT_ACCESS_DEFAULT,
  AI_SETTINGS_DEFAULTS,
  AiConnectionDraftSchema,
  AiConnectionTestResultSchema,
  AiServiceAccountSettingsSchema,
  AiSettingsSchema,
  AiStatusSchema,
  McpClientAllowlistAddedSchema,
  McpClientAllowlistEntrySchema,
  McpClientAllowlistMatchSchema,
  McpClientAllowlistRemovedDefaultsSchema,
  UpdateAiSettingsSchema,
  resolveMcpClientAllowlist,
  type McpClientAllowlistEntry,
} from "./ai-settings";

// AI settings, status and per-SA access (ADR-0097 decisions 1, 4, 7). The most important guard here is
// that the provider key is WRITE-ONLY (INV-AI-6): the read shape can never carry it.

const baseUpdate = {
  enabled: false,
  provider: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
  allowPrivateNetwork: false,
  effort: null,
  providerOptions: null,
  instructions: null,
  maxStepsPerRun: 20,
  maxOutputTokens: 16000,
  contextTokenLimit: 150000,
  dailyTokenLimitPerPrincipal: 2000000,
  retentionDays: 90,
  approvalTtlMinutes: 30,
  mcpEnabled: false,
  mcpClientAllowlistAdded: [],
  mcpClientAllowlistRemovedDefaults: [],
  mcpAllowAnyHttpsClient: false,
} as const;

describe("AiSettings read shape is write-only for the key", () => {
  test("has apiKeySet and keyConfigured, never a key or its envelope", () => {
    const shape = AiSettingsSchema.shape;
    expect("apiKeySet" in shape).toBe(true);
    expect("keyConfigured" in shape).toBe(true);
    for (const forbidden of ["apiKey", "apiKeyCiphertext", "apiKeyIv", "apiKeyAuthTag"]) {
      expect(forbidden in shape).toBe(false);
    }
  });

  test("parsing a payload that smuggles the key strips it", () => {
    const parsed = AiSettingsSchema.parse({
      ...baseUpdate,
      apiKeySet: true,
      keyConfigured: true,
      disclosureAcknowledgedAt: null,
      verifiedAt: null,
      updatedAt: null,
      apiKey: "sk-secret",
    });
    expect("apiKey" in parsed).toBe(false);
  });
});

describe("UpdateAiSettings write shape", () => {
  test("the key may be omitted (keep), set, or null (clear)", () => {
    expect(UpdateAiSettingsSchema.safeParse(baseUpdate).success).toBe(true);
    expect(UpdateAiSettingsSchema.safeParse({ ...baseUpdate, apiKey: "sk-new" }).success).toBe(true);
    expect(UpdateAiSettingsSchema.safeParse({ ...baseUpdate, apiKey: null }).success).toBe(true);
  });

  test("an empty key is refused rather than stored", () => {
    expect(UpdateAiSettingsSchema.safeParse({ ...baseUpdate, apiKey: "   " }).success).toBe(false);
  });

  test("unknown fields are refused (no smuggled ciphertext)", () => {
    expect(
      UpdateAiSettingsSchema.safeParse({ ...baseUpdate, apiKeyCiphertext: "x" }).success,
    ).toBe(false);
  });

  test("retention is bounded to 7–3650 days", () => {
    expect(UpdateAiSettingsSchema.safeParse({ ...baseUpdate, retentionDays: 6 }).success).toBe(false);
    expect(UpdateAiSettingsSchema.safeParse({ ...baseUpdate, retentionDays: 3651 }).success).toBe(
      false,
    );
    expect(UpdateAiSettingsSchema.safeParse({ ...baseUpdate, retentionDays: 7 }).success).toBe(true);
  });

  test("integers stay inside int4 (ADR-0036)", () => {
    expect(
      UpdateAiSettingsSchema.safeParse({ ...baseUpdate, contextTokenLimit: 2 ** 31 }).success,
    ).toBe(false);
  });

  test("a private-network host is allowed only for the OpenAI-compatible provider", () => {
    expect(
      UpdateAiSettingsSchema.safeParse({ ...baseUpdate, allowPrivateNetwork: true }).success,
    ).toBe(false);
    expect(
      UpdateAiSettingsSchema.safeParse({
        ...baseUpdate,
        provider: "openai-compatible",
        baseUrl: "http://10.0.0.5:11434/v1",
        allowPrivateNetwork: true,
      }).success,
    ).toBe(true);
  });

  test("provider options must suit the selected provider", () => {
    expect(
      UpdateAiSettingsSchema.safeParse({ ...baseUpdate, providerOptions: { temperature: 0.3 } })
        .success,
    ).toBe(false);
    expect(
      UpdateAiSettingsSchema.safeParse({
        ...baseUpdate,
        provider: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
        providerOptions: { temperature: 0.3 },
      }).success,
    ).toBe(true);
  });

  test("the base URL must be http(s)", () => {
    expect(
      UpdateAiSettingsSchema.safeParse({ ...baseUpdate, baseUrl: "ftp://example.com" }).success,
    ).toBe(false);
  });

  test("the defaults are themselves a valid write", () => {
    expect(
      UpdateAiSettingsSchema.safeParse({ ...baseUpdate, ...AI_SETTINGS_DEFAULTS }).success,
    ).toBe(true);
  });
});

describe("Connection test", () => {
  test("an empty draft tests the saved configuration", () => {
    expect(AiConnectionDraftSchema.safeParse({}).success).toBe(true);
  });

  test("a failed auth check skips the others (null) and carries a short error", () => {
    const parsed = AiConnectionTestResultSchema.safeParse({
      ok: false,
      checks: { auth: false, model: null, toolCalling: null },
      latencyMs: 120,
      error: { code: "PROVIDER_AUTH", message: "The provider rejected the key" },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("AI status", () => {
  test("accepts the per-caller shape", () => {
    expect(
      AiStatusSchema.safeParse({
        chat: { available: true },
        mcp: { available: false, auth: "personal-token" },
        configRevision: "2026-09-23T00:00:00.000Z",
        retentionDays: 90,
      }).success,
    ).toBe(true);
  });

  test("rejects an unknown MCP auth mode", () => {
    expect(
      AiStatusSchema.safeParse({
        chat: { available: false },
        mcp: { available: false, auth: "basic" },
        configRevision: "r",
        retentionDays: null,
      }).success,
    ).toBe(false);
  });
});

describe("Per-service-account AI access", () => {
  test("an absent row reads as read-write", () => {
    expect(AI_SERVICE_ACCOUNT_ACCESS_DEFAULT).toBe("read-write");
  });

  test("accepts each level and an optional cap; rejects unknown levels and a zero cap", () => {
    for (const access of ["off", "read-only", "read-write"]) {
      expect(
        AiServiceAccountSettingsSchema.safeParse({ access, maxMutationsPerRun: null }).success,
      ).toBe(true);
    }
    expect(
      AiServiceAccountSettingsSchema.safeParse({ access: "admin", maxMutationsPerRun: null })
        .success,
    ).toBe(false);
    expect(
      AiServiceAccountSettingsSchema.safeParse({ access: "read-write", maxMutationsPerRun: 0 })
        .success,
    ).toBe(false);
  });
});

describe("MCP client allowlist (ADR-0097 decision 13)", () => {
  const claudeCode: McpClientAllowlistEntry = {
    id: "claude-code",
    label: "Claude Code",
    match: { kind: "cimd_url", url: "https://claude-code.example.com/client-metadata.json" },
  };
  const cursor: McpClientAllowlistEntry = {
    id: "cursor",
    label: "Cursor",
    match: { kind: "redirect_uri", pattern: "https://cursor.example.com/oauth/callback" },
  };

  test("a match is either a CIMD URL or a redirect-URI pattern; unknown kinds are rejected", () => {
    expect(McpClientAllowlistMatchSchema.safeParse(claudeCode.match).success).toBe(true);
    expect(
      McpClientAllowlistMatchSchema.safeParse({
        kind: "redirect_uri",
        pattern: "https://chat.example.com/oauth/redirect",
      }).success,
    ).toBe(true);
    expect(
      McpClientAllowlistMatchSchema.safeParse({ kind: "client_name", name: "Claude Code" }).success,
    ).toBe(false);
  });

  test("an entry can never match on the client name", () => {
    expect(
      McpClientAllowlistEntrySchema.safeParse({
        id: "fake",
        label: "Claude Code",
        match: { kind: "client_name", value: "Claude Code" },
      }).success,
    ).toBe(false);
  });

  test("a CIMD client id must be https", () => {
    expect(
      McpClientAllowlistMatchSchema.safeParse({ kind: "cimd_url", url: "http://example.com/c.json" })
        .success,
    ).toBe(false);
  });

  test("a redirect pattern must be https, or plain http only on a loopback address", () => {
    for (const pattern of ["http://127.0.0.1/callback", "http://localhost:33418/cb", "http://[::1]/cb"]) {
      expect(McpClientAllowlistMatchSchema.safeParse({ kind: "redirect_uri", pattern }).success).toBe(
        true,
      );
    }
    for (const pattern of ["http://evil.example.com/cb", "cursor://x/cb", "http://127.0.0.1.evil.com/cb"]) {
      expect(McpClientAllowlistMatchSchema.safeParse({ kind: "redirect_uri", pattern }).success).toBe(
        false,
      );
    }
  });

  test("the admin's entries have unique ids and are bounded", () => {
    expect(McpClientAllowlistAddedSchema.safeParse([claudeCode, cursor]).success).toBe(true);
    expect(McpClientAllowlistAddedSchema.safeParse([cursor, cursor]).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => ({ ...cursor, id: `c${i}` }));
    expect(McpClientAllowlistAddedSchema.safeParse(many).success).toBe(false);
  });

  test("removed-default ids are de-duplicated", () => {
    expect(McpClientAllowlistRemovedDefaultsSchema.parse(["cursor", "cursor"])).toEqual(["cursor"]);
  });

  test("the settings read drops an entry this build cannot parse instead of failing", () => {
    const parsed = AiSettingsSchema.parse({
      ...baseUpdate,
      apiKeySet: false,
      keyConfigured: false,
      disclosureAcknowledgedAt: null,
      verifiedAt: null,
      updatedAt: null,
      mcpClientAllowlistAdded: [cursor, { id: "newer", label: "x", match: { kind: "spiffe" } }],
    });
    expect(parsed.mcpClientAllowlistAdded).toEqual([cursor]);
  });

  test("the any-https-client policy is off by default", () => {
    expect(AI_SETTINGS_DEFAULTS.mcpAllowAnyHttpsClient).toBe(false);
  });

  test("the effective list is the defaults minus the removed ones, plus the admin's entries", () => {
    const zed: McpClientAllowlistEntry = {
      id: "zed",
      label: "Zed",
      match: { kind: "redirect_uri", pattern: "http://127.0.0.1/callback" },
    };
    const internal: McpClientAllowlistEntry = {
      id: "internal-agent",
      label: "Our agent",
      match: { kind: "cimd_url", url: "https://agent.example.com/client.json" },
    };
    expect(resolveMcpClientAllowlist([claudeCode, cursor, zed], [internal], ["cursor"])).toEqual([
      claudeCode,
      zed,
      internal,
    ]);
  });

  test("an admin entry cannot overwrite a default with the same id", () => {
    const hijack: McpClientAllowlistEntry = {
      ...claudeCode,
      match: { kind: "cimd_url", url: "https://attacker.example.com/client.json" },
    };
    expect(resolveMcpClientAllowlist([claudeCode], [hijack], [])).toEqual([claudeCode]);
  });
});
