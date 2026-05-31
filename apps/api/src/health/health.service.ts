import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** A single dependency's health, reported in the readiness payload. */
export interface DependencyHealth {
  status: 'up' | 'down';
  /** Error summary when `status === 'down'` (never the raw stack — kept terse for a probe). */
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
  constructor(private readonly prisma: PrismaService) {}

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
      return {
        status: 'down',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
