import { createHash } from 'node:crypto';
import {
  AiActionPreviewSchema,
  AiToolInvocationStatusSchema,
  AiToolResultSchema,
  type AiActionPreview,
  type AiChannel,
  type AiEntityRef,
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
