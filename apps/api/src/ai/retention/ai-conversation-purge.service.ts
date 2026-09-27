import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AI_RETENTION_DAYS_MAX,
  AI_RETENTION_DAYS_MIN,
  AI_RUN_ACTIVE_STATUSES,
  AI_SETTINGS_DEFAULTS,
} from '@lazyit/shared';
import type { Prisma } from '../../../generated/prisma/client';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
} from '../core/ports/ai-settings.port';

/** Conversations (or MCP invocations) deleted per transaction — bounds each lock and cascade. */
export const AI_RETENTION_BATCH = 100;
/** Batches per reason per pass; whatever is left waits for the next pass. */
export const AI_RETENTION_MAX_BATCHES_PER_PASS = 20;
/** A batch deletes a conversation's messages and invocations by cascade; allow it more than the 5 s default. */
export const AI_RETENTION_TX_TIMEOUT_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Invocation statuses that are still in flight. An MCP row in one of these is never pruned, whatever its
 * age (the MCP stale-`EXECUTING` sweep, W3-2, settles it first), and a conversation holding one is never
 * deleted — the cascade would take a pending approval or an executing write with it.
 */
const IN_FLIGHT_INVOCATION_STATUSES = [
  'AWAITING_APPROVAL',
  'AWAITING_INPUT',
  'EXECUTING',
];

/** The outcome of purging a set of conversations. */
export interface AiPurgeOutcome {
  /** Conversations deleted (their messages and tool invocations went with them by cascade). */
  deleted: number;
  /** Candidates left in place: an active run, a concurrent writer holding the row, or already gone. */
  skipped: number;
}

/**
 * THE ONLY DELETER OF AI TRANSCRIPTS (ADR-0097 decision 11; provider-and-runtime.md §7 "Retention";
 * security.md §6.7). Conversations are not the system of record, so they are HARD-deleted — past
 * retention, at their owner's request, and on offboarding. `AiMessage` and `AiToolInvocation` rows go
 * with their conversation by the database cascade; `AiRun` rows survive (their conversation FK is
 * `SetNull`), and `AiUsage` and the permanent `AiActionLog` ledger are never touched — this file does not
 * reference either (a spec pins that).
 *
 * Every conversation delete goes through {@link purge}: it locks the candidate rows, re-checks — in new
 * statements, so it sees every committed row — that none has an active run (QUEUED, RUNNING,
 * AWAITING_APPROVAL or AWAITING_INPUT) or an AWAITING_APPROVAL, AWAITING_INPUT or EXECUTING tool invocation, and deletes only what still matches the caller's guard. The runtime's submit takes the same row lock
 * (it bumps `lastActivityAt`) before it creates a run, so a run can never start in a conversation that is
 * being deleted, and a conversation with an active run is never deleted (it is skipped; the next pass
 * retries).
 */
@Injectable()
export class AiConversationPurgeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
  ) {}

  /**
   * The retention window in days: `AiSettings.retentionDays`, clamped to 7–3650 on read (the write path
   * validates the range). The lower clamp keeps a hand-edited row below 7 from shortening the window; the
   * upper clamp does shorten a hand-set value above 3650 to 3650 (it deletes earlier than that row asks) —
   * the documented range wins. A non-integer reads as the default (90). A failed settings read throws: the caller skips the pass rather than guess.
   */
  async retentionDays(): Promise<number> {
    const { retentionDays } = await this.settings.getSettings();
    return clampRetentionDays(retentionDays);
  }

  /**
   * Owner-requested delete (`DELETE /ai/conversations/:id`, W3-1). Owner only: anyone else — and a
   * conversation that does not exist — gets 404. A conversation with an active run is refused with 409
   * `RUN_IN_PROGRESS` (cancel the run first). The ledger survives.
   */
  async deleteOwned(
    identity: DelegatedIdentity,
    conversationId: string,
  ): Promise<void> {
    const owner: Prisma.AiConversationWhereInput =
      identity.kind === 'human'
        ? { userId: identity.userId }
        : { serviceAccountId: identity.serviceAccountId };
    const found = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, ...owner },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Conversation not found',
      });
    }
    const { deleted } = await this.purge([conversationId], owner, {
      wait: true,
    });
    if (deleted === 0) {
      // Still there (it was owned a moment ago): an active run holds it. Gone: a concurrent delete won.
      const still = await this.prisma.aiConversation.findFirst({
        where: { id: conversationId, ...owner },
        select: { id: true },
      });
      if (still) {
        throw new ConflictException({
          code: 'RUN_IN_PROGRESS',
          message:
            'A run is active in this conversation; cancel it before deleting',
        });
      }
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Conversation not found',
      });
    }
  }

  /**
   * Offboarding purge: delete every conversation the user owns. A conversation with an active run is
   * skipped here and purged by the sweeper's offboarded-owner pass once the run ends (an offboarded
   * user's session epoch is bumped, so the run's next step is refused). Idempotent.
   */
  async purgeForUser(userId: string): Promise<AiPurgeOutcome> {
    return this.purgeWhere({ userId }, AI_RETENTION_BATCH * 1_000);
  }

  /**
   * Every conversation matching `where` with no active run, in id order, batch by batch, up to
   * `maxRows` candidates. `where` is re-applied at delete time as the guard.
   */
  async purgeWhere(
    where: Prisma.AiConversationWhereInput,
    maxRows: number = AI_RETENTION_BATCH * AI_RETENTION_MAX_BATCHES_PER_PASS,
  ): Promise<AiPurgeOutcome> {
    const total: AiPurgeOutcome = { deleted: 0, skipped: 0 };
    let after: string | null = null;
    let seen = 0;
    while (seen < maxRows) {
      const take = Math.min(AI_RETENTION_BATCH, maxRows - seen);
      const batch: Array<{ id: string }> =
        await this.prisma.aiConversation.findMany({
          where: {
            ...where,
            ...(after === null ? {} : { id: { gt: after } }),
            runs: { none: { status: { in: [...AI_RUN_ACTIVE_STATUSES] } } },
            invocations: {
              none: { status: { in: IN_FLIGHT_INVOCATION_STATUSES } },
            },
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take,
        });
      if (batch.length === 0) break;
      seen += batch.length;
      after = batch[batch.length - 1].id;
      const outcome = await this.purge(
        batch.map((c) => c.id),
        where,
        { wait: false },
      );
      total.deleted += outcome.deleted;
      total.skipped += outcome.skipped;
      if (batch.length < take) break;
    }
    return total;
  }

  /**
   * Conversation-less invocations (MCP calls; tools-and-execution.md §11) created before `cutoff` and no
   * longer in flight. Bounded like the conversation passes.
   */
  async pruneMcpInvocations(cutoff: Date): Promise<number> {
    const where: Prisma.AiToolInvocationWhereInput = {
      conversationId: null,
      createdAt: { lt: cutoff },
      status: { notIn: IN_FLIGHT_INVOCATION_STATUSES },
    };
    let deleted = 0;
    let after: string | null = null;
    for (let i = 0; i < AI_RETENTION_MAX_BATCHES_PER_PASS; i++) {
      const batch: Array<{ id: string }> =
        await this.prisma.aiToolInvocation.findMany({
          where: { ...where, ...(after === null ? {} : { id: { gt: after } }) },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: AI_RETENTION_BATCH,
        });
      if (batch.length === 0) break;
      after = batch[batch.length - 1].id;
      const { count } = await this.prisma.aiToolInvocation.deleteMany({
        where: { ...where, id: { in: batch.map((r) => r.id) } },
      });
      deleted += count;
      if (batch.length < AI_RETENTION_BATCH) break;
    }
    return deleted;
  }

  /**
   * The one delete primitive. In one transaction: lock the candidates (`SKIP LOCKED` for the sweeper, so a
   * busy row waits for the next pass; a blocking lock for an owner's delete), drop those with an active
   * run, and delete what still matches `guard`.
   */
  private async purge(
    ids: string[],
    guard: Prisma.AiConversationWhereInput,
    { wait }: { wait: boolean },
  ): Promise<AiPurgeOutcome> {
    if (ids.length === 0) return { deleted: 0, skipped: 0 };
    const deleted = await this.prisma.$transaction(
      async (tx) => {
        const locked = wait
          ? await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "ai_conversations" WHERE "id" = ANY(${ids}::text[]) FOR UPDATE`
          : await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "ai_conversations" WHERE "id" = ANY(${ids}::text[]) FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return 0;
        const lockedIds = locked.map((row) => row.id);
        const busy = await tx.aiRun.findMany({
          where: {
            conversationId: { in: lockedIds },
            status: { in: [...AI_RUN_ACTIVE_STATUSES] },
          },
          select: { conversationId: true },
        });
        const inFlight = await tx.aiToolInvocation.findMany({
          where: {
            conversationId: { in: lockedIds },
            status: { in: IN_FLIGHT_INVOCATION_STATUSES },
          },
          select: { conversationId: true },
        });
        const busyIds = new Set([
          ...busy.map((run) => run.conversationId),
          ...inFlight.map((invocation) => invocation.conversationId),
        ]);
        const deletable = lockedIds.filter((id) => !busyIds.has(id));
        if (deletable.length === 0) return 0;
        const { count } = await tx.aiConversation.deleteMany({
          where: { AND: [guard, { id: { in: deletable } }] },
        });
        return count;
      },
      { timeout: AI_RETENTION_TX_TIMEOUT_MS },
    );
    return { deleted, skipped: ids.length - deleted };
  }
}

/** `retentionDays` bounded to 7–3650; a non-integer is the default (tolerant read). */
export function clampRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return AI_SETTINGS_DEFAULTS.retentionDays;
  }
  return Math.min(
    AI_RETENTION_DAYS_MAX,
    Math.max(AI_RETENTION_DAYS_MIN, value),
  );
}

/** The instant before which a conversation's last activity is past retention. */
export function retentionCutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - days * DAY_MS);
}
