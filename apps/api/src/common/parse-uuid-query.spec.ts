import { BadRequestException } from '@nestjs/common';
import { parseUuidQuery } from './parse-uuid-query';

// SEC-004 — unvalidated uuid query filters must be rejected with 400 before they reach Postgres.
describe('parseUuidQuery', () => {
  const VALID = '11111111-1111-4111-8111-111111111111';

  it('passes through an absent filter (undefined)', () => {
    expect(parseUuidQuery(undefined, 'userId')).toBeUndefined();
  });

  it('returns a well-formed uuid unchanged', () => {
    expect(parseUuidQuery(VALID, 'userId')).toBe(VALID);
  });

  it('throws 400 on a malformed uuid', () => {
    expect(() => parseUuidQuery('not-a-uuid', 'authorId')).toThrow(
      BadRequestException,
    );
    expect(() => parseUuidQuery('', 'authorId')).toThrow(BadRequestException);
  });
});
