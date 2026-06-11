import { ALLOWED_ROOTS, mapData, renderTemplate } from './data-mapper';
import {
  freezeMappingContext,
  type WorkflowMappingContext,
} from '../handlers/step-handler';

/** The ADR-0058 grantee identity fields a ctx override must still carry (legajo/username/manager). */
const GRANTEE_DEFAULTS = {
  legajo: null,
  username: null,
  manager: { name: null, email: null, isOffboarded: false },
} satisfies Pick<
  WorkflowMappingContext['grantee'],
  'legajo' | 'username' | 'manager'
>;

function makeCtx(
  overrides: Partial<WorkflowMappingContext> = {},
): WorkflowMappingContext {
  return freezeMappingContext({
    event: 'ACCESS_GRANTED',
    grantee: {
      id: 'usr_1',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      ...GRANTEE_DEFAULTS,
    },
    application: { id: 'app_1', name: 'Jira' },
    grant: {
      id: 'grant_1',
      accessLevel: 'developer',
      grantedAt: '2026-06-08T00:00:00.000Z',
      expiresAt: null,
    },
    steps: {},
    ...overrides,
  });
}

describe('data-mapper — renderTemplate', () => {
  it('interpolates allowlisted ctx paths', () => {
    const ctx = makeCtx();
    expect(renderTemplate('{{ grantee.email }}', ctx, 'json')).toBe(
      'ada@example.com',
    );
    expect(
      renderTemplate(
        '{{ grantee.firstName }} {{ grantee.lastName }}',
        ctx,
        'json',
      ),
    ).toBe('Ada Lovelace');
    expect(renderTemplate('{{ application.name }}', ctx, 'json')).toBe('Jira');
    expect(renderTemplate('{{ event }}', ctx, 'json')).toBe('ACCESS_GRANTED');
  });

  it('reads prior step outputs (manual input feeding a later step)', () => {
    const ctx = makeCtx({ steps: { pick_team: { team: 'platform' } } });
    expect(renderTemplate('{{ steps.pick_team.team }}', ctx, 'json')).toBe(
      'platform',
    );
  });

  it('applies the closed filter set (lower/upper/trim/default)', () => {
    const ctx = makeCtx({
      steps: { s: { blank: '', name: '  Bob  ' } },
    });
    expect(renderTemplate('{{ grantee.email | upper }}', ctx, 'json')).toBe(
      'ADA@EXAMPLE.COM',
    );
    expect(renderTemplate('{{ application.name | lower }}', ctx, 'json')).toBe(
      'jira',
    );
    expect(renderTemplate('{{ steps.s.name | trim }}', ctx, 'json')).toBe(
      'Bob',
    );
    expect(
      renderTemplate("{{ steps.s.blank | default:'unassigned' }}", ctx, 'json'),
    ).toBe('unassigned');
  });

  it('treats a missing field as empty (and honours default)', () => {
    const ctx = makeCtx();
    expect(renderTemplate('[{{ grantee.middleName }}]', ctx, 'json')).toBe(
      '[]',
    );
    expect(
      renderTemplate("{{ grant.expiresAt | default:'never' }}", ctx, 'json'),
    ).toBe('never');
  });

  it('only exposes the allowlisted roots', () => {
    expect([...ALLOWED_ROOTS].sort()).toEqual(
      ['application', 'event', 'grant', 'grantee', 'steps'].sort(),
    );
    const ctx = makeCtx();
    // A non-allowlisted root resolves empty even if it existed on the object.
    expect(renderTemplate('[{{ process.env.SECRET }}]', ctx, 'json')).toBe(
      '[]',
    );
    expect(renderTemplate('[{{ constructor.name }}]', ctx, 'json')).toBe('[]');
  });
});

describe('data-mapper — prototype-pollution / SSTI guards', () => {
  const ctx = makeCtx();

  it('rejects __proto__ / prototype / constructor segments', () => {
    expect(renderTemplate('[{{ __proto__.polluted }}]', ctx, 'json')).toBe(
      '[]',
    );
    expect(
      renderTemplate('[{{ grantee.__proto__.toString }}]', ctx, 'json'),
    ).toBe('[]');
    expect(
      renderTemplate('[{{ grantee.constructor.name }}]', ctx, 'json'),
    ).toBe('[]');
    expect(renderTemplate('[{{ application.prototype }}]', ctx, 'json')).toBe(
      '[]',
    );
  });

  it('never re-interprets a resolved value as a template (single pass, no nested SSTI)', () => {
    const evil = makeCtx({
      grantee: {
        id: 'usr_1',
        email: '{{ application.name }}',
        firstName: 'A',
        lastName: 'B',
        ...GRANTEE_DEFAULTS,
      },
    });
    // The literal "{{ application.name }}" coming FROM a ctx value must NOT be expanded.
    expect(renderTemplate('{{ grantee.email }}', evil, 'json')).toBe(
      '{{ application.name }}',
    );
  });

  it('does not mutate / pollute via a mapping target field name', () => {
    // `JSON.parse` creates a REAL own enumerable `__proto__` key (an object literal would not), so
    // this genuinely exercises mapData's blocked-target guard.
    const mapping = JSON.parse(
      '{"__proto__":"{{ grantee.email }}","valid":"{{ grantee.email }}"}',
    ) as Record<string, string>;
    const result = mapData(mapping, ctx, 'json');
    expect(result.values.valid).toBe('ada@example.com');
    // The blocked target name is dropped; no prototype pollution of the output object.
    expect(
      Object.prototype.hasOwnProperty.call(result.values, '__proto__'),
    ).toBe(false);
    expect(({} as Record<string, unknown>).valid).toBeUndefined();
  });

  it('does not interpolate non-scalar leaves (no [object Object] / JSON dumps)', () => {
    const ctx2 = makeCtx({ steps: { s: { nested: { a: 1 } } } });
    expect(renderTemplate('[{{ steps.s.nested }}]', ctx2, 'json')).toBe('[]');
  });
});

describe('data-mapper — context-aware encoding (downstream injection defense)', () => {
  it('JSON body: an injected quote cannot break the payload once stringified', () => {
    const ctx = makeCtx({
      grantee: {
        id: 'usr_1',
        email: 'evil"}],"isAdmin":true,"x":["',
        firstName: 'A',
        lastName: 'B',
        ...GRANTEE_DEFAULTS,
      },
    });
    const mapped = mapData(
      { emailAddress: '{{ grantee.email }}' },
      ctx,
      'json',
    );
    const body = JSON.stringify(mapped.values);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed).toEqual({ emailAddress: 'evil"}],"isAdmin":true,"x":["' });
    expect(parsed.isAdmin).toBeUndefined();
  });

  it('URL: a path-traversal / separator injection is percent-encoded', () => {
    const ctx = makeCtx({
      grantee: {
        id: '../../admin?x=1',
        email: 'a@b.c',
        firstName: 'A',
        lastName: 'B',
        ...GRANTEE_DEFAULTS,
      },
    });
    const rendered = renderTemplate('/v3/user/{{ grantee.id }}', ctx, 'url');
    expect(rendered).toBe('/v3/user/..%2F..%2Fadmin%3Fx%3D1');
    expect(rendered).not.toContain('?');
    expect(rendered.includes('../')).toBe(false);
  });

  it('Header: CR/LF + control chars are stripped (no header injection)', () => {
    const ctx = makeCtx({
      grantee: {
        id: 'usr_1',
        email: 'a@b.c\r\nX-Injected: 1\x00',
        firstName: 'A',
        lastName: 'B',
        ...GRANTEE_DEFAULTS,
      },
    });
    const rendered = renderTemplate('{{ grantee.email }}', ctx, 'header');
    expect(rendered).toBe('a@b.cX-Injected: 1');
    expect(rendered).not.toContain('\r');
    expect(rendered).not.toContain('\n');
  });
});

describe('data-mapper — mapData', () => {
  it('returns the mapped field NAMES (safe to log) and rendered values (not)', () => {
    const ctx = makeCtx();
    const result = mapData(
      {
        emailAddress: '{{ grantee.email }}',
        displayName: '{{ grantee.firstName }} {{ grantee.lastName }}',
      },
      ctx,
      'json',
    );
    expect(result.fieldNames.sort()).toEqual(['displayName', 'emailAddress']);
    expect(result.values.emailAddress).toBe('ada@example.com');
    expect(result.values.displayName).toBe('Ada Lovelace');
  });

  it('handles an undefined / empty mapping', () => {
    const ctx = makeCtx();
    expect(mapData(undefined, ctx, 'json')).toEqual({
      values: {},
      fieldNames: [],
    });
    expect(mapData({}, ctx, 'json')).toEqual({ values: {}, fieldNames: [] });
  });
});
