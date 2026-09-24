import { createHash } from 'node:crypto';
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
 * The CLOSED list of preview warnings that make an `elevated` action require a password step-up (CEO
 * decision 2026-09-24, #1315, "Opción 2": step-up for privilege grants and credential delivery only —
 * ADR-0097 decision 4 — enforced by core, not left to each tool). A tool may still ask for step-up on
 * its own (`stepUpRequired: true`); it can never switch it off for these warnings.
 *
 * The list is the CEO's closed list: role and identity changes, access or privilege grants, and
 * credential delivery. A tool that grants access MUST emit `PRIVILEGE_GRANT`; one that delivers a
 * credential MUST emit `CREDENTIAL_DELIVERY`.
 */
export const AI_STEP_UP_WARNINGS: readonly AiPreviewWarningCode[] = [
  'ROLE_CHANGE',
  'IDENTITY_CHANGE',
  'PRIVILEGE_GRANT',
  'CREDENTIAL_DELIVERY',
];

/** Whether an action needs the password step-up: the tool asked, or an elevated preview carries a listed warning. */
export function requiresStepUp(
  preview: Pick<AiActionPreview, 'elevated' | 'stepUpRequired' | 'warnings'>,
): boolean {
  if (preview.stepUpRequired) return true;
  return (
    preview.elevated &&
    preview.warnings.some((w) =>
      (AI_STEP_UP_WARNINGS as readonly string[]).includes(w),
    )
  );
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
