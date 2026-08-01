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
  Req,
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
import type { Request } from 'express';
import {
  AgentReportAckSchema,
  AgentReportSchema,
  AttachInfraSecretSchema,
  BulkConfirmInfraNodesSchema,
  BulkDiscardInfraNodesSchema,
  ConfirmInfraNodeSchema,
  CreateInfraAutoConfirmRuleSchema,
  CreateInfraEdgeSchema,
  CreateInfraNodeSchema,
  InfraAutoConfirmRuleSchema,
  InfraBulkResponseSchema,
  InfraEdgeSchema,
  InfraIdentityMatchSchema,
  InfraImpactResponseSchema,
  InfraNodeDetailSchema,
  InfraNodeKindSchema,
  InfraNodeListItemSchema,
  InfraNodeSchema,
  InfraNodeStateSchema,
  InfraNodeStatusSchema,
  InfraSecretRefSchema,
  MergeInfraNodeSchema,
  UpdateInfraAutoConfirmRuleSchema,
  UpdateInfraNodeSchema,
} from '@lazyit/shared';
import { z } from 'zod';
import { InfraService } from './infra.service';
import { InfraAutoConfirmService } from './infra-auto-confirm.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';
import { HumanOnlyGuard } from '../secret-manager/human-only.guard';
import { InfraReportRateLimitGuard } from './infra-report-rate-limit.guard';

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
class ConfirmInfraNodeDto extends createZodDto(ConfirmInfraNodeSchema) {}
class MergeInfraNodeDto extends createZodDto(MergeInfraNodeSchema) {}
class InfraIdentityMatchDto extends createZodDto(InfraIdentityMatchSchema) {}
class BulkConfirmInfraNodesDto extends createZodDto(
  BulkConfirmInfraNodesSchema,
) {}
class BulkDiscardInfraNodesDto extends createZodDto(
  BulkDiscardInfraNodesSchema,
) {}
class InfraBulkResponseDto extends createZodDto(InfraBulkResponseSchema) {}
class InfraAutoConfirmRuleDto extends createZodDto(
  InfraAutoConfirmRuleSchema,
) {}
class CreateInfraAutoConfirmRuleDto extends createZodDto(
  CreateInfraAutoConfirmRuleSchema,
) {}
class UpdateInfraAutoConfirmRuleDto extends createZodDto(
  UpdateInfraAutoConfirmRuleSchema,
) {}

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
  constructor(
    private readonly infra: InfraService,
    // The #1145 auto-confirm rules. Their CRUD is its own service; InfraService only CONSULTS it, on
    // the report create branches — the routes below never touch a node.
    private readonly autoConfirm: InfraAutoConfirmService,
  ) {}

  // ── Reporting agent (ADR-0074) ───────────────────────────────────────────────

  @Post('report')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('infra:report')
  // THROTTLED (#1134): the permission alone bounded the blast radius but not the WRITE VOLUME — every
  // unknown `externalId` mints a row carrying a `specs` jsonb blob, so a leaked token (or a
  // misconfigured `OnUnitActiveSec=1s`) was an unbounded DB-fill on a self-hosted box. The guard caps
  // reports per SERVICE ACCOUNT per window (never per IP — agents share an egress NAT); the service's
  // enrollment limiter caps how many NEW nodes those reports may create per window.
  @UseGuards(InfraReportRateLimitGuard)
  @ApiOperation({
    summary:
      'Ingest a server reporting-agent inventory report (ADR-0074). MACHINE-intended: authenticated by the agent Service Account holding infra:report. Upserts on (reportingSource, externalId) — a new host lands in the PENDING review tray (no Asset yet) with its kind PROPOSED from the reported virtualization/chassis (#1139; a report with no evidence falls back to PHYSICAL_HOST); a known host refreshes its inventory + liveness without touching human curation, and is never re-kinded. A report carrying host.containers[] also reconciles CONTAINER child nodes joined to the host by an active RUNS_ON edge — absent means the collector never probed (nothing is touched), [] means it probed and found none (existing children go OFFLINE, never deleted). Rate-limited per service account, and a NEW host or child is refused once that account has enrolled its per-window quota — already-known hosts keep refreshing regardless, and a budget spent mid-list never fails the host report. Returns a minimal ack.',
  })
  @ApiOkResponse({ type: AgentReportAckDto })
  // FORWARD-COMPATIBLE (#1138): the contract root is no longer `strictObject`, so a report from a
  // NEWER agent degrades (unknown root keys stripped, host still ingested) instead of 400-ing — a host
  // vanishing from the CMDB is strictly worse than one stale on new fields. The pipe strips those keys
  // BEFORE this handler runs, so `req.body` — the raw parsed JSON, which the pipe does not mutate — is
  // the only place the evidence survives. It is handed to the service, which records what it dropped.
  report(
    @Body() report: AgentReportDto,
    @Req() req: Request,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.infra.ingestReport(report, principal, req.body);
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

  @Post('nodes/:id/confirm')
  // Asset-backed by default (mirrors POST /nodes), so the same infra:manage + asset:write posture.
  @RequirePermission('infra:manage', 'asset:write')
  // HUMAN-ONLY: confirming is human curation — the whole point of PENDING is a human gate, so a
  // machine (the reporting agent SA) must never self-confirm its own proposals (ADR-0074 §1/§8).
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Confirm a PENDING agent-reported node from the ADR-0074 review tray: flips state to CONFIRMED and (trackAsAsset, default true) mints the backing Asset with the agent host facts carried over — making the auto-discovered host a first-class Asset only on human approval. Optional kind/label overrides re-classify/rename. Idempotent on an already-confirmed node. To DISCARD a proposal instead, soft-delete it (DELETE /infra/nodes/:id).',
  })
  @ApiOkResponse({ type: InfraNodeDetailDto })
  confirmNode(
    @Param('id') id: string,
    @Body() dto: ConfirmInfraNodeDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.infra.confirmNode(id, dto, principal);
  }

  // ── The review tray at scale (ADR-0074 §1 amendment, #1145) ─────────────────

  @Post('nodes/bulk-confirm')
  // Identical posture to the single confirm — it IS the single confirm, run per item.
  @RequirePermission('infra:manage', 'asset:write')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Confirm MANY PENDING proposals in one request (ADR-0074 §1 amendment, #1145). Each item carries the SAME optional overrides the single confirm takes (trackAsAsset, kind, label) and is applied through the SAME method, so the semantics are identical — this only removes the one-dialog-per-row cost of onboarding a host that reports its containers. PER-ITEM outcomes: `applied`, `skipped` (already CONFIRMED — the single confirm is idempotent), `notFound` (discarded meanwhile) or `failed` with the message the single action would have returned. One failing item never discards the rest. Sequential server-side; bounded at 200 items.',
  })
  @ApiOkResponse({ type: InfraBulkResponseDto })
  bulkConfirm(
    @Body() dto: BulkConfirmInfraNodesDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.infra.bulkConfirmNodes(dto, principal);
  }

  @Post('nodes/bulk-discard')
  // Mirrors the single discard (DELETE /infra/nodes/:id): a topology edit, infra:manage only.
  @RequirePermission('infra:manage')
  @ApiOperation({
    summary:
      'Discard MANY proposals in one request (#1145). Discard is still the EXISTING soft delete — restorable, history kept; there is no reject endpoint (ADR-0074 §3). One statement for the whole batch. PER-ITEM outcomes: `applied`, or `notFound` for an id that was already gone (which never widens the write).',
  })
  @ApiOkResponse({ type: InfraBulkResponseDto })
  bulkDiscard(@Body() dto: BulkDiscardInfraNodesDto) {
    return this.infra.bulkDiscardNodes(dto);
  }

  // ── Auto-confirm rules (ADR-0074 §1 amendment, #1145) ───────────────────────

  @Get('auto-confirm-rules')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      'List the operator-authored auto-confirm rules, OLDEST FIRST — the order the matcher evaluates them in (first match wins). Disabled rules are included: this is a management surface, and a hidden disabled rule is a surprise waiting for whoever re-enables it. Each row carries its author (null when the rule predates the column or its author was deleted) plus how many times it has fired and when it last did.',
  })
  @ApiOkResponse({ type: [InfraAutoConfirmRuleDto] })
  listAutoConfirmRules() {
    return this.autoConfirm.list();
  }

  @Post('auto-confirm-rules')
  // Writing a rule is authoring a decision that will later mint Assets, so it carries the same pair
  // the confirm it automates carries.
  @RequirePermission('infra:manage', 'asset:write')
  // HUMAN-ONLY, and this is the load-bearing guard of the whole amendment: a rule is the human
  // decision that lets a later confirm happen without a human present, so a machine authoring one
  // would be the reporting agent granting itself the confirm ADR-0074 §1/§8 denies it.
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Save an auto-confirm rule (ADR-0074 §1 amendment, #1145). NOT RETROACTIVE: rules are evaluated only on reports that arrive AFTER they are saved, so proposals already in the review tray are never confirmed behind the operator. A rule MUST state at least one condition that can rule a proposal OUT — a hostname glob carrying a literal character (`*`, `**` and `*?*` match every name there is, so they state nothing), a subnet narrower than `/0`, or the kind the server proposed. A rule whose conditions exclude nothing IS blanket auto-confirm however it is spelled, and ADR-0074 §1 rejected that. `trackAsAsset` defaults ON for a HOST rule and OFF for any rule that can also reach a container child (CONTAINER or ANY). The authoring user is recorded and the Assets an auto-confirm mints are attributed to them. A key a human already DISCARDED is never auto-confirmed on a later report.',
  })
  @ApiCreatedResponse({ type: InfraAutoConfirmRuleDto })
  createAutoConfirmRule(
    @Body() dto: CreateInfraAutoConfirmRuleDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.autoConfirm.create(dto, principal);
  }

  @Patch('auto-confirm-rules/:id')
  @RequirePermission('infra:manage', 'asset:write')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Update a rule — including the `enabled` toggle, which is the fastest revocation (a disabled rule stops matching immediately). 400 if the patch would leave the MERGED rule with no condition that can rule a proposal out — nulling the last one, or widening it to an all-wildcard pattern or `/0`, are the same blanket rule spelled three ways.',
  })
  @ApiOkResponse({ type: InfraAutoConfirmRuleDto })
  updateAutoConfirmRule(
    @Param('id') id: string,
    @Body() dto: UpdateInfraAutoConfirmRuleDto,
  ) {
    return this.autoConfirm.update(id, dto);
  }

  @Delete('auto-confirm-rules/:id')
  @RequirePermission('infra:manage')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Delete a rule (soft delete, ADR-0006 — it stops matching immediately, the record of the decision is kept). Nodes it already confirmed are NOT reverted: they are confirmed inventory rows a human policy approved, and un-confirming them would be as retroactive as applying a rule backwards.',
  })
  @ApiOkResponse({ type: InfraAutoConfirmRuleDto })
  removeAutoConfirmRule(@Param('id') id: string) {
    return this.autoConfirm.remove(id);
  }

  // ── Identity reconciliation (ADR-0074 §3 amendment, #1141) ──────────────────

  @Get('nodes/:id/identity-matches')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      'Other live nodes whose stored corroborating evidence (host.identifiers) shares a burned-in serial or MAC with this one — the "this looks like srv-app-04 re-imaged, adopt?" hint above a fresh proposal (ADR-0074 §3 / #1141). Read-only: it suggests a merge, it never performs one. Empty for a node reported by an agent older than contract v2 (no identifiers stored), and hostname matches are deliberately never offered.',
  })
  @ApiOkResponse({ type: [InfraIdentityMatchDto] })
  identityMatches(@Param('id') id: string) {
    return this.infra.findIdentityMatches(id);
  }

  @Post('nodes/:id/merge-into')
  @RequirePermission('infra:manage')
  // HUMAN-ONLY, for the same reason confirm is: this moves a dedup key between nodes and archives one
  // of them. A reporting agent must never be able to re-key its own way out of the PENDING tray.
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Merge this (duplicate) node INTO an existing one: transplant its agent reporting key onto the target so future reports land there, then soft-delete this node with the merge stamped on it (the audit trail — there is no node history table). The re-image adoption path and the remedy for a cloned machine-id (ADR-0074 §3 / #1141). Identity moves; curation does NOT — the target keeps its label, state, kind, position and asset link. 400 on a self-merge or a source with no reporting key.',
  })
  @ApiOkResponse({ type: InfraNodeDetailDto })
  mergeNodeInto(
    @Param('id') id: string,
    @Body() dto: MergeInfraNodeDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.infra.mergeNodeInto(id, dto.targetNodeId, principal);
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
