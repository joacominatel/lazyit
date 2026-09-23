import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  attachDelegatedIdentity,
  hasDelegatedIdentity,
  readDelegatedIdentity,
} from './delegated-identity';

const HUMAN = {
  kind: 'human' as const,
  userId: '11111111-1111-1111-1111-111111111111',
  sessionEpoch: 3,
};

function identitySymbols(target: object): symbol[] {
  return Object.getOwnPropertySymbols(target).filter(
    (s) => s.description === 'lazyit.delegatedIdentity',
  );
}

/**
 * The delegated identity (ADR-0097, R1) rides on a module-private symbol. These tests pin the properties
 * that make it unreachable from outside the process: it is not a registered (`Symbol.for`) symbol, it is
 * an own, non-enumerable, frozen property invisible to serialization, nothing inherited can supply it,
 * and only the dispatcher and the guard import the module.
 */
describe('delegated identity', () => {
  it('round-trips an identity attached by the dispatcher', () => {
    const request = {};
    expect(hasDelegatedIdentity(request)).toBe(false);
    attachDelegatedIdentity(request, HUMAN);
    expect(hasDelegatedIdentity(request)).toBe(true);
    expect(readDelegatedIdentity(request)).toEqual(HUMAN);

    const service = {};
    attachDelegatedIdentity(service, {
      kind: 'service',
      serviceAccountId: 'sa1',
    });
    expect(readDelegatedIdentity(service)).toEqual({
      kind: 'service',
      serviceAccountId: 'sa1',
    });
  });

  it('uses a private, unregistered symbol — Symbol.for cannot reproduce it', () => {
    const request = {};
    attachDelegatedIdentity(request, HUMAN);
    const [symbol] = identitySymbols(request);
    expect(symbol).toBeDefined();
    expect(Symbol.keyFor(symbol)).toBeUndefined();
    const forged = { [Symbol.for('lazyit.delegatedIdentity')]: HUMAN };
    expect(hasDelegatedIdentity(forged)).toBe(false);
    const lookalike = { [Symbol('lazyit.delegatedIdentity')]: HUMAN };
    expect(hasDelegatedIdentity(lookalike)).toBe(false);
  });

  it('is non-enumerable, immutable and absent from serialization', () => {
    const request: Record<string, unknown> = { body: { a: 1 } };
    attachDelegatedIdentity(request, HUMAN);
    const [symbol] = identitySymbols(request);
    expect(Object.keys(request)).toEqual(['body']);
    expect(JSON.parse(JSON.stringify(request))).toEqual({ body: { a: 1 } });
    expect({ ...request }).toEqual({ body: { a: 1 } });
    expect(() => {
      (request as Record<symbol, unknown>)[symbol] = {
        kind: 'service',
        serviceAccountId: 'x',
      };
    }).toThrow(TypeError);
    expect(() => attachDelegatedIdentity(request, HUMAN)).toThrow(TypeError);
    expect(readDelegatedIdentity(request)).toEqual(HUMAN);
  });

  it('is never inherited: an identity on the prototype chain does not count', () => {
    const proto = {};
    attachDelegatedIdentity(proto, HUMAN);
    const request = Object.create(proto) as object;
    expect(hasDelegatedIdentity(request)).toBe(false);
  });

  it('treats string-keyed look-alikes from a network request as absent', () => {
    const request = JSON.parse(
      JSON.stringify({
        'Symbol(lazyit.delegatedIdentity)': HUMAN,
        delegatedIdentity: HUMAN,
        headers: { 'x-delegated-identity': JSON.stringify(HUMAN) },
      }),
    ) as object;
    expect(hasDelegatedIdentity(request)).toBe(false);
  });

  it('reads a malformed identity as null so the guard refuses it', () => {
    for (const bad of [
      { kind: 'human', userId: HUMAN.userId },
      { kind: 'human', userId: HUMAN.userId, sessionEpoch: '3' },
      { kind: 'human', userId: HUMAN.userId, sessionEpoch: 1.5 },
      { kind: 'service' },
      { kind: 'root', userId: HUMAN.userId },
    ]) {
      const request = {};
      attachDelegatedIdentity(request, bad as never);
      expect(hasDelegatedIdentity(request)).toBe(true);
      expect(readDelegatedIdentity(request)).toBeNull();
    }
  });

  it('is imported at runtime only by the guard and the AI tool dispatcher (type imports aside)', () => {
    const srcRoot = join(__dirname, '..');
    const allowed = new Set([
      'auth/delegated-identity.ts',
      'auth/jwt-auth.guard.ts',
      'ai/core/tool-dispatcher.ts',
    ]);
    // A value import (not `import type`) of the module — the only way to reach attach/read.
    const valueImport =
      /import\s+(?!type\s)[^;]*?from\s+['"][^'"]*delegated-identity['"]/;
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
          const rel = relative(srcRoot, full).split('\\').join('/');
          if (
            valueImport.test(readFileSync(full, 'utf8')) &&
            !allowed.has(rel)
          ) {
            importers.push(rel);
          }
        }
      }
    };
    walk(srcRoot);
    expect(importers).toEqual([]);
    // The scan is not vacuous: it does see a sanctioned importer.
    expect(
      valueImport.test(
        readFileSync(join(srcRoot, 'auth/jwt-auth.guard.ts'), 'utf8'),
      ),
    ).toBe(true);
  });
});
