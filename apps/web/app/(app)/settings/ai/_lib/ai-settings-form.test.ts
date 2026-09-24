import { describe, expect, test } from "bun:test";
import {
  AI_SETTINGS_DEFAULTS,
  type AiSettings,
  UpdateAiSettingsSchema,
} from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import {
  allowlistEntryId,
  allowlistValueProblem,
  baseUrlProblem,
  buildAllowlistEntry,
  buildUpdate,
  describeAiSettingsError,
  draftFromSettings,
  draftToPatch,
  draftToTest,
  initialWizardStep,
  isDestinationChange,
  keyFieldState,
  mcpConnectionMode,
  mcpEndpointUrl,
  parsePositiveInt,
  parseTemperature,
  settingsToUpdate,
  switchProvider,
  testErrorKey,
} from "./ai-settings-form";

const BASE: AiSettings = {
  enabled: false,
  provider: null,
  model: null,
  baseUrl: null,
  apiKeySet: false,
  keyConfigured: true,
  allowPrivateNetwork: false,
  effort: null,
  providerOptions: null,
  instructions: null,
  maxStepsPerRun: AI_SETTINGS_DEFAULTS.maxStepsPerRun,
  maxOutputTokens: AI_SETTINGS_DEFAULTS.maxOutputTokens,
  contextTokenLimit: AI_SETTINGS_DEFAULTS.contextTokenLimit,
  dailyTokenLimitPerPrincipal: AI_SETTINGS_DEFAULTS.dailyTokenLimitPerPrincipal,
  retentionDays: AI_SETTINGS_DEFAULTS.retentionDays,
  approvalTtlMinutes: AI_SETTINGS_DEFAULTS.approvalTtlMinutes,
  mcpEnabled: false,
  mcpClientAllowlistAdded: [],
  mcpClientAllowlistRemovedDefaults: [],
  mcpAllowAnyHttpsClient: false,
  disclosureAcknowledgedAt: null,
  verifiedAt: null,
  updatedAt: null,
};

function apiError(status: number, body: unknown, requestId = "req-1") {
  const message =
    (body as { message?: string } | undefined)?.message ?? `failed ${status}`;
  return new ApiError(status, message, body, requestId);
}

describe("settingsToUpdate / buildUpdate", () => {
  test("re-saves the read as a body the shared PUT schema accepts, without a key", () => {
    const body = settingsToUpdate({
      ...BASE,
      provider: "anthropic",
      model: "claude-opus-5",
      apiKeySet: true,
    });
    expect(UpdateAiSettingsSchema.safeParse(body).success).toBe(true);
    expect("apiKey" in body).toBe(false);
  });

  test("drops a removed-default id this build cannot represent", () => {
    const body = settingsToUpdate({
      ...BASE,
      mcpClientAllowlistRemovedDefaults: ["cursor", "Not Valid!"],
    });
    expect(body.mcpClientAllowlistRemovedDefaults).toEqual(["cursor"]);
  });

  test("applies the patch on top", () => {
    const body = buildUpdate(BASE, { mcpEnabled: true, retentionDays: 30 });
    expect(body.mcpEnabled).toBe(true);
    expect(body.retentionDays).toBe(30);
    expect(body.enabled).toBe(false);
  });
});

describe("the provider key", () => {
  const saved = { ...BASE, provider: "openai" as const, apiKeySet: true };

  test("a destination change is a provider or base-URL change", () => {
    expect(isDestinationChange(saved, "openai", null)).toBe(false);
    expect(isDestinationChange(saved, "anthropic", null)).toBe(true);
    expect(isDestinationChange(saved, "openai", "https://x.example")).toBe(true);
  });

  test("blank keeps the stored key only for the same destination", () => {
    expect(keyFieldState(saved, "openai", null)).toBe("keep");
    expect(keyFieldState(saved, "anthropic", null)).toBe("required");
  });

  test("an OpenAI-compatible server may run keyless", () => {
    expect(keyFieldState(BASE, "openai-compatible", "https://llm.example")).toBe(
      "optional",
    );
  });
});

describe("baseUrlProblem", () => {
  test("required only for the OpenAI-compatible provider", () => {
    expect(baseUrlProblem("", "openai-compatible", false)).toBe("required");
    expect(baseUrlProblem("", "openai", false)).toBeNull();
  });

  test("refuses what the API refuses from the text alone", () => {
    expect(baseUrlProblem("not a url", "openai-compatible", false)).toBe("invalid");
    expect(baseUrlProblem("ftp://x.example", "openai-compatible", false)).toBe("scheme");
    expect(baseUrlProblem("https://u:p@x.example/v1", "openai-compatible", false)).toBe(
      "credentials",
    );
    expect(baseUrlProblem("https://x.example/v1?k=1", "openai-compatible", false)).toBe(
      "queryFragment",
    );
    expect(baseUrlProblem("https://localhost/v1", "openai-compatible", true)).toBe(
      "loopback",
    );
  });

  test("plain http needs the OpenAI-compatible provider with the private-network option", () => {
    expect(baseUrlProblem("http://10.0.0.5:11434/v1", "openai-compatible", false)).toBe(
      "httpNeedsPrivate",
    );
    expect(baseUrlProblem("http://10.0.0.5:11434/v1", "openai-compatible", true)).toBeNull();
    expect(baseUrlProblem("https://llm.example/v1", "openai-compatible", false)).toBeNull();
  });
});

describe("initialWizardStep", () => {
  test("a fresh instance starts at the provider", () => {
    expect(initialWizardStep(BASE)).toBe("provider");
  });

  test("resumes at the first step that still needs the admin", () => {
    expect(initialWizardStep({ ...BASE, provider: "anthropic" })).toBe("credentials");
    expect(
      initialWizardStep({ ...BASE, provider: "openai-compatible", apiKeySet: false }),
    ).toBe("credentials");
    expect(
      initialWizardStep({
        ...BASE,
        provider: "openai-compatible",
        baseUrl: "https://llm.example/v1",
      }),
    ).toBe("model");
    expect(
      initialWizardStep({
        ...BASE,
        provider: "anthropic",
        apiKeySet: true,
        model: "claude-opus-5",
      }),
    ).toBe("test");
  });
});

describe("describeAiSettingsError", () => {
  test("maps every enable-gate 422 code and keeps the failed test", () => {
    for (const code of [
      "DISCLOSURE_REQUIRED",
      "PROVIDER_NOT_CONFIGURED",
      "API_KEY_REQUIRED",
    ]) {
      expect(describeAiSettingsError(apiError(422, { code, message: "x" })).key).toBe(
        `gate.${code}`,
      );
    }
    const test = {
      ok: false,
      checks: { auth: false, model: null, toolCalling: null },
      latencyMs: 120,
      error: { code: "PROVIDER_AUTH", message: "rejected" },
    };
    const info = describeAiSettingsError(
      apiError(422, { code: "CONNECTION_TEST_FAILED", message: "x", test }),
    );
    expect(info.key).toBe("gate.CONNECTION_TEST_FAILED");
    expect(info.test?.error?.code).toBe("PROVIDER_AUTH");
    expect(info.requestId).toBe("req-1");
  });

  test("tells the codeless 409s apart", () => {
    expect(
      describeAiSettingsError(
        apiError(409, {
          message:
            "AI_SECRET_KEY is not set or is not a 32-byte key — set one (openssl rand -hex 32) to store this secret.",
        }),
      ).key,
    ).toBe("secretKeyMissing");
    expect(
      describeAiSettingsError(
        apiError(409, {
          message:
            "The AI assistant cannot be enabled while authentication is disabled (AUTH_MODE=shim).",
        }),
      ).key,
    ).toBe("shimMode");
    expect(
      describeAiSettingsError(
        apiError(409, {
          message:
            "The AI settings were changed by someone else meanwhile — reload them and save again.",
        }),
      ).key,
    ).toBe("concurrentSave");
    const other = describeAiSettingsError(apiError(409, { message: "Something new" }));
    expect(other.key).toBe("conflict");
    expect(other.message).toBe("Something new");
  });

  test("maps the base-URL and shape 400s", () => {
    const cases: [string, string][] = [
      ["The base URL may not carry credentials — put the key in the API key field.", "baseUrl.credentials"],
      ["The base URL may not carry a query string or a fragment.", "baseUrl.queryFragment"],
      ["A plain http:// base URL is allowed only for the OpenAI-compatible provider on a private network (enable the private-network option).", "baseUrl.httpNeedsPrivate"],
      ["A plain http:// base URL must point at a private-network address, never a public one.", "baseUrl.httpPublic"],
      ["A loopback base URL is never allowed; use the host's LAN address.", "baseUrl.loopback"],
      ["This address range is never reachable (loopback, link-local, metadata or reserved).", "baseUrl.unreachable"],
      ["A private-network base URL needs the OpenAI-compatible provider with the private-network option on.", "baseUrl.privateNeedsOption"],
      ["The base URL is not a valid URL.", "baseUrl.invalid"],
      ["The base URL must be http:// or https://.", "baseUrl.scheme"],
      ["A private-network host is allowed only for the OpenAI-compatible provider.", "privateNetworkProviderOnly"],
      ["These options are not supported by the selected provider.", "providerOptions"],
      ["Choose a provider and a model before testing the connection.", "providerAndModelFirst"],
    ];
    for (const [message, key] of cases) {
      expect(describeAiSettingsError(apiError(400, { message })).key).toBe(key);
    }
    expect(
      describeAiSettingsError(apiError(400, { message: "Validation failed", errors: [] })).key,
    ).toBe("validation");
  });

  test("403, 404, network and the rest", () => {
    expect(describeAiSettingsError(apiError(403, {})).key).toBe("forbidden");
    expect(describeAiSettingsError(apiError(404, {})).key).toBe("notFound");
    expect(describeAiSettingsError(new TypeError("fetch failed")).key).toBe("network");
    expect(describeAiSettingsError(apiError(500, { message: "boom" })).key).toBe("generic");
  });
});

describe("testErrorKey", () => {
  test("known codes have copy; unknown codes fall back to the server text", () => {
    expect(testErrorKey("PROVIDER_AUTH")).toBe("PROVIDER_AUTH");
    expect(testErrorKey("TOOL_CALLING_UNSUPPORTED")).toBe("TOOL_CALLING_UNSUPPORTED");
    expect(testErrorKey("SOMETHING_NEWER")).toBeNull();
    expect(testErrorKey(null)).toBeNull();
  });
});

describe("MCP", () => {
  test("the endpoint is the instance origin + /mcp", () => {
    expect(mcpEndpointUrl("https://lazyit.acme.io")).toBe("https://lazyit.acme.io/mcp");
    expect(mcpEndpointUrl("http://10.0.0.4/")).toBe("http://10.0.0.4/mcp");
  });

  test("the status decides the mode; the browser scheme is only the fallback", () => {
    expect(mcpConnectionMode("personal-token", "https:")).toEqual({
      mode: "personal-token",
      source: "status",
    });
    expect(mcpConnectionMode("oauth", "http:")).toEqual({ mode: "oauth", source: "status" });
    expect(mcpConnectionMode(undefined, "http:")).toEqual({
      mode: "personal-token",
      source: "browser",
    });
    expect(mcpConnectionMode(undefined, "https:")).toEqual({ mode: "oauth", source: "browser" });
  });
});

describe("the allowlist editor", () => {
  test("explains why a value is refused", () => {
    expect(allowlistValueProblem("redirect_uri", "", "https://x")).toBe("labelRequired");
    expect(allowlistValueProblem("redirect_uri", "X", " ")).toBe("valueRequired");
    expect(allowlistValueProblem("cimd_url", "X", "http://x.example/meta")).toBe("cimdHttps");
    expect(allowlistValueProblem("redirect_uri", "X", "http://localhost:80@evil.com/")).toBe(
      "userinfo",
    );
    expect(allowlistValueProblem("redirect_uri", "X", "http://app.example/cb")).toBe(
      "httpNotLoopback",
    );
    expect(allowlistValueProblem("redirect_uri", "X", "javascript:alert(1)")).toBe(
      "browserScheme",
    );
    expect(allowlistValueProblem("redirect_uri", "X", "mailto:x@y")).toBe("redirectInvalid");
  });

  test("accepts https, loopback and private-use redirects, and https CIMD ids", () => {
    expect(allowlistValueProblem("redirect_uri", "X", "https://app.example/cb")).toBeNull();
    expect(allowlistValueProblem("redirect_uri", "X", "http://127.0.0.1/cb")).toBeNull();
    expect(allowlistValueProblem("redirect_uri", "X", "com.example.app:/cb")).toBeNull();
    expect(allowlistValueProblem("redirect_uri", "X", "cursor://a/cb")).toBeNull();
    expect(allowlistValueProblem("cimd_url", "X", "https://x.example/meta.json")).toBeNull();
  });

  test("ids are admin-prefixed, slugged and unique", () => {
    expect(allowlistEntryId("Zed editor", [])).toBe("admin-zed-editor");
    expect(allowlistEntryId("Zed editor", ["admin-zed-editor"])).toBe("admin-zed-editor-2");
    expect(allowlistEntryId("¡¡¡", [])).toBe("admin-client");
  });

  test("builds a schema-valid entry or returns the problem", () => {
    const built = buildAllowlistEntry("redirect_uri", " Pi ", "http://127.0.0.1/pi/cb", []);
    expect("entry" in built && built.entry).toEqual({
      id: "admin-pi",
      label: "Pi",
      match: { kind: "redirect_uri", pattern: "http://127.0.0.1/pi/cb" },
    });
    const refused = buildAllowlistEntry("cimd_url", "Pi", "http://x", []);
    expect(refused).toEqual({ problem: "cimdHttps" });
  });
});

describe("parsePositiveInt", () => {
  test("blank, zero, negatives and decimals are null", () => {
    expect(parsePositiveInt("")).toBeNull();
    expect(parsePositiveInt("0")).toBeNull();
    expect(parsePositiveInt("-3")).toBeNull();
    expect(parsePositiveInt("1.5")).toBeNull();
    expect(parsePositiveInt(" 42 ")).toBe(42);
    expect(parsePositiveInt("9999999999")).toBeNull();
  });
});

describe("the connection draft", () => {
  const saved: AiSettings = {
    ...BASE,
    provider: "openai-compatible",
    baseUrl: "http://10.0.0.5:11434/v1",
    allowPrivateNetwork: true,
    model: "llama-4",
    providerOptions: { temperature: 0.2 },
    apiKeySet: true,
  };

  test("opens from the saved configuration with a blank key", () => {
    expect(draftFromSettings(saved)).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://10.0.0.5:11434/v1",
      allowPrivateNetwork: true,
      apiKey: "",
      model: "llama-4",
      effort: null,
      temperature: "0.2",
    });
  });

  test("a fresh instance opens on the fallback provider's suggestion", () => {
    expect(draftFromSettings(BASE).model).toBe("claude-opus-5");
  });

  test("switching provider resets its fields and drops the typed key", () => {
    const draft = { ...draftFromSettings(saved), apiKey: "sk-typed" };
    const next = switchProvider(draft, "anthropic", saved);
    expect(next.apiKey).toBe("");
    expect(next.baseUrl).toBe("");
    expect(next.allowPrivateNetwork).toBe(false);
    expect(next.model).toBe("claude-opus-5");
    expect(switchProvider(next, "openai-compatible", saved)).toMatchObject({
      baseUrl: "http://10.0.0.5:11434/v1",
      allowPrivateNetwork: true,
      model: "llama-4",
      temperature: "0.2",
    });
  });

  test("the patch sends the key only when typed, and the base URL only for OpenAI-compatible", () => {
    expect("apiKey" in draftToPatch(draftFromSettings(saved))).toBe(false);
    const anthropic = draftToPatch({
      ...draftFromSettings(BASE),
      baseUrl: "https://ignored.example",
      allowPrivateNetwork: true,
      apiKey: " sk-ant ",
      temperature: "1",
    });
    expect(anthropic).toMatchObject({
      provider: "anthropic",
      baseUrl: null,
      allowPrivateNetwork: false,
      apiKey: "sk-ant",
      providerOptions: null,
    });
    expect(draftToPatch(draftFromSettings(saved)).providerOptions).toEqual({
      temperature: 0.2,
    });
    const body = buildUpdate(saved, draftToPatch(draftFromSettings(saved)));
    expect(UpdateAiSettingsSchema.safeParse(body).success).toBe(true);
  });

  test("the test draft carries the typed key and model", () => {
    expect(draftToTest({ ...draftFromSettings(saved), apiKey: "k" })).toEqual({
      provider: "openai-compatible",
      model: "llama-4",
      baseUrl: "http://10.0.0.5:11434/v1",
      allowPrivateNetwork: true,
      providerOptions: { temperature: 0.2 },
      apiKey: "k",
    });
  });

  test("temperature parsing", () => {
    expect(parseTemperature("")).toBeUndefined();
    expect(parseTemperature("0.7")).toBe(0.7);
    expect(Number.isNaN(parseTemperature("3"))).toBe(true);
    expect(Number.isNaN(parseTemperature("abc"))).toBe(true);
  });
});
