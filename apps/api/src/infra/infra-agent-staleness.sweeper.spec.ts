// The sweeper injects PrismaService + NotificationsService, both of which load the generated Prisma
// client (ESM `.js` re-exports jest can't resolve). Stub the client + adapter so the real modules load;
// the DB and the emit are faked per test — this exercises the transition→nudge fan-out without a database.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { InfraAgentStalenessSweeper } from './infra-agent-staleness.sweeper';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  EmitNotificationInput,
  NotificationsService,
} from '../notifications/notifications.service';

type StaleNode = {
  id: string;
  label: string;
  lastReportedAt: Date | null;
  /** The staleness this node was last SERVED (#1140). Absent ⇒ the env fallback applies. */
  policyStaleAfterSeconds?: number | null;
};
/** The single-arg tuple of a `NotificationsService.emit` call — cast `mock.calls` to read it typed. */
type EmitCall = [EmitNotificationInput];

/**
 * Wire a sweeper over a fake `infraNode` (the pre-query `findMany` returns the transitioning set; the
 * bulk `updateMany` returns its count) and a best-effort `emit` double. Just enough to prove: ONE
 * `infra.agent_offline` nudge per OFFLINE transition (#852), the dedupeKey keys on the last-report
 * instant, and a clean sweep is silent.
 */
function makeSweeper(transitioning: StaleNode[]) {
  const findMany = jest.fn().mockResolvedValue(transitioning);
  const updateMany = jest
    .fn()
    .mockResolvedValue({ count: transitioning.length });
  const prisma = {
    infraNode: { findMany, updateMany },
  } as unknown as PrismaService;
  const emit = jest.fn().mockResolvedValue('notif-id');
  const notifications = { emit } as unknown as NotificationsService;
  const sweeper = new InfraAgentStalenessSweeper(prisma, notifications);
  return { sweeper, findMany, updateMany, emit };
}

describe('InfraAgentStalenessSweeper (ADR-0074 §4 / #852)', () => {
  it('emits ONE infra.agent_offline nudge per node transitioning to OFFLINE', async () => {
    const last = new Date('2026-06-30T00:00:00.000Z');
    const { sweeper, updateMany, emit } = makeSweeper([
      { id: 'n1', label: 'web-01', lastReportedAt: last },
      { id: 'n2', label: 'db-01', lastReportedAt: last },
    ]);

    const count = await sweeper.sweep();

    expect(count).toBe(2);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(2);
    const first = (emit.mock.calls as EmitCall[])[0][0];
    expect(first.type).toBe('infra.agent_offline');
    expect(first.severity).toBe('warning');
    expect(first.recipientUserId).toBeUndefined(); // broadcast to the admin feed
    expect(first.title).toContain('web-01');
    // Deduped on the node's last-report instant so a fresh outage yields a fresh key (not once-per-sweep).
    expect(first.dedupeKey).toBe(
      `infra.agent_offline:n1:${last.toISOString()}`,
    );
    expect(first.metadata).toMatchObject({
      nodeId: 'n1',
      lastReportedAt: last.toISOString(),
    });
  });

  it('handles a node that never reported (null lastReportedAt) without throwing', async () => {
    const { sweeper, emit } = makeSweeper([
      { id: 'n3', label: 'edge-01', lastReportedAt: null },
    ]);
    await sweeper.sweep();
    const input = (emit.mock.calls as EmitCall[])[0][0];
    expect(input.dedupeKey).toBe('infra.agent_offline:n3:never');
    expect(input.metadata).toMatchObject({ lastReportedAt: null });
  });

  it('emits nothing when no agent node is stale', async () => {
    const { sweeper, emit } = makeSweeper([]);
    const count = await sweeper.sweep();
    expect(count).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  // ── Per-node staleness (#1140) — what makes heterogeneous cadences possible at all ──────────────

  it('does NOT flip a node whose SERVED threshold has not elapsed, even though the env default has', async () => {
    // The host the operator moved to a daily cadence. Under one global cutoff it sat OFFLINE 23
    // hours out of 24 and nudged the bell every day, which is what made a long cadence unusable.
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const { sweeper, updateMany, emit } = makeSweeper([
      {
        id: 'n-daily',
        label: 'backup-01',
        lastReportedAt: anHourAgo,
        policyStaleAfterSeconds: 90_000, // ~25 h
      },
    ]);

    expect(await sweeper.sweep()).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('flips a node whose SERVED threshold HAS elapsed, even when it is shorter than the env default', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const { sweeper, updateMany, emit } = makeSweeper([
      {
        id: 'n-tight',
        label: 'edge-02',
        lastReportedAt: tenMinutesAgo,
        policyStaleAfterSeconds: 300, // 5 min, the tick floor
      },
    ]);

    expect(await sweeper.sweep()).toBe(1);
    // The bulk flip now addresses the decided set by id — it cannot re-run the per-node comparison.
    const arg = updateMany.mock.calls[0][0] as {
      where: { id: { in: string[] } };
    };
    expect(arg.where.id.in).toEqual(['n-tight']);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('a node that was NEVER served a policy falls back to the env default — the pre-#1140 behaviour', async () => {
    // A manual row, or an agent that predates the policy channel. Long past the 45-minute default.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { sweeper, emit } = makeSweeper([
      {
        id: 'n-legacy',
        label: 'web-07',
        lastReportedAt: twoHoursAgo,
        policyStaleAfterSeconds: null,
      },
    ]);

    expect(await sweeper.sweep()).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
