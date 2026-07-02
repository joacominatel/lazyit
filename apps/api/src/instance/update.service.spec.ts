import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UpdateService } from './update.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
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
  const emit = jest.fn();
  const fetchMock = jest.fn();

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
            },
          },
        },
        { provide: NotificationsService, useValue: { emit } },
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
      emit,
      fetchMock,
    ]) {
      m.mockReset();
    }
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
