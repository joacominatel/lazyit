import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import { DEFAULT_ROLE_PERMISSIONS, type Role } from '@lazyit/shared';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so importing the service token never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * Notification bell authorization (ADR-0056 §6) — the four poll endpoints are gated by
 * `@RequirePermission('notification:read')`, seeded ADMIN-only. This proves the gate end-to-end through
 * the REAL {@link RolesGuard} + {@link PermissionResolverService} (Prisma mocked to return the SEEDED
 * rows): a MEMBER and a VIEWER are 403 and never reach the service, while an ADMIN succeeds. Since
 * `notification:read` is in ADMIN_ONLY_READS, neither MEMBER nor VIEWER holds it by default — were the
 * controller wrongly gated (or the permission seeded to MEMBER/VIEWER), the MEMBER case would 200 and
 * this test would fail.
 */

// Stand-in for JwtAuthGuard: populate request.user AND request.principal (the unified accessor the
// controller reads via @CurrentPrincipal) from a test header — a HUMAN with the given role.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    const role = req.headers['x-test-role'];
    if (role) {
      const user = { id: 'admin-uuid', role };
      req.user = user;
      req.principal = { kind: 'human', user };
    } else {
      req.user = undefined;
      req.principal = undefined;
    }
    return true;
  }
}

describe('Notification bell authZ — notification:read, ADMIN-only (ADR-0056)', () => {
  let app: INestApplication;
  const findPage = jest.fn();
  const unreadCount = jest.fn();
  const markRead = jest.fn();
  const markAllRead = jest.fn();

  const findMany = jest.fn(({ where }: { where: { role: Role } }) =>
    Promise.resolve(
      DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
        permission,
      })),
    ),
  );
  const prisma = {
    rolePermission: { findMany },
  } as unknown as PrismaService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        Reflector,
        {
          provide: NotificationsService,
          useValue: { findPage, unreadCount, markRead, markAllRead },
        },
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
    findPage.mockReset();
    unreadCount.mockReset();
  });

  it('rejects a MEMBER listing notifications with 403 and never reaches the service', async () => {
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('X-Test-Role', 'MEMBER');
    expect(res.status).toBe(403);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('rejects a VIEWER reading the unread count with 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set('X-Test-Role', 'VIEWER');
    expect(res.status).toBe(403);
    expect(unreadCount).not.toHaveBeenCalled();
  });

  it('lets an ADMIN list notifications (reaches the service, 200)', async () => {
    findPage.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('X-Test-Role', 'ADMIN');
    expect(res.status).toBe(200);
    expect(findPage).toHaveBeenCalledTimes(1);
    // The caller's human id is passed as the fan-out-on-read key.
    expect(findPage).toHaveBeenCalledWith('admin-uuid', expect.any(Object));
  });

  it('lets an ADMIN read the unread count (200, { unread })', async () => {
    unreadCount.mockResolvedValue(7);
    const res = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set('X-Test-Role', 'ADMIN');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unread: 7 });
  });

  it('lets an ADMIN mark one read (200) and mark-all read (200)', async () => {
    markRead.mockResolvedValue({ marked: 1, unread: 0 });
    markAllRead.mockResolvedValue({ marked: 3, unread: 0 });

    const one = await request(app.getHttpServer())
      .patch('/notifications/n1/read')
      .set('X-Test-Role', 'ADMIN');
    expect(one.status).toBe(200);
    expect(markRead).toHaveBeenCalledWith('admin-uuid', 'n1');

    const all = await request(app.getHttpServer())
      .patch('/notifications/read-all')
      .set('X-Test-Role', 'ADMIN');
    expect(all.status).toBe(200);
    expect(markAllRead).toHaveBeenCalledWith('admin-uuid');
  });
});
