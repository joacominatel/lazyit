import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UpdateService, UPDATE_CANCELLED_REASON } from './update.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentFleetService } from '../infra/agent-fleet.service';
import type { Principal } from '../auth/principal';

// No DB / no real Prisma client — the service only touches updateSettings + updateRun, both mocked.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/**
 * UpdateService (ADR-0084) — proves the security-and-correctness core:
 *   - runCheck is OPT-OUT by default (no fetch when the check is off) and FAIL-SOFT (a fetch error
 *     leaves the cache untouched and never throws);
 *   - the weekly email SUPPRESSES-WHEN-CURRENT and DE-DUPES per newly-observed latest version;
 *   - enqueue is ENQUEUE-ONLY, rejects a non-newer target and refuses a second in-flight run;
 *   - boot reconciliation finalizes in-flight runs by version compare and leaves `requested` alone.
 * The GitHub reach is a mocked global `fetch` — no network, INV: beacon-free (a bare GET, asserted).
 */
describe('UpdateService', () => {
  const settingsFindFirst = jest.fn();
  const settingsUpdate = jest.fn();
  const settingsUpsert = jest.fn();
  const runFindFirst = jest.fn();
  const runFindMany = jest.fn();
  const runCreate = jest.fn();
  const runUpdate = jest.fn();
  const runUpdateMany = jest.fn();
  const emit = jest.fn();
  const fetchMock = jest.fn();
  // ADR-0094 (#1206): the ONE aggregate agent line on the existing `update.available` email. Zero by
  // default, which is the shape every pre-#1206 assertion in this file was written against.
  const countAgentsMajorBehind = jest.fn();

  const ORIGINAL_APP_VERSION = process.env.APP_VERSION;

  async function build(): Promise<UpdateService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        UpdateService,
        {
          provide: PrismaService,
          useValue: {
            updateSettings: {
              findFirst: settingsFindFirst,
              update: settingsUpdate,
              upsert: settingsUpsert,
            },
            updateRun: {
              findFirst: runFindFirst,
              findMany: runFindMany,
              create: runCreate,
              update: runUpdate,
              updateMany: runUpdateMany,
            },
          },
        },
        { provide: NotificationsService, useValue: { emit } },
        {
          provide: AgentFleetService,
          useValue: { countAgentsMajorBehind },
        },
      ],
    }).compile();
    return moduleRef.get(UpdateService);
  }

  beforeEach(() => {
    for (const m of [
      settingsFindFirst,
      settingsUpdate,
      settingsUpsert,
      runFindFirst,
      runFindMany,
      runCreate,
      runUpdate,
      runUpdateMany,
      emit,
      fetchMock,
      countAgentsMajorBehind,
    ]) {
      m.mockReset();
    }
    countAgentsMajorBehind.mockResolvedValue(0);
    process.env.APP_VERSION = 'v1.4.2';
    process.env.NODE_ENV = 'test';
    global.fetch = fetchMock;
  });

  afterAll(() => {
    if (ORIGINAL_APP_VERSION === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = ORIGINAL_APP_VERSION;
  });

  /** Type the loosely-typed jest mock call args so the assertions stay type-safe (no `any` access). */
  type FetchInit = {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  };
  const fetchInit = (): FetchInit =>
    (fetchMock.mock.calls[0] as unknown[])[1] as FetchInit;
  const emitPayload = (): Record<string, unknown> =>
    (emit.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
  const settingsUpdateData = (): Record<string, unknown> =>
    (
      (settingsUpdate.mock.calls[0] as unknown[])[0] as {
        data: Record<string, unknown>;
      }
    ).data;
  const runUpdateData = (): Record<string, unknown> =>
    (
      (runUpdate.mock.calls[0] as unknown[])[0] as {
        data: Record<string, unknown>;
      }
    ).data;

  function githubOk(releases: Array<Record<string, unknown>>) {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(releases),
    });
  }

  describe('runCheck', () => {
    it('is opt-out by default: no fetch, no cache write when the check is off', async () => {
      settingsFindFirst.mockResolvedValue({ checkEnabled: false });
      const service = await build();

      const result = await service.runCheck();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(settingsUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({
        checked: false,
        latestVersion: null,
        behindBy: 0,
        emailed: false,
      });
    });

    it('caches latest + N behind and emits ONE email when behind (beacon-free GET)', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: null,
      });
      githubOk([
        { tag_name: 'v1.6.0', html_url: 'https://gh/1.6.0', name: 'v1.6.0' },
        { tag_name: 'v1.5.0', html_url: 'https://gh/1.5.0' },
        { tag_name: 'v1.4.2', html_url: 'https://gh/1.4.2' },
      ]);
      const service = await build();

      const result = await service.runCheck();

      // Beacon-free: a bare GET, no Authorization header, no request body.
      const init = fetchInit();
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.headers?.Authorization).toBeUndefined();

      expect(result).toMatchObject({
        checked: true,
        latestVersion: 'v1.6.0',
        behindBy: 2,
        emailed: true,
      });
      expect(settingsUpdateData()).toMatchObject({
        latestVersion: 'v1.6.0',
        behindBy: 2,
      });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emitPayload()).toMatchObject({
        type: 'update.available',
        dedupeKey: 'update.available:v1.6.0',
      });
    });

    it('suppresses the email when current (behindBy 0)', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: null,
      });
      githubOk([{ tag_name: 'v1.4.2' }, { tag_name: 'v1.4.1' }]);
      const service = await build();

      const result = await service.runCheck();

      expect(result.behindBy).toBe(0);
      expect(emit).not.toHaveBeenCalled();
    });

    it('de-dupes: no second email for an already-emailed latest version', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: 'v1.6.0',
      });
      githubOk([{ tag_name: 'v1.6.0' }, { tag_name: 'v1.4.2' }]);
      const service = await build();

      const result = await service.runCheck();

      expect(result.behindBy).toBe(1);
      expect(emit).not.toHaveBeenCalled();
    });

    it('drops drafts and pre-releases before comparing', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: null,
      });
      githubOk([
        { tag_name: 'v2.0.0', draft: true },
        { tag_name: 'v1.9.0', prerelease: true },
        { tag_name: 'v1.5.0' },
      ]);
      const service = await build();

      const result = await service.runCheck();

      expect(result).toMatchObject({ latestVersion: 'v1.5.0', behindBy: 1 });
    });

    it('flags the gap security-relevant and sends a flagged email when a release in the gap is marked (#908)', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: null,
        lastEmailedSecurity: false,
      });
      githubOk([
        {
          tag_name: 'v1.6.0',
          html_url: 'https://gh/1.6.0',
          body: 'routine notes',
        },
        // A release strictly newer than the running v1.4.2, carrying the security marker.
        { tag_name: 'v1.5.0', body: '<!-- lazyit:security -->\nfixes a hole' },
        { tag_name: 'v1.4.2', body: 'no marker here' },
      ]);
      const service = await build();

      const result = await service.runCheck();

      expect(result).toMatchObject({ latestVersion: 'v1.6.0', behindBy: 2 });
      expect(settingsUpdateData()).toMatchObject({ securityRelevant: true });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emitPayload()).toMatchObject({
        type: 'update.available',
        dedupeKey: 'update.available:v1.6.0:security',
        severity: 'warning',
      });
      expect(String(emitPayload().title)).toContain('Security update');
    });

    it('is NOT security-relevant when no release in the gap carries the marker (#908)', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: null,
        lastEmailedSecurity: false,
      });
      githubOk([
        { tag_name: 'v1.6.0', body: 'routine' },
        { tag_name: 'v1.5.0', body: 'routine' },
      ]);
      const service = await build();

      await service.runCheck();

      expect(settingsUpdateData()).toMatchObject({ securityRelevant: false });
      expect(emitPayload()).toMatchObject({
        dedupeKey: 'update.available:v1.6.0',
        severity: 'info',
      });
    });

    it('ignores a marker on a release that is NOT newer than the running version (#908)', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: null,
        lastEmailedSecurity: false,
      });
      // The marker sits on the CURRENT version (v1.4.2) — not in the gap, so not security-relevant.
      githubOk([
        { tag_name: 'v1.4.2', body: '<!-- lazyit:security -->' },
        { tag_name: 'v1.4.1', body: 'old' },
      ]);
      const service = await build();

      const result = await service.runCheck();

      expect(result.behindBy).toBe(0);
      expect(settingsUpdateData()).toMatchObject({ securityRelevant: false });
      expect(emit).not.toHaveBeenCalled();
    });

    it('re-fires ONCE when a version already emailed as routine later turns security-relevant (#908)', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: 'v1.6.0', // already emailed as a routine nudge
        lastEmailedSecurity: false, // …but not yet as security
      });
      githubOk([{ tag_name: 'v1.6.0', body: '<!-- lazyit:security -->' }]);
      const service = await build();

      const result = await service.runCheck();

      expect(result.behindBy).toBe(1);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emitPayload()).toMatchObject({ severity: 'warning' });
    });

    it('does not re-nag once the security nudge for a version has been emailed (#908)', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: 'v1.6.0',
        lastEmailedSecurity: true, // security already emailed for this version
      });
      githubOk([{ tag_name: 'v1.6.0', body: '<!-- lazyit:security -->' }]);
      const service = await build();

      await service.runCheck();

      expect(emit).not.toHaveBeenCalled();
    });

    // ── the ONE aggregate agent line (ADR-0094 §Decisions resolved 1, #1206) ──
    //
    // ONE sentence on the EXISTING email. No new notification type, no new schedule, no per-host
    // mail — epic #1146 item 8's per-host anti-pattern stays rejected, and these tests are what
    // stops it creeping back in.
    describe('the agent line', () => {
      /** The stock "one new version is out" check the agent-line tests all ride on. */
      function behindOne() {
        settingsFindFirst.mockResolvedValue({
          checkEnabled: true,
          lastEmailedVersion: null,
        });
        githubOk([{ tag_name: 'v1.6.0' }, { tag_name: 'v1.4.2' }]);
      }

      it('adds nothing when no agent is a MAJOR behind — the email is exactly what it was', async () => {
        behindOne();
        countAgentsMajorBehind.mockResolvedValue(0);
        const service = await build();

        await service.runCheck();

        const summary = String(emitPayload().summary);
        expect(summary).not.toContain('MAJOR');
        expect(emitPayload().metadata).not.toHaveProperty('agentsMajorBehind');
      });

      it('appends one sentence naming the count, and records it in the metadata', async () => {
        behindOne();
        countAgentsMajorBehind.mockResolvedValue(12);
        const service = await build();

        await service.runCheck();

        expect(String(emitPayload().summary)).toContain(
          '12 reporting agents are a MAJOR version behind',
        );
        expect(emitPayload().metadata).toMatchObject({
          agentsMajorBehind: 12,
        });
      });

      it('reads singular for exactly one agent', async () => {
        behindOne();
        countAgentsMajorBehind.mockResolvedValue(1);
        const service = await build();

        await service.runCheck();

        expect(String(emitPayload().summary)).toContain(
          'One reporting agent is a MAJOR version behind',
        );
      });

      it('rides on the SECURITY variant too — still one email, still one line', async () => {
        settingsFindFirst.mockResolvedValue({
          checkEnabled: true,
          lastEmailedVersion: null,
        });
        githubOk([{ tag_name: 'v1.6.0', body: '<!-- lazyit:security -->' }]);
        countAgentsMajorBehind.mockResolvedValue(3);
        const service = await build();

        await service.runCheck();

        expect(emit).toHaveBeenCalledTimes(1);
        const summary = String(emitPayload().summary);
        expect(summary).toContain('security-relevant');
        expect(summary).toContain(
          '3 reporting agents are a MAJOR version behind',
        );
      });

      it('never fires on its own — a current instance sends no email however stale the fleet', async () => {
        settingsFindFirst.mockResolvedValue({
          checkEnabled: true,
          lastEmailedVersion: null,
        });
        githubOk([{ tag_name: 'v1.4.2' }]);
        countAgentsMajorBehind.mockResolvedValue(40);
        const service = await build();

        await service.runCheck();

        // The line is a passenger on the update email, never a schedule of its own (ADR-0094 §8).
        expect(emit).not.toHaveBeenCalled();
      });

      it('is fail-soft: a fleet-count failure still sends the update email, minus the line', async () => {
        behindOne();
        countAgentsMajorBehind.mockRejectedValue(new Error('db down'));
        const service = await build();

        const result = await service.runCheck();

        expect(result.emailed).toBe(true);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(String(emitPayload().summary)).not.toContain('MAJOR');
      });
    });

    it('is fail-soft: a fetch error leaves the cache untouched and does not throw', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: null,
      });
      fetchMock.mockRejectedValue(new Error('egress blocked'));
      const service = await build();

      const result = await service.runCheck();

      expect(result).toEqual({
        checked: false,
        latestVersion: null,
        behindBy: 0,
        emailed: false,
      });
      expect(settingsUpdate).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('is fail-soft on a non-2xx (rate-limited) response', async () => {
      settingsFindFirst.mockResolvedValue({
        checkEnabled: true,
        lastEmailedVersion: null,
      });
      fetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({}),
      });
      const service = await build();

      const result = await service.runCheck();

      expect(result.checked).toBe(false);
      expect(settingsUpdate).not.toHaveBeenCalled();
    });
  });

  describe('enqueue', () => {
    const admin: Principal = {
      kind: 'human',
      user: { id: USER_ID, role: 'ADMIN' } as never,
    };

    it('rejects a target that is not newer than the running version', async () => {
      const service = await build();
      await expect(
        service.enqueue({ toVersion: 'v1.4.2' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.enqueue({ toVersion: 'v1.4.1' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runCreate).not.toHaveBeenCalled();
    });

    it('refuses a second run while one is already in flight', async () => {
      runFindFirst.mockResolvedValue({
        id: 7,
        toVersion: 'v1.5.0',
        status: 'building',
      });
      const service = await build();
      await expect(
        service.enqueue({ toVersion: 'v1.6.0' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runCreate).not.toHaveBeenCalled();
    });

    it('inserts an append-only requested run for a valid newer target', async () => {
      runFindFirst.mockResolvedValue(null);
      runCreate.mockResolvedValue({
        id: 1,
        requestedByUserId: USER_ID,
        fromVersion: 'v1.4.2',
        toVersion: 'v1.5.0',
        status: 'requested',
        startedAt: null,
        finishedAt: null,
        logTail: null,
        error: null,
        createdAt: new Date('2026-07-02T00:00:00Z'),
        updatedAt: new Date('2026-07-02T00:00:00Z'),
      });
      const service = await build();

      const run = await service.enqueue({ toVersion: '1.5.0' }, admin); // no leading v — normalized

      expect(runCreate).toHaveBeenCalledWith({
        data: {
          requestedByUserId: USER_ID,
          fromVersion: 'v1.4.2',
          toVersion: 'v1.5.0',
          status: 'requested',
        },
      });
      expect(run).toMatchObject({
        id: 1,
        status: 'requested',
        toVersion: 'v1.5.0',
      });
    });
  });

  describe('cancel', () => {
    const admin: Principal = {
      kind: 'human',
      user: { id: USER_ID, role: 'ADMIN' } as never,
    };

    /** A full `requested` UpdateRun row (the shape findFirst returns with no `select`). */
    const requestedRow = (
      overrides: Partial<Record<string, unknown>> = {},
    ) => ({
      id: 9,
      requestedByUserId: USER_ID,
      fromVersion: 'v1.4.2',
      toVersion: 'v1.5.0',
      status: 'requested',
      startedAt: null,
      finishedAt: null,
      logTail: null,
      error: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
      ...overrides,
    });

    it('cancels a stale `requested` run (terminal `failed` + distinct reason) so a fresh enqueue succeeds', async () => {
      const service = await build();

      // 1) The stuck run is found; the CAS flip matches it.
      runFindFirst.mockResolvedValueOnce(requestedRow());
      runUpdateMany.mockResolvedValue({ count: 1 });

      const cancelled = await service.cancel();

      expect(cancelled).toMatchObject({
        id: 9,
        status: 'failed',
        error: UPDATE_CANCELLED_REASON,
      });
      expect(cancelled.finishedAt).not.toBeNull();

      // CAS scoped to status='requested' so a concurrent host advance can't be clobbered.
      const casArg = (runUpdateMany.mock.calls[0] as unknown[])[0] as {
        where: { id: number; status: string };
        data: { status: string };
      };
      expect(casArg.where).toMatchObject({ id: 9, status: 'requested' });
      expect(casArg.data.status).toBe('failed');

      // 2) The single-flight guard now sees no active run — a fresh enqueue goes through.
      runFindFirst.mockResolvedValueOnce(null);
      runCreate.mockResolvedValue({
        id: 10,
        requestedByUserId: USER_ID,
        fromVersion: 'v1.4.2',
        toVersion: 'v1.6.0',
        status: 'requested',
        startedAt: null,
        finishedAt: null,
        logTail: null,
        error: null,
        createdAt: new Date('2026-07-02T00:00:00Z'),
        updatedAt: new Date('2026-07-02T00:00:00Z'),
      });

      const next = await service.enqueue({ toVersion: 'v1.6.0' }, admin);
      expect(next).toMatchObject({ status: 'requested', toVersion: 'v1.6.0' });
    });

    it('rejects cancelling a genuinely in-flight run (backing_up) — it must not be interrupted mid-apply', async () => {
      runFindFirst.mockResolvedValue(requestedRow({ status: 'backing_up' }));
      const service = await build();

      await expect(service.cancel()).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(runUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects when there is no pending update to cancel', async () => {
      runFindFirst.mockResolvedValue(null);
      const service = await build();

      await expect(service.cancel()).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(runUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects when the run advanced out of `requested` mid-cancel (CAS matched 0 rows)', async () => {
      runFindFirst.mockResolvedValue(requestedRow());
      runUpdateMany.mockResolvedValue({ count: 0 });
      const service = await build();

      await expect(service.cancel()).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('a genuinely in-flight run still blocks a new enqueue (single-flight unchanged)', async () => {
      runFindFirst.mockResolvedValue({
        id: 5,
        toVersion: 'v1.5.0',
        status: 'backing_up',
      });
      const service = await build();

      await expect(
        service.enqueue({ toVersion: 'v1.6.0' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runCreate).not.toHaveBeenCalled();
    });
  });

  describe('reconcileInterruptedRuns', () => {
    it('marks an in-flight run done when the running version matches the target', async () => {
      runFindMany.mockResolvedValue([{ id: 3, toVersion: 'v1.4.2' }]); // current == target
      const service = await build();

      const n = await service.reconcileInterruptedRuns();

      expect(n).toBe(1);
      expect(runUpdateData()).toMatchObject({ status: 'done' });
    });

    it('marks an in-flight run failed when the version did not change', async () => {
      runFindMany.mockResolvedValue([{ id: 4, toVersion: 'v1.5.0' }]); // current v1.4.2 != target
      const service = await build();

      await service.reconcileInterruptedRuns();

      expect(runUpdateData()).toMatchObject({ status: 'failed' });
    });

    it('never queries `requested` rows (they are pending intent, not interrupted runs)', async () => {
      runFindMany.mockResolvedValue([]);
      const service = await build();

      await service.reconcileInterruptedRuns();

      const arg = (runFindMany.mock.calls[0] as unknown[])[0] as {
        where: { status: { in: string[] } };
      };
      expect(arg.where.status.in).not.toContain('requested');
      expect(arg.where.status.in).toContain('building');
    });
  });
});
