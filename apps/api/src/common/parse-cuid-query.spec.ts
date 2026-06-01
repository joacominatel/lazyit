import { BadRequestException } from '@nestjs/common';
import { parseCuidQuery } from './parse-cuid-query';

// SEC-004 — unvalidated cuid query filters must be rejected with 400 before they reach Postgres
// (otherwise a garbage filter silently matches nothing and returns an empty list).
describe('parseCuidQuery', () => {
  const VALID = 'clh1abc0000xyz0000000abcd';

  it('passes through an absent filter (undefined)', () => {
    expect(parseCuidQuery(undefined, 'categoryId')).toBeUndefined();
  });

  it('returns a well-formed cuid unchanged', () => {
    expect(parseCuidQuery(VALID, 'categoryId')).toBe(VALID);
  });

  it('throws 400 on a malformed cuid', () => {
    expect(() => parseCuidQuery('not-a-cuid!', 'locationId')).toThrow(
      BadRequestException,
    );
    expect(() => parseCuidQuery('', 'locationId')).toThrow(BadRequestException);
  });

  it('rejects a uuid passed where a cuid is expected', () => {
    expect(() =>
      parseCuidQuery('11111111-1111-4111-8111-111111111111', 'applicationId'),
    ).toThrow(BadRequestException);
  });
});
