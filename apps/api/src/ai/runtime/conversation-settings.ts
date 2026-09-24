import { BadRequestException } from '@nestjs/common';
import {
  AI_PROVIDER_DESCRIPTORS,
  AI_WEB_SEARCH_MAX_USES_MAX,
  AI_WEB_SEARCH_MAX_USES_MIN,
  aiWebSearchSupported,
  AI_PROVIDER_OPTIONS_SCHEMAS,
  AiEffortSchema,
  AiProviderKindSchema,
  AiProviderOptionsSchema,
  type AiConversationChannel,
  type AiConversationSettings,
  type AiSettings,
  type AiEffort,
  type AiProviderKind,
  type AiProviderOptions,
} from '@lazyit/shared';
import type { AiConversation } from '../../../generated/prisma/client';
import type { ResolvedAiProviderConfig } from '../core/ports/ai-settings.port';

/**
 * PER-CONVERSATION MODEL SETTINGS (#1373; ADR-0097 decision 5 / default 7 as amended 2026-09-24).
 *
 * A conversation is pinned to its provider and prompt version, as before. Its MODEL is either the
 * instance default at creation (`modelChosen = false`, every legacy row — an admin change of the default
 * still makes it read-only, exactly as before) or the user's choice (`modelChosen = true` — any model of
 * the configured provider, listed or typed; the admin changing the DEFAULT does not touch it). The model,
 * the reasoning effort and the provider options can change only until the conversation's first run
 * starts; afterwards a different choice is a new conversation.
 *
 * `effort` / `providerOptions` null = the instance setting at call time. Both are validated on write
 * against the configured provider and read tolerantly: a stored value this build or this provider cannot
 * honour falls back to the instance setting instead of failing the run.
 */

type Pinned = Pick<AiConversation, 'provider' | 'model' | 'modelChosen'>;

/**
 * Whether the instance configuration moved away from what the conversation is pinned to: another
 * provider always; another default model only for a conversation that runs on the default.
 */
export function pinnedConfigChanged(
  config: Pick<ResolvedAiProviderConfig, 'provider' | 'model'>,
  conversation: Pinned,
): boolean {
  if (config.provider !== conversation.provider) return true;
  return !conversation.modelChosen && config.model !== conversation.model;
}

/** The fields a user may set on a conversation's model (create, or PATCH before the first run). */
export interface ConversationModelInput {
  model?: string;
  effort?: AiEffort | null;
  providerOptions?: AiProviderOptions | null;
}

/**
 * The per-provider write check (400 `{ code, message }`): an effort only for a provider whose definition
 * sends one (`supportsEffort`), provider options only within that provider's strict schema.
 */
export function assertModelSettingsSupported(
  provider: AiProviderKind,
  input: ConversationModelInput,
): void {
  if (
    input.effort !== undefined &&
    input.effort !== null &&
    !AI_PROVIDER_DESCRIPTORS[provider].supportsEffort
  ) {
    throw new BadRequestException({
      code: 'EFFORT_UNSUPPORTED',
      message: 'The configured provider does not take a reasoning effort',
    });
  }
  if (
    input.providerOptions !== undefined &&
    input.providerOptions !== null &&
    !AI_PROVIDER_OPTIONS_SCHEMAS[provider].safeParse(input.providerOptions)
      .success
  ) {
    throw new BadRequestException({
      code: 'PROVIDER_OPTIONS_UNSUPPORTED',
      message: 'These options are not supported by the configured provider',
    });
  }
}

/** Read-tolerant: the stored effort, if it is one this build knows and the provider takes. */
export function storedEffort(
  conversation: Pick<AiConversation, 'provider' | 'effort'>,
): AiEffort | null {
  const effort = AiEffortSchema.safeParse(conversation.effort);
  const provider = AiProviderKindSchema.safeParse(conversation.provider);
  if (!effort.success || !provider.success) return null;
  return AI_PROVIDER_DESCRIPTORS[provider.data].supportsEffort
    ? effort.data
    : null;
}

/** Read-tolerant: the stored provider options, if they still pass the provider's strict schema. */
export function storedProviderOptions(
  conversation: Pick<AiConversation, 'provider' | 'providerOptions'>,
): AiProviderOptions | null {
  if (conversation.providerOptions == null) return null;
  const provider = AiProviderKindSchema.safeParse(conversation.provider);
  if (!provider.success) return null;
  if (
    !AI_PROVIDER_OPTIONS_SCHEMAS[provider.data].safeParse(
      conversation.providerOptions,
    ).success
  ) {
    return null;
  }
  const parsed = AiProviderOptionsSchema.safeParse(
    conversation.providerOptions,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The per-call overrides a model step carries for this conversation: only the fields it set (the rest
 * stay the instance settings the provider layer reads).
 */
export function conversationCallOverrides(
  conversation: Pick<AiConversation, 'provider' | 'effort' | 'providerOptions'>,
): { effort?: AiEffort; providerOptions?: AiProviderOptions } {
  const effort = storedEffort(conversation);
  const providerOptions = storedProviderOptions(conversation);
  return {
    ...(effort !== null ? { effort } : {}),
    ...(providerOptions !== null ? { providerOptions } : {}),
  };
}

/** The wire shape of a conversation's settings. `locked` = its first run exists. */
export function conversationSettingsOf(
  conversation: Pick<
    AiConversation,
    | 'provider'
    | 'model'
    | 'modelChosen'
    | 'effort'
    | 'providerOptions'
    | 'autoApprove'
    | 'autoApproveEnabledAt'
  >,
  locked: boolean,
): AiConversationSettings {
  return {
    provider: conversation.provider,
    model: conversation.model,
    modelChosen: conversation.modelChosen,
    effort: storedEffort(conversation),
    providerOptions: storedProviderOptions(conversation),
    modelLocked: locked,
    autoApprove: conversation.autoApprove,
    autoApproveEnabledAt: conversation.autoApprove
      ? (conversation.autoApproveEnabledAt?.toISOString() ?? null)
      : null,
  };
}

/**
 * PROVIDER-NATIVE WEB SEARCH OF A CONVERSATION (#1389; ADR-0097 decision 3 as amended 2026-09-24).
 *
 * Frozen at creation like the toolset — the tools a conversation declares must stay byte-identical for its
 * whole life (prompt cache, Anthropic preserved thinking) — so it is decided once: a CHAT conversation
 * started while web search is on, on a provider and model that support it, carries the instance's search
 * cap; every other one (headless, legacy rows) carries null and never searches.
 *
 * Headless is excluded on purpose: its writes run with no one approving them, and search results are text
 * anyone on the web can write — the one place an injected instruction could turn into an unreviewed change.
 */
export function frozenWebSearchMaxUses(
  channel: AiConversationChannel,
  provider: AiProviderKind,
  model: string,
  settings: Pick<AiSettings, 'webSearchEnabled' | 'webSearchMaxUses'>,
): number | null {
  if (channel !== 'CHAT' || !settings.webSearchEnabled) return null;
  return aiWebSearchSupported(provider, model)
    ? settings.webSearchMaxUses
    : null;
}

/**
 * The web search a model step of this conversation carries: its frozen cap (read-tolerant — an
 * out-of-range stored value is clamped), or undefined when it has none.
 */
export function conversationWebSearch(
  conversation: Pick<AiConversation, 'channel' | 'webSearchMaxUses'>,
): { maxUses: number } | undefined {
  const stored = conversation.webSearchMaxUses;
  if (typeof stored !== 'number' || conversation.channel !== 'CHAT') {
    return undefined;
  }
  const maxUses = Math.min(
    AI_WEB_SEARCH_MAX_USES_MAX,
    Math.max(AI_WEB_SEARCH_MAX_USES_MIN, Math.trunc(stored)),
  );
  return { maxUses };
}

/**
 * Whether an admin turned web search off after this conversation was started with it. Its tool list
 * cannot change, so the conversation becomes read-only (`CONFIG_CHANGED`) — the switch applies at once.
 */
export function webSearchWithdrawn(
  settings: Pick<AiSettings, 'webSearchEnabled'>,
  conversation: Pick<AiConversation, 'webSearchMaxUses'>,
): boolean {
  return (
    typeof conversation.webSearchMaxUses === 'number' &&
    !settings.webSearchEnabled
  );
}

/** `AiConfigAuditLog.action` for a conversation's auto-approve toggle (#1376). */
export const AI_CONVERSATION_AUTO_APPROVE_AUDIT_ACTION =
  'CONVERSATION_AUTO_APPROVE_CHANGED';
