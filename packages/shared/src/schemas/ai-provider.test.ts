import { describe, expect, test } from "bun:test";
import {
  AI_PROVIDER_DESCRIPTORS,
  AI_PROVIDER_KINDS,
  AI_PROVIDER_OPTIONS_SCHEMAS,
  AiProviderDescriptorSchema,
  AiProviderKindSchema,
} from "./ai-provider";

// Provider kinds and descriptors (ADR-0097 decision 5). The descriptors drive the setup wizard, so every
// kind needs exactly one well-formed descriptor.

describe("AI provider kinds", () => {
  test("the four v1 providers, in wizard order", () => {
    expect([...AI_PROVIDER_KINDS]).toEqual(["anthropic", "openai", "google", "openai-compatible"]);
  });

  test("rejects an unknown kind", () => {
    expect(AiProviderKindSchema.safeParse("bedrock").success).toBe(false);
  });
});

describe("AI provider descriptors", () => {
  test("exactly one valid descriptor per kind, keyed by its own kind", () => {
    expect(Object.keys(AI_PROVIDER_DESCRIPTORS).sort()).toEqual([...AI_PROVIDER_KINDS].sort());
    for (const kind of AI_PROVIDER_KINDS) {
      const descriptor = AI_PROVIDER_DESCRIPTORS[kind];
      expect(AiProviderDescriptorSchema.safeParse(descriptor).success).toBe(true);
      expect(descriptor.kind).toBe(kind);
    }
  });

  test("only the OpenAI-compatible provider needs a base URL and may run without a key", () => {
    for (const kind of AI_PROVIDER_KINDS) {
      const descriptor = AI_PROVIDER_DESCRIPTORS[kind];
      const compatible = kind === "openai-compatible";
      expect(descriptor.requiresBaseUrl).toBe(compatible);
      expect(descriptor.requiresApiKey).toBe(!compatible);
    }
  });
});

describe("Per-provider options", () => {
  test("only the OpenAI-compatible provider accepts a temperature", () => {
    expect(AI_PROVIDER_OPTIONS_SCHEMAS["openai-compatible"].safeParse({ temperature: 0.2 }).success).toBe(
      true,
    );
    for (const kind of ["anthropic", "openai", "google"] as const) {
      expect(AI_PROVIDER_OPTIONS_SCHEMAS[kind].safeParse({ temperature: 0.2 }).success).toBe(false);
      expect(AI_PROVIDER_OPTIONS_SCHEMAS[kind].safeParse({}).success).toBe(true);
    }
  });

  test("temperature is bounded", () => {
    expect(AI_PROVIDER_OPTIONS_SCHEMAS["openai-compatible"].safeParse({ temperature: 3 }).success).toBe(
      false,
    );
  });
});
