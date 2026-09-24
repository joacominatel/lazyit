import { ForbiddenException } from '@nestjs/common';
import { mapToolError } from './error-mapper';
import {
  AI_AMBIGUITY_SAMPLE,
  AiReferenceError,
  entityRefOf,
  resolveReference,
} from './reference-resolver';
import { errorResult } from './result-shaper';

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Human-readable references resolve to exactly one entity through the tool's bound lookup, or fail with
 * a tool error the model can act on (tools-and-execution.md §7 "References").
 */
describe('resolveReference', () => {
  it('passes a raw id straight through without a lookup', async () => {
    const lookup = jest.fn();
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    await expect(
      resolveReference({
        type: 'user',
        reference: id,
        isId: (r) => UUID.test(r),
        lookup,
      }),
    ).resolves.toEqual({ type: 'user', id });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('resolves a unique match with its label and slug', async () => {
    await expect(
      resolveReference({
        type: 'article',
        reference: ' vpn-setup ',
        lookup: (r) =>
          Promise.resolve([{ id: 'k1', label: 'VPN setup', slug: r }]),
      }),
    ).resolves.toEqual({
      type: 'article',
      id: 'k1',
      label: 'VPN setup',
      slug: 'vpn-setup',
    });
  });

  it('dedupes the same entity matched twice', async () => {
    await expect(
      resolveReference({
        type: 'asset',
        reference: 'LT-1',
        lookup: () =>
          Promise.resolve([
            { id: 'a1', label: 'LT-1' },
            { id: 'a1', label: 'LT-1' },
          ]),
      }),
    ).resolves.toMatchObject({ id: 'a1' });
  });

  it('fails NOT_FOUND when nothing matches', async () => {
    const err = await resolveReference({
      type: 'asset',
      reference: 'LT-404',
      lookup: () => Promise.resolve([]),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiReferenceError);
    expect(mapToolError(err)).toEqual({
      code: 'NOT_FOUND',
      status: 404,
      message: 'No asset matches "LT-404"',
    });
  });

  it('fails AMBIGUOUS_REFERENCE with at most five candidates in the hint', async () => {
    const err = await resolveReference({
      type: 'asset',
      reference: 'Laptop',
      lookup: () =>
        Promise.resolve(
          Array.from({ length: 8 }, (_, i) => ({
            id: `a${i}`,
            label: `LT-${i}`,
          })),
        ),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiReferenceError);
    const reference = err as AiReferenceError;
    expect(reference.candidates).toHaveLength(AI_AMBIGUITY_SAMPLE);
    const mapped = mapToolError(err);
    expect(mapped).toMatchObject({
      code: 'AMBIGUOUS_REFERENCE',
      status: 409,
      hint: 'Candidates: LT-0 (asset a0), LT-1 (asset a1), LT-2 (asset a2), LT-3 (asset a3), LT-4 (asset a4)',
    });
    const result = errorResult('mutation', mapped);
    expect(result.ok ? undefined : result.error.hint).toContain('LT-4');
  });

  it('propagates the route refusal of the lookup unchanged (a resolution the caller may not read)', async () => {
    const err = await resolveReference({
      type: 'user',
      reference: 'someone@example.com',
      lookup: () => Promise.reject(new ForbiddenException()),
    }).catch((e: unknown) => e);
    expect(mapToolError(err)).toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('refuses an empty reference', async () => {
    await expect(
      resolveReference({ type: 'asset', reference: '   ' }),
    ).rejects.toBeInstanceOf(AiReferenceError);
  });

  it('builds the entity ref a result or preview carries', () => {
    expect(
      entityRefOf({ type: 'asset', id: 'a1', label: 'LT-1' }, 'updated'),
    ).toEqual({ type: 'asset', id: 'a1', op: 'updated', label: 'LT-1' });
    expect(
      entityRefOf({ type: 'accessGrant', id: 'g1' }, 'created', {
        type: 'application',
        id: 'app1',
      }),
    ).toEqual({
      type: 'accessGrant',
      id: 'g1',
      op: 'created',
      parent: { type: 'application', id: 'app1' },
    });
  });
});
