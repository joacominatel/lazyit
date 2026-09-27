import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AI_RUN_ACTIVE_STATUSES, type AiToolResult } from '@lazyit/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { canonicalJson } from '../core/pending-action';
import type { RegisteredAiTool } from '../core/tool-descriptor';
import {
  AI_BUDGET_WINDOW_MS,
  AI_RUN_CREATIONS_PER_MINUTE,
  AI_TOOL_CALLS_PER_MINUTE,
  AI_TOOL_OUTPUT_MAX_CHARS,
} from './runtime.constants';

/**
 * Consumption limits (provider-and-runtime.md §6.4, §9.1, §11; security.md §6.8; INV-AI-11). Budgets are
 * persisted (they are sums over `ai_usage`, so spend survives a restart); rate limits are in-memory token
 * buckets — lazyit runs one API process per install, and a restart forgetting a minute of rate state is
 * accepted (the login rate-limit posture).
 */

const INT4_MAX = 2_147_483_647;

/** A non-negative integer that fits an int4 column. */
export function clampInt4(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(value), 0), INT4_MAX);
}

/** Who a limit applies to: one key per human and per Service Account. */
export function principalKey(owner: {
  userId?: string | null;
  serviceAccountId?: string | null;
}): string {
  return owner.userId ? `user:${owner.userId}` : `sa:${owner.serviceAccountId}`;
}

/**
 * A keyed token bucket: `capacity` tokens, refilled continuously over `windowMs`. In-memory and
 * self-pruning (a full bucket is dropped), so the map is bounded by the keys active in one window.
 */
export class TokenBucket {
  private readonly buckets = new Map<
    string,
    { tokens: number; updatedAt: number }
  >();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Take one token; false when the bucket is empty. */
  take(key: string): boolean {
    const bucket = this.refill(key);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Seconds until one token is available again (0 when one is available now). */
  retryAfterSec(key: string): number {
    const bucket = this.refill(key);
    if (bucket.tokens >= 1) return 0;
    const perMs = this.capacity / this.windowMs;
    return Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000));
  }

  private refill(key: string): { tokens: number; updatedAt: number } {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      const refill = ((now - bucket.updatedAt) * this.capacity) / this.windowMs;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
      bucket.updatedAt = now;
    }
    if (this.buckets.size > 10_000) this.prune(now);
    return bucket;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const refill = ((now - bucket.updatedAt) * this.capacity) / this.windowMs;
      if (bucket.tokens + refill >= this.capacity) this.buckets.delete(key);
    }
  }
}

/**
 * The output handed to the model for one tool result, bounded ONCE, at write time (§6.4 "append-only
 * history"): the persisted tool message is never rewritten, so an oversized result is replaced here by
 * its serialized prefix and a marker telling the model to refine the query.
 */
export function capToolOutput(
  result: AiToolResult,
  max: number = AI_TOOL_OUTPUT_MAX_CHARS,
): unknown {
  const serialized = JSON.stringify(result);
  if (serialized.length <= max) return result;
  const more = serialized.length - max;
  return {
    ok: result.ok,
    kind: result.kind,
    mutated: result.mutated,
    truncatedOutput: `${serialized.slice(0, max)}\n[truncated — ${more} more characters; refine the query]`,
  };
}

/**
 * Any `<` that opens something reading as a turn-context tag — opening or closing, with whitespace,
 * attributes, a line break or no `>` at all (`< turn_context x="1">`, `</ turn_context >`).
 */
const TURN_CONTEXT_OPEN = /<(?=\s*\/?\s*turn_context)/gi;

/**
 * Neutralize a `<turn_context>` tag the USER typed, the way `untrusted()` neutralizes its own delimiter: the
 * frozen prompt tells the model the block is supplied by lazyit, so a user must not be able to forge one.
 */
export function neutralizeTurnContext(text: string): string {
  return text.replace(TURN_CONTEXT_OPEN, '&lt;');
}

/**
 * The hash a conversation's toolset is pinned to (`AiConversation.toolsetHash`, §6.4): the sorted names
 * with each tool's description, class and input schema — exactly what the model is shown. A lazyit
 * upgrade that changes any of them makes the conversation read-only (`VERSION_CHANGED`).
 */
export function toolsetHashOf(tools: readonly RegisteredAiTool[]): string {
  const shown = [...tools]
    .sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name))
    .map((tool) => ({
      name: tool.descriptor.name,
      description: tool.descriptor.description,
      class: tool.descriptor.class,
      inputSchema: tool.inputSchema,
    }));
  return createHash('sha256').update(canonicalJson(shown)).digest('hex');
}

/** The persisted and in-memory limits the runtime checks before a run and before every step. */
@Injectable()
export class AiRunLimits {
  readonly runCreations: TokenBucket;
  readonly toolCalls: TokenBucket;

  constructor(private readonly prisma: PrismaService) {
    this.runCreations = new TokenBucket(AI_RUN_CREATIONS_PER_MINUTE, 60_000);
    this.toolCalls = new TokenBucket(AI_TOOL_CALLS_PER_MINUTE, 60_000);
  }

  /** Input + output tokens this principal spent over the rolling 24 h window (`ai_usage`). */
  async tokensUsed(
    owner: { userId?: string | null; serviceAccountId?: string | null },
    now: Date = new Date(),
  ): Promise<number> {
    const since = new Date(now.getTime() - AI_BUDGET_WINDOW_MS);
    const where = owner.userId
      ? { userId: owner.userId, createdAt: { gte: since } }
      : {
          serviceAccountId: owner.serviceAccountId!,
          createdAt: { gte: since },
        };
    const sum = await this.prisma.aiUsage.aggregate({
      where,
      _sum: { inputTokens: true, outputTokens: true },
    });
    return (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0);
  }

  /** Whether the budget (null = none) is spent. */
  async budgetExceeded(
    owner: { userId?: string | null; serviceAccountId?: string | null },
    limit: number | null,
  ): Promise<boolean> {
    if (limit === null) return false;
    return (await this.tokensUsed(owner)) >= limit;
  }

  /** The principal's active runs (QUEUED, RUNNING, AWAITING_APPROVAL or AWAITING_INPUT). */
  async activeRuns(owner: {
    userId?: string | null;
    serviceAccountId?: string | null;
  }): Promise<number> {
    return this.prisma.aiRun.count({
      where: {
        ...(owner.userId
          ? { userId: owner.userId }
          : { serviceAccountId: owner.serviceAccountId! }),
        status: { in: [...AI_RUN_ACTIVE_STATUSES] },
      },
    });
  }

  /**
   * The input tokens of the conversation's latest model step — the context size the next step starts
   * from (§11 `contextTokenLimit`). 0 for a conversation with no step yet.
   */
  async lastInputTokens(conversationId: string): Promise<number> {
    const runs = await this.prisma.aiRun.findMany({
      where: { conversationId },
      select: { id: true },
    });
    if (runs.length === 0) return 0;
    const last = await this.prisma.aiUsage.findFirst({
      where: { runId: { in: runs.map((run) => run.id) } },
      orderBy: { id: 'desc' },
      select: { inputTokens: true },
    });
    return last?.inputTokens ?? 0;
  }
}
