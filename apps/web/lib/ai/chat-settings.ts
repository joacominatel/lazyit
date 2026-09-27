import {
  AiConversationModelIdSchema,
  type AiConversationSettings,
  type AiEffort,
  type AiModelCatalog,
  type CreateAiConversation,
  type UpdateAiConversation,
} from "@lazyit/shared";
import { refusalOf } from "./error-kinds";

/**
 * Per-chat settings (issues #1373 model and reasoning, #1376 auto-approve). Pure rules for the composer's
 * settings popover, the `/model` and `/auto` commands, and the create / PATCH bodies; the API decides
 * (docs/ai-assistant/provider-and-runtime.md "As built (#1373, #1376)").
 *
 * A chat that has not been created yet keeps a local {@link ChatSettingsDraft}; it is sent with
 * `POST /ai/conversations` on the first message. An existing chat is changed with
 * `PATCH /ai/conversations/:id`: the model fields only until its first run, auto-approve at any time.
 */

/** What the user picked. `null` means "the instance default" (the admin's setting at call time). */
export interface ChatSettingsDraft {
  model: string | null;
  effort: AiEffort | null;
  temperature: number | null;
  autoApprove: boolean;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettingsDraft = {
  model: null,
  effort: null,
  temperature: null,
  autoApprove: false,
};

/** The chat's settings as the popover shows them. */
export interface ChatSettingsView extends ChatSettingsDraft {
  /** The model the chat runs on (chosen, else the default) — null while neither is known yet. */
  runsOn: string | null;
  /** Model, effort and options are pinned (the first run started). */
  locked: boolean;
}

/** The server's settings of an existing chat, as the popover shows them. */
export function viewOfSettings(
  settings: AiConversationSettings,
  opts: { started: boolean } = { started: false },
): ChatSettingsView {
  return {
    model: settings.modelChosen ? settings.model : null,
    effort: settings.effort,
    temperature: settings.providerOptions?.temperature ?? null,
    autoApprove: settings.autoApprove,
    runsOn: settings.model,
    // A chat that already has messages has a run, even if the copy of its settings predates it.
    locked: settings.modelLocked || opts.started,
  };
}

/** A new chat's local draft, as the popover shows it. */
export function viewOfDraft(draft: ChatSettingsDraft, catalog: AiModelCatalog | null | undefined): ChatSettingsView {
  return { ...draft, runsOn: draft.model ?? catalog?.defaultModel ?? null, locked: false };
}

/** The `POST /ai/conversations` body for a draft; `undefined` when everything is the default. */
export function createBody(draft: ChatSettingsDraft): CreateAiConversation | undefined {
  const body: CreateAiConversation = {};
  if (draft.model !== null) body.model = draft.model;
  if (draft.effort !== null) body.effort = draft.effort;
  if (draft.temperature !== null) body.providerOptions = { temperature: draft.temperature };
  if (draft.autoApprove) body.autoApprove = true;
  return Object.keys(body).length === 0 ? undefined : body;
}

/**
 * The PATCH body for one change of the draft fields; `null` when nothing changes. The API has no "unset
 * the model", so going back to the default on an existing chat names the default model's id.
 */
export function settingsPatch(
  current: ChatSettingsDraft,
  change: Partial<ChatSettingsDraft>,
  defaultModel: string | null = null,
): UpdateAiConversation | null {
  const patch: UpdateAiConversation = {};
  if (change.model !== undefined && change.model !== current.model) {
    const model = change.model ?? defaultModel;
    if (model !== null) patch.model = model;
  }
  if (change.effort !== undefined && change.effort !== current.effort) patch.effort = change.effort;
  if (change.temperature !== undefined && change.temperature !== current.temperature) {
    patch.providerOptions = change.temperature === null ? null : { temperature: change.temperature };
  }
  if (change.autoApprove !== undefined && change.autoApprove !== current.autoApprove) {
    patch.autoApprove = change.autoApprove;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** A typed model id, checked with the shared rule (letters, digits and `. _ - : / @`, no `..`). */
export function validModelId(text: string): string | null {
  const parsed = AiConversationModelIdSchema.safeParse(text);
  return parsed.success ? parsed.data : null;
}

/** The listed models matching a search (id or label, case-insensitive), in the provider's order. */
export function filterModels(
  models: readonly AiModelCatalog["models"][number][],
  query: string,
): AiModelCatalog["models"][number][] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...models];
  return models.filter(
    (m) => m.id.toLowerCase().includes(q) || (m.label ?? "").toLowerCase().includes(q),
  );
}

/**
 * The "use this custom model id" option for what was typed: the trimmed, valid id when it is not a listed
 * model already; `null` otherwise (nothing typed, invalid, or listed).
 */
export function customModelCandidate(
  query: string,
  models: readonly { id: string }[],
): string | null {
  const id = validModelId(query);
  if (id === null) return null;
  return models.some((m) => m.id === id) ? null : id;
}

/** The temperature field: empty → the default (`null`); a number in [0, 2]; anything else invalid. */
export function parseTemperature(text: string): number | null | "invalid" {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return "invalid";
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : "invalid";
}

/** A short name for the toolbar button: the part after the last `/` (`models/gemini-2.5-pro`). */
export function shortModelName(id: string): string {
  const tail = id.split("/").filter(Boolean).at(-1) ?? id;
  return tail.length > 28 ? `${tail.slice(0, 27)}…` : tail;
}

/** `/auto on|off` — `true`, `false`, or `null` when the argument is not understood. */
export function parseAutoArgument(argument: string): boolean | null {
  const value = argument
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  if (["on", "true", "yes", "si", "1", "activar", "encender"].includes(value)) return true;
  if (["off", "false", "no", "0", "desactivar", "apagar"].includes(value)) return false;
  return null;
}

/** Why a settings change was refused, as a key under `ai.settings.errors`. */
export type SettingsErrorKey =
  | "locked"
  | "readOnly"
  | "aiDisabled"
  | "effortUnsupported"
  | "optionsUnsupported"
  | "invalidModel"
  | "notFound"
  | "generic";

export const SETTINGS_ERROR_KEYS: readonly SettingsErrorKey[] = [
  "locked",
  "readOnly",
  "aiDisabled",
  "effortUnsupported",
  "optionsUnsupported",
  "invalidModel",
  "notFound",
  "generic",
];

export function settingsErrorKey(error: unknown): SettingsErrorKey {
  const refusal = refusalOf(error);
  if (!refusal) return "generic";
  switch (refusal.code) {
    case "CONVERSATION_SETTINGS_LOCKED":
      return "locked";
    case "CONVERSATION_READ_ONLY":
      return "readOnly";
    case "AI_DISABLED":
      return "aiDisabled";
    case "EFFORT_UNSUPPORTED":
      return "effortUnsupported";
    case "PROVIDER_OPTIONS_UNSUPPORTED":
      return "optionsUnsupported";
  }
  if (refusal.status === 404) return "notFound";
  if (refusal.status === 400) return "invalidModel";
  return "generic";
}

/** Whether the catalog lets a chat set a temperature (only the providers that take it). */
export function supportsTemperature(catalog: AiModelCatalog | null | undefined): boolean {
  return catalog?.providerOptionKeys.includes("temperature") === true;
}

/** Where this browser remembers that its user read and accepted the auto-approve explanation. */
export const AUTO_APPROVE_CONSENT_KEY = "lazyit.ai.autoApproveConsent";

/**
 * Whether the user already accepted the auto-approve explanation in this browser. A convenience only —
 * storage that is missing or throws reads as "not yet", so the dialog shows again (never the reverse).
 */
export function hasAutoApproveConsent(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(AUTO_APPROVE_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberAutoApproveConsent(storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(AUTO_APPROVE_CONSENT_KEY, "1");
  } catch {
    // Blocked storage: the dialog simply shows again next time.
  }
}
