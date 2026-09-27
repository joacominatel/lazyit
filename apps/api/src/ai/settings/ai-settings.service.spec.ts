import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AI_SETTINGS_DEFAULTS,
  AiSettingsSchema,
  type AiConnectionTestResult,
  type UpdateAiSettings,
} from '@lazyit/shared';

// Stub the generated Prisma client (the api CommonJS-Jest convention). `DbNull` is a sentinel here.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { DbNull: 'DbNull' },
}));

import {
  EnvelopeCipher,
  EnvelopeKeyMissingError,
} from '../../common/crypto/envelope-cipher';
import type { PrismaService } from '../../prisma/prisma.service';
import { withProviderOverride } from './ai-provider-override';
import {
  AI_CONFIG_AUDIT_ACTIONS,
  AI_PROVIDER_KEY_PURPOSE,
} from './ai-settings.constants';
import {
  AiSettingsService,
  diffSettings,
  redactUrl,
} from './ai-settings.service';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const OTHER_KEY =
  'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
const PROVIDER_KEY = 'sk-ant-api03-SECRET-VALUE-1234';

const PASS: AiConnectionTestResult = {
  ok: true,
  checks: { auth: true, model: true, toolCalling: true },
  latencyMs: 12,
  error: null,
};
const FAIL: AiConnectionTestResult = {
  ok: false,
  checks: { auth: false, model: null, toolCalling: null },
  latencyMs: 5,
  error: {
    code: 'PROVIDER_AUTH',
    message: 'The provider rejected the credentials.',
  },
};

type Row = Record<string, unknown>;

/** A full `ai_settings` row with the column defaults. */
function makeRow(overrides: Row = {}): Row {
  return {
    id: 'singleton',
    enabled: false,
    provider: null,
    model: null,
    baseUrl: null,
    apiKeyCiphertext: null,
    apiKeyIv: null,
    apiKeyAuthTag: null,
    apiKeyKeyVersion: null,
    allowPrivateNetwork: false,
    effort: null,
    providerOptions: null,
    instructions: null,
    maxStepsPerRun: 20,
    maxOutputTokens: 16000,
    contextTokenLimit: 150000,
    dailyTokenLimitPerPrincipal: 2000000,
    retentionDays: 90,
    approvalTtlMinutes: 30,
    mcpEnabled: false,
    mcpClientAllowlistAdded: [],
    mcpClientAllowlistRemovedDefaults: [],
    mcpAllowAnyHttpsClient: false,
    webSearchEnabled: false,
    webSearchMaxUses: 5,
    disclosureAcknowledgedAt: null,
    disclosureAcknowledgedById: null,
    verifiedAt: null,
    updatedById: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

/** The envelope columns of `plaintext` encrypted under `key`. */
function keyColumns(plaintext = PROVIDER_KEY, key = KEY): Row {
  const envelope = new EnvelopeCipher('K', AI_PROVIDER_KEY_PURPOSE, {
    K: key,
  }).encrypt(plaintext);
  return {
    apiKeyCiphertext: envelope.ciphertext,
    apiKeyIv: envelope.iv,
    apiKeyAuthTag: envelope.authTag,
    apiKeyKeyVersion: envelope.keyVersion,
  };
}

/** A saved, enabled, verified Anthropic configuration with a stored key. */
function enabledRow(overrides: Row = {}): Row {
  return makeRow({
    enabled: true,
    provider: 'anthropic',
    model: 'claude-opus-5',
    ...keyColumns(),
    disclosureAcknowledgedAt: new Date('2026-09-02T00:00:00Z'),
    verifiedAt: new Date('2026-09-02T00:00:00Z'),
    ...overrides,
  });
}

/** A PUT body equal to the defaults, with overrides. */
function body(overrides: Partial<UpdateAiSettings> = {}): UpdateAiSettings {
  return {
    enabled: false,
    provider: null,
    model: null,
    baseUrl: null,
    allowPrivateNetwork: false,
    effort: null,
    providerOptions: null,
    instructions: null,
    maxStepsPerRun: 20,
    maxOutputTokens: 16000,
    contextTokenLimit: 150000,
    dailyTokenLimitPerPrincipal: 2000000,
    retentionDays: 90,
    approvalTtlMinutes: 30,
    mcpEnabled: false,
    mcpClientAllowlistAdded: [],
    mcpClientAllowlistRemovedDefaults: [],
    mcpAllowAnyHttpsClient: false,
    ...overrides,
  };
}

/** The PUT body that re-saves `enabledRow()` unchanged. */
function enabledBody(overrides: Partial<UpdateAiSettings> = {}) {
  return body({
    enabled: true,
    provider: 'anthropic',
    model: 'claude-opus-5',
    ...overrides,
  });
}

function setup(
  opts: {
    row?: Row | null;
    key?: string | undefined;
    /** Runs inside the write transaction, before the write — a concurrent save landing meanwhile. */
    beforeWrite?: (stored: Row | null) => Row | null;
  } = {},
) {
  const env: NodeJS.ProcessEnv = {
    AI_SECRET_KEY: 'key' in opts ? opts.key : KEY,
  };
  let row: Row | null = opts.row ?? null;
  let writes = 0;
  let lastWrite: Row | undefined;
  /** Apply a write the way Postgres + Prisma would: merge, and bump `updatedAt`. */
  const apply = (data: Row): Row => {
    lastWrite = data;
    writes += 1;
    row = makeRow({
      ...(row ?? {}),
      ...data,
      providerOptions:
        data.providerOptions === 'DbNull' ? null : data.providerOptions,
      updatedAt: new Date(Date.UTC(2026, 8, 24, 0, 0, writes)),
    });
    return row;
  };
  const aiSettings = {
    findUnique: jest.fn(() => Promise.resolve(row)),
    findUniqueOrThrow: jest.fn(() => Promise.resolve(row)),
    // The conditional write: only when the row is still the version the caller read.
    updateMany: jest.fn((args: { where: { updatedAt: Date }; data: Row }) => {
      const current = row?.updatedAt as Date | undefined;
      if (!current || current.getTime() !== args.where.updatedAt.getTime()) {
        return Promise.resolve({ count: 0 });
      }
      apply(args.data);
      return Promise.resolve({ count: 1 });
    }),
    create: jest.fn((args: { data: Row }) => {
      if (row) {
        return Promise.reject(
          Object.assign(new Error('unique'), { code: 'P2002' }),
        );
      }
      return Promise.resolve(apply(args.data));
    }),
  };
  const aiConfigAuditLog = {
    create: jest.fn((args: unknown) => Promise.resolve(args)),
  };
  const tx = { aiSettings, aiConfigAuditLog };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => {
      if (opts.beforeWrite) row = opts.beforeWrite(row);
      return fn(tx);
    }),
  };
  const tester = { test: jest.fn(() => Promise.resolve(PASS)) };
  const cipher = new EnvelopeCipher(
    'AI_SECRET_KEY',
    AI_PROVIDER_KEY_PURPOSE,
    env,
  );
  const service = new AiSettingsService(
    prisma as unknown as PrismaService,
    cipher,
    tester as never,
  );
  return {
    service,
    prisma,
    tester,
    env,
    current: () => row,
    writtenData: (): Row => {
      if (!lastWrite) throw new Error('nothing was written');
      return lastWrite;
    },
    audits: (): Array<{
      action: string;
      actorId: string | null;
      detail: unknown;
    }> =>
      aiConfigAuditLog.create.mock.calls.map(
        (call) => (call as unknown as [{ data: never }])[0].data,
      ),
  };
}

/** Runs `fn` and returns the thrown error's response body (for 409/422 assertions). */
async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    return err as Error & { getResponse?: () => unknown };
  }
  throw new Error('expected a refusal');
}

/**
 * Asserts a refusal's class AND its stable machine `code` (provider-and-runtime.md §9.1), plus any other
 * body fields given — the web matches the code, never the sentence.
 */
async function expectRefusal(
  promise: Promise<unknown>,
  type: new (...args: never[]) => Error,
  code: string,
  extra: Record<string, unknown> = {},
) {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e as Error & { getResponse: () => unknown },
  );
  expect(err).toBeInstanceOf(type);
  expect(err.getResponse()).toMatchObject({
    code,
    message: expect.any(String) as unknown,
    ...extra,
  });
}

const originalAuthMode = process.env.AUTH_MODE;
afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = originalAuthMode;
});

describe('AiSettingsService — read', () => {
  it('an absent row reads as the disabled defaults and creates nothing', async () => {
    const { service, prisma } = setup();
    const settings = await service.getSettings();
    expect(AiSettingsSchema.parse(settings)).toEqual(settings);
    expect(settings).toMatchObject({
      ...AI_SETTINGS_DEFAULTS,
      provider: null,
      apiKeySet: false,
      keyConfigured: true,
      updatedAt: null,
    });
    expect(prisma.aiSettings.create).not.toHaveBeenCalled();
    expect(prisma.aiSettings.updateMany).not.toHaveBeenCalled();
  });

  it('keyConfigured reflects AI_SECRET_KEY', async () => {
    const { service } = setup({ key: undefined });
    expect((await service.getSettings()).keyConfigured).toBe(false);
  });

  it('never returns the key or its envelope — only apiKeySet', async () => {
    const { service } = setup({ row: enabledRow() });
    const settings = await service.getSettings();
    expect(settings.apiKeySet).toBe(true);
    const wire = JSON.stringify(settings);
    expect(wire).not.toContain(PROVIDER_KEY);
    expect(wire).not.toMatch(/apiKeyCiphertext|apiKeyIv|apiKeyAuthTag/);
    expect(Object.keys(settings)).not.toContain('apiKey');
  });

  it('is read-tolerant of values a newer build wrote', async () => {
    const { service } = setup({
      row: makeRow({
        provider: 'mistral',
        effort: 'extreme',
        providerOptions: { topK: 3 },
        mcpClientAllowlistAdded: [
          {
            id: 'ok',
            label: 'Ok',
            match: { kind: 'cimd_url', url: 'https://a.example/c.json' },
          },
          { id: 'future', label: 'F', match: { kind: 'dns_sd', name: 'x' } },
        ],
      }),
    });
    const settings = await service.getSettings();
    expect(settings.provider).toBeNull();
    expect(settings.effort).toBeNull();
    expect(settings.providerOptions).toBeNull();
    expect(settings.mcpClientAllowlistAdded.map((e) => e.id)).toEqual(['ok']);
    expect(() => AiSettingsSchema.parse(settings)).not.toThrow();
  });
});

describe('AiSettingsService — resolveProviderConfig (the reader port)', () => {
  it('decrypts the key for an enabled, configured row', async () => {
    const { service } = setup({ row: enabledRow() });
    await expect(service.resolveProviderConfig()).resolves.toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKey: PROVIDER_KEY,
    });
  });

  it.each([
    ['no row', null],
    ['disabled', enabledRow({ enabled: false })],
    ['an unknown provider', enabledRow({ provider: 'mistral' })],
    ['no model', enabledRow({ model: null })],
  ])('is null with %s', async (_label, row) => {
    const { service } = setup({ row });
    await expect(service.resolveProviderConfig()).resolves.toBeNull();
  });

  it('is null when the key cannot be decrypted (AI_SECRET_KEY changed or removed)', async () => {
    for (const key of [OTHER_KEY, undefined]) {
      const { service } = setup({ row: enabledRow(), key });
      await expect(service.resolveProviderConfig()).resolves.toBeNull();
    }
  });

  it('is null in shim mode', async () => {
    process.env.AUTH_MODE = 'shim';
    const { service } = setup({ row: enabledRow() });
    await expect(service.resolveProviderConfig()).resolves.toBeNull();
  });

  it('answers a connection-test override only inside its async context', async () => {
    const { service } = setup({ row: null });
    const draft = {
      provider: 'openai' as const,
      model: 'gpt-6-sol',
      baseUrl: null,
      apiKey: 'draft-key',
      allowPrivateNetwork: false,
      effort: null,
      providerOptions: null,
    };
    await expect(
      withProviderOverride(draft, () => service.resolveProviderConfig()),
    ).resolves.toEqual(draft);
    await expect(service.resolveProviderConfig()).resolves.toBeNull();
  });
});

describe('AiSettingsService — the write-only key', () => {
  it('encrypts a new key and never stores or returns the plaintext', async () => {
    const { service, writtenData, current } = setup();
    const saved = await service.updateSettings(
      body({
        provider: 'anthropic',
        model: 'claude-opus-5',
        apiKey: PROVIDER_KEY,
      }),
      'admin-1',
    );
    expect(saved.apiKeySet).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify(writtenData())).not.toContain(PROVIDER_KEY);
    expect(current()?.apiKeyCiphertext).toEqual(expect.any(String));
  });

  it('refuses a key write without AI_SECRET_KEY and persists nothing', async () => {
    const { service, prisma } = setup({ key: undefined });
    await expect(
      service.updateSettings(
        body({ provider: 'anthropic', apiKey: PROVIDER_KEY }),
        'a',
      ),
    ).rejects.toBeInstanceOf(EnvelopeKeyMissingError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the stored key when the key is omitted and the destination is unchanged', async () => {
    const { service, writtenData } = setup({ row: enabledRow() });
    const saved = await service.updateSettings(
      enabledBody({ model: 'claude-sonnet-5' }),
      'a',
    );
    expect(writtenData()).not.toHaveProperty('apiKeyCiphertext');
    expect(saved.apiKeySet).toBe(true);
  });

  it('clears the stored key on null', async () => {
    const { service, writtenData } = setup({ row: enabledRow() });
    const saved = await service.updateSettings(
      body({ provider: 'anthropic', model: 'claude-opus-5', apiKey: null }),
      'a',
    );
    expect(writtenData()).toMatchObject({
      apiKeyCiphertext: null,
      apiKeyIv: null,
    });
    expect(saved.apiKeySet).toBe(false);
  });

  it('clears the stored key when the provider changes (destination binding)', async () => {
    const { service, writtenData } = setup({ row: enabledRow() });
    const saved = await service.updateSettings(
      body({ provider: 'openai', model: 'gpt-6-sol' }),
      'a',
    );
    expect(writtenData()).toMatchObject({
      apiKeyCiphertext: null,
      apiKeyIv: null,
      apiKeyAuthTag: null,
      apiKeyKeyVersion: null,
    });
    expect(saved.apiKeySet).toBe(false);
  });

  it('clears the stored key when the base URL changes (destination binding)', async () => {
    const { service, writtenData } = setup({
      row: enabledRow({
        provider: 'openai-compatible',
        model: 'llama',
        baseUrl: 'https://llm.internal.example/v1',
      }),
    });
    await service.updateSettings(
      body({
        provider: 'openai-compatible',
        model: 'llama',
        baseUrl: 'https://attacker.example/v1',
      }),
      'a',
    );
    expect(writtenData()).toMatchObject({ apiKeyCiphertext: null });
  });

  it('a new key sent with the destination change is stored', async () => {
    const { service } = setup({ row: enabledRow() });
    const saved = await service.updateSettings(
      body({ provider: 'openai', model: 'gpt-6-sol', apiKey: 'sk-openai' }),
      'a',
    );
    expect(saved.apiKeySet).toBe(true);
  });
});

describe('AiSettingsService — concurrent saves (review F1)', () => {
  it('refuses (409) when the row changed between the read and the write, writing nothing', async () => {
    // Admin A read the Anthropic row with its key. Meanwhile admin B moved the base URL (and B's save
    // cleared the key). A's save of the OLD destination must not land on B's row and keep a key.
    const { service, audits, current } = setup({
      row: enabledRow(),
      beforeWrite: (stored) =>
        makeRow({
          ...stored,
          provider: 'openai-compatible',
          model: 'llama',
          baseUrl: 'https://attacker.example/v1',
          apiKeyCiphertext: null,
          apiKeyIv: null,
          apiKeyAuthTag: null,
          apiKeyKeyVersion: null,
          updatedAt: new Date('2026-09-23T12:00:00Z'),
        }),
    });
    await expectRefusal(
      service.updateSettings(enabledBody({ retentionDays: 30 }), 'admin-a'),
      ConflictException,
      'AI_SETTINGS_CONCURRENT_SAVE',
      { statusCode: 409 },
    );
    expect(audits()).toEqual([]);
    expect(current()).toMatchObject({
      baseUrl: 'https://attacker.example/v1',
      apiKeyCiphertext: null,
      retentionDays: 90,
    });
  });

  it('refuses (409) a first save racing another first save', async () => {
    const { service, audits } = setup({
      row: null,
      beforeWrite: () =>
        makeRow({ updatedAt: new Date('2026-09-23T12:00:00Z') }),
    });
    await expectRefusal(
      service.updateSettings(body({ mcpEnabled: true }), 'a'),
      ConflictException,
      'AI_SETTINGS_CONCURRENT_SAVE',
    );
    expect(audits()).toEqual([]);
  });

  it('writes conditionally on the updatedAt it read', async () => {
    const read = enabledRow();
    const { service, prisma } = setup({ row: read });
    await service.updateSettings(enabledBody({ retentionDays: 30 }), 'a');
    expect(prisma.aiSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'singleton', updatedAt: read.updatedAt },
      }),
    );
  });
});

describe('AiSettingsService — the enable gate', () => {
  /** A disabled draft ready to enable: provider, model, key and the disclosure. */
  function readyRow(overrides: Row = {}) {
    return makeRow({
      provider: 'anthropic',
      model: 'claude-opus-5',
      ...keyColumns(),
      disclosureAcknowledgedAt: new Date('2026-09-02T00:00:00Z'),
      ...overrides,
    });
  }

  it('enables after a passing inline test and stamps verifiedAt', async () => {
    const { service, tester } = setup({ row: readyRow() });
    const saved = await service.updateSettings(enabledBody(), 'admin-1');
    expect(tester.test).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-opus-5',
        apiKey: PROVIDER_KEY,
      }),
    );
    expect(saved.enabled).toBe(true);
    expect(saved.verifiedAt).not.toBeNull();
  });

  it('refuses (422, with the test result) when the test fails, persisting nothing', async () => {
    const { service, tester, prisma } = setup({ row: readyRow() });
    tester.test.mockResolvedValueOnce(FAIL);
    const err = await refusal(() => service.updateSettings(enabledBody(), 'a'));
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getResponse?.()).toMatchObject({
      code: 'CONNECTION_TEST_FAILED',
      test: FAIL,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses without the disclosure acknowledgement', async () => {
    const { service, tester } = setup({
      row: readyRow({ disclosureAcknowledgedAt: null }),
    });
    const err = await refusal(() => service.updateSettings(enabledBody(), 'a'));
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getResponse?.()).toMatchObject({ code: 'DISCLOSURE_REQUIRED' });
    expect(tester.test).not.toHaveBeenCalled();
  });

  it('accepts the acknowledgement in the same request, recording its author once', async () => {
    const { service, audits, writtenData } = setup({
      row: readyRow({ disclosureAcknowledgedAt: null }),
    });
    const saved = await service.updateSettings(
      enabledBody({ acknowledgeDisclosure: true }),
      'admin-1',
    );
    expect(saved.disclosureAcknowledgedAt).not.toBeNull();
    expect(writtenData()).toMatchObject({
      disclosureAcknowledgedById: 'admin-1',
    });
    const ack = audits().filter(
      (a) => a.action === AI_CONFIG_AUDIT_ACTIONS.disclosureAcknowledged,
    );
    expect(ack).toEqual([expect.objectContaining({ actorId: 'admin-1' })]);
  });

  it('does not re-record an acknowledgement that already exists', async () => {
    const { service, audits, writtenData } = setup({ row: enabledRow() });
    await service.updateSettings(
      enabledBody({ acknowledgeDisclosure: true }),
      'b',
    );
    expect(writtenData()).not.toHaveProperty('disclosureAcknowledgedById');
    expect(
      audits().some(
        (a) => a.action === AI_CONFIG_AUDIT_ACTIONS.disclosureAcknowledged,
      ),
    ).toBe(false);
  });

  it('refuses (409) a key-requiring provider without AI_SECRET_KEY', async () => {
    const { service, tester, prisma } = setup({
      row: readyRow(),
      key: undefined,
    });
    await expectRefusal(
      service.updateSettings(enabledBody(), 'a'),
      ConflictException,
      'AI_SECRET_KEY_MISSING',
    );
    expect(tester.test).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('enables a keyless OpenAI-compatible server without AI_SECRET_KEY (§12)', async () => {
    const keyless = {
      provider: 'openai-compatible' as const,
      model: 'llama',
      baseUrl: 'https://llm.example/v1',
    };
    const { service, tester } = setup({
      row: readyRow({
        ...keyless,
        apiKeyCiphertext: null,
        apiKeyIv: null,
        apiKeyAuthTag: null,
        apiKeyKeyVersion: null,
      }),
      key: undefined,
    });
    const saved = await service.updateSettings(enabledBody(keyless), 'a');
    expect(saved.enabled).toBe(true);
    expect(tester.test).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: null }),
    );
  });

  it('refuses (409) in shim mode', async () => {
    process.env.AUTH_MODE = 'shim';
    const { service } = setup({ row: readyRow() });
    await expectRefusal(
      service.updateSettings(enabledBody(), 'a'),
      ConflictException,
      'AI_SHIM_MODE',
    );
  });

  it('refuses without a provider or model, or a base URL where required', async () => {
    const { service } = setup({ row: readyRow() });
    for (const draft of [
      enabledBody({ provider: null }),
      enabledBody({ model: null }),
      enabledBody({
        provider: 'openai-compatible',
        model: 'llama',
        baseUrl: null,
      }),
    ]) {
      const err = await refusal(() => service.updateSettings(draft, 'a'));
      expect(err.getResponse?.()).toMatchObject({
        code: 'PROVIDER_NOT_CONFIGURED',
      });
    }
  });

  it('refuses a key-requiring provider whose key was cleared by a destination change', async () => {
    const { service, tester } = setup({ row: readyRow() });
    const err = await refusal(() =>
      service.updateSettings(
        enabledBody({ provider: 'openai', model: 'gpt-6-sol' }),
        'a',
      ),
    );
    expect(err.getResponse?.()).toMatchObject({
      code: 'API_KEY_REQUIRED',
      reason: 'DESTINATION_CHANGED',
    });
    expect(tester.test).not.toHaveBeenCalled();
  });

  it('API_KEY_REQUIRED carries no reason when there simply never was a key', async () => {
    const { service } = setup({
      row: readyRow({
        apiKeyCiphertext: null,
        apiKeyIv: null,
        apiKeyAuthTag: null,
        apiKeyKeyVersion: null,
      }),
    });
    const err = await refusal(() => service.updateSettings(enabledBody(), 'a'));
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    const response = err.getResponse?.() as Record<string, unknown>;
    expect(response.code).toBe('API_KEY_REQUIRED');
    expect(response).not.toHaveProperty('reason');
  });

  it('skips the test when re-saving an enabled, verified, unchanged connection', async () => {
    const { service, tester } = setup({ row: enabledRow() });
    const saved = await service.updateSettings(
      enabledBody({ retentionDays: 30 }),
      'a',
    );
    expect(tester.test).not.toHaveBeenCalled();
    expect(saved.verifiedAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('re-tests when a connection field changes while enabled', async () => {
    const { service, tester } = setup({ row: enabledRow() });
    tester.test.mockResolvedValueOnce(FAIL);
    await expect(
      service.updateSettings(enabledBody({ model: 'claude-sonnet-5' }), 'a'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tester.test).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-5',
        apiKey: PROVIDER_KEY,
      }),
    );
  });

  it('a disabled save of a changed connection clears verifiedAt', async () => {
    const { service } = setup({ row: enabledRow() });
    const saved = await service.updateSettings(
      body({ provider: 'anthropic', model: 'claude-sonnet-5' }),
      'a',
    );
    expect(saved.verifiedAt).toBeNull();
  });

  it('the MCP switch needs no provider, key or test', async () => {
    const { service, tester } = setup({ key: undefined });
    const saved = await service.updateSettings(body({ mcpEnabled: true }), 'a');
    expect(saved.mcpEnabled).toBe(true);
    expect(saved.enabled).toBe(false);
    expect(tester.test).not.toHaveBeenCalled();
  });
});

describe('AiSettingsService — shape checks', () => {
  it('refuses a plain http base URL outside the private-network OpenAI-compatible case', async () => {
    const { service } = setup();
    await expectRefusal(
      service.updateSettings(
        body({
          provider: 'openai-compatible',
          model: 'm',
          baseUrl: 'http://10.0.0.5:11434/v1',
        }),
        'a',
      ),
      BadRequestException,
      'BASE_URL_HTTP_NOT_ALLOWED',
      { statusCode: 400 },
    );
    await expect(
      service.updateSettings(
        body({
          provider: 'openai-compatible',
          model: 'm',
          baseUrl: 'http://10.0.0.5:11434/v1',
          allowPrivateNetwork: true,
        }),
        'a',
      ),
    ).resolves.toMatchObject({ baseUrl: 'http://10.0.0.5:11434/v1' });
  });
});

describe('AiSettingsService — base URL checks (review F3, F5)', () => {
  const compatible = (baseUrl: string, allowPrivateNetwork = true) =>
    body({
      provider: 'openai-compatible',
      model: 'm',
      baseUrl,
      allowPrivateNetwork,
    });

  it.each([
    ['userinfo', 'https://user:secret@llm.example/v1', 'BASE_URL_CREDENTIALS'],
    ['a bare username', 'https://token@llm.example/v1', 'BASE_URL_CREDENTIALS'],
    [
      'a query string',
      'https://llm.example/v1?api_key=abc',
      'BASE_URL_QUERY_OR_FRAGMENT',
    ],
    ['an empty query', 'https://llm.example/v1?', 'BASE_URL_QUERY_OR_FRAGMENT'],
    ['a fragment', 'https://llm.example/v1#x', 'BASE_URL_QUERY_OR_FRAGMENT'],
  ])(
    'refuses a base URL with %s, on save and on test',
    async (_label, baseUrl, code) => {
      const { service, tester, prisma } = setup();
      await expectRefusal(
        service.updateSettings(compatible(baseUrl), 'a'),
        BadRequestException,
        code,
      );
      await expectRefusal(
        service.testConnection({
          provider: 'openai-compatible',
          model: 'm',
          baseUrl,
        }),
        BadRequestException,
        code,
      );
      expect(tester.test).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'plain http to a public literal',
      'http://8.8.8.8/v1',
      'BASE_URL_HTTP_PUBLIC',
    ],
    [
      'a loopback literal',
      'https://127.0.0.1:11434/v1',
      'BASE_URL_UNREACHABLE_RANGE',
    ],
    [
      'an IPv6 loopback literal',
      'http://[::1]:11434/v1',
      'BASE_URL_UNREACHABLE_RANGE',
    ],
    ['localhost', 'http://localhost:11434/v1', 'BASE_URL_LOOPBACK'],
    ['a *.localhost name', 'https://ollama.localhost/v1', 'BASE_URL_LOOPBACK'],
    [
      'the metadata address',
      'http://169.254.169.254/latest',
      'BASE_URL_UNREACHABLE_RANGE',
    ],
    [
      'a link-local literal',
      'http://169.254.10.10/v1',
      'BASE_URL_UNREACHABLE_RANGE',
    ],
    ['an unparseable value', 'not a url', 'BASE_URL_INVALID'],
    ['a non-http scheme', 'ftp://llm.example/v1', 'BASE_URL_SCHEME'],
  ])('refuses %s', async (_label, baseUrl, code) => {
    const { service } = setup();
    await expectRefusal(
      service.updateSettings(compatible(baseUrl), 'a'),
      BadRequestException,
      code,
    );
  });

  it('refuses the private-network option or provider options that do not fit the provider', async () => {
    const { service } = setup();
    await expectRefusal(
      service.testConnection({
        provider: 'anthropic',
        model: 'm',
        allowPrivateNetwork: true,
      }),
      BadRequestException,
      'PRIVATE_NETWORK_PROVIDER_MISMATCH',
    );
    await expectRefusal(
      service.testConnection({
        provider: 'anthropic',
        model: 'm',
        providerOptions: { notAnOption: true } as never,
      }),
      BadRequestException,
      'PROVIDER_OPTIONS_UNSUPPORTED',
    );
  });

  it('refuses a private literal without the private-network option', async () => {
    const { service } = setup();
    await expectRefusal(
      service.updateSettings(compatible('https://10.0.0.5/v1', false), 'a'),
      BadRequestException,
      'BASE_URL_PRIVATE_NOT_ALLOWED',
    );
  });

  it.each([
    ['http to a private literal', 'http://192.168.1.20:11434/v1'],
    ['http to a ULA literal', 'http://[fd00::20]:11434/v1'],
    [
      'http to a name (resolved and checked by the provider layer)',
      'http://ollama.lan:11434/v1',
    ],
    ['https to a public literal', 'https://8.8.8.8/v1'],
  ])('accepts %s with the private-network option', async (_label, baseUrl) => {
    const { service } = setup();
    await expect(
      service.updateSettings(compatible(baseUrl), 'a'),
    ).resolves.toMatchObject({ baseUrl });
  });
});

describe('AiSettingsService — shim mode (review F6)', () => {
  it('the connection test makes no provider call', async () => {
    process.env.AUTH_MODE = 'shim';
    const { service, tester } = setup({ row: enabledRow() });
    await expectRefusal(
      service.testConnection({}),
      ConflictException,
      'AI_SHIM_MODE',
    );
    expect(tester.test).not.toHaveBeenCalled();
  });

  it('the reader ignores a test override', async () => {
    process.env.AUTH_MODE = 'shim';
    const { service } = setup();
    await expect(
      withProviderOverride(
        {
          provider: 'openai',
          model: 'gpt-6-sol',
          baseUrl: null,
          apiKey: 'draft',
          allowPrivateNetwork: false,
          effort: null,
          providerOptions: null,
        },
        () => service.resolveProviderConfig(),
      ),
    ).resolves.toBeNull();
  });
});

describe('AiSettingsService — config audit', () => {
  it('writes one redacted settings.updated row per changing write', async () => {
    const { service, audits } = setup({ row: enabledRow() });
    await service.updateSettings(
      body({
        provider: 'openai-compatible',
        model: 'llama',
        baseUrl: 'https://llm.example/v1',
        apiKey: 'sk-new-secret',
        instructions: 'Be terse.',
        retentionDays: 30,
      }),
      'admin-1',
    );
    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AI_CONFIG_AUDIT_ACTIONS.settingsUpdated,
      actorId: 'admin-1',
    });
    const detail = JSON.stringify(rows[0].detail);
    expect(detail).not.toContain('sk-new-secret');
    expect(detail).not.toContain(PROVIDER_KEY);
    expect(detail).not.toContain('Be terse.');
    expect(rows[0].detail).toMatchObject({
      changes: {
        enabled: { before: true, after: false },
        provider: { before: 'anthropic', after: 'openai-compatible' },
        baseUrl: { before: null, after: 'https://llm.example/v1' },
        retentionDays: { before: 90, after: 30 },
        instructions: { beforeLength: 0, afterLength: 9 },
        apiKey: 'set',
      },
    });
  });

  it('records a destination-change key clear', async () => {
    const { service, audits } = setup({ row: enabledRow() });
    await service.updateSettings(
      body({ provider: 'google', model: 'gemini-3.8-flash' }),
      'a',
    );
    expect(audits()[0].detail).toMatchObject({
      changes: { apiKey: 'cleared-destination-changed' },
    });
  });

  it('web search (#1389): off by default, omitted keeps the stored value, a change is audited', async () => {
    const fresh = setup();
    expect((await fresh.service.getSettings()).webSearchEnabled).toBe(false);
    expect((await fresh.service.getSettings()).webSearchMaxUses).toBe(5);

    const { service, audits } = setup({
      row: enabledRow({ webSearchEnabled: true, webSearchMaxUses: 3 }),
    });
    // A caller written before web search existed omits both fields: the stored values stay, no audit.
    const kept = await service.updateSettings(enabledBody(), 'a');
    expect(kept).toMatchObject({ webSearchEnabled: true, webSearchMaxUses: 3 });
    expect(audits()).toEqual([]);

    const changed = await service.updateSettings(
      enabledBody({ webSearchEnabled: false, webSearchMaxUses: 8 }),
      'a',
    );
    expect(changed).toMatchObject({
      webSearchEnabled: false,
      webSearchMaxUses: 8,
    });
    expect(audits()[0].detail).toMatchObject({
      changes: {
        webSearchEnabled: { before: true, after: false },
        webSearchMaxUses: { before: 3, after: 8 },
      },
    });
  });

  it('web search (#1389): a stored cap outside the range reads as the default (tolerant read)', async () => {
    const { service } = setup({ row: makeRow({ webSearchMaxUses: 999 }) });
    expect((await service.getSettings()).webSearchMaxUses).toBe(5);
  });

  it('writes nothing to the audit for a no-op save', async () => {
    const { service, audits } = setup({ row: enabledRow() });
    await service.updateSettings(enabledBody(), 'a');
    expect(audits()).toEqual([]);
  });

  it('records allowlist overlay changes as entries added and ids removed', () => {
    const entry = {
      id: 'corp-agent',
      label: 'Corp agent',
      match: { kind: 'redirect_uri' as const, pattern: 'com.corp.agent:/cb' },
    };
    const before = {
      ...AiSettingsSchema.parse({
        ...AI_SETTINGS_DEFAULTS,
        provider: null,
        model: null,
        baseUrl: null,
        apiKeySet: false,
        keyConfigured: true,
        effort: null,
        providerOptions: null,
        instructions: null,
        disclosureAcknowledgedAt: null,
        verifiedAt: null,
        updatedAt: null,
        mcpClientAllowlistAdded: [],
        mcpClientAllowlistRemovedDefaults: [],
        mcpAllowAnyHttpsClient: false,
      }),
    };
    const changes = diffSettings(
      before,
      body({
        mcpClientAllowlistAdded: [entry],
        mcpClientAllowlistRemovedDefaults: ['cursor'],
        mcpAllowAnyHttpsClient: true,
      }),
      'kept',
    );
    expect(changes).toEqual({
      mcpClientAllowlistAdded: { added: [entry], removed: [] },
      mcpClientAllowlistRemovedDefaults: { before: [], after: ['cursor'] },
      mcpAllowAnyHttpsClient: { before: false, after: true },
    });
  });

  it('redactUrl strips credentials, query and fragment', () => {
    expect(redactUrl('https://u:p@h.example:8443/v1?k=s#f')).toBe(
      'https://h.example:8443/v1',
    );
    expect(redactUrl(null)).toBeNull();
  });
});

describe('AiSettingsService — the MCP allowlist overlay', () => {
  it('stores the admin overlay as written and reads it back', async () => {
    const { service } = setup();
    const entry = {
      id: 'corp-agent',
      label: 'Corp agent',
      match: {
        kind: 'cimd_url' as const,
        url: 'https://agent.corp.example/client.json',
      },
    };
    const saved = await service.updateSettings(
      body({
        mcpClientAllowlistAdded: [entry],
        mcpClientAllowlistRemovedDefaults: ['windsurf'],
      }),
      'a',
    );
    expect(saved.mcpClientAllowlistAdded).toEqual([entry]);
    expect(saved.mcpClientAllowlistRemovedDefaults).toEqual(['windsurf']);
  });
});

describe('AiSettingsService — connection test (draft)', () => {
  it('uses the saved key only while provider and base URL are unchanged', async () => {
    const { service, tester } = setup({ row: enabledRow() });
    await service.testConnection({});
    expect(tester.test).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: PROVIDER_KEY }),
    );
    await service.testConnection({ provider: 'openai', model: 'gpt-6-sol' });
    expect(tester.test).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'openai', apiKey: null }),
    );
    await service.testConnection({ baseUrl: 'https://attacker.example/v1' });
    expect(tester.test).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: null }),
    );
  });

  it('an inline key wins and nothing is persisted', async () => {
    const { service, tester, prisma } = setup({ row: null });
    const result = await service.testConnection({
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKey: 'inline',
    });
    expect(result).toEqual(PASS);
    expect(tester.test).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'inline' }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('400s without a provider and a model', async () => {
    const { service } = setup();
    await expectRefusal(
      service.testConnection({}),
      BadRequestException,
      'PROVIDER_NOT_CONFIGURED',
    );
  });

  it('model suggestions come from the provider descriptor', async () => {
    const { service } = setup();
    await expect(
      service.listModels({ provider: 'anthropic' }),
    ).resolves.toEqual({
      models: [{ id: 'claude-opus-5', label: null }],
    });
    await expect(service.listModels({})).resolves.toEqual({ models: [] });
  });
});
