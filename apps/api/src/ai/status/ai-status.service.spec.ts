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
import { AiStatusService, resolveMcpAuthMode } from './ai-status.service';

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

function makeService(settings: AiSettings, rolePerms: Permission[] = []) {
  const reader = {
    getSettings: jest.fn(() => Promise.resolve(settings)),
    resolveProviderConfig: jest.fn(),
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
  it('no settings row: nothing available, revision "0", and the contract holds', async () => {
    const status = await makeService(DISABLED, [
      'ai:use',
      'ai:connect',
    ]).getStatus(human('ADMIN'));
    expect(status).toEqual({
      chat: { available: false },
      mcp: { available: false, auth: 'personal-token' },
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
      mcp: { available: false, auth: 'personal-token' },
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
