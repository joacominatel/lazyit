jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { createHash } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import JSZip from 'jszip';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Permission } from '@lazyit/shared';
import { AiToolRegistry } from '../../ai/core/tool-registry';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { RolesGuard } from '../../auth/roles.guard';
import { OAuthPolicyService } from '../../oauth/oauth-policy.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PluginDistributionController } from './plugin-distribution.controller';
import { PluginDistributionService } from './plugin-distribution.service';

/**
 * The distribution surface over real HTTP (Express + Nest routing, the REAL RolesGuard and permission
 * resolver, the REAL ServicePrincipalForbiddenGuard; Prisma mocked). The gating matrix of R8
 * (mcp-and-oauth.md §5.1, §5.5):
 *
 *   | surface                  | anon | human w/o ai:connect | human + ai:connect | SA  | MCP off | lan | shim |
 *   | plugin.zip (auth)        | 403* | 403                  | 200                | 403 | 404     | 200 | 404  |
 *   | marketplace.json (anon)  | 200  | 200                  | 200                | 200 | 404     | 404 | 404  |
 *   | lazyit-plugin.zip (anon) | 200  | 200                  | 200                | 200 | 404     | 404 | 404  |
 *
 * (*) The harness's fake authentication leaves an anonymous request without a principal, so RolesGuard
 * answers 403; in the app the real JwtAuthGuard answers 401 first. Either way the handler never runs.
 */

const HTTPS = 'https://lazyit.example.com';

// Headers pick the principal: `X-Test-Role` → a human of that role; `X-Test-Service` → a service account
// holding `ai:connect`; neither → anonymous.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    if (req.headers['x-test-service'] === 'true') {
      req.principal = {
        kind: 'service',
        serviceAccount: { id: 'sa1' },
        permissions: new Set<Permission>(['ai:connect', 'ai:use']),
      };
      return true;
    }
    const role = req.headers['x-test-role'];
    if (role) {
      const user = { id: 'u1', role };
      req.user = user;
      req.principal = { kind: 'human', user };
    }
    return true;
  }
}

/** Role → permissions for the resolver: MEMBER holds `ai:connect`, VIEWER does not (ADMIN is full). */
const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  MEMBER: ['asset:read', 'ai:connect'],
  VIEWER: ['asset:read'],
};

const SENTINELS = {
  AI_SECRET_KEY: 'sentinel-ai-secret-key-0001',
  JWT_SECRET: 'sentinel-jwt-secret-0002',
  AUTH_SECRET: 'sentinel-auth-secret-0003',
  DATABASE_URL:
    'postgresql://sentinel-db-user:sentinel-db-pass@db-internal:5432/x',
  INTERNAL_API_URL: 'http://api-internal-host:3001',
};

/** supertest parser that keeps the raw bytes (the zip) as a Buffer. */
function binary(
  res: request.Response,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

/** Typed JSON parse for assertions (keeps `any` out of the spec). */
interface PluginJson {
  userConfig?: Record<string, { sensitive?: boolean }>;
  mcpServers?: Record<string, { url?: string }>;
  code?: string;
  [key: string]: unknown;
}
function parseJson(text: string): PluginJson {
  return JSON.parse(text) as PluginJson;
}

async function unzip(buffer: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer);
  const out: Record<string, string> = {};
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[path] = await entry.async('string');
  }
  return out;
}

describe('Claude Code plugin distribution — HTTP gating (R8)', () => {
  let app: INestApplication<App>;
  let mcpEnabled: boolean;
  const saved = { ...process.env };

  beforeAll(async () => {
    const prisma = {
      aiSettings: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            mcpEnabled,
            mcpClientAllowlistAdded: [],
            mcpClientAllowlistRemovedDefaults: [],
            mcpAllowAnyHttpsClient: false,
          }),
        ),
      },
      rolePermission: {
        findMany: jest.fn(({ where }: { where: { role: string } }) =>
          Promise.resolve(
            (ROLE_PERMISSIONS[where.role] ?? []).map((permission) => ({
              permission,
            })),
          ),
        ),
      },
    };
    const registry = {
      all: () => [
        {
          descriptor: {
            name: 'search_assets',
            title: 'Search assets',
            description: 'Search the asset inventory.',
            class: 'read',
          },
          permissions: ['asset:read'],
          channels: ['CHAT', 'MCP', 'HEADLESS'],
        },
      ],
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [PluginDistributionController],
      providers: [
        Reflector,
        PluginDistributionService,
        OAuthPolicyService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: AiToolRegistry, useValue: registry },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    process.env = { ...saved, ...SENTINELS };
    process.env.AUTH_MODE = 'local';
    process.env.WEB_ORIGIN = HTTPS;
    delete process.env.AUTH_TRUST_HOST;
    mcpEnabled = true;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  const server = () => app.getHttpServer();
  const download = () =>
    request(server())
      .get('/ai/claude-code/plugin.zip')
      .buffer(true)
      .parse(binary);

  describe('authenticated download — GET /ai/claude-code/plugin.zip', () => {
    it('serves a human holding ai:connect: zip, attachment, private no-store, ETag = digest', async () => {
      const res = await download().set('X-Test-Role', 'MEMBER').expect(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="lazyit-plugin.zip"',
      );
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
      const files = await unzip(res.body as Buffer);
      expect(Object.keys(files)).toContain('skills/lazyit/reference/tools.md');
      expect(parseJson(files['.mcp.json'])).toEqual({
        mcpServers: { lazyit: { type: 'http', url: `${HTTPS}/mcp` } },
      });
    });

    it('refuses a human without ai:connect (403)', async () => {
      await download().set('X-Test-Role', 'VIEWER').expect(403);
    });

    it('refuses an anonymous caller', async () => {
      await download().expect(403);
    });

    it('refuses a service account even when it holds ai:connect (human sessions only)', async () => {
      await download().set('X-Test-Service', 'true').expect(403);
    });

    it('answers 404 while MCP is switched off', async () => {
      mcpEnabled = false;
      await download().set('X-Test-Role', 'ADMIN').expect(404);
    });

    it('answers 404 in shim mode', async () => {
      process.env.AUTH_MODE = 'shim';
      await download().set('X-Test-Role', 'ADMIN').expect(404);
    });

    it('ignores Host / X-Forwarded-Host on an HTTPS instance: the origin is the pinned issuer', async () => {
      const res = await download()
        .set('X-Test-Role', 'ADMIN')
        .set('X-Forwarded-Host', 'evil.example.net')
        .expect(200);
      const files = await unzip(res.body as Buffer);
      expect(Object.values(files).join('\n')).not.toContain('evil.example.net');
    });

    it('on lan (AUTH_TRUST_HOST) renders the personal-token variant for the host the caller reached', async () => {
      delete process.env.WEB_ORIGIN;
      process.env.AUTH_TRUST_HOST = 'true';
      const res = await download()
        .set('X-Test-Role', 'MEMBER')
        .set('Host', '192.168.1.20:8080')
        .expect(200);
      const files = await unzip(res.body as Buffer);
      expect(parseJson(files['.mcp.json'])).toEqual({
        mcpServers: {
          lazyit: {
            type: 'http',
            url: 'http://192.168.1.20:8080/mcp',
            headers: { Authorization: 'Bearer ${user_config.token}' },
          },
        },
      });
      expect(
        parseJson(files['.claude-plugin/plugin.json']).userConfig?.token
          .sensitive,
      ).toBe(true);
    });

    it('on lan refuses a malformed Host with 409 ORIGIN_UNKNOWN, never a half-built origin', async () => {
      delete process.env.WEB_ORIGIN;
      process.env.AUTH_TRUST_HOST = 'true';
      const res = await download()
        .set('X-Test-Role', 'MEMBER')
        .set('X-Forwarded-Host', 'a"b/c')
        .expect(409);
      expect(parseJson((res.body as Buffer).toString()).code).toBe(
        'ORIGIN_UNKNOWN',
      );
    });

    it('on lan without a pinned origin or AUTH_TRUST_HOST answers 409 ORIGIN_UNKNOWN', async () => {
      delete process.env.WEB_ORIGIN;
      await download().set('X-Test-Role', 'MEMBER').expect(409);
    });
  });

  describe('public marketplace — GET /ai/claude-code/marketplace.json and /lazyit-plugin.zip', () => {
    it('serves the marketplace anonymously on an HTTPS instance with MCP on, pinned to the public archive', async () => {
      const market = await request(server())
        .get('/ai/claude-code/marketplace.json')
        .expect(200);
      expect(market.headers['content-type']).toMatch(/^application\/json/);
      expect(market.headers['cache-control']).toBe('no-cache');
      const body = market.body as {
        plugins: { source: { url: string; sha256: string } }[];
      };
      const source = body.plugins[0].source;
      expect(source.url).toBe(`${HTTPS}/api/ai/claude-code/lazyit-plugin.zip`);
      expect(market.headers.etag).toBe(`"${source.sha256}"`);

      const archive = await request(server())
        .get('/ai/claude-code/lazyit-plugin.zip')
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(archive.headers['content-type']).toBe('application/zip');
      expect(archive.headers.etag).toBe(`"${source.sha256}"`);
      expect(
        createHash('sha256')
          .update(archive.body as Buffer)
          .digest('hex'),
      ).toBe(source.sha256);
    });

    it('the public archive carries no tool index, no userConfig and no token header', async () => {
      const res = await request(server())
        .get('/ai/claude-code/lazyit-plugin.zip')
        .buffer(true)
        .parse(binary)
        .expect(200);
      const files = await unzip(res.body as Buffer);
      expect(Object.keys(files).sort()).toEqual([
        '.claude-plugin/plugin.json',
        '.mcp.json',
        'skills/lazyit/SKILL.md',
        'skills/lazyit/reference/domain.md',
      ]);
      expect(Object.values(files).join('\n')).not.toContain('${');
      expect(Object.values(files).join('\n')).not.toContain('search_assets');
    });

    it('answers 304 to a matching If-None-Match', async () => {
      const first = await request(server())
        .get('/ai/claude-code/marketplace.json')
        .expect(200);
      const etag = first.headers.etag;
      await request(server())
        .get('/ai/claude-code/marketplace.json')
        .set('If-None-Match', etag)
        .expect(304);
      await request(server())
        .get('/ai/claude-code/lazyit-plugin.zip')
        .set('If-None-Match', `W/${etag}`)
        .expect(304);
    });

    it.each([
      [
        'MCP off',
        () => {
          mcpEnabled = false;
        },
      ],
      [
        'lan (no pinned origin)',
        () => {
          delete process.env.WEB_ORIGIN;
          process.env.AUTH_TRUST_HOST = 'true';
        },
      ],
      [
        'an http:// pinned origin',
        () => {
          process.env.WEB_ORIGIN = 'http://lazyit.lan';
        },
      ],
      [
        'shim mode',
        () => {
          process.env.AUTH_MODE = 'shim';
        },
      ],
    ])('is absent (404) with %s', async (_label, arrange) => {
      arrange();
      await request(server())
        .get('/ai/claude-code/marketplace.json')
        .set('Host', 'lazyit.lan')
        .expect(404);
      await request(server())
        .get('/ai/claude-code/lazyit-plugin.zip')
        .set('Host', 'lazyit.lan')
        .expect(404);
    });
  });

  it('never renders a secret, a database or internal host, or a token into any surface', async () => {
    const bodies: string[] = [];
    const auth = await download().set('X-Test-Role', 'ADMIN').expect(200);
    bodies.push(...Object.values(await unzip(auth.body as Buffer)));
    const pub = await request(server())
      .get('/ai/claude-code/lazyit-plugin.zip')
      .buffer(true)
      .parse(binary)
      .expect(200);
    bodies.push(...Object.values(await unzip(pub.body as Buffer)));
    const market = await request(server())
      .get('/ai/claude-code/marketplace.json')
      .expect(200);
    bodies.push(market.text);

    delete process.env.WEB_ORIGIN;
    process.env.AUTH_TRUST_HOST = 'true';
    const lan = await download()
      .set('X-Test-Role', 'ADMIN')
      .set('Host', '10.0.0.5')
      .expect(200);
    bodies.push(...Object.values(await unzip(lan.body as Buffer)));

    const all = bodies.join('\n');
    for (const value of [
      ...Object.values(SENTINELS),
      'sentinel',
      'db-internal',
      'api-internal-host',
    ]) {
      expect(all).not.toContain(value);
    }
    expect(all).not.toMatch(/lzit_(pat|oat|ort|sa)_[A-Za-z0-9_-]{6,}/);
  });
});
