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

type StaleNode = { id: string; label: string; lastReportedAt: Date | null };
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
});
