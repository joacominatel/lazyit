import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { withSoftDeleteFilter } from './soft-delete.extension';

/**
 * Injectable Prisma client wired into Nest's lifecycle.
 *
 * Prisma 7 requires a driver adapter (no embedded engine); we use the Postgres adapter and read
 * DATABASE_URL from apps/api/.env. See docs/03-decisions/0003-prisma-orm.md.
 *
 * Soft delete (ADR-0032): the constructor applies a `$extends` query filter (built from
 * {@link withSoftDeleteFilter}) and returns a Proxy that transparently routes model access
 * (`prisma.user`, …) and the `$`-prefixed client methods to the *extended* client, so every read on
 * a soft-deletable model is scoped to `deletedAt: null` without services carrying per-query guards.
 * Lifecycle methods stay on the base instance, and the extended client shares this instance's
 * single connection/pool.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    super({ adapter: new PrismaPg({ connectionString }) });

    const extended = this.$extends(
      Prisma.defineExtension({
        name: 'soft-delete',
        query: {
          $allModels: {
            $allOperations({ model, operation, args, query }) {
              return query(withSoftDeleteFilter(model, operation, args));
            },
          },
        },
      }),
    );

    return new Proxy(this, {
      get(target, prop, receiver) {
        const ext = extended as unknown as Record<string | symbol, unknown>;
        if (prop in ext) {
          const value = ext[prop];
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(ext)
            : value;
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
