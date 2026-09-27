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
import { PasswordStepUpVerifier } from '../../auth/local/password-step-up.verifier';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_RUN_QUEUE } from '../ai.constants';
import { AiConversationsController } from '../conversations/ai-conversations.controller';
import { AiConversationsModule } from '../conversations/ai-conversations.module';
import { AiServiceAccountAccessController } from '../headless/ai-service-account-access.controller';
import { AiHeadlessModule } from '../headless/ai-headless.module';
import { InProcessRunEventBus } from '../runtime/run-event-bus';
import { AiRunsController } from './ai-runs.controller';
import { AiRunsModule } from './ai-runs.module';
import { AiRunEventStream } from './run-event-stream';

/** What the global Prisma and Auth modules provide in the app, stubbed. */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: PermissionResolverService, useValue: {} },
    { provide: PrincipalLoaderService, useValue: {} },
    { provide: LocalCredentialService, useValue: {} },
    { provide: PasswordStepUpVerifier, useValue: {} },
  ],
  exports: [
    PrismaService,
    PermissionResolverService,
    PrincipalLoaderService,
    LocalCredentialService,
    PasswordStepUpVerifier,
  ],
})
class GlobalStubsModule {}

describe('AI HTTP surface modules wiring (W3-1)', () => {
  it('resolves the three modules against the runtime, sharing its one event bus', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GlobalStubsModule,
        BullModule.forRoot({ connection: { host: '127.0.0.1', port: 1 } }),
        AiConversationsModule,
        AiRunsModule,
        AiHeadlessModule,
      ],
    })
      .overrideProvider(getQueueToken(AI_RUN_QUEUE))
      .useValue({ add: jest.fn(), getJobs: jest.fn() })
      .compile();

    expect(moduleRef.get(AiConversationsController)).toBeInstanceOf(
      AiConversationsController,
    );
    expect(moduleRef.get(AiRunsController)).toBeInstanceOf(AiRunsController);
    expect(moduleRef.get(AiServiceAccountAccessController)).toBeInstanceOf(
      AiServiceAccountAccessController,
    );
    const stream = moduleRef.get(AiRunEventStream, { strict: false });
    const bus = moduleRef.get(InProcessRunEventBus, { strict: false });
    expect((stream as unknown as { bus: InProcessRunEventBus }).bus).toBe(bus);
    await moduleRef.close();
  });
});
