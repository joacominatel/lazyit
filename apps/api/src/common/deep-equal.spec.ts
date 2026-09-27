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

  // SEC-032 / SEC-072: the diff runs on specs ALREADY in the database, so it must not depend on the
  // write-time bound in the shared schema. A nesting deep enough to blow a recursive walk's call stack
  // has to be compared, not thrown on.
  describe('pathologically deep values (SEC-032)', () => {
    const DEPTH = 100_000;
    const chain = (leaf: unknown): unknown => {
      let node: unknown = leaf;
      for (let i = 0; i < DEPTH; i++) node = { a: node };
      return node;
    };
    const arrayChain = (leaf: unknown): unknown => {
      let node: unknown = leaf;
      for (let i = 0; i < DEPTH; i++) node = [node];
      return node;
    };

    it('compares two equal deep object chains without throwing', () => {
      expect(() => jsonDeepEqual(chain(1), chain(1))).not.toThrow();
      expect(jsonDeepEqual(chain(1), chain(1))).toBe(true);
    });

    it('detects a change at the bottom of a deep object chain', () => {
      expect(jsonDeepEqual(chain(1), chain(2))).toBe(false);
    });

    it('compares deep array chains without throwing', () => {
      expect(jsonDeepEqual(arrayChain('x'), arrayChain('x'))).toBe(true);
      expect(jsonDeepEqual(arrayChain('x'), arrayChain('y'))).toBe(false);
    });
  });
});
