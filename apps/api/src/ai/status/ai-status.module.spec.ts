import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AiStatusSchema } from '@lazyit/shared';

jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { DbNull: 'DbNull' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_SETTINGS_READER } from '../core/ports/ai-settings.port';
import { AiSettingsModule } from '../settings/ai-settings.module';
import { AiSettingsService } from '../settings/ai-settings.service';
import { AiStatusModule } from './ai-status.module';

/** What the global PrismaModule and AuthModule provide in the app, stubbed. */
const prisma = {
  aiSettings: {
    findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
  },
};
const resolver = {
  resolve: jest.fn(() => Promise.resolve(new Set(['ai:use']))),
};

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: PermissionResolverService, useValue: resolver },
  ],
  exports: [PrismaService, PermissionResolverService],
})
class GlobalStubsModule {}

/** Consumer-side view: a module that imports AiSettingsModule only, as the runtime and /mcp will. */
@Module({ imports: [AiSettingsModule] })
class ConsumerModule {}

describe('AiSettingsModule / AiStatusModule wiring', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, AiStatusModule, ConsumerModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // Stand in for the global JwtAuthGuard: the request carries an authenticated human principal.
    app.use((req: { principal?: unknown }, _res: unknown, next: () => void) => {
      req.principal = { kind: 'human', user: { id: 'u1', role: 'MEMBER' } };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('binds and exports AI_SETTINGS_READER as the settings service', () => {
    const reader: unknown = app
      .select(ConsumerModule)
      .get(AI_SETTINGS_READER, { strict: false });
    expect(reader).toBeInstanceOf(AiSettingsService);
    expect(reader).toBe(app.get(AiSettingsService, { strict: false }));
  });

  it('GET /ai/status answers the shared contract (no row = off)', async () => {
    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get('/ai/status')
      .expect(200);
    expect(AiStatusSchema.parse(res.body)).toEqual(res.body);
    expect(res.body).toMatchObject({
      chat: { available: false },
      configRevision: '0',
      retentionDays: null,
    });
  });

  it('GET /ai/status reflects an enabled configuration', async () => {
    const previous = process.env.AI_SECRET_KEY;
    process.env.AI_SECRET_KEY = 'a'.repeat(64);
    const enabledRow = {
      id: 'singleton',
      enabled: true,
      provider: 'openai-compatible',
      model: 'llama',
      baseUrl: 'https://llm.example/v1',
      apiKeyCiphertext: null,
      apiKeyIv: null,
      apiKeyAuthTag: null,
      apiKeyKeyVersion: null,
      allowPrivateNetwork: false,
      effort: null,
      providerOptions: null,
      instructions: null,
      maxStepsPerRun: 20,
      maxOutputTokens: 16000,
      contextTokenLimit: 150000,
      dailyTokenLimitPerPrincipal: null,
      retentionDays: 30,
      approvalTtlMinutes: 30,
      mcpEnabled: false,
      mcpClientAllowlistAdded: [],
      mcpClientAllowlistRemovedDefaults: [],
      mcpAllowAnyHttpsClient: false,
      disclosureAcknowledgedAt: new Date(),
      verifiedAt: new Date(),
      updatedAt: new Date('2026-09-24T10:00:00Z'),
    };
    // Read twice: the redacted settings, then the provider check the runtime also makes.
    prisma.aiSettings.findUnique
      .mockResolvedValueOnce(enabledRow)
      .mockResolvedValueOnce(enabledRow);
    try {
      const res = await request(
        app.getHttpServer() as Parameters<typeof request>[0],
      )
        .get('/ai/status')
        .expect(200);
      expect(AiStatusSchema.parse(res.body)).toEqual(res.body);
      expect(res.body).toEqual({
        chat: { available: true },
        // endpoint / marketplaceUrl depend on the test env's WEB_ORIGIN (pinned in the service spec).
        mcp: expect.objectContaining({
          available: false,
          auth: expect.any(String) as unknown,
        }) as unknown,
        configRevision: '2026-09-24T10:00:00.000Z',
        retentionDays: 30,
      });
    } finally {
      if (previous === undefined) delete process.env.AI_SECRET_KEY;
      else process.env.AI_SECRET_KEY = previous;
    }
  });
});
