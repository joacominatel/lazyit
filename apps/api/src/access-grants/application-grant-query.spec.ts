import { BadRequestException } from '@nestjs/common';
import { parseApplicationGrantQuery } from './application-grant-query';

describe('parseApplicationGrantQuery (#1660)', () => {
  it('returns no filter for an empty query', () => {
    expect(parseApplicationGrantQuery({})).toEqual({});
  });

  it('parses status, an exact level and a trimmed search', () => {
    expect(
      parseApplicationGrantQuery({
        status: 'expiring',
        accessLevel: '  admin ',
        q: '  ana  ',
      }),
    ).toEqual({ status: 'expiring', accessLevel: 'admin', q: 'ana' });
  });

  it('noAccessLevel=true selects grants with no level; false is no filter', () => {
    expect(parseApplicationGrantQuery({ noAccessLevel: 'true' })).toEqual({
      accessLevel: null,
    });
    expect(parseApplicationGrantQuery({ noAccessLevel: 'false' })).toEqual({});
  });

  it('a blank search is no search', () => {
    expect(parseApplicationGrantQuery({ q: '   ' })).toEqual({});
  });

  it.each([
    [{ status: 'expired' }],
    [{ status: '' }],
    [{ accessLevel: 'admin', noAccessLevel: 'true' }],
    [{ accessLevel: '' }],
    [{ accessLevel: 'x'.repeat(101) }],
    [{ q: 'x'.repeat(201) }],
  ])('rejects %o with 400', (raw) => {
    expect(() => parseApplicationGrantQuery(raw)).toThrow(BadRequestException);
  });
});
