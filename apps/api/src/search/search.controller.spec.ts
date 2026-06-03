import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';

// SearchService (the DI token) imports the ESM `meilisearch` package, which jest can't transform.
// The service is replaced by a mock below; this stub keeps the import from loading the real module.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
// The controller now imports PermissionResolverService → PrismaService → the generated Prisma client
// (ESM `.js` re-exports jest can't resolve). The resolver is mocked, so stub the client/adapter too.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

type SearchArg = {
  q: string;
  entities?: string[];
  limit: number;
};

/**
 * The `users` facet drop (ADR-0046 P3) depends on the caller's `user:read`. These tests run the
 * controller WITHOUT the global guards, so a middleware injects a fake `request.user` whose role the
 * mocked {@link PermissionResolverService} maps to a permission set. `canReadUsers` toggles whether
 * the injected user holds `user:read`, exercising both the privileged and the deprivileged path.
 */
describe('SearchController', () => {
  let app: INestApplication;
  const search = jest.fn();
  let canReadUsers = true;

  // The mock resolver: `hasAll` honours the per-test `canReadUsers` flag for `user:read`. Returns a
  // resolved Promise<boolean> to match the real signature (the controller awaits it).
  const hasAll = jest.fn((_role: string, perms: readonly string[]) =>
    Promise.resolve(
      perms.every((p) => (p === 'user:read' ? canReadUsers : true)),
    ),
  );

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [
        { provide: SearchService, useValue: { search } },
        { provide: PermissionResolverService, useValue: { hasAll } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Inject a fake authenticated user so the controller's user:read check has an actor to resolve.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: unknown }).user = { role: 'VIEWER' };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    search.mockReset();
    search.mockResolvedValue({});
    hasAll.mockClear();
    canReadUsers = true;
  });

  const lastArg = (): SearchArg =>
    (search.mock.calls as Array<[SearchArg]>)[0][0];

  it('delegates q, parsed entities and limit to the service', async () => {
    const res = await request(app.getHttpServer()).get(
      '/search?q=vpn&entities=assets,articles&limit=10',
    );
    expect(res.status).toBe(200);
    expect(lastArg()).toEqual({
      q: 'vpn',
      entities: ['assets', 'articles'],
      limit: 10,
    });
  });

  it('defaults q to "", entities to all (undefined) and limit to 20 when omitted', async () => {
    await request(app.getHttpServer()).get('/search');
    expect(lastArg()).toEqual({ q: '', entities: undefined, limit: 20 });
  });

  it('drops unknown entities and de-dupes, preserving canonical order', async () => {
    await request(app.getHttpServer()).get(
      '/search?entities=users,bogus,assets,users',
    );
    expect(lastArg().entities).toEqual(['assets', 'users']);
  });

  it('falls back to all (undefined) when no requested entity is valid', async () => {
    await request(app.getHttpServer()).get('/search?entities=bogus,nope');
    expect(lastArg().entities).toBeUndefined();
  });

  it('clamps limit above the max to 50', async () => {
    await request(app.getHttpServer()).get('/search?limit=999');
    expect(lastArg().limit).toBe(50);
  });

  it('clamps limit below the min to 1', async () => {
    await request(app.getHttpServer()).get('/search?limit=0');
    expect(lastArg().limit).toBe(1);
  });

  it('defaults limit to 20 for a non-numeric value', async () => {
    await request(app.getHttpServer()).get('/search?limit=abc');
    expect(lastArg().limit).toBe(20);
  });

  it('returns the service result object as the response body', async () => {
    search.mockResolvedValue({
      assets: { hits: [{ id: 'a1' }], total: 1 },
    });
    const res = await request(app.getHttpServer()).get(
      '/search?entities=assets',
    );
    expect(res.body).toEqual({ assets: { hits: [{ id: 'a1' }], total: 1 } });
  });

  // ── users-facet tightening (ADR-0046 P3) ──────────────────────────────────────────────────────

  it('drops the users index from "search all" when the caller lacks user:read', async () => {
    canReadUsers = false;
    await request(app.getHttpServer()).get('/search');
    // "all" minus users — materialized to the explicit four-index list (users removed).
    expect(lastArg().entities).toEqual([
      'assets',
      'articles',
      'locations',
      'applications',
    ]);
  });

  it('drops users from an explicit entity list when the caller lacks user:read', async () => {
    canReadUsers = false;
    await request(app.getHttpServer()).get('/search?entities=assets,users');
    expect(lastArg().entities).toEqual(['assets']);
  });

  it('returns an empty envelope (never re-expands to all) when a deprivileged caller asks ONLY for users', async () => {
    canReadUsers = false;
    const res = await request(app.getHttpServer()).get(
      '/search?entities=users',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    // The service is never called — there is nothing left to search.
    expect(search).not.toHaveBeenCalled();
  });

  it('keeps the users index for a caller WITH user:read (behavior-preserving)', async () => {
    canReadUsers = true;
    await request(app.getHttpServer()).get('/search?entities=assets,users');
    expect(lastArg().entities).toEqual(['assets', 'users']);
  });
});
