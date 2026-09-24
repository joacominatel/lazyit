import { z } from 'zod';

// Only the tool descriptors are read; their controllers' Prisma/IdP imports are stubbed.
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

import { ALL_TOOLSETS } from '.';
import { AI_SEARCH_TEXT_MAX, searchText } from './search-text';

/**
 * List mode for every search tool (#1374): a tool whose free-text `query` is optional must LIST when it
 * gets none — and a blank one (`""`, whitespace) is "none", as an absent `q` is for the route. A model
 * asked for "every admin" sends `query: ""` with the filter; that used to fail validation and the model
 * retried the same call.
 */
const TOOLS = ALL_TOOLSETS.flatMap((set) => set.tools);

function jsonSchemaOf(input: z.ZodType) {
  return z.toJSONSchema(input, { io: 'input' }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

const OPTIONAL_QUERY = TOOLS.filter((tool) => {
  const schema = jsonSchemaOf(tool.input);
  return (
    schema.properties?.query !== undefined &&
    !(schema.required ?? []).includes('query')
  );
}).map((tool) => tool.name);

describe('search tools list without text (#1374)', () => {
  it('covers every search/list tool with a free-text query', () => {
    expect([...OPTIONAL_QUERY].sort()).toEqual(
      [
        'activity_list',
        'application_search',
        'asset_search',
        'consumable_search',
        'infra_node_search',
        'kb_search',
        'reference_lookup',
        'user_search',
      ].sort(),
    );
  });

  it.each(OPTIONAL_QUERY)(
    '%s: a blank query is no text filter, never a validation error',
    (name) => {
      const tool = TOOLS.find((t) => t.name === name)!;
      for (const blank of ['', '   ', '\t']) {
        const parsed = tool.input.safeParse({ query: blank });
        const queryIssues = parsed.success
          ? []
          : parsed.error.issues.filter((i) => i.path[0] === 'query');
        expect(queryIssues).toEqual([]);
        if (parsed.success) {
          expect((parsed.data as { query?: unknown }).query).toBeUndefined();
        }
      }
      // Text is still trimmed and bounded.
      const text = tool.input.safeParse({ query: '  vpn  ' });
      if (text.success) {
        expect((text.data as { query?: unknown }).query).toBe('vpn');
      }
      expect(
        tool.input.safeParse({ query: 'x'.repeat(AI_SEARCH_TEXT_MAX + 1) })
          .success,
      ).toBe(false);
    },
  );

  it('the listed JSON Schema is a plain optional string (the blank mapping is not part of it)', () => {
    const schema = jsonSchemaOf(z.strictObject({ query: searchText('Text.') }));
    expect(schema.required ?? []).not.toContain('query');
    expect(schema.properties?.query).toEqual({
      type: 'string',
      maxLength: AI_SEARCH_TEXT_MAX,
      description:
        'Text. Omit it to list by the other filters alone (no text filter).',
    });
  });

  it('asset_search: a blank query does not count as a filter next to mine', () => {
    const tool = TOOLS.find((t) => t.name === 'asset_search')!;
    expect(tool.input.safeParse({ mine: true, query: '' }).success).toBe(true);
    expect(tool.input.safeParse({ mine: true, query: 'vpn' }).success).toBe(
      false,
    );
  });

  it('lazyit_search keeps a required query and points to the list-capable tools', () => {
    const tool = TOOLS.find((t) => t.name === 'lazyit_search')!;
    expect(jsonSchemaOf(tool.input).required).toContain('query');
    expect(tool.description).toMatch(/user_search/);
  });
});
