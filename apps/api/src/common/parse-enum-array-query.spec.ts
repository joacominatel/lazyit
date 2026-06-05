import { BadRequestException } from '@nestjs/common';
import { ArticleStatusSchema } from '@lazyit/shared';
import { parseEnumArrayQuery } from './parse-enum-array-query';

// #198 — multi-value enum query filter against an allowlist. An unknown element is a clean 400
// (ADR-0030: never silently ignored); single values stay backward-compatible.
describe('parseEnumArrayQuery', () => {
  it('passes through an absent filter (undefined)', () => {
    expect(
      parseEnumArrayQuery(undefined, ArticleStatusSchema, 'status'),
    ).toBeUndefined();
  });

  it('returns a single value as a one-element array (backward-compat)', () => {
    expect(parseEnumArrayQuery('DRAFT', ArticleStatusSchema, 'status')).toEqual([
      'DRAFT',
    ]);
  });

  it('splits a comma-encoded list into an array', () => {
    expect(
      parseEnumArrayQuery('DRAFT,PUBLISHED', ArticleStatusSchema, 'status'),
    ).toEqual(['DRAFT', 'PUBLISHED']);
  });

  it('accepts a repeated param (string[])', () => {
    expect(
      parseEnumArrayQuery(['DRAFT', 'PUBLISHED'], ArticleStatusSchema, 'status'),
    ).toEqual(['DRAFT', 'PUBLISHED']);
  });

  it('trims whitespace, drops empties and de-duplicates', () => {
    expect(
      parseEnumArrayQuery(
        ' DRAFT , , PUBLISHED , DRAFT ',
        ArticleStatusSchema,
        'status',
      ),
    ).toEqual(['DRAFT', 'PUBLISHED']);
  });

  it('returns undefined when the value resolves to no elements', () => {
    expect(
      parseEnumArrayQuery(' , , ', ArticleStatusSchema, 'status'),
    ).toBeUndefined();
  });

  it('throws 400 when any element is outside the allowlist', () => {
    expect(() =>
      parseEnumArrayQuery('DRAFT,ARCHIVED', ArticleStatusSchema, 'status'),
    ).toThrow(BadRequestException);
  });
});
