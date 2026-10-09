import {
  AI_PROVIDER_DESCRIPTORS,
  type AiSettings,
  MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS,
} from "@lazyit/shared";
import { documentExtractionAvailability, webSearchAvailability } from "./ai-settings-form";

/**
 * Pure derivations behind the Settings → AI header (#1540): the four status tiles and the tab each
 * one opens. No React, so the server render and the hydrating client agree and the rules are tested.
 */

/** The page's tabs, in order; the value is also the `?tab=` value. */
export const AI_TABS = ["connection", "limits", "capabilities", "agents"] as const;
export type AiTab = (typeof AI_TABS)[number];

export interface AiStatusTiles {
  /** `on` — assistant enabled; `draft` — a provider is saved but the assistant is off; `none`. */
  provider: { state: "on" | "draft" | "none"; label: string | null };
  /** Web search actually in effect (switch on AND the provider/model can search). */
  webSearch: boolean;
  /** Document extraction actually in effect (switch on AND assistant on AND a reading provider). */
  documents: boolean;
  /** MCP switch, and how many clients are explicitly allowed (built-ins kept + the admin's own). */
  agents: { on: boolean; clients: number };
}

export function aiStatusTiles(settings: AiSettings): AiStatusTiles {
  const provider = settings.provider;
  // The provider column is TEXT, tolerated on read: an unknown kind still shows its raw name.
  const label = provider ? (AI_PROVIDER_DESCRIPTORS[provider]?.label ?? provider) : null;
  const removed = new Set(settings.mcpClientAllowlistRemovedDefaults ?? []);
  const builtIns = MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS.filter((e) => !removed.has(e.id)).length;
  return {
    provider: {
      state: settings.enabled ? "on" : provider ? "draft" : "none",
      label,
    },
    webSearch: settings.webSearchEnabled === true && webSearchAvailability(settings) === "available",
    documents:
      settings.documentExtractionEnabled === true &&
      documentExtractionAvailability(settings) === "available",
    agents: {
      on: settings.mcpEnabled,
      clients: builtIns + (settings.mcpClientAllowlistAdded ?? []).length,
    },
  };
}

/**
 * Whether flipping a data-egress switch needs the "What leaves lazyit" confirmation first: only when
 * turning it ON. Turning it off never sends anything anywhere, so it applies at once.
 */
export function egressNeedsConsent(current: boolean, next: boolean): boolean {
  return next && !current;
}
