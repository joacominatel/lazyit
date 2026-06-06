import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Generic, non-revealing detail returned in the public readiness body when a dependency is down.
 * SEC-070: the raw pg driver message embeds the internal DB host/IP + port — operators get the real
 * cause from the correlated server log (ADR-0031), not the @Public() 503 body.
 */
const DEPENDENCY_DOWN_DETAIL = 'unreachable';

/** A single dependency's health, reported in the readiness payload. */
export interface DependencyHealth {
  status: 'up' | 'down';
  /** Coarse, fixed summary when `status === 'down'` — never the raw driver error (SEC-070). */
  error?: string;
}

/** Shape of `GET /health/ready` — `ready` gates orchestrator traffic. */
export interface ReadinessReport {
  status: 'ok' | 'degraded' | 'error';
  ready: boolean;
  checks: {
    database: DependencyHealth;
  };
}

/**
 * Hand-rolled health checks (ADR-0035 fail-soft posture; no @nestjs/terminus dependency).
 *
 * - Liveness is trivial (the process is up) and lives in the controller.
 * - Readiness verifies the one hard dependency — Postgres — with a cheap `SELECT 1`. Meilisearch is
 *   deliberately NOT a readiness gate: search is fail-soft (ADR-0035), so a Meili outage is
 *   "degraded, still serving", never "unready / pull me from rotation".
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(HealthService.name)
    private readonly logger: PinoLogger,
  ) {}

  /** Verify the DB connection with a trivial round-trip; `ready=false` when it fails. */
  async readiness(): Promise<ReadinessReport> {
    const database = await this.checkDatabase();
    const ready = database.status === 'up';
    return {
      status: ready ? 'ok' : 'error',
      ready,
      checks: { database },
    };
  }

  private async checkDatabase(): Promise<DependencyHealth> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up' };
    } catch (err) {
      // log the rich detail server-side (correlated by request id, ADR-0031); the public body only
      // gets a coarse generic string so an anonymous caller can't read the DB host/port (SEC-070)
      this.logger.error({ err }, 'readiness DB check failed');
      return { status: 'down', error: DEPENDENCY_DOWN_DETAIL };
    }
  }
}
