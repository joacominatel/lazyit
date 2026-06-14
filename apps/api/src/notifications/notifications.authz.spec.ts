import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { DEFAULT_ROLE_PERMISSIONS, type Role } from '@lazyit/shared';
import request from 'supertest';
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
 * Notification bell authorization — the ADR-0056 AMENDMENT contract (2026-06-14, #453). v1 gated all
 * four poll endpoints by `@RequirePermission('notification:read')` (ADMIN-only), 403'ing a non-admin
 * before the service. The amendment RELAXES the routes to any authenticated HUMAN and moves the
 * visibility decision INTO the service (scoped: own targeted rows always; broadcast only with
 * `notification:read`). This proves the relaxed gate end-to-end through the REAL {@link RolesGuard} +
 * {@link PermissionResolverService}:
 *   - a MEMBER and a VIEWER now REACH the service (200) — they are NOT 403'd by the controller — and the
 *     controller forwards their `{ userId, role }` so the service can scope them to their own targeted
 *     rows only;
 *   - an ADMIN reaches the service with role=ADMIN (so the service grants them the broadcast set too);
 *   - a SERVICE-ACCOUNT principal is 403'd (the bell is a human per-user surface).
 * The actual scoping (own-targeted vs broadcast, IDOR-safe mark-read) is unit-tested against the SERVICE
 * in notifications.service.spec.ts; here we prove the controller is reachable and forwards the viewer.
 */

// Stand-in for JwtAuthGuard: populate request.user AND request.principal (the unified accessor the
// controller reads via @CurrentPrincipal) from test headers — a HUMAN with the given role, or a
// SERVICE-ACCOUNT principal when X-Test-Service is set.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    if (req.headers['x-test-service']) {
      req.user = undefined;
      req.principal = {
        kind: 'service',
        serviceAccount: { id: 'sa-1' },
        permissions: new Set(['notification:read']),
      };
      return true;
    }
    const role = req.headers['x-test-role'];
    const userId = req.headers['x-test-user'] ?? 'caller-uuid';
    if (role) {
      const user = { id: userId, role };
      req.user = user;
      req.principal = { kind: 'human', user };
    } else {
      req.user = undefined;
      req.principal = undefined;
    }
    return true;
  }
}

describe('Notification bell authZ — relaxed + service-scoped (ADR-0056 amendment, #453)', () => {
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
    markRead.mockReset();
    markAllRead.mockReset();
  });

  it('a MEMBER now REACHES the service (200) and is forwarded as { userId, role: MEMBER } for scoping', async () => {
    findPage.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('X-Test-Role', 'MEMBER')
      .set('X-Test-User', 'member-uuid');
    expect(res.status).toBe(200);
    // The relaxed route no longer 403s a non-admin; the service receives the viewer and scopes it.
    expect(findPage).toHaveBeenCalledWith(
      { userId: 'member-uuid', role: 'MEMBER' },
      expect.any(Object),
    );
  });

  it('a VIEWER now REACHES the unread-count service (200), forwarded as role: VIEWER', async () => {
    unreadCount.mockResolvedValue(0);
    const res = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set('X-Test-Role', 'VIEWER')
      .set('X-Test-User', 'viewer-uuid');
    expect(res.status).toBe(200);
    expect(unreadCount).toHaveBeenCalledWith({
      userId: 'viewer-uuid',
      role: 'VIEWER',
    });
  });

  it('an ADMIN reaches the service with role: ADMIN (so the service grants the broadcast set too)', async () => {
    findPage.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('X-Test-Role', 'ADMIN')
      .set('X-Test-User', 'admin-uuid');
    expect(res.status).toBe(200);
    expect(findPage).toHaveBeenCalledWith(
      { userId: 'admin-uuid', role: 'ADMIN' },
      expect.any(Object),
    );
  });

  it('mark-one and mark-all forward the caller as the viewer (the service enforces IDOR-safety)', async () => {
    markRead.mockResolvedValue({ marked: 1, unread: 0 });
    markAllRead.mockResolvedValue({ marked: 3, unread: 0 });

    const one = await request(app.getHttpServer())
      .patch('/notifications/n1/read')
      .set('X-Test-Role', 'MEMBER')
      .set('X-Test-User', 'member-uuid');
    expect(one.status).toBe(200);
    expect(markRead).toHaveBeenCalledWith(
      { userId: 'member-uuid', role: 'MEMBER' },
      'n1',
    );

    const all = await request(app.getHttpServer())
      .patch('/notifications/read-all')
      .set('X-Test-Role', 'ADMIN')
      .set('X-Test-User', 'admin-uuid');
    expect(all.status).toBe(200);
    expect(markAllRead).toHaveBeenCalledWith({
      userId: 'admin-uuid',
      role: 'ADMIN',
    });
  });

  it('a SERVICE-ACCOUNT principal is 403 — the bell is a human per-user surface (never reaches the service)', async () => {
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('X-Test-Service', '1');
    expect(res.status).toBe(403);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('an anonymous caller (no principal) is 403 (requireViewer rejects a non-human)', async () => {
    const res = await request(app.getHttpServer()).get('/notifications');
    expect(res.status).toBe(403);
    expect(findPage).not.toHaveBeenCalled();
  });
});
