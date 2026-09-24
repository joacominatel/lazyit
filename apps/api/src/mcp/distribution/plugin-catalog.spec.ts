// Only decorator metadata is read (the same stubs as `tool-coverage.spec.ts`): the shipped toolsets import
// every domain controller, so stub what cannot load under Jest.
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
  SignJWT: jest.fn(),
}));

import 'reflect-metadata';
import { validateToolsets } from '../../ai/core/boot-validation';
import { ALL_TOOLSETS } from '../../ai/tools';
import { type PluginToolEntry, renderPluginFiles } from './plugin-renderer';

/**
 * The tool index rendered from the SHIPPED catalog — what the live registry holds after boot. Every tool
 * an MCP client can be offered appears once, with the permission derived from its route, and no tool
 * description carries a sequence Claude Code would substitute or execute (the renderer would refuse it,
 * which would break the download: this spec catches that at CI time, not in production).
 */
describe('Claude Code plugin — tool index from the shipped catalog', () => {
  const registered = validateToolsets(ALL_TOOLSETS);
  const entries: PluginToolEntry[] = registered.map((tool) => ({
    name: tool.descriptor.name,
    title: tool.descriptor.title,
    description: tool.descriptor.description,
    class: tool.descriptor.class,
    permissions: tool.permissions,
    channels: tool.channels,
  }));

  it.each(['oauth', 'personal-token'] as const)(
    'renders every MCP tool exactly once (%s)',
    (auth) => {
      const files = renderPluginFiles({
        origin: 'https://lazyit.example.com',
        auth,
        tools: entries,
      });
      const index = files.find(
        (f) => f.path === 'skills/lazyit/reference/tools.md',
      )?.content;
      expect(index).toBeDefined();
      const listed = (index ?? '')
        .split('\n')
        .filter((line) => line.startsWith('| `'))
        .map((line) => /^\| `([a-z0-9_]+)`/.exec(line)?.[1]);
      const mcpTools = registered
        .filter((tool) => tool.channels.includes('MCP'))
        .map((tool) => tool.descriptor.name)
        .sort((a, b) => a.localeCompare(b));
      expect(mcpTools.length).toBeGreaterThan(0);
      expect(listed).toEqual(mcpTools);
      const chatOnly = registered.filter(
        (tool) => !tool.channels.includes('MCP'),
      );
      for (const tool of chatOnly) {
        expect(index).not.toContain(`\`${tool.descriptor.name}\``);
      }
    },
  );
});
