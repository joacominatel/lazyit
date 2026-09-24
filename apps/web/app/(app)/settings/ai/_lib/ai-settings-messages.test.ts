import { describe, expect, test } from "bun:test";
import {
  AI_EFFORT_LEVELS,
  AI_PROVIDER_KINDS,
  AI_SERVICE_ACCOUNT_ACCESS_LEVELS,
  MCP_CLIENT_ALLOWLIST_VERIFICATIONS,
} from "@lazyit/shared";
import enAi from "@/messages/en/aiSettings.json";
import esAi from "@/messages/es/aiSettings.json";
import enSettings from "@/messages/en/settings.json";
import esSettings from "@/messages/es/settings.json";
import {
  AI_SETTINGS_ERROR_KEYS,
  AI_TEST_ERROR_CODES,
  AI_WIZARD_STEPS,
} from "./ai-settings-form";

/**
 * A covering set (frontend.md §8.1): every code, kind and problem the page can render has copy in BOTH
 * catalogs, so a new value surfaces as a failing test rather than a raw key on screen.
 */
function at(catalog: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );
}

const ERROR_KEYS = AI_SETTINGS_ERROR_KEYS;

const AI_PATHS = [
  ...ERROR_KEYS.map((key) => `errors.${key}`),
  ...AI_TEST_ERROR_CODES.map((code) => `test.codes.${code}`),
  ...AI_PROVIDER_KINDS.map((kind) => `provider.descriptions.${kind}`),
  ...AI_WIZARD_STEPS.map((step) => `wizard.steps.${step}`),
  ...AI_EFFORT_LEVELS.map((level) => `model.effort.${level}`),
  ...[
    "required",
    "invalid",
    "scheme",
    "credentials",
    "queryFragment",
    "httpNeedsPrivate",
    "loopback",
  ].map((problem) => `credentials.baseUrl.problems.${problem}`),
  ...[
    "labelRequired",
    "valueRequired",
    "cimdHttps",
    "userinfo",
    "httpNotLoopback",
    "browserScheme",
    "redirectInvalid",
  ].map((problem) => `mcp.allowlist.errors.${problem}`),
  ...["https", "loopback", "private-use"].map((kind) => `mcp.allowlist.redirectKinds.${kind}`),
  ...MCP_CLIENT_ALLOWLIST_VERIFICATIONS.map(
    (verification) => `mcp.allowlist.verification.${verification}`,
  ),
];

const SETTINGS_PATHS = [
  "hub.ai.title",
  "hub.ai.description",
  "serviceAccounts.rowActions.aiAccess",
  ...AI_SERVICE_ACCOUNT_ACCESS_LEVELS.flatMap((level) => [
    `serviceAccounts.aiAccess.levels.${level}.label`,
    `serviceAccounts.aiAccess.levels.${level}.description`,
  ]),
  ...["infraReport", "noAiUse", "noAiConnect"].map(
    (note) => `serviceAccounts.aiAccess.notes.${note}`,
  ),
];

describe("Settings → AI copy", () => {
  test.each([
    ["en", enAi],
    ["es", esAi],
  ])("aiSettings (%s) covers every rendered code", (_locale, catalog) => {
    for (const path of AI_PATHS) {
      expect({ path, value: typeof at(catalog, path) }).toEqual({ path, value: "string" });
    }
  });

  test.each([
    ["en", enSettings],
    ["es", esSettings],
  ])("settings (%s) covers the hub card and the per-account AI access", (_locale, catalog) => {
    for (const path of SETTINGS_PATHS) {
      expect({ path, value: typeof at(catalog, path) }).toEqual({ path, value: "string" });
    }
  });
});
