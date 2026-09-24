import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import {
  AiActionPreviewSchema,
  AiToolInvocationStatusSchema,
  AiToolResultSchema,
  type AiActionPreview,
  type AiChannel,
  type AiEntityRef,
  type AiPreviewWarningCode,
  type AiToolClass,
  type AiToolInvocationStatus,
  type AiToolResult,
} from '@lazyit/shared';
import type { AiToolInvocation } from '../../../generated/prisma/client';

/**
 * The approval unit as core hands it to the runtime and the decision endpoint (tools-and-execution.md
 * §9, §16 `AiPendingAction`). API-internal: the wire projection the web receives is the runtime's
 * `AiApprovalRequest` (`@lazyit/shared` `ai-run.ts`). Built from the `ai_tool_invocations` row — the card
 * renders the STORED preview, never model prose.
 */
export interface AiPendingAction {
  id: string;
  channel: AiChannel;
  conversationId: string | null;
  runId: string | null;
  /** The provider's tool-use block id, to answer the call when the loop resumes. */
  toolUseId: string | null;
  toolName: string;
  toolClass: AiToolClass;
  status: AiToolInvocationStatus;
  preview: AiActionPreview | null;
  createdAt: Date;
  expiresAt: Date | null;
  decidedAt: Date | null;
  /** The tool result once the action ran, was refused at execute, or was decided. */
  result: AiToolResult | null;
  /** True when `approve` found the action already finished and returned the stored outcome. */
  replayed?: boolean;
}

/** What `propose` answers: the stored pending action, or the tool result to hand the model instead. */
export type AiProposal =
  | { ok: true; action: AiPendingAction }
  | { ok: false; result: AiToolResult };

/** What the caller of `approve` has verified before calling it (synthesis §4.4; security.md §6.2). */
export interface AiApproveOptions {
  /**
   * The password step-up was verified for THIS request by the decision endpoint (the runtime's approval
   * service). Core never sees the password: it only refuses an action whose preview requires step-up
   * when this is not set, and records the flag in the ledger.
   */
  stepUpVerified?: boolean;
}

/**
 * The CLOSED list of preview warnings that make a write — `write` or `elevated`, whatever the tool's
 * class — require a password step-up (CEO
 * decision 2026-09-24, #1315, "Opción 2": step-up for privilege grants and credential delivery only —
 * ADR-0097 decision 4 — enforced by core, not left to each tool). A tool may still ask for step-up on
 * its own (`stepUpRequired: true`); it can never switch it off for these warnings.
 *
 * The list is the CEO's closed list: role and identity changes, access or privilege grants,
 * credential delivery, and — since the ADR-0097 decision 3 amendment (2026-09-24, #1315) — actions on
 * a critical application. A tool that grants access MUST emit `PRIVILEGE_GRANT`; one that delivers a
 * credential MUST emit `CREDENTIAL_DELIVERY`; a workflow write, access grant or revoke on an application
 * with `isCritical = true` MUST emit `CRITICAL_APPLICATION`. `OUTBOUND_INTEGRATION` is deliberately NOT
 * listed (CEO: "que no pida contraseña, que sea flexible, excepto que la aplicacion sea critica").
 */
export const AI_STEP_UP_WARNINGS: readonly AiPreviewWarningCode[] = [
  'ROLE_CHANGE',
  'IDENTITY_CHANGE',
  'PRIVILEGE_GRANT',
  'CREDENTIAL_DELIVERY',
  'CRITICAL_APPLICATION',
];

/**
 * Whether an action needs the password step-up: the tool asked, or its preview carries a listed warning.
 * Derived from the warnings on ANY write preview, `write` or `elevated` (ADR-0097 decision 3 as amended
 * 2026-09-24): a `write`-class tool such as an access revoke on a critical application needs step-up
 * too, whether or not it escalated the invocation to `elevated`.
 */
export function requiresStepUp(
  preview: Pick<AiActionPreview, 'stepUpRequired' | 'warnings'>,
): boolean {
  if (preview.stepUpRequired) return true;
  return preview.warnings.some((w) =>
    (AI_STEP_UP_WARNINGS as readonly string[]).includes(w),
  );
}

/**
 * Preview warnings whose action a channel refuses outright — the seam for a per-channel refusal (e.g. a
 * headless action on a critical application, a CEO question open on #1315). EMPTY today on every channel:
 * nothing is refused by warning yet. Over MCP and headless no preview is built, so a tool that detects
 * such a condition in `run` calls {@link assertChannelAllows} with the warnings it would have emitted;
 * enabling a refusal is then one entry here.
 */
export const AI_CHANNEL_REFUSED_WARNINGS: Readonly<
  Record<AiChannel, readonly AiPreviewWarningCode[]>
> = {
  CHAT: [],
  MCP: [],
  HEADLESS: [],
};

/** The first warning this channel refuses, if any. */
export function channelRefusal(
  channel: AiChannel,
  warnings: readonly string[],
  refused: Readonly<
    Record<AiChannel, readonly AiPreviewWarningCode[]>
  > = AI_CHANNEL_REFUSED_WARNINGS,
): AiPreviewWarningCode | undefined {
  const list = refused[channel] ?? [];
  return list.find((code) => warnings.includes(code));
}

/**
 * Refuse cleanly, as a FORBIDDEN tool error (the error mapper's 403), when the channel refuses one of the
 * warnings. A tool calls it from `run` before any side effect.
 */
export function assertChannelAllows(
  channel: AiChannel,
  warnings: readonly string[],
  refused?: Readonly<Record<AiChannel, readonly AiPreviewWarningCode[]>>,
): void {
  const code = channelRefusal(channel, warnings, refused);
  if (code) {
    throw new ForbiddenException(
      `This action (${code}) is not available on the ${channel} channel; ask a person to do it in the lazyit chat or the app.`,
    );
  }
}

/** JSON with object keys sorted, so equal inputs hash equally whatever their key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** SHA-256 of the canonical input: binds an approval to exactly these arguments (INV-AI-3). */
export function inputHashOf(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/** Merge ref lists, first occurrence wins, keyed by type and id. */
export function mergeRefs(
  ...lists: ReadonlyArray<readonly AiEntityRef[] | undefined>
): AiEntityRef[] {
  const seen = new Map<string, AiEntityRef>();
  for (const list of lists) {
    for (const ref of list ?? []) {
      const key = `${ref.type}:${ref.id}`;
      if (!seen.has(key)) seen.set(key, ref);
    }
  }
  return [...seen.values()];
}

/**
 * Project an invocation row. Read-tolerant: a stored preview, result or status this build cannot parse
 * (a newer build wrote it) reads as null / `FAILED` instead of throwing.
 */
export function toPendingAction(row: AiToolInvocation): AiPendingAction {
  const preview = AiActionPreviewSchema.safeParse(row.preview);
  const result = AiToolResultSchema.safeParse(row.result);
  const status = AiToolInvocationStatusSchema.safeParse(row.status);
  return {
    id: row.id,
    channel: row.channel as AiChannel,
    conversationId: row.conversationId,
    runId: row.runId,
    toolUseId: row.toolUseId,
    toolName: row.toolName,
    toolClass: row.toolClass as AiToolClass,
    status: status.success ? status.data : 'FAILED',
    preview: preview.success ? preview.data : null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    result: row.result == null ? null : result.success ? result.data : null,
  };
}
