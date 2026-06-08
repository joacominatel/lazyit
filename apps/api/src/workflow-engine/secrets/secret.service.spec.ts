// SecretService imports PrismaService, which loads the generated Prisma client (ESM `.js` re-exports
// jest can't resolve) + the pg adapter. Stub both; the DB is faked with jest.fn()s below.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import {
  CURRENT_KEY_VERSION,
  resolveWorkflowSecretKey,
  SecretService,
  WORKFLOW_SECRET_KEY_ENV,
  type SecretEnvelope,
} from './secret.service';
import type { PrismaService } from '../../prisma/prisma.service';

// A deterministic 32-byte key (64 hex chars) for the round-trip tests.
const TEST_KEY_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

interface SecretRow {
  id: string;
  applicationId: string;
  connectionId: string | null;
  label: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** A tiny in-memory fake of the `workflowSecret` model surface SecretService uses. */
function makeFakePrisma() {
  const store = new Map<string, SecretRow>();
  let seq = 0;
  const workflowSecret = {
    create: jest.fn(
      ({
        data,
      }: {
        data: Omit<SecretRow, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
      }) => {
        const id = `sec_${++seq}`;
        const now = new Date();
        const row: SecretRow = {
          id,
          applicationId: data.applicationId,
          connectionId: data.connectionId ?? null,
          label: data.label,
          ciphertext: data.ciphertext,
          iv: data.iv,
          authTag: data.authTag,
          keyVersion: data.keyVersion,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        store.set(id, row);
        return Promise.resolve(row);
      },
    ),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: string; deletedAt: null };
        data: Partial<SecretRow>;
      }) => {
        const row = store.get(where.id);
        if (!row || row.deletedAt !== null) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return Promise.resolve({ count: 1 });
      },
    ),
    findFirst: jest.fn(
      ({ where }: { where: { id: string; deletedAt: null } }) => {
        const row = store.get(where.id);
        return Promise.resolve(row && row.deletedAt === null ? row : null);
      },
    ),
    findFirstOrThrow: jest.fn(({ where }: { where: { id: string } }) => {
      const row = store.get(where.id);
      return row
        ? Promise.resolve(row)
        : Promise.reject(new Error('not found'));
    }),
  };
  return { workflowSecret, store } as unknown as PrismaService & {
    workflowSecret: typeof workflowSecret;
    store: Map<string, SecretRow>;
  };
}

describe('SecretService — key resolution (fail-loud at boot)', () => {
  const original = process.env[WORKFLOW_SECRET_KEY_ENV];
  afterEach(() => {
    if (original === undefined) {
      delete process.env[WORKFLOW_SECRET_KEY_ENV];
    } else {
      process.env[WORKFLOW_SECRET_KEY_ENV] = original;
    }
  });

  it('throws when the key is missing', () => {
    delete process.env[WORKFLOW_SECRET_KEY_ENV];
    expect(() => resolveWorkflowSecretKey()).toThrow(/is not set/);
    expect(() => new SecretService(makeFakePrisma()).onModuleInit()).toThrow(
      /is not set/,
    );
  });

  it('throws when the key is the wrong length', () => {
    process.env[WORKFLOW_SECRET_KEY_ENV] = 'too-short';
    expect(() => resolveWorkflowSecretKey()).toThrow(/32 bytes/);
  });

  it('accepts a 64-char hex key, a base64 32-byte key, and a raw 32-char key', () => {
    process.env[WORKFLOW_SECRET_KEY_ENV] = TEST_KEY_HEX;
    expect(resolveWorkflowSecretKey()).toHaveLength(32);

    process.env[WORKFLOW_SECRET_KEY_ENV] = Buffer.alloc(32, 7).toString(
      'base64',
    );
    expect(resolveWorkflowSecretKey()).toHaveLength(32);

    process.env[WORKFLOW_SECRET_KEY_ENV] = 'A'.repeat(32);
    expect(resolveWorkflowSecretKey()).toHaveLength(32);
  });
});

describe('SecretService — crypto', () => {
  let service: SecretService;
  const original = process.env[WORKFLOW_SECRET_KEY_ENV];

  beforeAll(() => {
    process.env[WORKFLOW_SECRET_KEY_ENV] = TEST_KEY_HEX;
  });
  afterAll(() => {
    if (original === undefined) {
      delete process.env[WORKFLOW_SECRET_KEY_ENV];
    } else {
      process.env[WORKFLOW_SECRET_KEY_ENV] = original;
    }
  });
  beforeEach(() => {
    service = new SecretService(makeFakePrisma());
  });

  it('round-trips encrypt → reveal', () => {
    const plaintext = 'jira-api-token-Σ-🔐-value';
    const env = service.encrypt(plaintext);
    expect(env.keyVersion).toBe(CURRENT_KEY_VERSION);
    expect(service.reveal(env)).toBe(plaintext);
  });

  it('produces a fresh random IV per encryption (no ciphertext reuse)', () => {
    const a = service.encrypt('same');
    const b = service.encrypt('same');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(service.reveal(a)).toBe('same');
    expect(service.reveal(b)).toBe('same');
  });

  it('fails closed on a tampered ciphertext (GCM auth tag)', () => {
    const env = service.encrypt('secret');
    const tampered: SecretEnvelope = {
      ...env,
      ciphertext: flipFirstBase64Byte(env.ciphertext),
    };
    expect(() => service.reveal(tampered)).toThrow(/Failed to decrypt/);
  });

  it('fails closed on a tampered auth tag', () => {
    const env = service.encrypt('secret');
    const tampered: SecretEnvelope = {
      ...env,
      authTag: flipFirstBase64Byte(env.authTag),
    };
    expect(() => service.reveal(tampered)).toThrow(/Failed to decrypt/);
  });

  it('rejects an unknown key version', () => {
    const env = service.encrypt('secret');
    expect(() => service.reveal({ ...env, keyVersion: 99 })).toThrow(
      /unknown key version/,
    );
  });

  it('never leaks the plaintext in a decrypt error message', () => {
    const env = service.encrypt('TOP-SECRET-PLAINTEXT');
    const tampered: SecretEnvelope = {
      ...env,
      ciphertext: flipFirstBase64Byte(env.ciphertext),
    };
    try {
      service.reveal(tampered);
      throw new Error('expected reveal to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('TOP-SECRET-PLAINTEXT');
    }
  });
});

describe('SecretService — write-only CRUD (redaction)', () => {
  let service: SecretService;
  let prisma: ReturnType<typeof makeFakePrisma>;
  const original = process.env[WORKFLOW_SECRET_KEY_ENV];

  beforeAll(() => {
    process.env[WORKFLOW_SECRET_KEY_ENV] = TEST_KEY_HEX;
  });
  afterAll(() => {
    if (original === undefined) {
      delete process.env[WORKFLOW_SECRET_KEY_ENV];
    } else {
      process.env[WORKFLOW_SECRET_KEY_ENV] = original;
    }
  });
  beforeEach(() => {
    prisma = makeFakePrisma();
    service = new SecretService(prisma);
  });

  it('create returns ONLY the redacted descriptor (no cleartext / ciphertext)', async () => {
    const descriptor = await service.create({
      applicationId: 'app_1',
      label: 'Jira API token',
      value: 'super-secret-token',
    });
    expect(descriptor).toMatchObject({
      applicationId: 'app_1',
      label: 'Jira API token',
      keyVersion: CURRENT_KEY_VERSION,
      configured: true,
    });
    const asJson = JSON.stringify(descriptor);
    expect(asJson).not.toContain('super-secret-token');
    expect(Object.keys(descriptor)).not.toContain('ciphertext');
    expect(Object.keys(descriptor)).not.toContain('iv');
    expect(Object.keys(descriptor)).not.toContain('authTag');
    // The stored row holds ciphertext, never the cleartext.
    const stored = prisma.store.get(descriptor.id)!;
    expect(stored.ciphertext).not.toContain('super-secret-token');
    expect(service.reveal(stored)).toBe('super-secret-token');
  });

  it('rotate re-encrypts in place (new envelope) and returns the redacted descriptor', async () => {
    const created = await service.create({
      applicationId: 'app_1',
      label: 'token',
      value: 'old-value',
    });
    const before = prisma.store.get(created.id)!.ciphertext;
    const rotated = await service.rotate(created.id, 'new-value');
    const after = prisma.store.get(created.id)!.ciphertext;
    expect(rotated.id).toBe(created.id);
    expect(after).not.toBe(before);
    expect(service.reveal(prisma.store.get(created.id)!)).toBe('new-value');
    expect(JSON.stringify(rotated)).not.toContain('new-value');
  });

  it('softDelete stamps deletedAt and blocks a later reveal', async () => {
    const created = await service.create({
      applicationId: 'app_1',
      label: 'token',
      value: 'val',
    });
    expect(await service.revealById(created.id)).toBe('val');
    await service.softDelete(created.id);
    expect(prisma.store.get(created.id)!.deletedAt).toBeInstanceOf(Date);
    await expect(service.revealById(created.id)).rejects.toThrow(/not found/);
  });

  it('rotate / softDelete throw for a missing or already-deleted secret', async () => {
    await expect(service.rotate('nope', 'x')).rejects.toThrow(/not found/);
    await expect(service.softDelete('nope')).rejects.toThrow(/not found/);
  });
});

/** Flip the first byte of a base64 payload so the decoded bytes differ (forces a GCM auth failure). */
function flipFirstBase64Byte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0] ^= 0xff;
  return buf.toString('base64');
}
