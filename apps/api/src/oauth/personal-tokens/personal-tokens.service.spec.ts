/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
// The generated client never loads under Jest (no DB); the services run over FakeOAuthPrisma instead.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreatePersonalTokenSchema } from '@lazyit/shared';
import {
  ISSUER,
  buildHarness,
  connect,
  enableMcp,
  seedUser,
  type Harness,
} from '../../../test/oauth/oauth-harness';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import { OAuthAuditService } from '../oauth-audit.service';
import {
  MAX_LIVE_PERSONAL_TOKENS,
  PERSONAL_TOKEN_RESOURCE,
  PersonalTokensService,
} from './personal-tokens.service';

/**
 * Personal MCP tokens (W3-4; ADR-0097 decision 9, default 14; mcp-and-oauth.md §5.4): the lifecycle over
 * the in-memory database — mint (hash only, shown once, mandatory expiry), list, revoke — and the `/mcp`
 * verification, which must refuse exactly what an OAuth grant's check refuses.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ENV_KEYS = ['WEB_ORIGIN', 'AUTH_MODE'] as const;
const savedEnv: Record<string, string | undefined> = {};

let h: Harness;
let service: PersonalTokensService;

/** A plain-HTTP `lan` instance: no pinned origin, local auth. */
function useLanInstance(): void {
  delete process.env.WEB_ORIGIN;
  process.env.AUTH_MODE = 'local';
}

const input = (over: Record<string, unknown> = {}) =>
  CreatePersonalTokenSchema.parse({ label: 'laptop', ...over });

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  useLanInstance();
  h = buildHarness();
  enableMcp(h);
  // The advisory lock the mint takes (a no-op in memory; its ORDER is asserted below).
  (h.prisma as any).$executeRaw = jest.fn().mockResolvedValue(0);
  service = new PersonalTokensService(
    h.prisma as any,
    h.policy,
    h.subjects,
    new PrincipalLoaderService(h.prisma as any),
    h.tokens,
    new OAuthAuditService(h.prisma as any),
  );
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

describe('mint', () => {
  it('returns a lzit_pat_ token once, stores only its SHA-256, and audits without the secret', async () => {
    const user = seedUser(h);
    const before = Date.now();
    const created = await service.create(user, input(), { ip: '10.0.0.5' });

    expect(created.token).toMatch(/^lzit_pat_[A-Za-z0-9_-]{43}$/);
    expect(created.grant).toMatchObject({
      kind: 'personal',
      label: 'laptop',
      client: null,
      redirectHost: null,
      scopes: ['lazyit.read', 'lazyit.write'],
    });
    const expiresAt = new Date(created.grant.expiresAt!).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(90 * DAY_MS - 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(90 * DAY_MS + 1000);

    const [grant] = h.prisma.tables.oAuthGrant;
    expect(grant).toMatchObject({
      userId: user.id,
      kind: 'personal',
      clientRefId: null,
      resource: PERSONAL_TOKEN_RESOURCE,
      sessionEpoch: 0,
    });
    const [token] = h.prisma.tables.oAuthToken;
    expect(token).toMatchObject({ grantId: grant.id, kind: 'personal' });
    expect(token.tokenHash).toBe(
      createHash('sha256').update(created.token).digest('hex'),
    );
    // The cleartext exists nowhere at rest.
    expect(JSON.stringify(h.prisma.tables)).not.toContain(created.token);
    expect(h.prisma.tables.oAuthAuditLog).toEqual([
      expect.objectContaining({
        action: 'PERSONAL_TOKEN_CREATED',
        userId: user.id,
        actorId: user.id,
        grantId: grant.id,
        ip: '10.0.0.5',
      }),
    ]);
  });

  it('honours the chosen expiry up to 365 days and the chosen scopes', async () => {
    const user = seedUser(h);
    const created = await service.create(
      user,
      input({ expiresInDays: 365, scopes: ['lazyit.read'] }),
    );
    const days =
      (new Date(created.grant.expiresAt!).getTime() - Date.now()) / DAY_MS;
    expect(Math.round(days)).toBe(365);
    expect(created.grant.scopes).toEqual(['lazyit.read']);
    // The contract bounds the lifetime: no token without an expiry, none past a year.
    expect(
      CreatePersonalTokenSchema.safeParse({ label: 'x', expiresInDays: 366 })
        .success,
    ).toBe(false);
    expect(
      CreatePersonalTokenSchema.safeParse({
        label: 'x',
        scopes: ['lazyit.admin'],
      }).success,
    ).toBe(false);
  });

  it('never logs the token', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) => jest.spyOn(Logger.prototype, level),
    );
    const user = seedUser(h);
    const created = await service.create(user, input());
    await service.verify(created.token);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(created.token);
      }
    }
  });

  it('is refused on an HTTPS instance: OAuth is the only path there', async () => {
    process.env.WEB_ORIGIN = ISSUER;
    const user = seedUser(h);
    await expect(service.create(user, input())).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'OAUTH_INSTANCE' }),
    });
    expect(h.prisma.tables.oAuthGrant).toHaveLength(0);
  });

  it('is refused while MCP is off (and with no settings row), and in the shim', async () => {
    const user = seedUser(h);
    enableMcp(h, { mcpEnabled: false });
    await expect(service.create(user, input())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_DISABLED' }),
    });
    h.prisma.tables.aiSettings = [];
    await expect(service.create(user, input())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_DISABLED' }),
    });
    enableMcp(h);
    process.env.AUTH_MODE = 'shim';
    await expect(service.create(user, input())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_DISABLED' }),
    });
  });

  it('is refused to an account that lost ai:connect, is inactive or owes a password change', async () => {
    const viewer = seedUser(h, { role: 'VIEWER' });
    await expect(service.create(viewer, input())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const inactive = seedUser(h, { isActive: false });
    await expect(service.create(inactive, input())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const mustChange = seedUser(h, { mustChangePassword: true });
    await expect(service.create(mustChange, input())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('counts the cap under a per-user advisory lock, inside the create transaction (G3 review F4)', async () => {
    const user = seedUser(h);
    const order: string[] = [];
    let inTransaction = false;
    const db = h.prisma as any;
    const transaction = db.$transaction.bind(db);
    db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await transaction(fn);
      } finally {
        inTransaction = false;
      }
    };
    db.$executeRaw.mockImplementation((strings: TemplateStringsArray) => {
      order.push(`lock:${inTransaction}:${strings.join('?')}`);
      return Promise.resolve(0);
    });
    db.oAuthGrant.count.mockImplementation(() => {
      order.push(`count:${inTransaction}`);
      return Promise.resolve(0);
    });
    const create = db.oAuthGrant.create.getMockImplementation();
    db.oAuthGrant.create.mockImplementation((args: unknown) => {
      order.push(`create:${inTransaction}`);
      return create(args);
    });
    await service.create(user, input());
    expect(order).toEqual([
      'lock:true:SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))',
      'count:true',
      'create:true',
    ]);
    expect(db.$executeRaw.mock.calls[0].slice(1)).toEqual([
      'lazyit.personal_token',
      user.id,
    ]);
  });

  it('re-asserts the scopes in the service: never lazyit.admin, never none (G3 review F7)', async () => {
    const user = seedUser(h);
    for (const scopes of [
      ['lazyit.read', 'lazyit.admin'],
      ['lazyit.admin'],
      [],
      ['openid'],
    ]) {
      await expect(
        service.create(user, {
          label: 'x',
          expiresInDays: 90,
          scopes,
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(h.prisma.tables.oAuthGrant).toHaveLength(0);
  });

  it(`caps live personal tokens at ${MAX_LIVE_PERSONAL_TOKENS} per user`, async () => {
    const user = seedUser(h);
    for (let i = 0; i < MAX_LIVE_PERSONAL_TOKENS; i += 1) {
      await service.create(user, input({ label: `t${i}` }));
    }
    await expect(service.create(user, input())).rejects.toBeInstanceOf(
      ConflictException,
    );
    // A revoked one frees a slot.
    const [first] = h.prisma.tables.oAuthGrant;
    await service.revokeMine(user, first.id);
    await expect(service.create(user, input())).resolves.toBeDefined();
  });
});

describe('list and revoke', () => {
  it('lists only the caller’s live personal tokens, never a secret', async () => {
    const user = seedUser(h);
    const other = seedUser(h);
    const mine = await service.create(user, input({ label: 'mine' }));
    await service.create(other, input({ label: 'theirs' }));
    const revoked = await service.create(user, input({ label: 'revoked' }));
    await service.revokeMine(user, revoked.grant.id);
    const expired = await service.create(user, input({ label: 'expired' }));
    h.prisma.tables.oAuthGrant.find(
      (g) => g.id === expired.grant.id,
    )!.expiresAt = new Date(Date.now() - 1000);

    const listed = await service.listMine(user);
    expect(listed.map((g) => g.label)).toEqual(['mine']);
    expect(JSON.stringify(listed)).not.toContain(mine.token);
    expect(JSON.stringify(listed)).not.toMatch(/tokenHash|lzit_pat_/);
  });

  it('revokes only the caller’s own personal token; anything else is 404', async () => {
    const user = seedUser(h);
    const other = seedUser(h);
    const theirs = await service.create(other, input());
    await expect(
      service.revokeMine(user, theirs.grant.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.revokeMine(user, 'not-a-cuid')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // An OAuth grant is not a personal token, even the caller's own.
    process.env.WEB_ORIGIN = ISSUER;
    await connect(h, user);
    const oauthGrant = h.prisma.tables.oAuthGrant.find(
      (g) => g.kind === 'oauth',
    )!;
    useLanInstance();
    await expect(
      service.revokeMine(user, oauthGrant.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    const mine = await service.create(user, input());
    await service.revokeMine(user, mine.grant.id, { ip: '10.0.0.9' });
    expect(
      h.prisma.tables.oAuthGrant.find((g) => g.id === mine.grant.id),
    ).toMatchObject({ revokeReason: 'user', revokedById: user.id });
    expect(
      h.prisma.tables.oAuthToken.filter((t) => t.grantId === mine.grant.id),
    ).toHaveLength(0);
    expect(h.prisma.tables.oAuthAuditLog.at(-1)).toMatchObject({
      action: 'PERSONAL_TOKEN_REVOKED',
      grantId: mine.grant.id,
      ip: '10.0.0.9',
    });
  });

  it('the admin revoke path records PERSONAL_TOKEN_REVOKED with reason admin (G3 review F8)', async () => {
    const user = seedUser(h);
    const admin = seedUser(h, { role: 'ADMIN' });
    const created = await service.create(user, input());
    await h.grants.revoke(admin, created.grant.id, '10.0.0.7');
    expect(
      h.prisma.tables.oAuthGrant.find((g) => g.id === created.grant.id),
    ).toMatchObject({ revokeReason: 'admin', revokedById: admin.id });
    expect(h.prisma.tables.oAuthAuditLog.at(-1)).toMatchObject({
      action: 'PERSONAL_TOKEN_REVOKED',
      userId: user.id,
      actorId: admin.id,
      grantId: created.grant.id,
    });
  });

  it('shares the connected-apps list and its revoke (DELETE /oauth/grants/:id)', async () => {
    const user = seedUser(h);
    const created = await service.create(user, input());
    expect(await h.grants.listMine(user)).toEqual([
      expect.objectContaining({ id: created.grant.id, kind: 'personal' }),
    ]);
    await h.grants.revoke(user, created.grant.id);
    // Revocation hard-deletes the credential row: the token no longer exists at all.
    expect(await service.verify(created.token)).toMatchObject({
      ok: false,
      reason: 'invalid',
      status: 401,
    });
    expect(h.prisma.tables.oAuthAuditLog.at(-1)).toMatchObject({
      action: 'PERSONAL_TOKEN_REVOKED',
    });
  });
});

describe('verify (the /mcp check)', () => {
  it('accepts a live token: the user, its scopes and the grant', async () => {
    const user = seedUser(h);
    const created = await service.create(
      user,
      input({ scopes: ['lazyit.read'] }),
    );
    expect(await service.verify(created.token)).toMatchObject({
      ok: true,
      principal: { kind: 'human', user: { id: user.id } },
      grant: {
        id: created.grant.id,
        clientId: null,
        clientName: 'laptop',
        scopes: ['lazyit.read'],
      },
    });
  });

  it('refuses a wrong, malformed or foreign token', async () => {
    const user = seedUser(h);
    const created = await service.create(user, input());
    expect(await service.verify(`${created.token}x`)).toMatchObject({
      ok: false,
      reason: 'invalid',
      status: 401,
    });
    expect(await service.verify('lzit_oat_abc')).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses an expired token (row or grant)', async () => {
    const user = seedUser(h);
    const created = await service.create(user, input({ expiresInDays: 1 }));
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * DAY_MS);
    expect(await service.verify(created.token)).toMatchObject({
      ok: false,
      reason: 'expired',
      status: 401,
    });
  });

  it('dies with the user: epoch bump, deactivation, offboarding, forced password change', async () => {
    const cases: Array<[string, (user: any) => void, string]> = [
      ['sessionEpoch bump', (u) => (u.sessionEpoch += 1), 'session_revoked'],
      ['deactivation', (u) => (u.isActive = false), 'inactive'],
      ['offboarding', (u) => (u.deletedAt = new Date()), 'not_found'],
      [
        'forced password change',
        (u) => (u.mustChangePassword = true),
        'password_change_required',
      ],
    ];
    for (const [, mutate, reason] of cases) {
      const user = seedUser(h);
      const created = await service.create(user, input());
      mutate(h.prisma.tables.user.find((u) => u.id === user.id));
      expect(await service.verify(created.token)).toMatchObject({
        ok: false,
        reason,
        status: 401,
      });
    }
  });

  it('answers 403 when a valid token meets a withdrawn capability', async () => {
    const user = seedUser(h);
    const created = await service.create(user, input());
    enableMcp(h, { mcpEnabled: false });
    expect(await service.verify(created.token)).toMatchObject({
      ok: false,
      reason: 'mcp_disabled',
      status: 403,
    });
    enableMcp(h);
    h.rolePermissions.set('MEMBER', new Set());
    expect(await service.verify(created.token)).toMatchObject({
      ok: false,
      reason: 'forbidden',
      status: 403,
    });
  });

  it('is not accepted once the instance serves OAuth (HTTPS)', async () => {
    const user = seedUser(h);
    const created = await service.create(user, input());
    process.env.WEB_ORIGIN = ISSUER;
    expect(await service.verify(created.token)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('never accepts an OAuth token row, and an OAuth token never verifies as personal', async () => {
    process.env.WEB_ORIGIN = ISSUER;
    const user = seedUser(h);
    const { tokens } = await connect(h, user);
    useLanInstance();
    // Same hash space, different kind and prefix: refused by prefix before any lookup.
    expect(await service.verify(tokens.access_token)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    const forged = `lzit_pat_${tokens.access_token.slice('lzit_oat_'.length)}`;
    expect(await service.verify(forged)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });
});
