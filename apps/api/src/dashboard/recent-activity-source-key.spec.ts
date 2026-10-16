import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The `sourceKey` the activity export pages by (ADR-0044 amendment, ADR-0103): an additive view change,
// and a keyset that only holds while every `occurredAt` source keeps millisecond precision.
const MIGRATIONS = join(__dirname, '../../prisma/migrations');
const read = (suffix: string) => {
  const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith(suffix));
  return dir
    ? readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8')
    : '';
};
const viewOf = (sql: string) =>
  sql.slice(sql.indexOf('CREATE OR REPLACE VIEW "recent_activity" AS'));

describe('activity_view_source_key migration', () => {
  const sql = read('_activity_view_source_key');
  const statements = sql
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n');

  it('only re-issues the view: no table touched, nothing dropped', () => {
    expect(sql).not.toBe('');
    expect(statements).not.toMatch(
      /\b(DROP|ALTER|UPDATE|DELETE|TRUNCATE|INSERT)\b/i,
    );
    expect(statements.match(/CREATE OR REPLACE VIEW/g)).toHaveLength(1);
    expect(statements).not.toMatch(/CREATE TABLE/i);
  });

  it('appends sourceKey as the last column of every branch, leaving the rest byte-identical', () => {
    const previous = viewOf(read('_user_sessions'));
    const next = viewOf(sql);
    expect(next.match(/AS "occurredAt"/g)).toHaveLength(7);
    expect(next.match(/,\n {2}[^\n]+AS "sourceKey"\nFROM /g)).toHaveLength(7);
    expect(next.replace(/,\n {2}[^\n]+AS "sourceKey"/g, '')).toBe(previous);
  });

  it('keys each event by its source row, and an assignment or a grant by its action too', () => {
    const keys = [...viewOf(sql).matchAll(/\n {2}(.+?)\s+AS "sourceKey"/g)].map(
      (m) => m[1],
    );
    expect(keys).toEqual([
      `'asset_history:' || ah."id"::text`,
      `'asset_assignments:' || aa."id" || ':assigned'`,
      `'asset_assignments:' || aa."id" || ':released'`,
      `'access_grants:' || ag."id" || ':granted'`,
      `'access_grants:' || ag."id" || ':revoked'`,
      `'consumable_movements:' || cm."id"::text`,
      `'user_history:' || uh."id"::text`,
    ]);
  });
});

describe('occurredAt sources keep millisecond precision', () => {
  // A JS Date holds milliseconds: a cursor read from a microsecond column would skip or repeat rows.
  const schema = readFileSync(
    join(__dirname, '../../prisma/schema.prisma'),
    'utf8',
  );
  const field = (model: string, name: string) => {
    const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(
      schema,
    )?.[1];
    return new RegExp(`^\\s+${name}\\s+(.+)$`, 'm').exec(body ?? '')?.[1];
  };

  it.each([
    ['AssetHistory', 'createdAt'],
    ['AssetAssignment', 'assignedAt'],
    ['AssetAssignment', 'releasedAt'],
    ['AccessGrant', 'grantedAt'],
    ['AccessGrant', 'revokedAt'],
    ['ConsumableMovement', 'createdAt'],
    ['UserHistory', 'createdAt'],
  ])('%s.%s is a default DateTime, TIMESTAMP(3)', (model, name) => {
    const definition = field(model, name);
    expect(definition).toMatch(/^DateTime\??(\s|$)/);
    expect(definition).not.toMatch(/@db\.(?!Timestamp\(3\)|Timestamptz\(3\))/);
  });
});
