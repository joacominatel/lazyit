import { jsonDeepEqual } from './deep-equal';

// Order-insensitive structural equality for the SPECS_CHANGED diff (ADR-0033). The headline case:
// jsonb does not preserve object key order, so reordered keys must NOT read as a change.
describe('jsonDeepEqual', () => {
  it('treats null and undefined as the same "no specs"', () => {
    expect(jsonDeepEqual(null, undefined)).toBe(true);
    expect(jsonDeepEqual(undefined, null)).toBe(true);
    expect(jsonDeepEqual(null, null)).toBe(true);
  });

  it('treats present vs absent specs as a change', () => {
    expect(jsonDeepEqual({ cpu: 'i7' }, null)).toBe(false);
    expect(jsonDeepEqual(null, { cpu: 'i7' })).toBe(false);
  });

  it('is order-insensitive over object keys (the SPECS_CHANGED false-positive fix)', () => {
    expect(jsonDeepEqual({ cpu: 'i7', ram: 16 }, { ram: 16, cpu: 'i7' })).toBe(
      true,
    );
  });

  it('is order-insensitive recursively for nested objects', () => {
    expect(
      jsonDeepEqual(
        { net: { mac: 'aa', ip: '1.1.1.1' }, cpu: 'i7' },
        { cpu: 'i7', net: { ip: '1.1.1.1', mac: 'aa' } },
      ),
    ).toBe(true);
  });

  it('detects a real value change', () => {
    expect(jsonDeepEqual({ ram: 16 }, { ram: 32 })).toBe(false);
  });

  it('detects an added or removed key', () => {
    expect(jsonDeepEqual({ cpu: 'i7' }, { cpu: 'i7', ram: 16 })).toBe(false);
    expect(jsonDeepEqual({ cpu: 'i7', ram: 16 }, { cpu: 'i7' })).toBe(false);
  });

  it('keeps arrays ORDER-SENSITIVE (list order is meaningful)', () => {
    expect(jsonDeepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(jsonDeepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(jsonDeepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('does not confuse an array with an object', () => {
    expect(jsonDeepEqual([], {})).toBe(false);
  });

  it('compares primitives by value', () => {
    expect(jsonDeepEqual('a', 'a')).toBe(true);
    expect(jsonDeepEqual('a', 'b')).toBe(false);
    expect(jsonDeepEqual(1, 1)).toBe(true);
    expect(jsonDeepEqual(true, false)).toBe(false);
  });

  // SEC-032 — a pathologically deep specs object (unvalidated jsonb) must NOT overflow the stack.
  // Past the depth bound the compare returns (treating the values as "changed"), never throws.
  it('bounds recursion depth instead of overflowing the stack on a deep object', () => {
    const deep = (levels: number): Record<string, unknown> => {
      const root: Record<string, unknown> = {};
      let cur = root;
      for (let i = 0; i < levels; i++) {
        const next: Record<string, unknown> = {};
        cur.a = next;
        cur = next;
      }
      return root;
    };
    const a = deep(50_000);
    const b = deep(50_000);
    expect(() => jsonDeepEqual(a, b)).not.toThrow();
    // Identical-but-too-deep chains are reported as "changed" (false) rather than crashing.
    expect(jsonDeepEqual(a, b)).toBe(false);
  });
});
