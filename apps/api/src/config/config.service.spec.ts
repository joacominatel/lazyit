import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
  delete: jest.Mock;
};

type IdpMock = {
  kind: string;
  supportsManagement: boolean;
  resolveExternalRef: jest.Mock;
  createUser: jest.Mock;
  deactivateUser: jest.Mock;
  grantRole: jest.Mock;
  revokeRole: jest.Mock;
  // Issue #149: the IdentityProvider gained updateUser + requestPasswordReset. ConfigService never
  // calls them, but the mock must satisfy the interface shape for the `as IdentityProvider` cast.
  updateUser: jest.Mock;
  requestPasswordReset: jest.Mock;
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
  // Bundled-Zitadel posture is the default mock (supportsManagement=true), so the wizard supplies the
  // initial password (issue #335). The BYOI tests below drop it explicitly.
  password: 'Abcdef1!',
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
      delete: jest.fn().mockResolvedValue(makeAdminRow()),
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
      updateUser: jest.fn(),
      requestPasswordReset: jest.fn(),
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

    it('requiresAdminPassword mirrors idp.supportsManagement (issue #335)', async () => {
      // Bundled Zitadel (management supported) → the wizard must collect an initial password.
      idp.supportsManagement = true;
      expect((await service.getStatus()).requiresAdminPassword).toBe(true);

      // BYOI / generic-OIDC (no management) → the operator's IdP owns the credential, no password.
      idp.supportsManagement = false;
      expect((await service.getStatus()).requiresAdminPassword).toBe(false);
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
      // The wizard-chosen password is threaded through to the IdP so Zitadel creates the user active
      // (changeRequired:false) — issue #335.
      expect(idp.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'ADMIN',
          email: 'admin@example.com',
          password: 'Abcdef1!',
        }),
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

    it('400s when management is supported but no password is given (before creating any row) — issue #335', async () => {
      user.count.mockResolvedValue(0);
      idp.supportsManagement = true;
      const { password: _password, ...noPassword } = SETUP_INPUT;

      await expect(
        service.setup(noPassword, '203.0.113.7'),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The 400 fires BEFORE the DB write and BEFORE any IdP call.
      expect(user.create).not.toHaveBeenCalled();
      expect(idp.createUser).not.toHaveBeenCalled();
    });

    it('compensates (deletes the local row) + 503s when the IdP mirror fails — NO local-only ADMIN (issue #335)', async () => {
      user.count.mockResolvedValue(0);
      idp.createUser.mockRejectedValue(
        new Error('Zitadel management not configured'),
      );

      await expect(
        service.setup(SETUP_INPUT, '203.0.113.7'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // The just-created local ADMIN was rolled back (hard delete) so nothing is left behind — there
      // is no loggable local-only ADMIN on the bundled path.
      expect(user.delete).toHaveBeenCalledWith({
        where: { id: makeAdminRow().id },
      });
      // No success-path search sync ran for the (now-deleted) admin.
      expect(search.upsert).not.toHaveBeenCalled();
    });

    it('creates a local-only ADMIN without an IdP call (or a password) under BYOI (generic-oidc, no management)', async () => {
      user.count.mockResolvedValue(0);
      idp.supportsManagement = false;
      // BYOI sends no password — the operator's own IdP owns the credential.
      const { password: _password, ...noPassword } = SETUP_INPUT;

      const outcome = await service.setup(noPassword, '203.0.113.7');

      expect(idp.createUser).not.toHaveBeenCalled();
      expect(outcome.mirrored).toBe(false);
      expect(outcome.adminId).toBe(makeAdminRow().id);
    });
  });
});
