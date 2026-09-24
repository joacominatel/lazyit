import { describe, expect, mock, test } from "bun:test";
import type { AiConversationSettings, AiModelCatalog } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import {
  AUTO_APPROVE_CONSENT_KEY,
  createBody,
  customModelCandidate,
  DEFAULT_CHAT_SETTINGS,
  filterModels,
  hasAutoApproveConsent,
  parseAutoArgument,
  parseTemperature,
  rememberAutoApproveConsent,
  settingsErrorKey,
  settingsPatch,
  shortModelName,
  supportsTemperature,
  validModelId,
  viewOfDraft,
  viewOfSettings,
} from "./chat-settings";

const catalog: AiModelCatalog = {
  provider: "anthropic",
  defaultModel: "claude-sonnet-4-5",
  defaultEffort: "medium",
  supportsEffort: true,
  providerOptionKeys: [],
  models: [
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
    { id: "claude-haiku-4-5", label: null },
  ],
  listed: true,
  listingError: null,
};

const settings: AiConversationSettings = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  modelChosen: false,
  effort: null,
  providerOptions: null,
  modelLocked: false,
  autoApprove: false,
  autoApproveEnabledAt: null,
};

describe("views", () => {
  test("a created chat shows the server's settings; an unchosen model reads as the default", () => {
    const view = viewOfSettings(settings);
    expect(view.model).toBeNull();
    expect(view.runsOn).toBe("claude-sonnet-4-5");
    expect(view.locked).toBe(false);
    const chosen = viewOfSettings({
      ...settings,
      model: "claude-opus-4-1",
      modelChosen: true,
      providerOptions: { temperature: 0.4 },
      autoApprove: true,
    });
    expect(chosen).toMatchObject({ model: "claude-opus-4-1", temperature: 0.4, autoApprove: true });
  });

  test("the model is pinned once a run exists, even when the copy of the settings is older", () => {
    expect(viewOfSettings({ ...settings, modelLocked: true }).locked).toBe(true);
    expect(viewOfSettings(settings, { started: true }).locked).toBe(true);
  });

  test("a new chat's draft runs on the admin's default until a model is chosen", () => {
    expect(viewOfDraft(DEFAULT_CHAT_SETTINGS, catalog).runsOn).toBe("claude-sonnet-4-5");
    expect(viewOfDraft(DEFAULT_CHAT_SETTINGS, undefined).runsOn).toBeNull();
    expect(viewOfDraft({ ...DEFAULT_CHAT_SETTINGS, model: "x-1" }, catalog).runsOn).toBe("x-1");
  });
});

describe("createBody", () => {
  test("all defaults send no body at all (the pre-#1373 request)", () => {
    expect(createBody(DEFAULT_CHAT_SETTINGS)).toBeUndefined();
  });

  test("only what was chosen is sent", () => {
    expect(
      createBody({ model: "claude-opus-4-1", effort: "high", temperature: null, autoApprove: true }),
    ).toEqual({ model: "claude-opus-4-1", effort: "high", autoApprove: true });
    expect(createBody({ ...DEFAULT_CHAT_SETTINGS, temperature: 0 })).toEqual({
      providerOptions: { temperature: 0 },
    });
  });
});

describe("settingsPatch", () => {
  const current = { ...DEFAULT_CHAT_SETTINGS };

  test("nothing changed is no request", () => {
    expect(settingsPatch(current, {})).toBeNull();
    expect(settingsPatch(current, { autoApprove: false, effort: null })).toBeNull();
  });

  test("each changed field is sent; clearing effort or temperature sends null (the default)", () => {
    expect(settingsPatch(current, { autoApprove: true })).toEqual({ autoApprove: true });
    expect(settingsPatch({ ...current, effort: "low" }, { effort: null })).toEqual({ effort: null });
    expect(settingsPatch({ ...current, temperature: 1 }, { temperature: null })).toEqual({
      providerOptions: null,
    });
    expect(settingsPatch(current, { temperature: 0.7 })).toEqual({ providerOptions: { temperature: 0.7 } });
  });

  test("back to the default model names the default's id (there is no 'unset')", () => {
    const chosen = { ...current, model: "claude-opus-4-1" };
    expect(settingsPatch(chosen, { model: null }, "claude-sonnet-4-5")).toEqual({ model: "claude-sonnet-4-5" });
    expect(settingsPatch(chosen, { model: null }, null)).toBeNull();
  });
});

describe("model ids", () => {
  test("the shared rule decides what a typed id may be", () => {
    expect(validModelId(" gpt-4o-mini ")).toBe("gpt-4o-mini");
    expect(validModelId("models/gemini-2.5-pro")).toBe("models/gemini-2.5-pro");
    expect(validModelId("my-org/llama@q4:latest")).toBe("my-org/llama@q4:latest");
    expect(validModelId("")).toBeNull();
    expect(validModelId("a/../b")).toBeNull();
    expect(validModelId("has space")).toBeNull();
    expect(validModelId("x?y=1")).toBeNull();
    expect(validModelId("-leading")).toBeNull();
  });

  test("the search matches id or label, and a new valid id becomes a custom option", () => {
    expect(filterModels(catalog.models, "OPUS").map((m) => m.id)).toEqual(["claude-opus-4-1"]);
    expect(filterModels(catalog.models, "sonnet 4.5").map((m) => m.id)).toEqual(["claude-sonnet-4-5"]);
    expect(filterModels(catalog.models, "").length).toBe(3);
    expect(customModelCandidate("my-deployment", catalog.models)).toBe("my-deployment");
    expect(customModelCandidate("claude-haiku-4-5", catalog.models)).toBeNull();
    expect(customModelCandidate("not valid", catalog.models)).toBeNull();
  });

  test("the toolbar shows a short name", () => {
    expect(shortModelName("models/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(shortModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(shortModelName("a".repeat(40))).toHaveLength(28);
  });
});

describe("parseTemperature", () => {
  test("empty is the default, 0–2 is accepted (comma too), anything else is invalid", () => {
    expect(parseTemperature("")).toBeNull();
    expect(parseTemperature(" 0 ")).toBe(0);
    expect(parseTemperature("0,7")).toBe(0.7);
    expect(parseTemperature("2")).toBe(2);
    expect(parseTemperature("2.1")).toBe("invalid");
    expect(parseTemperature("-1")).toBe("invalid");
    expect(parseTemperature("warm")).toBe("invalid");
  });

  test("only a provider that takes a temperature shows the field", () => {
    expect(supportsTemperature(catalog)).toBe(false);
    expect(supportsTemperature({ ...catalog, providerOptionKeys: ["temperature"] })).toBe(true);
    expect(supportsTemperature(undefined)).toBe(false);
  });
});

describe("parseAutoArgument", () => {
  test("on/off in English and Spanish; anything else is not understood", () => {
    for (const on of ["on", "ON", "true", "yes", "sí", "si", "activar", "encender"]) expect(parseAutoArgument(on)).toBe(true);
    for (const off of ["off", "no", "false", "desactivar", "apagar"]) expect(parseAutoArgument(off)).toBe(false);
    expect(parseAutoArgument("maybe")).toBeNull();
    expect(parseAutoArgument("")).toBeNull();
  });
});

describe("settingsErrorKey", () => {
  const refusal = (status: number, code?: string) =>
    new ApiError(status, "refused", code ? { code, message: "refused" } : {});

  test("each documented refusal has its own message", () => {
    expect(settingsErrorKey(refusal(409, "CONVERSATION_SETTINGS_LOCKED"))).toBe("locked");
    expect(settingsErrorKey(refusal(409, "CONVERSATION_READ_ONLY"))).toBe("readOnly");
    expect(settingsErrorKey(refusal(409, "AI_DISABLED"))).toBe("aiDisabled");
    expect(settingsErrorKey(refusal(400, "EFFORT_UNSUPPORTED"))).toBe("effortUnsupported");
    expect(settingsErrorKey(refusal(400, "PROVIDER_OPTIONS_UNSUPPORTED"))).toBe("optionsUnsupported");
    expect(settingsErrorKey(refusal(400))).toBe("invalidModel");
    expect(settingsErrorKey(refusal(404))).toBe("notFound");
    expect(settingsErrorKey(refusal(500))).toBe("generic");
    expect(settingsErrorKey(new Error("offline"))).toBe("generic");
  });
});

describe("auto-approve consent memory", () => {
  test("remembered per browser; missing or failing storage reads as not yet (the dialog shows)", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(hasAutoApproveConsent(storage)).toBe(false);
    rememberAutoApproveConsent(storage);
    expect(store.get(AUTO_APPROVE_CONSENT_KEY)).toBe("1");
    expect(hasAutoApproveConsent(storage)).toBe(true);

    expect(hasAutoApproveConsent(undefined)).toBe(false);
    const throwing = {
      getItem: mock(() => {
        throw new Error("blocked");
      }),
      setItem: mock(() => {
        throw new Error("blocked");
      }),
    };
    expect(hasAutoApproveConsent(throwing)).toBe(false);
    expect(() => rememberAutoApproveConsent(throwing)).not.toThrow();
  });
});
