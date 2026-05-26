import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

// SearchService (the DI token) imports the ESM `meilisearch` package, which jest can't transform.
// The service is replaced by a mock below; this stub keeps the import from loading the real module.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

type SearchArg = {
  q: string;
  entities?: string[];
  limit: number;
};

describe('SearchController', () => {
  let app: INestApplication;
  const search = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [{ provide: SearchService, useValue: { search } }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    search.mockReset();
    search.mockResolvedValue({});
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
});
