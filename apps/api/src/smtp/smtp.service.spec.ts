import { SmtpService } from './smtp.service';
import { SMTP_SECRET_KEY_ENV } from './email.constants';
import type { PrismaService } from '../prisma/prisma.service';

// Stub the generated Prisma client so ts-jest never resolves its ESM-style `.js` imports (the api
// CommonJS-Jest convention — mirrors asset-tag-scheme.service.spec). PrismaService is mocked anyway.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

// SmtpService (ADR-0079) — the singleton config store. Core invariants: an explicit disabled default
// (never a 404), the WRITE-ONLY password (never echoed; omitted keeps the stored envelope), and the
// redacted wire shape.

const TEST_KEY =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function makePrisma() {
  const smtpSettings = {
    findFirst: jest.fn(),
    upsert: jest.fn(),
  };
  return { smtpSettings } as unknown as PrismaService & {
    smtpSettings: { findFirst: jest.Mock; upsert: jest.Mock };
  };
}

/** Typed accessor for the upsert() call args (avoids unsafe `any` member access on mock.calls). */
function upsertArg(prisma: { smtpSettings: { upsert: jest.Mock } }): {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
} {
  const args = prisma.smtpSettings.upsert.mock.calls[0] as unknown[];
  return args[0] as {
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  };
}

describe('SmtpService', () => {
  const original = process.env[SMTP_SECRET_KEY_ENV];
  let prisma: ReturnType<typeof makePrisma>;
  let service: SmtpService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new SmtpService(prisma);
  });
  afterEach(() => {
    if (original === undefined) delete process.env[SMTP_SECRET_KEY_ENV];
    else process.env[SMTP_SECRET_KEY_ENV] = original;
  });

  it('getSettings returns an explicit DISABLED default when no row exists (never a 404)', async () => {
    prisma.smtpSettings.findFirst.mockResolvedValue(null);
    const settings = await service.getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.host).toBeNull();
    expect(settings.security).toBe('starttls');
    expect(settings.passwordSet).toBe(false);
    expect(settings.rejectUnauthorized).toBe(true);
  });

  it('getSettings NEVER returns the password — only passwordSet true when an envelope is stored', async () => {
    prisma.smtpSettings.findFirst.mockResolvedValue({
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      username: 'mailer',
      passwordCiphertext: 'ZW5j', // present => passwordSet true
      passwordIv: 'aXY=',
      passwordAuthTag: 'dGFn',
      passwordKeyVersion: 1,
      fromAddress: 'it@example.com',
      fromName: 'lazyit',
      rejectUnauthorized: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const settings = await service.getSettings();
    expect(settings.passwordSet).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('ZW5j'); // no ciphertext on the wire
    expect('password' in settings).toBe(false);
  });

  it('updateSettings with a non-empty password stores an ENCRYPTED envelope (never the cleartext)', async () => {
    process.env[SMTP_SECRET_KEY_ENV] = TEST_KEY;
    prisma.smtpSettings.upsert.mockResolvedValue({
      enabled: true,
      host: 'smtp.example.com',
      port: 465,
      security: 'tls',
      username: 'mailer',
      passwordCiphertext: 'x',
      passwordIv: 'y',
      passwordAuthTag: 'z',
      passwordKeyVersion: 1,
      fromAddress: 'it@example.com',
      fromName: null,
      rejectUnauthorized: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.updateSettings({
      enabled: true,
      host: 'smtp.example.com',
      port: 465,
      security: 'tls',
      username: 'mailer',
      password: 'plaintext-pw',
      fromAddress: 'it@example.com',
      rejectUnauthorized: false,
    });
    const createArg = upsertArg(prisma).create;
    // The envelope is persisted, and it is NOT the cleartext.
    expect(createArg.passwordCiphertext).toBeDefined();
    expect(JSON.stringify(createArg)).not.toContain('plaintext-pw');
    expect(createArg.passwordKeyVersion).toBe(1);
  });

  it('updateSettings WITHOUT a password does NOT touch the envelope columns (keeps the stored value)', async () => {
    prisma.smtpSettings.upsert.mockResolvedValue({
      enabled: false,
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      username: null,
      passwordCiphertext: null,
      passwordIv: null,
      passwordAuthTag: null,
      passwordKeyVersion: null,
      fromAddress: null,
      fromName: null,
      rejectUnauthorized: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.updateSettings({
      enabled: false,
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      rejectUnauthorized: true,
    });
    const updateArg = upsertArg(prisma).update;
    expect('passwordCiphertext' in updateArg).toBe(false);
    expect('passwordIv' in updateArg).toBe(false);
  });

  it('updateSettings with a password but NO key throws (mapped to 409 at the controller)', async () => {
    delete process.env[SMTP_SECRET_KEY_ENV];
    await expect(
      service.updateSettings({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        security: 'starttls',
        password: 'x',
        fromAddress: 'it@example.com',
        rejectUnauthorized: true,
      }),
    ).rejects.toThrow(/SMTP_SECRET_KEY/);
  });

  it('sendTest returns a clean failure when config is incomplete (no crash)', async () => {
    prisma.smtpSettings.findFirst.mockResolvedValue(null);
    const result = await service.sendTest('someone@example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not fully configured/i);
  });
});
