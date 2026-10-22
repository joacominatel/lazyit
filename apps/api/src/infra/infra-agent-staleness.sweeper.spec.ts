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
type FlipArgs = {
  where: {
    status: unknown;
    deletedAt: null;
    OR: { id: string; lastReportedAt: Date | null }[];
  };
};

/**
 * Wire a sweeper over a fake `infraNode` (the pre-query `findMany` returns the transitioning set; the
 * bulk `updateMany` returns its count) and a best-effort `emit` double. Just enough to prove: ONE
 * `infra.agent_offline` nudge per OFFLINE transition (#852), the dedupeKey keys on the last-report
 * instant, and a clean sweep is silent.
 */
function makeSweeper(
  transitioning: StaleNode[],
  // Default: a server that has been up far longer than any window, i.e. no boot grace in play — the
  // behaviour every test above the boot-grace block is about.
  clock: { bootedAtMs?: number; nowMs?: number } = {},
) {
  const findMany = jest.fn().mockResolvedValue(transitioning);
  // Default: every row the per-node filter decided is still stale at write time and flips.
  const updateMany = jest
    .fn()
    .mockImplementation((args: FlipArgs) =>
      Promise.resolve(args.where.OR.map((clause) => ({ id: clause.id }))),
    );
  const prisma = {
    infraNode: { findMany, updateManyAndReturn: updateMany },
  } as unknown as PrismaService;
  const emit = jest.fn().mockResolvedValue('notif-id');
  const notifications = { emit } as unknown as NotificationsService;
  const sweeper = new InfraAgentStalenessSweeper(prisma, notifications);
  sweeper.bootedAtMs = clock.bootedAtMs ?? 0;
  if (clock.nowMs !== undefined) {
    const fixed = clock.nowMs;
    sweeper.now = () => fixed;
  }
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
    // The bulk flip addresses the decided set by id, each pinned to the report instant it was judged on.
    const arg = (updateMany.mock.calls as unknown[][])[0][0] as FlipArgs;
    expect(arg.where.OR).toEqual([
      { id: 'n-tight', lastReportedAt: tenMinutesAgo },
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  // ── The read→write race (AUD-058) ───────────────────────────────────────────────────────────────

  it('the flip is conditional: still not OFFLINE, still live, and still on the snapshot report instant', async () => {
    const last = new Date('2026-06-30T00:00:00.000Z');
    const { sweeper, updateMany } = makeSweeper([
      { id: 'n1', label: 'web-01', lastReportedAt: last },
    ]);

    await sweeper.sweep();

    const arg = (updateMany.mock.calls as unknown[][])[0][0] as FlipArgs;
    expect(arg.where).toEqual({
      status: { not: 'OFFLINE' },
      deletedAt: null,
      OR: [{ id: 'n1', lastReportedAt: last }],
    });
  });

  it('a node that reported between the read and the flip is neither counted nor announced', async () => {
    const last = new Date('2026-06-30T00:00:00.000Z');
    const { sweeper, updateMany, emit } = makeSweeper([
      { id: 'n-stale', label: 'web-01', lastReportedAt: last },
      { id: 'n-back', label: 'db-01', lastReportedAt: last },
    ]);
    // n-back checked in after the snapshot, so its row no longer matches the conditional write.
    updateMany.mockResolvedValueOnce([{ id: 'n-stale' }]);

    expect(await sweeper.sweep()).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);
    const input = (emit.mock.calls as EmitCall[])[0][0];
    expect(input.metadata).toMatchObject({ nodeId: 'n-stale' });
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

  // ── Boot grace (#1674, split from #1146 item 8) ─────────────────────────────────────────────────
  //
  // After the API itself was down, every agent's last report is old because nobody was listening.
  // For one staleness window after boot nothing is flipped OFFLINE (and so nothing is announced).

  describe('boot grace', () => {
    const BOOT = Date.parse('2026-10-21T08:00:00.000Z');
    const MIN = 60 * 1000;
    const DEFAULT_WINDOW = 45 * MIN; // INFRA_AGENT_STALE_AFTER_MS_DEFAULT
    // Silent since well before the outage — stale by any threshold, if the server had been listening.
    const lastBeforeOutage = new Date(BOOT - 3 * 60 * MIN);

    it('does not flip or announce a silent node inside the window after boot', async () => {
      const { sweeper, updateMany, emit } = makeSweeper(
        [{ id: 'n1', label: 'web-01', lastReportedAt: lastBeforeOutage }],
        { bootedAtMs: BOOT, nowMs: BOOT + 15 * MIN },
      );

      expect(await sweeper.sweep()).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('is still inside the grace at EXACTLY one window after boot', async () => {
      const { sweeper, updateMany, emit } = makeSweeper(
        [{ id: 'n1', label: 'web-01', lastReportedAt: lastBeforeOutage }],
        { bootedAtMs: BOOT, nowMs: BOOT + DEFAULT_WINDOW },
      );

      expect(await sweeper.sweep()).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('flips and announces as normal one millisecond past the window', async () => {
      const { sweeper, updateMany, emit } = makeSweeper(
        [{ id: 'n1', label: 'web-01', lastReportedAt: lastBeforeOutage }],
        { bootedAtMs: BOOT, nowMs: BOOT + DEFAULT_WINDOW + 1 },
      );

      expect(await sweeper.sweep()).toBe(1);
      const arg = (updateMany.mock.calls as unknown[][])[0][0] as FlipArgs;
      // The flip is still pinned to the REAL last report, and the nudge keys on it: one per outage.
      expect(arg.where.OR).toEqual([
        { id: 'n1', lastReportedAt: lastBeforeOutage },
      ]);
      expect(emit).toHaveBeenCalledTimes(1);
      const input = (emit.mock.calls as EmitCall[])[0][0];
      expect(input.dedupeKey).toBe(
        `infra.agent_offline:n1:${lastBeforeOutage.toISOString()}`,
      );
    });

    it("the window is the node's OWN served threshold, not the env default", async () => {
      // 10 min after boot: past a 5-minute served window, inside a daily one and the 45-min default.
      const { sweeper, updateMany, emit } = makeSweeper(
        [
          {
            id: 'n-tight',
            label: 'edge-02',
            lastReportedAt: lastBeforeOutage,
            policyStaleAfterSeconds: 300,
          },
          {
            id: 'n-daily',
            label: 'backup-01',
            lastReportedAt: new Date(BOOT - 25 * 60 * MIN),
            policyStaleAfterSeconds: 90_000,
          },
          {
            id: 'n-default',
            label: 'web-01',
            lastReportedAt: lastBeforeOutage,
          },
        ],
        { bootedAtMs: BOOT, nowMs: BOOT + 10 * MIN },
      );

      expect(await sweeper.sweep()).toBe(1);
      const arg = (updateMany.mock.calls as unknown[][])[0][0] as FlipArgs;
      expect(arg.where.OR.map((clause) => clause.id)).toEqual(['n-tight']);
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('a node that reported after boot is judged on that report, exactly as without the grace', async () => {
      // Checked in 2 min after boot, then went silent: it is measured from its report, not from boot,
      // so it flips once ITS window has elapsed — the grace never lengthens a post-boot silence.
      const lastAfterBoot = new Date(BOOT + 2 * MIN);
      const inside = makeSweeper(
        [{ id: 'n1', label: 'web-01', lastReportedAt: lastAfterBoot }],
        { bootedAtMs: BOOT, nowMs: BOOT + 2 * MIN + DEFAULT_WINDOW },
      );
      expect(await inside.sweeper.sweep()).toBe(0);

      const past = makeSweeper(
        [{ id: 'n1', label: 'web-01', lastReportedAt: lastAfterBoot }],
        { bootedAtMs: BOOT, nowMs: BOOT + 2 * MIN + DEFAULT_WINDOW + 1 },
      );
      expect(await past.sweeper.sweep()).toBe(1);
      expect(past.emit).toHaveBeenCalledTimes(1);
    });

    it('defaults its boot instant to when the provider was constructed', () => {
      const before = Date.now();
      const fresh = new InfraAgentStalenessSweeper(
        {} as PrismaService,
        {} as NotificationsService,
      );
      expect(fresh.bootedAtMs).toBeGreaterThanOrEqual(before);
      expect(fresh.bootedAtMs).toBeLessThanOrEqual(Date.now());
    });
  });
});
