import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  CreateSoftwareWatchSchema,
  SOFTWARE_WATCH_LIMIT,
  SoftwareWatchHostPageSchema,
  SoftwareWatchPresenceSchema,
  SoftwareWatchSchema,
  SoftwareWatchSummarySchema,
} from '@lazyit/shared';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';
import { HumanOnlyGuard } from '../secret-manager/human-only.guard';
import { parsePageQuery } from '../common/parse-page-query';
import {
  SoftwareWatchService,
  type SoftwareWatchHostFilters,
} from './software-watch.service';

class SoftwareWatchDto extends createZodDto(SoftwareWatchSchema) {}
class SoftwareWatchSummaryDto extends createZodDto(
  SoftwareWatchSummarySchema,
) {}
class SoftwareWatchHostPageDto extends createZodDto(
  SoftwareWatchHostPageSchema,
) {}
class CreateSoftwareWatchDto extends createZodDto(CreateSoftwareWatchSchema) {}

/** The query keys the host list accepts; anything else is a 400 (the `nodes/page` posture). */
const HOST_QUERY_KEYS: ReadonlySet<string> = new Set([
  'presence',
  'version',
  'limit',
  'offset',
  'page',
]);

/**
 * The software watchlist (#1684, split from epic #1146 item 4) — its own controller inside
 * InfraModule, under `/infra/software-watches`.
 *
 * Reads are `infra:read`: the package lists they aggregate are already readable at that gate on every
 * node's drill-in (`specs`), so the watchlist widens nothing — it answers across hosts what one host's
 * page already shows. Writes are `infra:manage` and HUMAN-ONLY, like every other operator-authored
 * infra configuration (auto-confirm rules, agent policy): a watch is a human's choice of what to look
 * at, and the reporting agent's credential (`infra:report`) can reach none of this.
 */
@ApiTags('infra')
@Controller('infra/software-watches')
export class SoftwareWatchController {
  constructor(private readonly watches: SoftwareWatchService) {}

  @Get()
  @RequirePermission('infra:read')
  @ApiOperation({
    summary: `Every live software watch, oldest first (at most ${SOFTWARE_WATCH_LIMIT}), each with its fleet-wide distribution computed on this read: hosts with the package per distinct version, hosts MISSING it, and hosts UNKNOWN for it (#1684).`,
    description:
      'DISTRIBUTION ONLY: a version is an opaque string that is counted, never compared — no "outdated", no EOL flag, no CVE matching. ' +
      'The population is every live agent-reported HOST (container/guest children and manual nodes excluded), PENDING and OFFLINE included. ' +
      "MISSING means the host stores a package list that does not name the package. A host storing NO list (software collection disabled by policy at any scope, the host's local veto, or a collector that never enumerated) is UNKNOWN, never MISSING; so is one whose resolvable policy excludes the name by glob. " +
      '`installed + missing + unknown = hostsTotal`; a host carrying two versions counts once in each version bucket.',
  })
  @ApiOkResponse({ type: [SoftwareWatchSummaryDto] })
  list() {
    return this.watches.list();
  }

  @Get(':id')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      'One live software watch with its distribution (the same row the list returns). 404 for an unknown or deleted watch.',
  })
  @ApiOkResponse({ type: SoftwareWatchSummaryDto })
  get(@Param('id') id: string) {
    return this.watches.get(id);
  }

  @Get(':id/hosts')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      'The hosts behind one watch, in label order, PAGED on the house Page<T> contract (ADR-0030): default 50, hard max 200. Filter by presence and/or one version bucket. Unknown query keys are rejected.',
  })
  @ApiQuery({
    name: 'presence',
    required: false,
    enum: [...SoftwareWatchPresenceSchema.options],
  })
  @ApiQuery({
    name: 'version',
    required: false,
    description:
      'One version bucket, matched exactly (implies presence=INSTALLED). An EMPTY value (`version=`) selects the bucket of hosts that list the package without a version. 400 with presence=MISSING or UNKNOWN.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ type: SoftwareWatchHostPageDto })
  listHosts(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    const unknown = Object.keys(query).find((key) => !HOST_QUERY_KEYS.has(key));
    if (unknown) {
      throw new BadRequestException(`Unknown query parameter: ${unknown}`);
    }
    const presenceRaw = stringQuery(query.presence, 'presence');
    const versionRaw = stringQuery(query.version, 'version');

    const filters: SoftwareWatchHostFilters = {};
    if (presenceRaw !== undefined) {
      const parsed = SoftwareWatchPresenceSchema.safeParse(presenceRaw);
      if (!parsed.success) throw new BadRequestException('Invalid presence');
      filters.presence = parsed.data;
    }
    if (versionRaw !== undefined) {
      if (filters.presence !== undefined && filters.presence !== 'INSTALLED') {
        throw new BadRequestException(
          'version only applies to INSTALLED hosts',
        );
      }
      filters.version = versionRaw === '' ? null : versionRaw;
    }

    return this.watches.listHosts(
      id,
      filters,
      parsePageQuery({
        limit: stringQuery(query.limit, 'limit'),
        offset: stringQuery(query.offset, 'offset'),
        page: stringQuery(query.page, 'page'),
      }),
    );
  }

  @Post()
  @RequirePermission('infra:manage')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary: `Add a package name to the watchlist. The name is NORMALIZED before it is stored (whitespace collapsed, trimmed, lower-cased) and a reported package matches it when its name normalizes to the same string — an exact name, never a pattern or a product family. 409 when a live watch already holds that name; 400 once the list holds ${SOFTWARE_WATCH_LIMIT}. Human-only.`,
  })
  @ApiCreatedResponse({ type: SoftwareWatchDto })
  create(
    @Body() dto: CreateSoftwareWatchDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.watches.create(dto, principal);
  }

  @Delete(':id')
  @RequirePermission('infra:manage')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Remove a watch (soft delete, ADR-0006): it leaves the list immediately and its name is free for a new watch; the row is kept. Nothing about any host changes. Human-only.',
  })
  @ApiOkResponse({ type: SoftwareWatchDto })
  remove(@Param('id') id: string) {
    return this.watches.remove(id);
  }
}

/** A single-valued string query param; a repeated key (an array) is a 400, never silently the first. */
function stringQuery(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new BadRequestException(`Invalid ${name}`);
  return value;
}
