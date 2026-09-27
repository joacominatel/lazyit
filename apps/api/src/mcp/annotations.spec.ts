import type { AiToolListing } from '../ai/core/tool-descriptor';
import { isMcpListable, toMcpAnnotations } from './annotations';
import { scopesToCeiling } from './mcp-caller';

function listing(
  over: Partial<AiToolListing> & Pick<AiToolListing, 'class'>,
): AiToolListing {
  return {
    name: 'x',
    title: 'X',
    description: 'x',
    inputSchema: {},
    permissions: [],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    ...over,
  };
}

describe('MCP annotations from the tool class (R4; mcp-and-oauth.md §5.3)', () => {
  it('read: read-only, idempotent, closed-world — every hint explicit', () => {
    expect(toMcpAnnotations(listing({ class: 'read', title: 'Get' }))).toEqual({
      title: 'Get',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('additive write: not destructive (an omitted hint would default to destructive)', () => {
    expect(toMcpAnnotations(listing({ class: 'write' }))).toEqual({
      title: 'X',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('destructive write carries the registry flags (destructive, idempotent, external effects)', () => {
    expect(
      toMcpAnnotations(
        listing({
          class: 'write',
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        }),
      ),
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('elevated is always destructive', () => {
    expect(
      toMcpAnnotations(listing({ class: 'elevated' })).destructiveHint,
    ).toBe(true);
  });

  it('navigate is never listed over MCP', () => {
    expect(isMcpListable('navigate')).toBe(false);
    expect(isMcpListable('read')).toBe(true);
    expect(isMcpListable('write')).toBe(true);
    expect(isMcpListable('elevated')).toBe(true);
  });
});

describe('the scope hierarchy (R7)', () => {
  it.each([
    [['lazyit.read'], ['read']],
    [['lazyit.write'], ['read', 'write']],
    [
      ['lazyit.read', 'lazyit.write'],
      ['read', 'write'],
    ],
    [['lazyit.admin'], ['read', 'elevated']],
    [
      ['lazyit.read', 'lazyit.write', 'lazyit.admin'],
      ['read', 'write', 'elevated'],
    ],
    [[], []],
  ] as const)('%j → %j', (scopes, ceiling) => {
    expect(scopesToCeiling(scopes)).toEqual(ceiling);
  });
});
