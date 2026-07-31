import { Body, Controller, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AgentReportSchema, type AgentReport } from '@lazyit/shared';
import request from 'supertest';
import {
  DEFAULT_JSON_BODY_LIMIT,
  EXPRESS_DEFAULT_JSON_BODY_LIMIT,
  resolveJsonBodyLimit,
} from './body-limit';

/**
 * Issue #1132. `NestFactory.create` was called without a body-parser limit, so Nest-on-Express
 * applied its own default of 100kb — while `AgentReportSchema` allows 5000 packages and the
 * collector caps at exactly that. A package-heavy host therefore 413'd forever, and the installer
 * mis-reported the cause as a URL/token problem. These tests pin BOTH halves: the resolver, and the
 * behaviour that actually broke (a full-size agent report must round-trip).
 */

/** A realistic dpkg-shaped package list — the shape `collectSoftware` produces on a Debian host. */
function packages(count: number): NonNullable<AgentReport['software']> {
  return Array.from({ length: count }, (_, i) => ({
    name: `libexample-package-name-${i}`,
    version: `1.${i}.0-1ubuntu2.4`,
  }));
}

function reportWith(packageCount: number): AgentReport {
  return AgentReportSchema.parse({
    agentVersion: '1.0.0',
    reportingSource: 'agent:abcdef123456',
    externalId: 'abcdef1234567890abcdef1234567890',
    reportedAt: new Date('2026-07-31T12:00:00.000Z').toISOString(),
    host: {
      hostname: 'srv-app-04',
      os: { name: 'Ubuntu', version: '24.04', kernel: '6.8.0-51-generic' },
      cpu: { model: 'Intel(R) Xeon(R) Silver 4210R CPU @ 2.40GHz', cores: 20 },
      memoryBytes: 68_719_476_736,
    },
    software: packages(packageCount),
  } satisfies AgentReport);
}

/** Boot a minimal app around a single echo route — no DB, no AppModule graph. */
async function bootApp(limit: string): Promise<NestExpressApplication> {
  @Controller('probe')
  class ProbeController {
    @Post()
    echo(@Body() body: AgentReport) {
      return { packages: body.software?.length ?? 0 };
    }
  }

  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useBodyParser('json', { limit });
  await app.init();
  return app;
}

describe('resolveJsonBodyLimit', () => {
  it('defaults to the lazyit limit, not the express one', () => {
    expect(resolveJsonBodyLimit({})).toBe(DEFAULT_JSON_BODY_LIMIT);
    expect(DEFAULT_JSON_BODY_LIMIT).not.toBe(EXPRESS_DEFAULT_JSON_BODY_LIMIT);
  });

  it('honours an explicit JSON_BODY_LIMIT', () => {
    expect(resolveJsonBodyLimit({ JSON_BODY_LIMIT: '32mb' })).toBe('32mb');
    expect(resolveJsonBodyLimit({ JSON_BODY_LIMIT: ' 512kb ' })).toBe('512kb');
  });

  it.each(['', '   ', 'lots', '8 megabytes', '-1mb', '8', 'mb'])(
    'falls back to the default for the unusable value %p',
    (raw) => {
      expect(resolveJsonBodyLimit({ JSON_BODY_LIMIT: raw })).toBe(
        DEFAULT_JSON_BODY_LIMIT,
      );
    },
  );
});

describe('agent report body size (#1132)', () => {
  it('a full-size report exceeds the express default — the bug was real', () => {
    const bytes = Buffer.byteLength(JSON.stringify(reportWith(5000)));
    expect(bytes).toBeGreaterThan(100 * 1024);
  });

  it('413s a package-heavy report under the express default limit', async () => {
    const app = await bootApp(EXPRESS_DEFAULT_JSON_BODY_LIMIT);
    try {
      await request(app.getHttpServer())
        .post('/probe')
        .send(reportWith(5000))
        .expect(413);
    } finally {
      await app.close();
    }
  });

  it('round-trips a 5000-package report under the resolved limit', async () => {
    const app = await bootApp(resolveJsonBodyLimit({}));
    try {
      await request(app.getHttpServer())
        .post('/probe')
        .send(reportWith(5000))
        .expect(201)
        .expect({ packages: 5000 });
    } finally {
      await app.close();
    }
  });
});
