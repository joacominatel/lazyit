import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HEALTH_REDIS, type HealthRedisClient } from './health-redis';

/** A single dependency's health, reported in the readiness payload. */
export interface DependencyHealth {
  status: 'up' | 'down';
  /** A fixed category when `status === 'down'`; the driver detail goes to the server log only. */
  error?: string;
}

/** Minimum gap between logged failures per dependency (ms) — the route is anonymous and pollable. */
export const HEALTH_FAILURE_LOG_THROTTLE_MS = 60_000;

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
  private readonly logger = new Logger(HealthService.name);
  private readonly lastLoggedAt = new Map<string, number>();

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
      return this.down('database', err);
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
        : this.down('valkey', `unexpected PING reply: ${reply}`);
    } catch (err) {
      return this.down('valkey', err);
    }
  }

  /** The raw message names internal hosts and ports, so it stays in the log (SEC-070, AUD-018). */
  private down(dependency: string, err: unknown): DependencyHealth {
    const now = Date.now();
    const last = this.lastLoggedAt.get(dependency);
    if (last === undefined || now - last >= HEALTH_FAILURE_LOG_THROTTLE_MS) {
      this.lastLoggedAt.set(dependency, now);
      this.logger.warn(
        `Readiness check: ${dependency} is down: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { status: 'down', error: 'unreachable' };
  }
}
