// Only external I/O is replaced below; every app-owned provider must resolve from its real module.
jest.mock('../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../generated/prisma/enums',
  );
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
    construct: () => inert as object,
  });
  class PrismaClient {
    $extends() {
      return {};
    }
    $connect() {
      return Promise.resolve();
    }
    $disconnect() {
      return Promise.resolve();
    }
  }
  return { ...enums, $Enums: enums, PrismaClient, Prisma: inert };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));
jest.mock('ioredis', () => {
  class InertRedis {
    on() {
      return this;
    }
    duplicate() {
      return new InertRedis();
    }
    quit() {
      return Promise.resolve('OK');
    }
    disconnect() {}
  }
  return { __esModule: true, default: InertRedis, Redis: InertRedis };
});
jest.mock('bullmq', () => {
  class Inert {
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  }
  return {
    Queue: Inert,
    Worker: Inert,
    QueueEvents: Inert,
    FlowProducer: Inert,
  };
});

import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

// #1628: unit specs list providers by hand, so only this catches a module that forgot an import.
describe('AppModule dependency graph', () => {
  it('compiles: every provider and controller resolves from the modules it imports', async () => {
    process.env.DATABASE_URL ??= 'postgresql://compile-only@127.0.0.1:1/none';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    expect(moduleRef.get(AppModule)).toBeInstanceOf(AppModule);
  });
});
