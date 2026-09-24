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

import { Global, Module } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { LocalCredentialService } from '../../auth/local/local-credential.service';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_RUN_QUEUE } from '../ai.constants';
import { RUN_EVENT_BUS } from '../core/ports/run-event-bus.port';
import { AgentRunOrchestrator } from './agent-run.orchestrator';
import { AgentRunWorker } from './agent-run.worker';
import { AiRuntimeModule } from './ai-runtime.module';
import { AiApprovalService } from './approval.service';
import { InProcessRunEventBus } from './run-event-bus';

/** What the global Prisma and Auth modules provide in the app, stubbed. */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: PermissionResolverService, useValue: {} },
    { provide: PrincipalLoaderService, useValue: {} },
    { provide: LocalCredentialService, useValue: {} },
  ],
  exports: [
    PrismaService,
    PermissionResolverService,
    PrincipalLoaderService,
    LocalCredentialService,
  ],
})
class GlobalStubsModule {}

/** A consumer of the runtime, as the HTTP surfaces (W3-1) will be. */
@Module({ imports: [AiRuntimeModule] })
class ConsumerModule {}

describe('AiRuntimeModule wiring', () => {
  it('resolves every provider and exports the orchestrator, the approvals and RUN_EVENT_BUS', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GlobalStubsModule,
        BullModule.forRoot({ connection: { host: '127.0.0.1', port: 1 } }),
        ConsumerModule,
      ],
    })
      .overrideProvider(getQueueToken(AI_RUN_QUEUE))
      .useValue({ add: jest.fn(), getJobs: jest.fn() })
      .compile();

    const consumer = moduleRef.select(ConsumerModule);
    const bus: unknown = consumer.get(RUN_EVENT_BUS, { strict: false });
    expect(bus).toBeInstanceOf(InProcessRunEventBus);
    expect(bus).toBe(moduleRef.get(InProcessRunEventBus, { strict: false }));
    expect(
      consumer.get(AgentRunOrchestrator, { strict: false }),
    ).toBeInstanceOf(AgentRunOrchestrator);
    expect(consumer.get(AiApprovalService, { strict: false })).toBeInstanceOf(
      AiApprovalService,
    );
    expect(moduleRef.get(AgentRunWorker, { strict: false })).toBeInstanceOf(
      AgentRunWorker,
    );
    await moduleRef.close();
  });
});
