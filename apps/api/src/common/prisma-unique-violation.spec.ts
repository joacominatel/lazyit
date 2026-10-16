// The generated client's own error class; the generated barrel itself does not load under Jest.
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { adapterPgUniqueViolationMeta } from '../../test/prisma/unique-violation';
import { uniqueViolationTargets } from './prisma-unique-violation';

const p2002 = (meta?: Record<string, unknown>) =>
  new PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta,
  });

describe('uniqueViolationTargets', () => {
  it('reads the violated index from the adapter-pg shape, where meta.target is absent', () => {
    const err = p2002(
      adapterPgUniqueViolationMeta({ index: 'assets_assetTag_active_key' }),
    );

    expect(err.meta?.target).toBeUndefined();
    expect(uniqueViolationTargets(err)).toEqual(['assets_assetTag_active_key']);
  });

  it('reads column names when the adapter reports fields instead of an index', () => {
    const err = p2002(
      adapterPgUniqueViolationMeta({ fields: ['requesterId', 'applicationId'] }),
    );

    expect(uniqueViolationTargets(err)).toEqual(['requesterId', 'applicationId']);
  });

  it('still reads meta.target as a string or an array', () => {
    expect(
      uniqueViolationTargets(p2002({ target: 'assets_serial_active_key' })),
    ).toEqual(['assets_serial_active_key']);
    expect(uniqueViolationTargets(p2002({ target: ['serial'] }))).toEqual([
      'serial',
    ]);
  });

  it('returns nothing when the error names no constraint', () => {
    expect(uniqueViolationTargets(p2002())).toEqual([]);
  });
});
