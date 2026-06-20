import { maxImportRows, parseImport } from './parser';

/**
 * Unit tests for the migrator ingest parser (ADR-0069 wave 2, #629). Covers the CSV + JSON happy
 * paths (raw rows, headers, dialect, count) and the malformed-input contract: every bad-but-present
 * file is a graceful `{ ok: false, reason }` — NEVER a throw — so the sandboxed worker can record a
 * session error instead of crashing the child.
 */

const buf = (s: string): Buffer => Buffer.from(s, 'utf-8');

describe('parseImport — CSV', () => {
  it('parses headers, raw rows and the row count', () => {
    const result = parseImport(
      buf('name,serial\nLaptop,ABC123\nMonitor,DEF456\n'),
      'csv',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers).toEqual(['name', 'serial']);
    expect(result.rowCount).toBe(2);
    expect(result.rows[0]).toEqual({ name: 'Laptop', serial: 'ABC123' });
    expect(result.rows[1]).toEqual({ name: 'Monitor', serial: 'DEF456' });
    expect(result.dialect.delimiter).toBe(',');
    expect(result.encoding).toBe('utf-8');
  });

  it('keeps cells verbatim (no coercion) — numbers and booleans stay strings', () => {
    const result = parseImport(buf('qty,active\n0042,true\n'), 'csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual({ qty: '0042', active: 'true' });
  });

  it('sniffs a semicolon delimiter', () => {
    const result = parseImport(buf('a;b;c\n1;2;3\n'), 'csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dialect.delimiter).toBe(';');
    expect(result.headers).toEqual(['a', 'b', 'c']);
    expect(result.rows[0]).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('handles RFC-4180 quoting: embedded commas and newlines', () => {
    const result = parseImport(
      buf('name,note\n"Smith, John","line1\nline2"\n'),
      'csv',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual({
      name: 'Smith, John',
      note: 'line1\nline2',
    });
  });

  it('strips a UTF-8 BOM and reports it', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      buf('name\nLaptop\n'),
    ]);
    const result = parseImport(withBom, 'csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers).toEqual(['name']);
    expect(result.dialect.hadBom).toBe(true);
  });

  it('tolerates a ragged short row (pads missing cells to "")', () => {
    const result = parseImport(buf('a,b,c\n1,2\n'), 'csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('tolerates a ragged long row (drops extra cells)', () => {
    const result = parseImport(buf('a,b\n1,2,3,4\n'), 'csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual({ a: '1', b: '2' });
  });

  it('fails gracefully on an empty file', () => {
    const result = parseImport(buf(''), 'csv');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/empty/i);
  });

  it('fails gracefully on a header-only file (no data rows)', () => {
    const result = parseImport(buf('name,serial\n'), 'csv');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no data rows/i);
  });

  it('de-dups duplicate headers deterministically (no data loss) [REDESIGN §4.1]', () => {
    // Two columns literally named "name" — the old parser hard-rejected; now the 2nd becomes "name (2)"
    // so BOTH columns survive as distinct keys (the CEO's Snipe-IT export has Dirección ×4, Notas ×2).
    const result = parseImport(buf('name,name\nA,B\n'), 'csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers).toEqual(['name', 'name (2)']);
    expect(result.rows[0]).toEqual({ name: 'A', 'name (2)': 'B' });
  });

  it('de-dup never collides when the source ALREADY contains the suffixed form [REDESIGN §4.1]', () => {
    // The dangerous case: the file already has a literal "addr (2)" AND two "addr" columns. A naive
    // "rename the 2nd to addr (2)" would collapse two distinct columns into one key (silent data loss).
    // The while-until-unique de-dup checks the FULL seen set, so every column keeps a UNIQUE key.
    const result = parseImport(buf('addr,addr,addr (2)\nx,y,z\n'), 'csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 3 source columns → 3 distinct keys, none overwriting another.
    expect(result.headers).toEqual(['addr', 'addr (2)', 'addr (2) (2)']);
    expect(new Set(result.headers).size).toBe(3);
    expect(result.rows[0]).toEqual({
      addr: 'x',
      'addr (2)': 'y',
      'addr (2) (2)': 'z',
    });
  });

  it('de-dups four identical headers (Snipe-IT Dirección ×4) into four unique keys [REDESIGN §4.1]', () => {
    const result = parseImport(buf('Dir,Dir,Dir,Dir\n1,2,3,4\n'), 'csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers).toEqual(['Dir', 'Dir (2)', 'Dir (3)', 'Dir (4)']);
    expect(result.rows[0]).toEqual({
      Dir: '1',
      'Dir (2)': '2',
      'Dir (3)': '3',
      'Dir (4)': '4',
    });
  });
});

describe('parseImport — JSON', () => {
  it('parses a bare array of objects', () => {
    const result = parseImport(
      buf('[{"name":"Laptop","serial":"A1"},{"name":"Monitor"}]'),
      'json',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers).toEqual(['name', 'serial']);
    expect(result.rowCount).toBe(2);
    expect(result.rows[0]).toEqual({ name: 'Laptop', serial: 'A1' });
    // Sparse record: the missing key is backfilled to ''.
    expect(result.rows[1]).toEqual({ name: 'Monitor', serial: '' });
    expect(result.dialect.delimiter).toBeNull();
  });

  it('parses a { data: [...] } envelope', () => {
    const result = parseImport(buf('{"data":[{"name":"X"}]}'), 'json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toEqual({ name: 'X' });
  });

  it('parses a single object as a one-row import', () => {
    const result = parseImport(buf('{"name":"Solo"}'), 'json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toEqual({ name: 'Solo' });
  });

  it('parses NDJSON (one object per line)', () => {
    const result = parseImport(buf('{"name":"A"}\n{"name":"B"}\n'), 'json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(2);
    expect(result.rows.map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('stringifies scalar cells (number/boolean → string)', () => {
    const result = parseImport(buf('[{"qty":42,"active":true}]'), 'json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual({ qty: '42', active: 'true' });
  });

  it('fails gracefully on a non-array, non-object JSON (a bare number)', () => {
    const result = parseImport(buf('42'), 'json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/array of records|object/i);
  });

  it('fails gracefully when an array element is not an object', () => {
    const result = parseImport(buf('[{"name":"A"},"oops"]'), 'json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not an object/i);
  });

  it('fails gracefully on broken JSON that is also not NDJSON', () => {
    const result = parseImport(buf('{ this is not json'), 'json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not valid json/i);
  });

  it('fails gracefully on an empty JSON array', () => {
    const result = parseImport(buf('[]'), 'json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no records/i);
  });
});

describe('maxImportRows', () => {
  const original = process.env.MAX_IMPORT_ROWS;
  afterEach(() => {
    if (original === undefined) delete process.env.MAX_IMPORT_ROWS;
    else process.env.MAX_IMPORT_ROWS = original;
  });

  it('defaults to 50000', () => {
    delete process.env.MAX_IMPORT_ROWS;
    expect(maxImportRows()).toBe(50_000);
  });

  it('honors a valid override', () => {
    process.env.MAX_IMPORT_ROWS = '10';
    expect(maxImportRows()).toBe(10);
  });

  it('falls back on a bad override', () => {
    process.env.MAX_IMPORT_ROWS = 'nonsense';
    expect(maxImportRows()).toBe(50_000);
  });
});
