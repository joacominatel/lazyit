import { Injectable } from '@nestjs/common';
import type { UserHistoryEventType } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import type { ActorAttribution } from '../common/actor.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One user-lifecycle event to append (DEBT-2, issue #185). `userId` is the SUBJECT (whose history this
 * is). `payload` is contextual jsonb (e.g. `{ from, to }` on ROLE_CHANGED, `{ fields }` on UPDATED).
 * `actor` is the resolved attribution (ADR-0048): a HUMAN write sets `{ userId }` → `performedById`; a
 * SERVICE-ACCOUNT write sets `{ serviceAccountId }` → `serviceAccountId`; system/unknown leaves both
 * null. The DB at-most-one-actor CHECK guarantees the two columns can never both be set — `ActorService`
 * already returns at most one of the pair, so spreading it here is CHECK-safe by construction.
 *
 * NOTE the field name clash: the SUBJECT id is `userId` here, while `actor.userId` (inside
 * ActorAttribution) is the HUMAN ACTOR's id. They are distinct (subject vs actor); on a self-action they
 * may coincide. Keep them separate when spreading.
 */
export interface RecordUserEvent {
  userId: string;
  eventType: UserHistoryEventType;
  payload?: Prisma.InputJsonValue;
  actor?: ActorAttribution;
}

/**
 * A client able to write `user_history` — the base `PrismaService` or a `$transaction` client. Typed
 * structurally so emitters can pass their transaction client (atomic with the change it records).
 */
export interface UserHistoryWriter {
  userHistory: {
    create: (args: {
      data: Prisma.UserHistoryUncheckedCreateInput;
    }) => Promise<unknown>;
  };
}

/**
 * UserHistory writer/reader (DEBT-2, issue #185) — the User entity's append-only lifecycle log, the
 * counterpart of {@link AssetHistoryService} for the asset (ADR-0033 / ADR-0006). Events are appended by
 * EXPLICIT service calls: the Users service passes its transaction client so the log row commits
 * atomically with the write it records. Feeds the `recent_activity` view's user branch.
 */
@Injectable()
export class UserHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Append one history row using the given client (pass a transaction client for atomicity). */
  record(client: UserHistoryWriter, event: RecordUserEvent): Promise<unknown> {
    // Spread the actor attribution: a human → performedById, a service account → serviceAccountId,
    // system/unknown → neither (both FKs stay null). resolveActor guarantees at most one is set, so the
    // at-most-one-actor CHECK on user_history is always satisfied (ADR-0048). `actor.userId` is the
    // ACTOR's id — distinct from `event.userId`, the SUBJECT whose history this row belongs to.
    const actor = event.actor ?? {};
    return client.userHistory.create({
      data: {
        userId: event.userId,
        eventType: event.eventType,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        ...(actor.userId != null ? { performedById: actor.userId } : {}),
        ...(actor.serviceAccountId != null
          ? { serviceAccountId: actor.serviceAccountId }
          : {}),
      },
    });
  }

  /** A page of a user's history, newest first; `before` is an exclusive cursor on the id. */
  list(userId: string, opts: { limit: number; before?: number }) {
    return this.prisma.userHistory.findMany({
      where: {
        userId,
        ...(opts.before !== undefined ? { id: { lt: opts.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: opts.limit,
    });
  }
}
