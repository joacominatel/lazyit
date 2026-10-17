jest.mock('../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../generated/prisma/enums',
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
// The queue modules build their workers at compile time; with no Valkey they must not connect.
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
import { ExportService } from '../common/export';
import { InfraController } from './infra.controller';
import { InfraModule } from './infra.module';

describe('InfraModule wiring', () => {
  it('resolves the export engine from ExportModule, not from a stand-in', async () => {
    const mocked: unknown[] = [];
    // Only what a @Global app module provides may be stood in; a missing module import is the bug.
    const moduleRef = await Test.createTestingModule({
      imports: [InfraModule],
    })
      .useMocker((token) => {
        mocked.push(token);
        return {};
      })
      .compile();

    const controller = moduleRef.get(InfraController);
    expect(mocked).not.toContain(ExportService);
    expect(
      (controller as unknown as { exports: unknown }).exports,
    ).toBeInstanceOf(ExportService);
  });
});
