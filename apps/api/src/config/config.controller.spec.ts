import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

// The controller imports ConfigService at runtime, which loads the generated Prisma client and the
// ESM `meilisearch` package (via SearchService) — both unparseable by ts-jest. The service is never
// instantiated here (a hand-built mock is passed to the controller), so these stubs only stop the
// real modules from loading.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { ConfigController } from './config.controller';
import type { ConfigService, SetupOutcome } from './config.service';
import type { SetupCsrfService } from './setup-csrf.service';

/** Minimal Express request stub carrying an IP for the audit line. */
function reqWithIp(ip: string): Request {
  return {
    ip,
    headers: {} as Record<string, string | string[] | undefined>,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

const SETUP_DTO = {
  email: 'admin@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

describe('ConfigController', () => {
  let controller: ConfigController;
  let config: jest.Mocked<
    Pick<ConfigService, 'getStatus' | 'issueCsrfToken' | 'setup'>
  >;
  let csrf: jest.Mocked<Pick<SetupCsrfService, 'verify'>>;

  const OUTCOME: SetupOutcome = {
    adminId: '11111111-1111-1111-1111-111111111111',
    email: 'admin@example.com',
    mirrored: true,
    setupCompletedAt: new Date('2026-06-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    config = {
      getStatus: jest.fn().mockResolvedValue({
        isConfigured: false,
        adminCount: 0,
        integrationMode: 'zitadel',
        devMode: true,
        csrfToken: 'tok',
      }),
      issueCsrfToken: jest.fn().mockReturnValue('fresh-token'),
      setup: jest.fn().mockResolvedValue(OUTCOME),
    };
    csrf = { verify: jest.fn() };
    controller = new ConfigController(
      config as unknown as ConfigService,
      csrf as unknown as SetupCsrfService,
    );
  });

  it('GET /config/status returns the status payload', async () => {
    const status = await controller.status();
    expect(status.isConfigured).toBe(false);
    expect(status.integrationMode).toBe('zitadel');
  });

  it('GET /config/csrf issues a fresh token', () => {
    expect(controller.csrfToken()).toEqual({ csrfToken: 'fresh-token' });
  });

  it('POST /config/setup rejects a missing/invalid CSRF token with 403 and never calls setup', async () => {
    csrf.verify.mockReturnValue(false);
    await expect(
      controller.setup(SETUP_DTO, undefined, reqWithIp('1.2.3.4')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(config.setup).not.toHaveBeenCalled();
  });

  it('POST /config/setup with a valid CSRF token creates the admin and shapes the result', async () => {
    csrf.verify.mockReturnValue(true);
    const result = await controller.setup(
      SETUP_DTO,
      'valid-token',
      reqWithIp('203.0.113.7'),
    );
    expect(csrf.verify).toHaveBeenCalledWith('valid-token');
    expect(config.setup).toHaveBeenCalledWith(SETUP_DTO, '203.0.113.7');
    expect(result).toEqual({
      success: true,
      adminId: OUTCOME.adminId,
      email: OUTCOME.email,
      mirrored: true,
      setupCompletedAt: '2026-06-01T00:00:00.000Z',
    });
  });
});
