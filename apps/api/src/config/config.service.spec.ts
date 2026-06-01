import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { ConfigService } from './config.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { SetupCsrfService } from './setup-csrf.service';
import { IDENTITY_PROVIDER } from '../auth/identity/identity-provider.interface';
import type { IdentityProvider } from '../auth/identity/identity-provider.interface';

// Mock the generated Prisma client so the test never loads the real one (no DB). ConfigService uses
// Role as a VALUE (Role.ADMIN), so the mock must expose the enum.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
// ConfigService transitively imports the ESM `meilisearch` package (via SearchService); jest can't
// transform it. SearchService is replaced by a mock below; this stub stops the real module loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

type PrismaUserMock = {
  count: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

type IdpMock = {
  kind: string;
  supportsManagement: boolean;
  resolveExternalRef: jest.Mock;
  createUser: jest.Mock;
  deactivateUser: jest.Mock;
  grantRole: jest.Mock;
  revokeRole: jest.Mock;
};

type SearchMock = { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };
type LoggerMock = { info: jest.Mock; warn: jest.Mock; error: jest.Mock };

const NOW = new Date('2026-06-01T00:00:00.000Z');

function makeAdminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'admin@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: 'ADMIN',
    externalId: null,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

const SETUP_INPUT = {
  email: 'admin@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

describe('ConfigService', () => {
  let service: ConfigService;
  let user: PrismaUserMock;
  let search: SearchMock;
  let idp: IdpMock;
  let logger: LoggerMock;

  beforeEach(async () => {
    delete process.env.IDENTITY_PROVIDER_TYPE;
    delete process.env.AUTH_MODE;
    delete process.env.NODE_ENV;

    user = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(makeAdminRow()),
      update: jest.fn(),
    };
    const prisma = { user };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };
    idp = {
      kind: 'zitadel',
      supportsManagement: true,
      resolveExternalRef: jest.fn(),
      // Default: a successful mirror returning a distinct external id.
      createUser: jest
        .fn()
        .mockResolvedValue({ externalId: 'zitadel-user-99' }),
      deactivateUser: jest.fn(),
      grantRole: jest.fn(),
      revokeRole: jest.fn(),
    };
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConfigService,
        SetupCsrfService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: search },
        { provide: IDENTITY_PROVIDER, useValue: idp as IdentityProvider },
        { provide: getLoggerToken(ConfigService.name), useValue: logger },
      ],
    })
      .overrideProvider(PinoLogger)
      .useValue(logger)
      .compile();

    service = moduleRef.get(ConfigService);
  });

  // ---------- getStatus -----------------------------------------------------

  describe('getStatus', () => {
    it('reports not-configured with a CSRF token when no ADMIN exists', async () => {
      user.count.mockResolvedValue(0);
      const status = await service.getStatus();
      expect(status.isConfigured).toBe(false);
      expect(status.adminCount).toBe(0);
      expect(status.integrationMode).toBe('zitadel');
      expect(typeof status.csrfToken).toBe('string');
      expect(status.csrfToken.length).toBeGreaterThan(0);
    });

    it('reports configured once an ADMIN exists', async () => {
      user.count.mockResolvedValue(2);
      const status = await service.getStatus();
      expect(status.isConfigured).toBe(true);
      expect(status.adminCount).toBe(2);
    });

    it('derives integrationMode=generic-oidc from IDENTITY_PROVIDER_TYPE', async () => {
      process.env.IDENTITY_PROVIDER_TYPE = 'generic-oidc';
      const status = await service.getStatus();
      expect(status.integrationMode).toBe('generic-oidc');
    });

    it('devMode is true under shim auth and false under NODE_ENV=production', async () => {
      process.env.AUTH_MODE = 'shim';
      process.env.NODE_ENV = 'production';
      expect((await service.getStatus()).devMode).toBe(true); // shim wins

      process.env.AUTH_MODE = 'oidc';
      process.env.NODE_ENV = 'production';
      expect((await service.getStatus()).devMode).toBe(false);

      process.env.NODE_ENV = 'development';
      expect((await service.getStatus()).devMode).toBe(true);
    });
  });

  // ---------- setup ---------------------------------------------------------

  describe('setup', () => {
    it('creates the first ADMIN (role locked to ADMIN) and PERSISTS the externalId link from the IdP mirror', async () => {
      user.count.mockResolvedValue(0); // no ADMIN yet
      const linkedRow = makeAdminRow({ externalId: 'zitadel-user-99' });
      user.update.mockResolvedValue(linkedRow);

      const outcome = await service.setup(SETUP_INPUT, '203.0.113.7');

      expect(user.create).toHaveBeenCalledWith({
        data: {
          email: 'admin@example.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          role: 'ADMIN',
        },
      });
      expect(idp.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'ADMIN', email: 'admin@example.com' }),
      );
      // The mirror landed → the local ADMIN row is UPDATED to LINK the IdP-returned externalId.
      // This is the load-bearing assertion: setup must write the externalId back onto the first
      // ADMIN, not merely call createUser (ADR-0043 §5b — the bootstrapped ADMIN is a linked mirror,
      // not an orphan local row). Asserting the exact update payload proves the link is persisted.
      expect(user.update).toHaveBeenCalledTimes(1);
      expect(user.update).toHaveBeenCalledWith({
        where: { id: makeAdminRow().id },
        data: { externalId: 'zitadel-user-99' },
      });
      // The mirror-success path syncs the search index from the LINKED row and reports mirrored=true
      // with the linked row's id — confirming setup carries the linked (externalId-bearing) row
      // forward rather than dropping the link after createUser.
      expect(search.upsert).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ id: linkedRow.id }),
      );
      expect(outcome.mirrored).toBe(true);
      expect(outcome.adminId).toBe(linkedRow.id);
    });

    it('409s when an ADMIN already exists (idempotent one-time gate) and never creates a row', async () => {
      user.count.mockResolvedValue(1);
      await expect(
        service.setup(SETUP_INPUT, '1.2.3.4'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(user.create).not.toHaveBeenCalled();
    });

    it('audits the admin creation (op, email, ip)', async () => {
      user.count.mockResolvedValue(0);
      user.update.mockResolvedValue(
        makeAdminRow({ externalId: 'zitadel-user-99' }),
      );
      await service.setup(SETUP_INPUT, '203.0.113.7');
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'setup',
          email: 'admin@example.com',
          ip: '203.0.113.7',
        }),
        expect.any(String),
      );
    });

    it('degrades to a local-only ADMIN (mirrored=false, not a hard block) when the IdP mirror fails', async () => {
      user.count.mockResolvedValue(0);
      idp.createUser.mockRejectedValue(
        new Error('Zitadel management not configured'),
      );

      const outcome = await service.setup(SETUP_INPUT, '203.0.113.7');

      // The local ADMIN was kept (no compensation/delete) and reported local-only.
      expect(outcome.mirrored).toBe(false);
      expect(outcome.adminId).toBe(makeAdminRow().id);
      // A warn was logged; no error/throw.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'setup', email: 'admin@example.com' }),
        expect.stringContaining('IdP mirror failed'),
      );
      expect(search.upsert).toHaveBeenCalled();
    });

    it('creates a local-only ADMIN without an IdP call under BYOI (generic-oidc, no management)', async () => {
      user.count.mockResolvedValue(0);
      idp.supportsManagement = false;

      const outcome = await service.setup(SETUP_INPUT, '203.0.113.7');

      expect(idp.createUser).not.toHaveBeenCalled();
      expect(outcome.mirrored).toBe(false);
      expect(outcome.adminId).toBe(makeAdminRow().id);
    });
  });
});
