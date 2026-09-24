import {
  AI_SETTINGS_DEFAULTS,
  AiStatusSchema,
  type AiSettings,
  type Permission,
} from '@lazyit/shared';

jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { DbNull: 'DbNull' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import type { ServiceAccount, User } from '../../../generated/prisma/client';
import type { Principal } from '../../auth/principal';
import type { ResolvedAiProviderConfig } from '../core/ports/ai-settings.port';
import {
  AiStatusService,
  resolveMcpAuthMode,
  resolveMcpUrls,
} from './ai-status.service';

const DISABLED: AiSettings = {
  ...AI_SETTINGS_DEFAULTS,
  mcpClientAllowlistAdded: [],
  mcpClientAllowlistRemovedDefaults: [],
  provider: null,
  model: null,
  baseUrl: null,
  apiKeySet: false,
  keyConfigured: false,
  effort: null,
  providerOptions: null,
  instructions: null,
  disclosureAcknowledgedAt: null,
  verifiedAt: null,
  updatedAt: null,
};

const ENABLED: AiSettings = {
  ...DISABLED,
  enabled: true,
  provider: 'anthropic',
  model: 'claude-opus-5',
  apiKeySet: true,
  keyConfigured: true,
  retentionDays: 45,
  mcpEnabled: true,
  instructions: 'internal admin addendum',
  baseUrl: 'https://secret-host.internal/v1',
  updatedAt: '2026-09-24T10:00:00.000Z',
};

const human = (role: string): Principal => ({
  kind: 'human',
  user: { id: 'u1', role } as User,
});
const service = (perms: Permission[]): Principal => ({
  kind: 'service',
  serviceAccount: { id: 'sa-1' } as ServiceAccount,
  permissions: new Set(perms),
});

/**
 * What the real reader's `resolveProviderConfig()` answers for `settings`: null when disabled or
 * unconfigured, or when the stored key cannot be decrypted (modelled as `keyConfigured: false`).
 */
function resolvedFrom(settings: AiSettings): ResolvedAiProviderConfig | null {
  if (!settings.enabled || !settings.provider || !settings.model) return null;
  if (settings.apiKeySet && !settings.keyConfigured) return null;
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKeySet ? 'decrypted' : null,
    allowPrivateNetwork: settings.allowPrivateNetwork,
    effort: settings.effort,
    providerOptions: settings.providerOptions,
  };
}

function makeService(
  settings: AiSettings,
  rolePerms: Permission[] = [],
  resolved: ResolvedAiProviderConfig | null = resolvedFrom(settings),
) {
  const reader = {
    getSettings: jest.fn(() => Promise.resolve(settings)),
    resolveProviderConfig: jest.fn(() => Promise.resolve(resolved)),
  };
  const resolver = {
    resolve: jest.fn(() => Promise.resolve(new Set(rolePerms))),
  };
  return new AiStatusService(reader, resolver as never);
}

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('AiStatusService', () => {
  beforeEach(() => {
    delete process.env.WEB_ORIGIN;
  });

  it('no settings row: nothing available, revision "0", and the contract holds', async () => {
    const status = await makeService(DISABLED, [
      'ai:use',
      'ai:connect',
    ]).getStatus(human('ADMIN'));
    expect(status).toEqual({
      chat: { available: false },
      mcp: {
        available: false,
        auth: 'personal-token',
        endpoint: null,
        marketplaceUrl: null,
      },
      configRevision: '0',
      retentionDays: null,
    });
    expect(AiStatusSchema.parse(status)).toEqual(status);
  });

  it('enabled + configured + ai:use → chat available, with retention and the revision', async () => {
    const status = await makeService(ENABLED, ['ai:use']).getStatus(
      human('MEMBER'),
    );
    expect(status).toEqual({
      chat: { available: true },
      mcp: {
        available: false,
        auth: 'personal-token',
        endpoint: null,
        marketplaceUrl: null,
      },
      configRevision: '2026-09-24T10:00:00.000Z',
      retentionDays: 45,
    });
    expect(AiStatusSchema.parse(status)).toEqual(status);
  });

  it('never leaks provider, model, base URL, instructions or key facts', async () => {
    const status = await makeService(ENABLED, [
      'ai:use',
      'ai:connect',
    ]).getStatus(human('ADMIN'));
    const wire = JSON.stringify(status);
    for (const secret of [
      'anthropic',
      'claude-opus-5',
      'secret-host',
      'addendum',
      'apiKey',
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(Object.keys(status).sort()).toEqual(
      ['chat', 'configRevision', 'mcp', 'retentionDays'].sort(),
    );
  });

  it('without ai:use the chat is unavailable and retention is withheld', async () => {
    const status = await makeService(ENABLED, ['ai:connect']).getStatus(
      human('VIEWER'),
    );
    expect(status.chat.available).toBe(false);
    expect(status.retentionDays).toBeNull();
    expect(status.mcp.available).toBe(true);
  });

  it.each([
    ['disabled', { ...ENABLED, enabled: false }],
    ['no provider', { ...ENABLED, provider: null }],
    ['no key stored', { ...ENABLED, apiKeySet: false }],
    ['AI_SECRET_KEY gone', { ...ENABLED, keyConfigured: false }],
  ])('chat is unavailable when %s', async (_label, settings) => {
    const status = await makeService(settings, ['ai:use']).getStatus(
      human('ADMIN'),
    );
    expect(status.chat.available).toBe(false);
  });

  it('chat is unavailable when the stored key does not decrypt, even though the row says it is set (review F4)', async () => {
    // The read shape says a key is stored and AI_SECRET_KEY is present — but it is a DIFFERENT key, so
    // the reader cannot decrypt and resolves null. Status must agree with the runtime, not the row.
    const status = await makeService(ENABLED, ['ai:use'], null).getStatus(
      human('ADMIN'),
    );
    expect(status.chat.available).toBe(false);
    expect(status.retentionDays).toBeNull();
  });

  it('a keyless OpenAI-compatible provider is configured without a stored key', async () => {
    const status = await makeService(
      {
        ...ENABLED,
        provider: 'openai-compatible',
        apiKeySet: false,
        keyConfigured: false,
      },
      ['ai:use'],
    ).getStatus(human('MEMBER'));
    expect(status.chat.available).toBe(true);
  });

  it('MCP needs the switch and ai:connect, independent of the provider', async () => {
    const mcpOnly = { ...DISABLED, mcpEnabled: true };
    expect(
      (await makeService(mcpOnly, ['ai:connect']).getStatus(human('MEMBER')))
        .mcp.available,
    ).toBe(true);
    expect(
      (await makeService(mcpOnly, []).getStatus(human('MEMBER'))).mcp.available,
    ).toBe(false);
  });

  it('a service account is judged by its own grants, never a role', async () => {
    const svc = makeService(ENABLED, ['ai:use', 'ai:connect']);
    const status = await svc.getStatus(service(['ai:connect']));
    expect(status.chat.available).toBe(false);
    expect(status.mcp.available).toBe(true);
  });

  it('shim mode and an anonymous caller get nothing', async () => {
    const svc = makeService(ENABLED, ['ai:use', 'ai:connect']);
    expect((await svc.getStatus(undefined)).chat.available).toBe(false);
    process.env.AUTH_MODE = 'shim';
    const status = await svc.getStatus(human('ADMIN'));
    expect(status.chat.available).toBe(false);
    expect(status.mcp.available).toBe(false);
  });

  it('exposes the MCP endpoint and marketplace from the pinned origin (https, MCP on)', async () => {
    process.env.WEB_ORIGIN = 'https://it.example.com/';
    const status = await makeService(ENABLED, ['ai:connect']).getStatus(
      human('MEMBER'),
    );
    expect(status.mcp).toEqual({
      available: true,
      auth: 'oauth',
      endpoint: 'https://it.example.com/mcp',
      marketplaceUrl:
        'https://it.example.com/api/ai/claude-code/marketplace.json',
    });
    expect(AiStatusSchema.parse(status)).toEqual(status);
  });

  it('keeps the endpoint but no marketplace while MCP is off, or on a plain-http pinned origin', async () => {
    process.env.WEB_ORIGIN = 'https://it.example.com';
    const off = await makeService({ ...ENABLED, mcpEnabled: false }, [
      'ai:connect',
    ]).getStatus(human('ADMIN'));
    expect(off.mcp).toMatchObject({
      endpoint: 'https://it.example.com/mcp',
      marketplaceUrl: null,
    });
    process.env.WEB_ORIGIN = 'http://10.0.0.5:8080';
    const lan = await makeService(ENABLED, ['ai:connect']).getStatus(
      human('ADMIN'),
    );
    expect(lan.mcp).toMatchObject({
      auth: 'personal-token',
      endpoint: 'http://10.0.0.5:8080/mcp',
      marketplaceUrl: null,
    });
  });

  it('never derives the URLs from the request: no pinned origin, a bad one, or shim → null', () => {
    expect(resolveMcpUrls(true, { AUTH_TRUST_HOST: 'true' })).toEqual({
      endpoint: null,
      marketplaceUrl: null,
    });
    expect(resolveMcpUrls(true, { WEB_ORIGIN: 'not an origin' })).toEqual({
      endpoint: null,
      marketplaceUrl: null,
    });
    expect(
      resolveMcpUrls(true, { WEB_ORIGIN: 'ftp://it.example.com' }),
    ).toEqual({ endpoint: null, marketplaceUrl: null });
    expect(
      resolveMcpUrls(true, {
        WEB_ORIGIN: 'https://it.example.com',
        AUTH_MODE: 'shim',
      }),
    ).toEqual({ endpoint: null, marketplaceUrl: null });
  });

  it('shim mode and an anonymous caller get no URLs', async () => {
    process.env.WEB_ORIGIN = 'https://it.example.com';
    const svc = makeService(ENABLED, ['ai:connect']);
    expect((await svc.getStatus(undefined)).mcp).toMatchObject({
      endpoint: null,
      marketplaceUrl: null,
    });
    process.env.AUTH_MODE = 'shim';
    expect((await svc.getStatus(human('ADMIN'))).mcp).toMatchObject({
      endpoint: null,
      marketplaceUrl: null,
    });
  });

  it('the MCP auth mode is oauth only on a pinned https origin', () => {
    expect(resolveMcpAuthMode({ WEB_ORIGIN: 'https://it.example.com' })).toBe(
      'oauth',
    );
    expect(resolveMcpAuthMode({ WEB_ORIGIN: 'http://10.0.0.5' })).toBe(
      'personal-token',
    );
    expect(resolveMcpAuthMode({})).toBe('personal-token');
  });
});
