import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// Mock the generated Prisma client so importing the controller's deps never loads the real one.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { ImportController } from './import.controller';
import { PERMISSION_KEY } from '../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import type { ServiceAccount, User } from '../../generated/prisma/client';
import type { HumanPrincipal, ServicePrincipal } from '../auth/principal';
import { GUARDS_METADATA } from '@nestjs/common/constants';

/**
 * Controller-level unit tests for the migrator HTTP surface (ADR-0069 wave 4b, #635). They assert the
 * AUTHORIZATION WIRING (the CEO-reviewed bits) at the metadata level — `import:run` on every route +
 * the human-only guard on the controller — and that every handler is OWNER-SCOPED (the human's
 * `user.id` is what reaches the service) and rejects a non-human / missing principal. The service-layer
 * behaviour (owner-scoped reads, status gating, the runtime per-target authz) is covered by the
 * session/dry-run/commit service specs.
 */

const HUMAN: HumanPrincipal = {
  kind: 'human',
  user: { id: 'human-1' } as User,
};
const SERVICE: ServicePrincipal = {
  kind: 'service',
  serviceAccount: { id: 'sa-1' } as ServiceAccount,
  permissions: new Set(),
};

function makeController() {
  const sessions = {
    createAndParse: jest.fn(async () => ({ sessionId: 's1' })),
    getForOwner: jest.fn(async () => ({ id: 's1' })),
    setMapping: jest.fn(async () => undefined),
  };
  const dryRun = {
    dryRun: jest.fn(async () => ({ result: {}, conflicts: [], tags: [] })),
    saveResolutionPlan: jest.fn(async () => undefined),
  };
  const commits = {
    enqueueCommit: jest.fn(async () => ({ sessionId: 's1' })),
    getCommitResult: jest.fn(async () => ({ sessionId: 's1', status: 'COMMITTED' })),
  };
  const controller = new ImportController(
    sessions as never,
    dryRun as never,
    commits as never,
  );
  return { controller, sessions, dryRun, commits };
}

const FILE = {
  originalname: 'assets.csv',
  buffer: Buffer.from('Name,Status\nA,active\n'),
  size: 22,
} as Express.Multer.File;

describe('ImportController — authorization wiring', () => {
  const reflector = new Reflector();

  it('every route requires the import:run permission (class-level @RequirePermission)', () => {
    const classPerms = reflector.get(PERMISSION_KEY, ImportController);
    expect(classPerms).toEqual(['import:run']);
  });

  it('the controller is human-only (ServicePrincipalForbiddenGuard at class level)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ImportController) ?? [];
    expect(guards).toContain(ServicePrincipalForbiddenGuard);
  });

  it('BEHAVIORAL: a service principal hitting an import route is 403d by the bound guard', () => {
    // Run the guard ACTUALLY bound to ImportController against a request carrying a service principal —
    // proving the human-only refusal at runtime, not just at the metadata level. The guard short-circuits
    // before any handler runs, so the SA never reaches the import wizard regardless of its grants.
    const guard = new ServicePrincipalForbiddenGuard();
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ principal: SERVICE }) }),
      getHandler: () => ImportController.prototype.commit,
      getClass: () => ImportController,
    } as never;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('BEHAVIORAL: a human principal passes the bound guard (humans are never blocked)', () => {
    const guard = new ServicePrincipalForbiddenGuard();
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ principal: HUMAN }) }),
      getHandler: () => ImportController.prototype.commit,
      getClass: () => ImportController,
    } as never;
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe('ImportController — owner-scoping + human-only', () => {
  it('upload passes the human owner id, detected format and file to the session service', async () => {
    const { controller, sessions } = makeController();
    await controller.upload(FILE, undefined, HUMAN);
    expect(sessions.createAndParse).toHaveBeenCalledWith(
      'human-1',
      'asset',
      'csv',
      expect.objectContaining({ originalname: 'assets.csv' }),
    );
  });

  it('upload 400s on a missing file', () => {
    const { controller } = makeController();
    expect(() => controller.upload(undefined, undefined, HUMAN)).toThrow(
      BadRequestException,
    );
  });

  it('upload 400s on an unsupported file type (.xlsx → export-to-CSV message)', () => {
    const { controller } = makeController();
    const xlsx = { ...FILE, originalname: 'sheet.xlsx' } as Express.Multer.File;
    expect(() => controller.upload(xlsx, undefined, HUMAN)).toThrow(/CSV/i);
  });

  it('status / mapping / dry-run / plan / commit / result all scope to the human owner id', async () => {
    const { controller, sessions, dryRun, commits } = makeController();

    await controller.status('s1', HUMAN);
    expect(sessions.getForOwner).toHaveBeenCalledWith('s1', 'human-1');

    await controller.setMapping('s1', { columns: [] } as never, HUMAN);
    expect(sessions.setMapping).toHaveBeenCalledWith('s1', 'human-1', expect.any(Object));

    await controller.runDryRun('s1', HUMAN);
    expect(dryRun.dryRun).toHaveBeenCalledWith('s1', 'human-1');

    await controller.savePlan('s1', { conflicts: [] } as never, HUMAN);
    expect(dryRun.saveResolutionPlan).toHaveBeenCalledWith('s1', 'human-1', expect.any(Object));

    await controller.commit('s1', HUMAN);
    expect(commits.enqueueCommit).toHaveBeenCalledWith('s1', 'human-1');

    await controller.result('s1', HUMAN);
    expect(commits.getCommitResult).toHaveBeenCalledWith('s1', 'human-1');
  });

  it('a service principal is rejected at the ownerId boundary (defence-in-depth behind the guard)', () => {
    const { controller, commits } = makeController();
    expect(() => controller.commit('s1', SERVICE)).toThrow(BadRequestException);
    expect(commits.enqueueCommit).not.toHaveBeenCalled();
  });

  it('a missing principal is rejected (never a null owner that could widen a query)', () => {
    const { controller, sessions } = makeController();
    expect(() => controller.status('s1', undefined)).toThrow(BadRequestException);
    expect(sessions.getForOwner).not.toHaveBeenCalled();
  });
});
