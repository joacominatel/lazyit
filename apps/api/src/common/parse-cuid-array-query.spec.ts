import { BadRequestException } from '@nestjs/common';
import { parseCuidArrayQuery } from './parse-cuid-array-query';

// #198 — multi-value cuid query filter (the array counterpart of parseCuidQuery). A garbage element
// must still be a clean 400 (never a silently-empty list); single values stay backward-compatible.
describe('parseCuidArrayQuery', () => {
  const A = 'clh1abc0000xyz0000000abcd';
  const B = 'clh2def0000xyz0000000abcd';

  it('passes through an absent filter (undefined)', () => {
    expect(parseCuidArrayQuery(undefined, 'categoryId')).toBeUndefined();
  });

  it('returns a single cuid as a one-element array (backward-compat)', () => {
    expect(parseCuidArrayQuery(A, 'categoryId')).toEqual([A]);
  });

  it('splits a comma-encoded list into an array', () => {
    expect(parseCuidArrayQuery(`${A},${B}`, 'categoryId')).toEqual([A, B]);
  });

  it('accepts a repeated param (string[])', () => {
    expect(parseCuidArrayQuery([A, B], 'categoryId')).toEqual([A, B]);
  });

  it('trims whitespace and drops empty segments', () => {
    expect(parseCuidArrayQuery(` ${A} , , ${B} `, 'categoryId')).toEqual([A, B]);
  });

  it('de-duplicates repeated values (set semantics for `in`)', () => {
    expect(parseCuidArrayQuery(`${A},${A},${B}`, 'categoryId')).toEqual([A, B]);
  });

  it('returns undefined when the value resolves to no elements', () => {
    expect(parseCuidArrayQuery(' , , ', 'categoryId')).toBeUndefined();
    expect(parseCuidArrayQuery('', 'categoryId')).toBeUndefined();
  });

  it('throws 400 when any element is a malformed cuid', () => {
    expect(() => parseCuidArrayQuery(`${A},not-a-cuid!`, 'categoryId')).toThrow(
      BadRequestException,
    );
  });

  it('throws 400 for a uuid element where a cuid is expected', () => {
    expect(() =>
      parseCuidArrayQuery(
        `${A},11111111-1111-4111-8111-111111111111`,
        'categoryId',
      ),
    ).toThrow(BadRequestException);
  });
});
