import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_AUDIT_ACTIONS } from '@lazyit/shared';

// The audit filter is driven by the shared mirror, so a value missing there can never be filtered on.
describe('SecretAuditAction shared mirror', () => {
  it('lists exactly the values of the prisma enum', () => {
    const schema = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const block = /enum SecretAuditAction \{([^}]*)\}/.exec(schema)?.[1];
    expect(block).toBeDefined();
    const values = block!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0);

    expect([...SECRET_AUDIT_ACTIONS].sort()).toEqual(values.sort());
  });
});
