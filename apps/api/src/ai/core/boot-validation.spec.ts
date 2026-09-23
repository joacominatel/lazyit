import {
  Controller,
  Get,
  Injectable,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type NestInterceptor,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';

// The exclusion list imports real controllers; stub what cannot load under Jest (see tool-coverage.spec).
jest.mock('../../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../../generated/prisma/enums',
  );
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
    construct: () => inert as object,
  });
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: inert };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import { Public } from '../../auth/public.decorator';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../../auth/service-principal-forbidden.guard';
import { ServiceOnlyGuard } from '../../secret-manager/service-only.guard';
import { ServiceAccountsController } from '../../service-accounts/service-accounts.controller';
import { UsersController } from '../../users/users.controller';
import { AiToolRegistryError, validateToolsets } from './boot-validation';
import { AiToolDispatcher } from './tool-dispatcher';
import {
  bind,
  defineTool,
  unexposed,
  type AiToolDescriptor,
  type AiToolset,
} from './tool-descriptor';
import { AI_TOOLSETS, AiToolRegistry } from './tool-registry';

@Injectable()
class PerIpRateLimitGuard implements CanActivate {
  canActivate() {
    return true;
  }
}

@Injectable()
class UploadInterceptor implements NestInterceptor {
  intercept(_ctx: unknown, next: { handle: () => unknown }) {
    return next.handle() as never;
  }
}

@Controller('fixtures')
class FixtureController {
  @Get()
  @RequirePermission('asset:read')
  read() {
    return [];
  }

  @Get('open')
  open() {
    return {};
  }

  @Get('pair')
  @RequirePermission('infra:manage', 'asset:write')
  pair() {
    return {};
  }

  @Get('humans')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @RequirePermission('asset:read')
  humansOnly() {
    return {};
  }

  @Get('services')
  @UseGuards(ServiceOnlyGuard)
  @RequirePermission('secret:fetch')
  servicesOnly() {
    return {};
  }

  @Get('public')
  @Public()
  pub() {
    return {};
  }

  @Get('raw')
  @RequirePermission('asset:read')
  raw(@Res() res: unknown) {
    return { res };
  }

  @Post('upload')
  @RequirePermission('asset:write')
  @UseInterceptors(UploadInterceptor)
  upload(@UploadedFile() file: unknown) {
    return { file };
  }

  @Post('limited')
  @UseGuards(PerIpRateLimitGuard)
  @RequirePermission('asset:read')
  limited() {
    return {};
  }

  notARoute() {
    return {};
  }
}

@Controller('secret-vaults/extra')
class LookalikeSecretController {
  @Get()
  @RequirePermission('asset:read')
  list() {
    return [];
  }
}

@Controller('ai-helpers')
class PrefixNeighbourController {
  @Get()
  @RequirePermission('asset:read')
  list() {
    return [];
  }
}

class NotAController {
  @Get()
  get() {
    return {};
  }
}

function tool(overrides: Partial<AiToolDescriptor> = {}): AiToolDescriptor {
  return defineTool({
    name: 'fixture_read',
    title: 'Fixture read',
    description: 'Reads the fixture.',
    domain: 'context',
    class: 'read',
    input: z.strictObject({ q: z.string().optional() }),
    bindings: [bind(FixtureController, 'read')],
    run: () => Promise.resolve({ data: null }),
    ...overrides,
  });
}

function toolset(
  tools: AiToolDescriptor[],
  unexposedEntries: AiToolset['unexposed'] = [],
): AiToolset[] {
  return [{ domain: 'context', tools, unexposed: unexposedEntries }];
}

function problemsOf(toolsets: AiToolset[]): readonly string[] {
  try {
    validateToolsets(toolsets);
  } catch (err) {
    expect(err).toBeInstanceOf(AiToolRegistryError);
    return (err as AiToolRegistryError).problems;
  }
  throw new Error('expected validation to fail');
}

/**
 * BOOT VALIDATION (tools-and-execution.md §8.3). The registry refuses to start on a bad descriptor or a
 * binding the in-process dispatcher could not run without losing enforcement — every rule fails loud.
 */
describe('AI tool registry — boot validation', () => {
  it('registers a valid tool and derives its permission and principal kinds from the route', () => {
    const [registered] = validateToolsets(toolset([tool()]));
    expect(registered.permissions).toEqual(['asset:read']);
    expect(registered.principalKinds).toEqual({ human: true, service: true });
    expect(registered.route).toEqual({ method: 'GET', path: '/fixtures' });
    expect(registered.channels).toEqual(['CHAT', 'MCP', 'HEADLESS']);
    expect(registered.inputSchema.type).toBe('object');
    expect(registered.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(registered.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('derives an AND pair, and an ungated route as human-only (RolesGuard is fail-closed for SAs)', () => {
    const [pair, open] = validateToolsets(
      toolset([
        tool({ name: 'pair', bindings: [bind(FixtureController, 'pair')] }),
        tool({ name: 'open', bindings: [bind(FixtureController, 'open')] }),
      ]),
    );
    expect(pair.permissions).toEqual(['infra:manage', 'asset:write']);
    expect(open.permissions).toEqual([]);
    expect(open.principalKinds).toEqual({ human: true, service: false });
  });

  it('derives the principal kinds the handler guards admit', () => {
    const [humans, services] = validateToolsets(
      toolset([
        tool({
          name: 'humans',
          bindings: [bind(FixtureController, 'humansOnly')],
        }),
        tool({
          name: 'services',
          bindings: [bind(FixtureController, 'servicesOnly')],
        }),
      ]),
    );
    expect(humans.principalKinds).toEqual({ human: true, service: false });
    expect(services.principalKinds).toEqual({ human: false, service: true });
  });

  it.each([
    ['a bad name', { name: 'Bad-Name' }, 'name must match'],
    ['a name over 40 characters', { name: 'a'.repeat(41) }, 'name must match'],
    ['an unknown class', { class: 'admin' as never }, 'unknown class'],
    [
      'a write without a preview',
      { class: 'write' as const },
      'must declare a preview',
    ],
    [
      'an elevated tool without a preview',
      { class: 'elevated' as const },
      'must declare a preview',
    ],
    [
      'an unrepresentable input schema',
      { input: z.strictObject({ at: z.date() }) },
      'not representable as JSON Schema',
    ],
    ['a non-object input', { input: z.string() }, 'must be an object schema'],
    [
      'a navigate tool on MCP',
      { class: 'navigate' as const, channels: ['CHAT', 'MCP'] as const },
      'navigate tool is chat-only',
    ],
    [
      'a domain that differs from its toolset',
      { domain: 'assets' as const },
      'declared in the context toolset',
    ],
    [
      'a method that is not a route handler',
      { bindings: [bind(FixtureController, 'notARoute')] as const },
      'is not a route handler',
    ],
    [
      'a class that is not a controller',
      { bindings: [bind(NotAController, 'get')] as const },
      'is not a Nest controller',
    ],
    [
      'a @Public() route',
      { bindings: [bind(FixtureController, 'pub')] as const },
      'is @Public()',
    ],
    [
      'a handler taking @Res()',
      { bindings: [bind(FixtureController, 'raw')] as const },
      'RESPONSE',
    ],
    [
      'an upload handler',
      { bindings: [bind(FixtureController, 'upload')] as const },
      'upload handlers cannot be tools',
    ],
    [
      'a network-keyed guard',
      { bindings: [bind(FixtureController, 'limited')] as const },
      'non-allowlisted guards (PerIpRateLimitGuard)',
    ],
    [
      'an excluded route prefix (Secret Manager)',
      { bindings: [bind(LookalikeSecretController, 'list')] as const },
      'structurally excluded',
    ],
    [
      'a Service Account token create (credential in cleartext)',
      { bindings: [bind(ServiceAccountsController, 'create')] as const },
      'structurally excluded (returns a credential in cleartext)',
    ],
    [
      'a temporary-password provisioning',
      { bindings: [bind(UsersController, 'provisionLocalAccount')] as const },
      'structurally excluded',
    ],
    [
      'an excluded handler as a secondary binding',
      {
        bindings: [
          bind(FixtureController, 'read'),
          bind(ServiceAccountsController, 'rotate'),
        ] as const,
      },
      'structurally excluded',
    ],
  ])('fails loud on %s', (_label, overrides, expected) => {
    const problems = problemsOf(toolset([tool(overrides)]));
    expect(problems.join('\n')).toContain(expected);
  });

  it('matches excluded prefixes by path segment, not by string prefix', () => {
    expect(() =>
      validateToolsets(
        toolset([
          tool({ bindings: [bind(PrefixNeighbourController, 'list')] }),
        ]),
      ),
    ).not.toThrow();
  });

  it('refuses duplicate names', () => {
    const problems = problemsOf(toolset([tool(), tool()]));
    expect(problems).toContain('tool fixture_read: duplicate tool name');
  });

  it('reports every problem at once', () => {
    const problems = problemsOf(
      toolset([
        tool({ name: 'BAD' }),
        tool({ name: 'raw', bindings: [bind(FixtureController, 'raw')] }),
      ]),
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  describe('unexposed entries', () => {
    it('must name real route handlers', () => {
      const problems = problemsOf(
        toolset([], [unexposed(FixtureController, ['notARoute'], 'why')]),
      );
      expect(problems.join('\n')).toContain('is not a route handler');
    });

    it('must not overlap a bound handler', () => {
      const problems = problemsOf(
        toolset([tool()], [unexposed(FixtureController, ['read'], 'why')]),
      );
      expect(problems.join('\n')).toContain(
        'bound by a tool and listed as unexposed',
      );
    });

    it('must not list a handler twice', () => {
      const problems = problemsOf(
        toolset(
          [],
          [
            unexposed(FixtureController, ['open'], 'one'),
            unexposed(FixtureController, ['open'], 'two'),
          ],
        ),
      );
      expect(problems.join('\n')).toContain('listed twice');
    });

    it('must carry a reason', () => {
      const problems = problemsOf(
        toolset([], [unexposed(FixtureController, ['open'], ' ')]),
      );
      expect(problems.join('\n')).toContain('needs a reason');
    });
  });
});

describe('AI tool registry — boot resolution against the running application', () => {
  async function boot(toolsets: AiToolset[]) {
    const moduleRef = await Test.createTestingModule({
      controllers: [FixtureController],
      providers: [
        AiToolDispatcher,
        AiToolRegistry,
        { provide: AI_TOOLSETS, useValue: toolsets },
      ],
    }).compile();
    await moduleRef.init();
    return moduleRef;
  }

  it('boots and serves a tool whose controller is registered', async () => {
    const moduleRef = await boot(toolset([tool()]));
    const registry = moduleRef.get(AiToolRegistry);
    expect(registry.get('fixture_read')?.route.path).toBe('/fixtures');
    expect(registry.all().map((t) => t.descriptor.name)).toEqual([
      'fixture_read',
    ]);
    await moduleRef.close();
  });

  it('refuses to boot when a binding names a controller the application does not register', async () => {
    await expect(
      boot(
        toolset([
          tool({ bindings: [bind(PrefixNeighbourController, 'list')] }),
        ]),
      ),
    ).rejects.toThrow(/not registered in any module/);
  });

  it('refuses to boot on an invalid descriptor', async () => {
    await expect(boot(toolset([tool({ name: 'Nope' })]))).rejects.toThrow(
      AiToolRegistryError,
    );
  });
});
