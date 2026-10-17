import { ForbiddenException } from '@nestjs/common';
import { CreateAccessRequestSchema } from '@lazyit/shared';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AccessRequestsController } from './access-requests.controller';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

const CALLER = '22222222-2222-4222-8222-22222222abcd';
const PERSON = '11111111-1111-4111-8111-111111111111';
const APP_ID = 'capp1aaaaaaaaaaaaaaaaaaaa';
const HUMAN = { kind: 'human', user: { id: CALLER, role: 'MEMBER' } } as never;

describe('AccessRequestsController create, on behalf of another person (#1645)', () => {
  let requests: { create: jest.Mock };
  let permissions: { principalHas: jest.Mock };
  let controller: AccessRequestsController;

  beforeEach(() => {
    requests = { create: jest.fn().mockResolvedValue({ id: 'req' }) };
    permissions = { principalHas: jest.fn() };
    controller = new AccessRequestsController(
      requests as never,
      {} as never,
      permissions as never,
    );
  });

  it('lets an accessGrant:grant holder file for someone else', async () => {
    permissions.principalHas.mockResolvedValue(true);
    const dto = { applicationId: APP_ID, requesterId: PERSON };

    await controller.create(dto, HUMAN);

    expect(permissions.principalHas).toHaveBeenCalledWith(
      HUMAN,
      'accessGrant:grant',
    );
    expect(requests.create).toHaveBeenCalledWith(CALLER, dto);
  });

  it('refuses a caller without accessGrant:grant with 403 ACCESS_REQUEST_ON_BEHALF_FORBIDDEN', async () => {
    permissions.principalHas.mockResolvedValue(false);

    const err: unknown = await controller
      .create({ applicationId: APP_ID, requesterId: PERSON }, HUMAN)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'ACCESS_REQUEST_ON_BEHALF_FORBIDDEN',
    });
    expect(requests.create).not.toHaveBeenCalled();
  });

  it.each([
    ['omits requesterId', { applicationId: APP_ID }],
    ['names themselves', { applicationId: APP_ID, requesterId: CALLER }],
  ])(
    'needs no extra permission when the caller %s',
    async (_, dto: { applicationId: string; requesterId?: string }) => {
      await controller.create(dto, HUMAN);

      expect(permissions.principalHas).not.toHaveBeenCalled();
      expect(requests.create).toHaveBeenCalledWith(CALLER, dto);
    },
  );

  it('treats the caller own id in uppercase as a self-request, with no permission lookup', async () => {
    const dto = CreateAccessRequestSchema.parse({
      applicationId: APP_ID,
      requesterId: CALLER.toUpperCase(),
    });

    await controller.create(dto, HUMAN);

    expect(permissions.principalHas).not.toHaveBeenCalled();
    expect(requests.create).toHaveBeenCalledWith(CALLER, {
      applicationId: APP_ID,
      requesterId: CALLER,
    });
  });

  it('keeps refusing service principals on the route', () => {
    const handler = Reflect.get(
      AccessRequestsController.prototype,
      'create',
    ) as object;
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
    expect(guards).toContain(ServicePrincipalForbiddenGuard);
  });
});
