jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { Test, type TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import { DEFAULT_ROLE_PERMISSIONS, type Role } from '@lazyit/shared';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkflowRunsController } from './runs/workflow-runs.controller';
import { WorkflowRunsService } from './runs/workflow-runs.service';
import { WorkflowsController } from './definitions/workflows.controller';
import { WorkflowsService } from './definitions/workflows.service';
import { WorkflowSecretsController } from './definitions/workflow-secrets.controller';
import { WorkflowSecretsService } from './definitions/workflow-secrets.service';
import { ManualTasksController } from './tasks/manual-tasks.controller';
import { ManualTasksService } from './tasks/manual-tasks.service';

/**
 * End-to-end permission gating for the engine endpoints (ADR-0046 P4) through the REAL RolesGuard +
 * PermissionResolverService (Prisma mocked to the SEEDED matrix). The workflow verbs are ADMIN-only by
 * default, so a MEMBER is 403 on every gate and an ADMIN passes:
 *   - GET  /workflow-runs            → workflow:read
 *   - POST /workflow-runs/:id/retry  → workflow:run
 *   - POST /workflows                → workflow:manage
 *   - POST /workflow-secrets         → workflow:secrets
 *   - POST /workflow-tasks/:id/submit→ workflow:task
 */

@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const role = req.headers['x-test-role'];
    req.user = role ? { id: 'u1', role } : undefined;
    return true;
  }
}

describe('Workflow engine endpoints — permission gating (ADR-0046)', () => {
  let app: INestApplication;
  const runsFindPage = jest.fn();
  const runsRetry = jest.fn();
  const workflowsCreate = jest.fn();
  const secretsCreate = jest.fn();
  const tasksSubmit = jest.fn();

  const findMany = jest.fn(({ where }: { where: { role: Role } }) =>
    Promise.resolve(
      DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
        permission,
      })),
    ),
  );
  const prisma = { rolePermission: { findMany } } as unknown as PrismaService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [
        WorkflowRunsController,
        WorkflowsController,
        WorkflowSecretsController,
        ManualTasksController,
      ],
      providers: [
        Reflector,
        {
          provide: WorkflowRunsService,
          useValue: { findPage: runsFindPage, retry: runsRetry },
        },
        { provide: WorkflowsService, useValue: { create: workflowsCreate } },
        {
          provide: WorkflowSecretsService,
          useValue: { create: secretsCreate },
        },
        { provide: ManualTasksService, useValue: { submit: tasksSubmit } },
        { provide: PrismaService, useValue: prisma },
        PermissionResolverService,
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    runsFindPage
      .mockReset()
      .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    runsRetry.mockReset().mockResolvedValue({ ok: true, runId: 'r1' });
    workflowsCreate.mockReset().mockResolvedValue({ id: 'wf1' });
    secretsCreate.mockReset().mockResolvedValue({ id: 's1', configured: true });
    tasksSubmit.mockReset().mockResolvedValue({ ok: true });
  });

  describe('GET /workflow-runs — workflow:read', () => {
    it('403 for a MEMBER (never reaches the service)', async () => {
      const res = await request(app.getHttpServer())
        .get('/workflow-runs')
        .set('X-Test-Role', 'MEMBER');
      expect(res.status).toBe(403);
      expect(runsFindPage).not.toHaveBeenCalled();
    });
    it('200 for an ADMIN', async () => {
      const res = await request(app.getHttpServer())
        .get('/workflow-runs')
        .set('X-Test-Role', 'ADMIN');
      expect(res.status).toBe(200);
      expect(runsFindPage).toHaveBeenCalled();
    });
  });

  describe('POST /workflow-runs/:id/retry — workflow:run', () => {
    it('403 for a MEMBER (never reaches the service — retry is a distinct verb from read)', async () => {
      const res = await request(app.getHttpServer())
        .post('/workflow-runs/r1/retry')
        .set('X-Test-Role', 'MEMBER');
      expect(res.status).toBe(403);
      expect(runsRetry).not.toHaveBeenCalled();
    });
    it('200 for an ADMIN', async () => {
      const res = await request(app.getHttpServer())
        .post('/workflow-runs/r1/retry')
        .set('X-Test-Role', 'ADMIN');
      expect(res.status).toBe(200);
      expect(runsRetry).toHaveBeenCalledWith('r1');
    });
  });

  describe('POST /workflows — workflow:manage', () => {
    const body = {
      applicationId: 'app1',
      trigger: 'ACCESS_GRANTED',
      name: 'WF',
    };
    it('403 for a MEMBER', async () => {
      const res = await request(app.getHttpServer())
        .post('/workflows')
        .set('X-Test-Role', 'MEMBER')
        .send(body);
      expect(res.status).toBe(403);
      expect(workflowsCreate).not.toHaveBeenCalled();
    });
    it('201 for an ADMIN', async () => {
      const res = await request(app.getHttpServer())
        .post('/workflows')
        .set('X-Test-Role', 'ADMIN')
        .send(body);
      expect(res.status).toBe(201);
      expect(workflowsCreate).toHaveBeenCalled();
    });
  });

  describe('POST /workflow-secrets — workflow:secrets', () => {
    const body = {
      applicationId: 'app1',
      label: 'Jira token',
      value: 'super-secret',
    };
    it('403 for a MEMBER', async () => {
      const res = await request(app.getHttpServer())
        .post('/workflow-secrets')
        .set('X-Test-Role', 'MEMBER')
        .send(body);
      expect(res.status).toBe(403);
      expect(secretsCreate).not.toHaveBeenCalled();
    });
    it('201 for an ADMIN', async () => {
      const res = await request(app.getHttpServer())
        .post('/workflow-secrets')
        .set('X-Test-Role', 'ADMIN')
        .send(body);
      expect(res.status).toBe(201);
      expect(secretsCreate).toHaveBeenCalled();
    });
  });

  describe('POST /workflow-tasks/:id/submit — workflow:task', () => {
    it('403 for a MEMBER', async () => {
      const res = await request(app.getHttpServer())
        .post('/workflow-tasks/t1/submit')
        .set('X-Test-Role', 'MEMBER')
        .send({ input: {} });
      expect(res.status).toBe(403);
      expect(tasksSubmit).not.toHaveBeenCalled();
    });
    it('201 for an ADMIN', async () => {
      const res = await request(app.getHttpServer())
        .post('/workflow-tasks/t1/submit')
        .set('X-Test-Role', 'ADMIN')
        .send({ input: {} });
      expect(res.status).toBe(201);
      expect(tasksSubmit).toHaveBeenCalled();
    });
  });
});
