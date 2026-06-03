import { Test, TestingModule } from '@nestjs/testing';
import {
  Controller,
  Get,
  INestApplication,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { Request } from 'express';
import request from 'supertest';
import { DEFAULT_ROLE_PERMISSIONS, type Role } from '@lazyit/shared';

// The resolver imports PrismaService, which loads the generated Prisma client (ESM `.js` re-exports
// jest can't resolve). The DB is mocked here, so stub the client/adapter to keep them from loading.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { RolesGuard } from './roles.guard';
import { PermissionResolverService } from './permission-resolver.service';
import { RequirePermission } from './require-permission.decorator';
import { Roles } from './roles.decorator';
import { Public } from './public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read-authorization MATRIX (ADR-0046 P3). Boots a Nest app with the REAL {@link RolesGuard} +
 * {@link PermissionResolverService} (Prisma mocked to return the SEEDED rows from the shared single
 * source of truth) and a tiny controller carrying the SAME `@RequirePermission` annotations the real
 * GETs use. Each role is impersonated by a middleware setting `request.user`, then we assert the
 * 200/403 outcome per (role × endpoint). This proves the guard + the chosen permissions yield exactly
 * the intended behavior delta: VIEWER loses `accessGrant:read` + `user:read`, nothing else changes.
 *
 * It is the end-to-end counterpart to the guard unit test: the unit test pins the guard's branching;
 * this pins the WIRING (decorator → metadata → resolver → seed) against the real seed matrix.
 */

// A stand-in for the annotated read surface. The permissions mirror the real controllers 1:1.
@Controller('m')
class MatrixController {
  @Get('assets')
  @RequirePermission('asset:read')
  assets() {
    return { ok: true };
  }

  @Get('applications')
  @RequirePermission('application:read')
  applications() {
    return { ok: true };
  }

  @Get('consumables')
  @RequirePermission('consumable:read')
  consumables() {
    return { ok: true };
  }

  @Get('dashboard')
  @RequirePermission('dashboard:read')
  dashboard() {
    return { ok: true };
  }

  @Get('search')
  @RequirePermission('search:read')
  search() {
    return { ok: true };
  }

  // The two pre-tightened reads (VIEWER → 403).
  @Get('access-grants')
  @RequirePermission('accessGrant:read')
  accessGrants() {
    return { ok: true };
  }

  @Get('users')
  @RequirePermission('user:read')
  users() {
    return { ok: true };
  }

  // The directory-relational read gated on user:read (asset:read would NOT deny a VIEWER).
  @Get('users/:id/assignments')
  @RequirePermission('user:read')
  userAssignments() {
    return { ok: true };
  }

  // `/users/me`: NO @RequirePermission — open to any authenticated user (incl. VIEWER).
  @Get('users/me')
  me() {
    return { ok: true };
  }

  // A write gate kept on @Roles (dual-mode) — proves the 63 @Roles sites still enforce.
  @Get('admin-only')
  @Roles('ADMIN')
  adminOnly() {
    return { ok: true };
  }

  // A @Public read — skips authz entirely.
  @Get('public')
  @Public()
  pub() {
    return { ok: true };
  }
}

// Pass-through auth guard: real auth is out of scope here; the `?role=` query impersonates the
// DB-resolved user (the role a real JwtAuthGuard would have set on request.user from the local row).
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: unknown }>();
    const role = (req.query as Record<string, string>).role;
    if (role) {
      req.user = { role };
    }
    return true;
  }
}

describe('Read-authz matrix (ADR-0046 P3)', () => {
  let app: INestApplication;

  // Prisma mock returns the SEEDED rows for the requested role (the real seed source).
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
      controllers: [MatrixController],
      providers: [
        Reflector,
        { provide: PrismaService, useValue: prisma },
        PermissionResolverService,
        // The guards in the SAME order as production: auth (fake) then authZ (real RolesGuard).
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

  const get = (path: string, role?: Role) =>
    request(app.getHttpServer()).get(
      role ? `/m/${path}?role=${role}` : `/m/${path}`,
    );

  // The reads granted to ALL three roles (behavior-preserving hygiene).
  const OPEN_TO_ALL = [
    'assets',
    'applications',
    'consumables',
    'dashboard',
    'search',
  ];
  // The reads VIEWER LOSES (ADMIN + MEMBER only).
  const VIEWER_DENIED = ['access-grants', 'users', 'users/123/assignments'];

  describe('VIEWER', () => {
    it.each(OPEN_TO_ALL)('200 on GET /m/%s', async (path) => {
      await get(path, 'VIEWER').expect(200);
    });

    it.each(VIEWER_DENIED)('403 on GET /m/%s', async (path) => {
      await get(path, 'VIEWER').expect(403);
    });

    it('200 on GET /m/users/me (self-read stays open)', async () => {
      await get('users/me', 'VIEWER').expect(200);
    });

    it('403 on the @Roles ADMIN-only write gate (dual-mode still enforces)', async () => {
      await get('admin-only', 'VIEWER').expect(403);
    });
  });

  describe('MEMBER', () => {
    it.each([...OPEN_TO_ALL, ...VIEWER_DENIED])(
      '200 on GET /m/%s (incl. the access-grant + user directory reads)',
      async (path) => {
        await get(path, 'MEMBER').expect(200);
      },
    );

    it('403 on the @Roles ADMIN-only write gate', async () => {
      await get('admin-only', 'MEMBER').expect(403);
    });
  });

  describe('ADMIN', () => {
    it.each([...OPEN_TO_ALL, ...VIEWER_DENIED])(
      '200 on GET /m/%s',
      async (path) => {
        await get(path, 'ADMIN').expect(200);
      },
    );

    it('200 on the @Roles ADMIN-only write gate', async () => {
      await get('admin-only', 'ADMIN').expect(200);
    });
  });

  describe('cross-cutting', () => {
    it('@Public read is reachable without any user', async () => {
      await get('public').expect(200);
    });

    it('a @RequirePermission read with no authenticated user is 403', async () => {
      await get('assets').expect(403);
    });
  });
});
