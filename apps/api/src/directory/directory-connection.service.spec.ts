import { DirectoryConnectionService } from './directory-connection.service';
import { DIRECTORY_SECRET_KEY_ENV } from './directory.constants';
import { encryptBindPassword } from './directory.crypto';
import type { PrismaService } from '../prisma/prisma.service';
import { withGlobalOmit } from '../../test/prisma/global-omit';

// Stub the generated Prisma client so ts-jest never resolves its ESM-style `.js` imports (the api
// CommonJS-Jest convention). PrismaService is mocked anyway.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

// DirectoryConnectionService (ADR-0091) under the client-level omit (ADR-0105): the bind-password
// envelope is globally omitted, so the settings read opts the ciphertext back in for `bindPasswordSet`
// and the bind-config read opts the whole envelope in to decrypt it. The mock answers through
// `withGlobalOmit`, so a missed opt-in shows up as a missing column, as it would against Postgres.

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const envelope = encryptBindPassword('bind-s3cret!');
  return {
    id: 'singleton',
    enabled: true,
    host: 'dc1.example.internal',
    port: 636,
    transport: 'ldaps',
    rejectUnauthorized: true,
    baseDN: 'DC=example,DC=internal',
    bindDN: 'CN=lazyit,OU=Svc,DC=example,DC=internal',
    searchFilter: '(objectClass=user)',
    attributeMap: null,
    offboardGraceDays: 7,
    bindPasswordCiphertext: envelope.ciphertext,
    bindPasswordIv: envelope.iv,
    bindPasswordAuthTag: envelope.authTag,
    bindPasswordKeyVersion: envelope.keyVersion,
    serviceAccountId: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncCounts: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('DirectoryConnectionService — envelope opt-ins (ADR-0105)', () => {
  const original = process.env[DIRECTORY_SECRET_KEY_ENV];
  let findFirst: jest.Mock;
  let upsert: jest.Mock;
  let service: DirectoryConnectionService;

  beforeEach(() => {
    process.env[DIRECTORY_SECRET_KEY_ENV] = KEY;
    findFirst = jest.fn();
    upsert = jest.fn();
    const prisma = { directoryConnection: { findFirst, upsert } };
    service = new DirectoryConnectionService(
      withGlobalOmit(prisma) as unknown as PrismaService,
    );
  });
  afterEach(() => {
    if (original === undefined) delete process.env[DIRECTORY_SECRET_KEY_ENV];
    else process.env[DIRECTORY_SECRET_KEY_ENV] = original;
  });

  it('getSettings reports bindPasswordSet from the stored envelope, and never returns it', async () => {
    const stored = row();
    findFirst.mockResolvedValue(stored);
    const settings = await service.getSettings();
    expect(settings.bindPasswordSet).toBe(true);
    const wire = JSON.stringify(settings);
    expect(wire).not.toContain(stored.bindPasswordCiphertext as string);
    expect(wire).not.toContain(stored.bindPasswordIv as string);
  });

  it('updateSettings reports bindPasswordSet from the upserted row', async () => {
    upsert.mockResolvedValue(row());
    findFirst.mockResolvedValue(row());
    const settings = await service.updateSettings({
      enabled: true,
      transport: 'ldaps',
      rejectUnauthorized: true,
      offboardGraceDays: 7,
    });
    expect(settings.bindPasswordSet).toBe(true);
  });

  it('resolveConfig decrypts the stored bind password in memory', async () => {
    findFirst.mockResolvedValue(row());
    const config = await service.resolveConfig(true);
    expect(config?.bindPassword).toBe('bind-s3cret!');
  });
});
