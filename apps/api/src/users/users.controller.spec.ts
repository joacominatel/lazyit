import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { ActorService } from '../common/actor.service';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// UsersService transitively imports the ESM `meilisearch` package (via SearchService); jest can't
// transform it. The service is mocked below, so this stub just stops the real module from loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * SEC-004 — `User.id` is a uuid PK. A malformed `:id` used to flow straight into Prisma and 500.
 * ParseUUIDPipe must reject it with 400 at the edge, before the service (and the DB) are touched.
 */
describe('UsersController :id uuid validation (SEC-004)', () => {
  let app: INestApplication;
  const findOne = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            findOne,
            findAll: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
        { provide: AssetAssignmentsService, useValue: { findAll: jest.fn() } },
        { provide: AccessGrantsService, useValue: { findAll: jest.fn() } },
        {
          provide: ActorService,
          useValue: { resolve: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => findOne.mockReset());

  it('rejects a malformed :id with 400 and never reaches the service', async () => {
    const res = await request(app.getHttpServer()).get('/users/not-a-uuid');
    expect(res.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('passes a well-formed uuid through to the service', async () => {
    findOne.mockResolvedValue({ id: 'ok' });
    const res = await request(app.getHttpServer()).get(
      '/users/11111111-1111-4111-8111-111111111111',
    );
    expect(res.status).toBe(200);
    expect(findOne).toHaveBeenCalledTimes(1);
  });
});
