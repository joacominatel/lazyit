import type { Type } from '@nestjs/common';

// Only decorator METADATA is read here — no instance, no DB. The whole application is imported, so stub
// what cannot load under Jest: the generated Prisma client (its `.js` re-exports) keeps its real enums and
// gets an inert `Prisma` namespace (module-scope `Prisma.sql` fragments, `@Catch(...)` targets); the ESM
// packages are stubbed as in the other auth specs.
jest.mock('../../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../../generated/prisma/enums',
  );
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
    construct: () => inert as object,
  });
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: inert };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  SignJWT: jest.fn(),
}));

import { AppModule } from '../../app.module';
import { ALL_TOOLSETS } from '../tools';
import { decidedHandlers, validateToolsets } from './boot-validation';
import { listRouteHandlers } from './route-metadata';

/** Every controller registered anywhere under a module, following static and dynamic imports. */
function registeredControllers(root: unknown): Set<Type<unknown>> {
  const controllers = new Set<Type<unknown>>();
  const visited = new Set<unknown>();
  const visit = (entry: unknown): void => {
    if (!entry || visited.has(entry)) return;
    visited.add(entry);
    if (typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      if (typeof record.forwardRef === 'function') {
        visit((record.forwardRef as () => unknown)());
        return;
      }
      // A dynamic module: `{ module, imports?, controllers? }`.
      visit(record.module);
      for (const imported of (record.imports as unknown[]) ?? [])
        visit(imported);
      for (const c of (record.controllers as Type<unknown>[]) ?? []) {
        controllers.add(c);
      }
      return;
    }
    if (typeof entry === 'function') {
      for (const imported of (Reflect.getMetadata('imports', entry) as
        | unknown[]
        | undefined) ?? []) {
        visit(imported);
      }
      for (const c of (Reflect.getMetadata('controllers', entry) as
        | Type<unknown>[]
        | undefined) ?? []) {
        controllers.add(c);
      }
    }
  };
  visit(root);
  return controllers;
}

/**
 * COVERAGE (tools-and-execution.md §8.3; synthesis §4.1). Every route handler of every controller the
 * application registers must be DECIDED: bound by a tool, or listed in a toolset's `unexposed` with a
 * reason. A new endpoint therefore fails CI until someone decides whether the AI may use it — "most
 * functions" stays honest, and nothing becomes a tool by accident.
 */
describe('AI tool coverage — every controller handler is bound or unexposed', () => {
  const controllers = registeredControllers(AppModule);

  it('finds the application controllers (sanity: the walk reaches the feature modules)', () => {
    const names = [...controllers].map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'AssetsController',
        'UsersController',
        'SearchController',
        'VaultsController',
      ]),
    );
    expect(controllers.size).toBeGreaterThan(40);
  });

  it('the shipped catalog passes boot validation', () => {
    expect(() => validateToolsets(ALL_TOOLSETS)).not.toThrow();
  });

  it('leaves no handler undecided', () => {
    const decided = decidedHandlers(ALL_TOOLSETS);
    const undecided: string[] = [];
    for (const controller of controllers) {
      for (const method of listRouteHandlers(controller)) {
        if (!decided.get(controller)?.has(method)) {
          undecided.push(`${controller.name}.${method}`);
        }
      }
    }
    expect(undecided).toEqual([]);
  });

  it('decides nothing for a controller the application does not register', () => {
    const decided = decidedHandlers(ALL_TOOLSETS);
    const strays = [...decided.keys()]
      .filter((c) => !controllers.has(c as Type<unknown>))
      .map((c) => (c as Type<unknown>).name);
    expect(strays).toEqual([]);
  });
});
