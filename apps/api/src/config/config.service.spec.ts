import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { ConfigService } from './config.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { SetupCsrfService } from './setup-csrf.service';
import { IDENTITY_PROVIDER } from '../auth/identity/identity-provider.interface';
import type { IdentityProvider } from '../auth/identity/identity-provider.interface';
import { LocalProvisioningService } from '../auth/local/local-provisioning.service';

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
  password: 'Abcdef1!',
};

const SETUP_INPUT_NO_PASSWORD = {
  email: SETUP_INPUT.email,
  firstName: SETUP_INPUT.firstName,
  lastName: SETUP_INPUT.lastName,
};

describe('ConfigService', () => {
  let service: ConfigService;
  let user: PrismaUserMock;
  let instanceConfig: { upsert: jest.Mock };
  let provisioning: {
    credentialFields: jest.Mock;
    generateTempPassword: jest.Mock;
  };
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
    // instance_config marker (ADR-0086 §1): setup upserts the auth-mode marker on success.
    instanceConfig = { upsert: jest.fn().mockResolvedValue(undefined) };
    const prisma = { user, instanceConfig };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };
    // Local provisioning primitive (ADR-0086 §5): hashes the local admin's password on setup.
    provisioning = {
      credentialFields: jest.fn().mockResolvedValue({
        passwordHash: '$argon2id$hash',
        passwordUpdatedAt: new Date('2026-07-03T00:00:00.000Z'),
        mustChangePassword: false,
      }),
      generateTempPassword: jest.fn().mockReturnValue('Temp-Pass-9xZ!'),
    };
    // Default posture: generic OIDC, the only OIDC flavour since ADR-0102.
    idp = {
      kind: 'generic-oidc',
      supportsManagement: false,
      resolveExternalRef: jest.fn(),
      createUser: jest.fn(),
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
        { provide: LocalProvisioningService, useValue: provisioning },
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
    it('reports not-configured, generic-oidc and no password under AUTH_MODE=oidc with IDENTITY_PROVIDER_TYPE unset', async () => {
      process.env.AUTH_MODE = 'oidc';
      user.count.mockResolvedValue(0);
      const status = await service.getStatus();
      expect(status.isConfigured).toBe(false);
      expect(status.adminCount).toBe(0);
      expect(status.integrationMode).toBe('generic-oidc');
      expect(status.requiresAdminPassword).toBe(false);
      expect(typeof status.csrfToken).toBe('string');
      expect(status.csrfToken.length).toBeGreaterThan(0);
    });

    it('reports generic-oidc for a legacy IDENTITY_PROVIDER_TYPE=zitadel (ADR-0102 §4)', async () => {
      process.env.AUTH_MODE = 'oidc';
      process.env.IDENTITY_PROVIDER_TYPE = 'zitadel';
      expect((await service.getStatus()).integrationMode).toBe('generic-oidc');
    });

    it('still emits canProvisionAccounts=false explicitly, for older web builds', async () => {
      const status = await service.getStatus();
      expect(status).toHaveProperty('canProvisionAccounts', false);
    });

    it('reports configured once an ADMIN exists', async () => {
      user.count.mockResolvedValue(2);
      const status = await service.getStatus();
      expect(status.isConfigured).toBe(true);
      expect(status.adminCount).toBe(2);
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

  // ---------- AUTH_MODE=local (ADR-0086 §5, F1c) ----------------------------

  describe('local mode', () => {
    // Put the service into local posture: the AuthModule builds the LocalIdentityProvider
    // (kind='local', supportsManagement=false) and AUTH_MODE=local drives integrationMode + the marker.
    beforeEach(() => {
      idp.kind = 'local';
      idp.supportsManagement = false;
      process.env.AUTH_MODE = 'local';
    });

    it('getStatus DECOUPLES requiresAdminPassword from supportsManagement — true in local mode, with authMode=local', async () => {
      user.count.mockResolvedValue(0);
      const status = await service.getStatus();
      // supportsManagement is false (no IdP) yet the wizard STILL must collect a password (else the first
      // ADMIN is un-loggable and the instance bricks — ADR-0086 §5).
      expect(status.requiresAdminPassword).toBe(true);
      expect(status.authMode).toBe('local');
      expect(status.integrationMode).toBe('local');
      expect(status.canProvisionAccounts).toBe(false);
    });

    it('setup REQUIRES a password in local mode and hashes it onto the first ADMIN (no IdP call)', async () => {
      user.count.mockResolvedValue(0);
      const localAdmin = makeAdminRow({ id: 'local-admin-1' });
      user.create.mockResolvedValue(localAdmin);

      const outcome = await service.setup(SETUP_INPUT, '203.0.113.7');

      // The password was hashed via the provisioning primitive (owner sets their own → no forced change).
      expect(provisioning.credentialFields).toHaveBeenCalledWith('Abcdef1!', {
        mustChangePassword: false,
      });
      // The ADMIN is created WITH the hashed credential fields (the provisioning mock returns a fixed
      // hash + date) and NO externalId — no IdP mirror at all.
      expect(user.create).toHaveBeenCalledWith({
        data: {
          email: 'admin@example.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          role: 'ADMIN',
          passwordHash: '$argon2id$hash',
          passwordUpdatedAt: new Date('2026-07-03T00:00:00.000Z'),
          mustChangePassword: false,
        },
      });
      expect(idp.createUser).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
      expect(outcome.adminId).toBe('local-admin-1');
    });

    it('setup 400s in local mode when no password is given, before any row is created', async () => {
      user.count.mockResolvedValue(0);
      await expect(
        service.setup(SETUP_INPUT_NO_PASSWORD, '203.0.113.7'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(user.create).not.toHaveBeenCalled();
      expect(provisioning.credentialFields).not.toHaveBeenCalled();
    });

    it('setup PERSISTS the local mode marker (instance_config) on success — immutability write side (§1)', async () => {
      user.count.mockResolvedValue(0);
      user.create.mockResolvedValue(makeAdminRow());
      await service.setup(SETUP_INPUT, '203.0.113.7');
      expect(instanceConfig.upsert).toHaveBeenCalledWith({
        where: { id: 'singleton' },
        create: { id: 'singleton', authMode: 'local' },
        update: { authMode: 'local' },
      });
    });
  });

  // ---------- setup ---------------------------------------------------------

  describe('setup (OIDC)', () => {
    beforeEach(() => {
      process.env.AUTH_MODE = 'oidc';
    });

    it('creates the first ADMIN without a password and without any IdP call', async () => {
      user.count.mockResolvedValue(0);

      const outcome = await service.setup(
        SETUP_INPUT_NO_PASSWORD,
        '203.0.113.7',
      );

      expect(user.create).toHaveBeenCalledWith({
        data: {
          email: 'admin@example.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          role: 'ADMIN',
        },
      });
      expect(idp.createUser).not.toHaveBeenCalled();
      expect(provisioning.credentialFields).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
      expect(search.upsert).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ id: makeAdminRow().id }),
      );
      expect(outcome.adminId).toBe(makeAdminRow().id);
    });

    it('never stores a password the wizard sent anyway', async () => {
      user.count.mockResolvedValue(0);
      await service.setup(SETUP_INPUT, '203.0.113.7');
      expect(provisioning.credentialFields).not.toHaveBeenCalled();
      const [[arg]] = user.create.mock.calls as [[{ data: object }]];
      expect(arg.data).not.toHaveProperty('passwordHash');
    });

    it('PERSISTS the oidc mode marker — immutability write side (§1)', async () => {
      user.count.mockResolvedValue(0);
      await service.setup(SETUP_INPUT_NO_PASSWORD, '203.0.113.7');
      expect(instanceConfig.upsert).toHaveBeenCalledWith({
        where: { id: 'singleton' },
        create: { id: 'singleton', authMode: 'oidc' },
        update: { authMode: 'oidc' },
      });
    });

    it('409s when an ADMIN already exists (idempotent one-time gate) and never creates a row', async () => {
      user.count.mockResolvedValue(1);
      await expect(
        service.setup(SETUP_INPUT_NO_PASSWORD, '1.2.3.4'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(user.create).not.toHaveBeenCalled();
    });

    it('audits the admin creation (op, email, ip)', async () => {
      user.count.mockResolvedValue(0);
      await service.setup(SETUP_INPUT_NO_PASSWORD, '203.0.113.7');
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'setup',
          email: 'admin@example.com',
          ip: '203.0.113.7',
        }),
        expect.any(String),
      );
    });
  });
});
