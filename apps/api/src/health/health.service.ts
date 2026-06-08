import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HEALTH_REDIS, type HealthRedisClient } from './health-redis';

/** A single dependency's health, reported in the readiness payload. */
export interface DependencyHealth {
  status: 'up' | 'down';
  /** Error summary when `status === 'down'` (never the raw stack — kept terse for a probe). */
  error?: string;
}

/** Shape of `GET /health/ready` — `ready` gates orchestrator traffic; `valkey` is observability only. */
export interface ReadinessReport {
  status: 'ok' | 'degraded' | 'error';
  ready: boolean;
  checks: {
    database: DependencyHealth;
    /** NON-GATING (OPS-6/ADR-0053): the BullMQ broker is transport, not the record. */
    valkey: DependencyHealth;
  };
}

/**
 * Hand-rolled health checks (ADR-0035 fail-soft posture; no @nestjs/terminus dependency).
 *
 * - Liveness is trivial (the process is up) and lives in the controller.
 * - Readiness gates on the ONE hard dependency — Postgres — with a cheap `SELECT 1`. Meilisearch
 *   (ADR-0035) and Valkey (ADR-0053) are deliberately NOT readiness gates: search is fail-soft and
 *   the queue is transport, so an outage of either is "degraded, still serving", never "pull me from
 *   rotation". The Valkey ping is added purely for OBSERVABILITY (OPS-6) — a broker outage that
 *   silently broke async imports used to be invisible from the probe.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(HEALTH_REDIS) private readonly valkey: HealthRedisClient,
  ) {}

  /**
   * Verify dependencies. `ready` tracks Postgres ONLY (the system of record). Valkey is reported but
   * never gates: when the DB is up and the broker is down the result is `degraded` (still HTTP 200).
   */
  async readiness(): Promise<ReadinessReport> {
    const [database, valkey] = await Promise.all([
      this.checkDatabase(),
      this.checkValkey(),
    ]);
    // DB-ONLY gate (OPS-6): a Valkey outage must not pull the instance from rotation.
    const ready = database.status === 'up';
    const status: ReadinessReport['status'] = !ready
      ? 'error'
      : valkey.status === 'up'
        ? 'ok'
        : 'degraded';
    return { status, ready, checks: { database, valkey } };
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

  /**
   * Non-gating Valkey/BullMQ-broker reachability ping. The probe connection fails fast (it disables
   * the offline queue and bounds the command timeout), so a broker outage resolves to `down` quickly
   * rather than hanging the readiness response.
   */
  private async checkValkey(): Promise<DependencyHealth> {
    try {
      const reply = await this.valkey.ping();
      return reply === 'PONG'
        ? { status: 'up' }
        : { status: 'down', error: `unexpected PING reply: ${reply}` };
    } catch (err) {
      return {
        status: 'down',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
