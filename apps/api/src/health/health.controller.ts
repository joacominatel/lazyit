import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { HealthService, type ReadinessReport } from './health.service';

/**
 * Operational health probes (ops-boot integrity). Both routes are `@Public()` so an unauthenticated
 * orchestrator / load balancer / `docker healthcheck` can poll them.
 *
 * - GET /health/live  — liveness: always 200 while the process can serve HTTP. No dependency checks.
 * - GET /health/ready — readiness: 200 when the DB answers, 503 otherwise. Meilisearch (ADR-0035) and
 *   Valkey (ADR-0053) are fail-soft and never readiness gates — the `valkey` check is reported for
 *   observability only (a broker outage reads as `degraded`, still 200; OPS-6).
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Liveness probe (always 200 while the process is up)',
  })
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe (200 when the DB is reachable, 503 otherwise)',
  })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        ready: true,
        checks: {
          database: { status: 'up' },
          valkey: { status: 'up' },
        },
      },
    },
  })
  async ready(): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    if (!report.ready) {
      // 503 so orchestrators pull this instance from rotation; the body still carries the per-check
      // detail so an operator can see which dependency is down.
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
