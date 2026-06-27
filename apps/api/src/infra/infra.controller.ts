import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  AgentReportAckSchema,
  AgentReportSchema,
  AttachInfraSecretSchema,
  CreateInfraEdgeSchema,
  CreateInfraNodeSchema,
  InfraEdgeSchema,
  InfraImpactResponseSchema,
  InfraNodeDetailSchema,
  InfraNodeKindSchema,
  InfraNodeListItemSchema,
  InfraNodeSchema,
  InfraNodeStateSchema,
  InfraNodeStatusSchema,
  InfraSecretRefSchema,
  UpdateInfraNodeSchema,
} from '@lazyit/shared';
import { z } from 'zod';
import { InfraService } from './infra.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';
import { HumanOnlyGuard } from '../secret-manager/human-only.guard';

class InfraNodeDto extends createZodDto(InfraNodeSchema) {}
class InfraNodeListItemDto extends createZodDto(InfraNodeListItemSchema) {}
class InfraNodeDetailDto extends createZodDto(InfraNodeDetailSchema) {}
class InfraImpactResponseDto extends createZodDto(InfraImpactResponseSchema) {}
class UpdateInfraNodeDto extends createZodDto(UpdateInfraNodeSchema) {}
class InfraEdgeDto extends createZodDto(InfraEdgeSchema) {}
class CreateInfraEdgeDto extends createZodDto(CreateInfraEdgeSchema) {}
class InfraSecretRefDto extends createZodDto(InfraSecretRefSchema) {}
class AttachInfraSecretDto extends createZodDto(AttachInfraSecretSchema) {}
class AgentReportDto extends createZodDto(AgentReportSchema) {}
class AgentReportAckDto extends createZodDto(AgentReportAckSchema) {}

/**
 * The "track as asset" toggle on node create (ADR-0070 §5), DEFAULT-ON. It is API logic, not part of
 * the persisted node wire shape, so it rides as its own optional body field (default true). A
 * graph-only node (`trackAsAsset: false`) carries no Asset — right for ephemeral containers.
 */
class CreateInfraNodeWithFlagDto extends createZodDto(
  CreateInfraNodeSchema.extend({ trackAsAsset: z.boolean().optional() }),
) {}

/** PATCH /infra/nodes/:id/position body — the canvas x/y (free-move board). */
const PatchPositionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
});
class PatchPositionDto extends createZodDto(PatchPositionSchema) {}

@ApiTags('infra')
@Controller('infra')
export class InfraController {
  constructor(private readonly infra: InfraService) {}

  // ── Reporting agent (ADR-0074) ───────────────────────────────────────────────

  @Post('report')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('infra:report')
  @ApiOperation({
    summary:
      'Ingest a server reporting-agent inventory report (ADR-0074). MACHINE-intended: authenticated by the agent Service Account holding infra:report. Upserts on (reportingSource, externalId) — a new host lands in the PENDING review tray (no Asset yet); a known host refreshes its inventory + liveness without touching human curation. Returns a minimal ack.',
  })
  @ApiOkResponse({ type: AgentReportAckDto })
  report(@Body() report: AgentReportDto) {
    return this.infra.ingestReport(report);
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────

  @Get('nodes')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      'List topology nodes (filter by kind/status/state; excludes archived/soft-deleted). Newest first.',
  })
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: [...InfraNodeKindSchema.options],
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...InfraNodeStatusSchema.options],
  })
  @ApiQuery({
    name: 'state',
    required: false,
    enum: [...InfraNodeStateSchema.options],
  })
  @ApiOkResponse({ type: [InfraNodeListItemDto] })
  listNodes(
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('state') state?: string,
  ) {
    return this.infra.listNodes({
      kind: this.parseEnum(kind, InfraNodeKindSchema, 'kind'),
      status: this.parseEnum(status, InfraNodeStatusSchema, 'status'),
      state: this.parseEnum(state, InfraNodeStateSchema, 'state'),
    });
  }

  @Get('nodes/:id')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      'Get a node enriched with its drill-in payoff: owners, KB links, secret handles (never values), shortcuts, IP and children (ADR-0070 §6).',
  })
  @ApiOkResponse({ type: InfraNodeDetailDto })
  getNode(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.infra.getNodeDetail(id, principal);
  }

  @Get('nodes/:id/impact')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      'Blast radius: the downstream node set affected if this node goes down — transitive over ACTIVE inverse RUNS_ON/DEPENDS_ON edges, each with its minimum hop depth (ADR-0070 §7).',
  })
  @ApiOkResponse({ type: InfraImpactResponseDto })
  getImpact(@Param('id') id: string) {
    return this.infra.getImpact(id);
  }

  @Post('nodes')
  @RequirePermission('infra:manage', 'asset:write')
  @ApiOperation({
    summary:
      'Create a node. Asset-backed by default (links/creates a backing Asset); pass trackAsAsset:false for a graph-only node. Asset-backed create also requires asset:write (ADR-0070 §5/§8).',
  })
  @ApiCreatedResponse({ type: InfraNodeDto })
  createNode(
    @Body() dto: CreateInfraNodeWithFlagDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    const { trackAsAsset, ...node } = dto;
    return this.infra.createNode(node, trackAsAsset ?? true, principal);
  }

  @Patch('nodes/:id/position')
  @RequirePermission('infra:manage')
  @ApiOperation({
    summary: 'Persist a node canvas position (x/y) — cheap, debounce-friendly.',
  })
  @ApiOkResponse({ type: InfraNodeDto })
  patchPosition(@Param('id') id: string, @Body() dto: PatchPositionDto) {
    return this.infra.updatePosition(id, dto.x, dto.y);
  }

  @Patch('nodes/:id')
  @RequirePermission('infra:manage')
  @ApiOperation({
    summary:
      'Update a node. assetId:null detaches the link (soft-deletes an auto-created Asset, un-links a pre-existing one — ADR-0070 §5).',
  })
  @ApiOkResponse({ type: InfraNodeDto })
  updateNode(
    @Param('id') id: string,
    @Body() dto: UpdateInfraNodeDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.infra.updateNode(id, dto, principal);
  }

  @Delete('nodes/:id')
  @RequirePermission('infra:manage')
  @ApiOperation({ summary: 'Soft-delete a node (off the map; history kept).' })
  @ApiOkResponse({ type: InfraNodeDto })
  removeNode(@Param('id') id: string) {
    return this.infra.removeNode(id);
  }

  @Post('nodes/:id/restore')
  @RequirePermission('infra:manage')
  @ApiOperation({ summary: 'Restore a soft-deleted node.' })
  @ApiOkResponse({ type: InfraNodeDto })
  restoreNode(@Param('id') id: string) {
    return this.infra.restoreNode(id);
  }

  // ── Node → secret linkage (ADR-0073, #801) ──────────────────────────────────

  @Post('nodes/:id/secrets')
  @RequirePermission('infra:manage', 'secret:read')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Attach a secret HANDLE reference to a node (handle + vaultId in the body; never a value — INV-10). Requires infra:manage + secret:read AND live membership of the vault (enforced server-side). Idempotent on (node, vault, handle). Returns the node’s updated resolved secretRefs (ADR-0073).',
  })
  @ApiOkResponse({ type: [InfraSecretRefDto] })
  attachSecret(
    @Param('id') id: string,
    @Body() dto: AttachInfraSecretDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.infra.attachSecret(id, dto, principal);
  }

  @Delete('nodes/:id/secrets')
  @RequirePermission('infra:manage')
  @ApiOperation({
    summary:
      'Detach a secret HANDLE reference from a node (handle + vaultId in the BODY — handles can contain dots). A topology edit: infra:manage only, no vault membership needed. Idempotent. Returns the node’s updated resolved secretRefs (ADR-0073).',
  })
  @ApiOkResponse({ type: [InfraSecretRefDto] })
  detachSecret(@Param('id') id: string, @Body() dto: AttachInfraSecretDto) {
    return this.infra.detachSecret(id, dto);
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  @Get('nodes/:id/edges')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      "List a node's edges (either endpoint), newest first. active=false includes closed edges (migration history).",
  })
  @ApiQuery({
    name: 'active',
    required: false,
    type: Boolean,
    description:
      'Default true (open edges only). false includes closed edges (endedAt set).',
  })
  @ApiOkResponse({ type: [InfraEdgeDto] })
  listEdges(@Param('id') id: string, @Query('active') active?: string) {
    return this.infra.listEdgesForNode(id, parseBooleanQuery(active, true));
  }

  @Post('edges')
  @RequirePermission('infra:manage')
  @ApiOperation({
    summary:
      'Open an edge. CONNECTS_TO is canonicalized (lower id as source); a new RUNS_ON for a source with an active host migrates (closes the old, opens the new); implausible kind pairs warn, never block (ADR-0070 §3).',
  })
  @ApiCreatedResponse({ type: InfraEdgeDto })
  createEdge(@Body() dto: CreateInfraEdgeDto) {
    return this.infra.createEdge(dto);
  }

  @Post('edges/:id/close')
  @RequirePermission('infra:manage')
  @ApiOperation({
    summary:
      'Close an edge (set endedAt) — the ADR-0019 lifecycle/migration marker.',
  })
  @ApiOkResponse({ type: InfraEdgeDto })
  closeEdge(@Param('id') id: string) {
    return this.infra.closeEdge(id);
  }

  /** Parse an optional `@Query` enum against its allowlist; unknown value → 400 (ADR-0030). */
  private parseEnum<T extends string>(
    value: string | undefined,
    schema: z.ZodType<T>,
    name: string,
  ): T | undefined {
    if (value === undefined) return undefined;
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(`Invalid ${name}`);
    }
    return result.data;
  }
}
