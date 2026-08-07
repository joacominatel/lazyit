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
  Put,
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
  AgentFleetViewSchema,
  AgentPolicyOverrideSchema,
  AgentPolicySettingsSchema,
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
  InfraGraphSchema,
  InfraNodeDetailSchema,
  InfraNodeFactChangeListSchema,
  InfraNodeKindSchema,
  InfraNodeListItemSchema,
  InfraNodeListPageSchema,
  InfraNodeSchema,
  InfraNodeSourceSchema,
  InfraNodeStateSchema,
  InfraNodeStatusSchema,
  InfraSecretRefSchema,
  MergeInfraNodeSchema,
  UpdateInfraAutoConfirmRuleSchema,
  UpdateInfraNodeSchema,
} from '@lazyit/shared';
import { z } from 'zod';
import { INFRA_NODE_SORT_ALLOWLIST, InfraService } from './infra.service';
import { InfraAutoConfirmService } from './infra-auto-confirm.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parseCuidArrayQuery } from '../common/parse-cuid-array-query';
import { parsePageQuery } from '../common/parse-page-query';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';
import { HumanOnlyGuard } from '../secret-manager/human-only.guard';
import { InfraReportRateLimitGuard } from './infra-report-rate-limit.guard';
import { AgentPolicyService } from './agent-policy.service';
import { AgentFleetService } from './agent-fleet.service';

class InfraNodeDto extends createZodDto(InfraNodeSchema) {}
class AgentFleetViewDto extends createZodDto(AgentFleetViewSchema) {}
class InfraNodeListItemDto extends createZodDto(InfraNodeListItemSchema) {}
class InfraNodeListPageDto extends createZodDto(InfraNodeListPageSchema) {}
class InfraGraphDto extends createZodDto(InfraGraphSchema) {}
class InfraNodeDetailDto extends createZodDto(InfraNodeDetailSchema) {}
class InfraImpactResponseDto extends createZodDto(InfraImpactResponseSchema) {}
class InfraNodeFactChangeListDto extends createZodDto(
  InfraNodeFactChangeListSchema,
) {}
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
class AgentPolicySettingsDto extends createZodDto(AgentPolicySettingsSchema) {}
class AgentPolicyOverrideDto extends createZodDto(AgentPolicyOverrideSchema) {}

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
    private readonly agentPolicy: AgentPolicyService,
    // The ADR-0094 assisted-update READ (#1206). Read-only: it computes the version buckets and
    // projects `specs.host.os.family`; it writes nothing and sends nothing toward a host.
    private readonly agentFleet: AgentFleetService,
  ) {}

  // ── The agent fleet view (ADR-0094 §4, #1206 — absorbs epic #1146 item 1) ───

  @Get('agents/fleet')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      'The agent fleet: every agent-bearing host bucketed by version against the running instance, plus liveness, collector diagnostics and the agent credentials that have never been used (ADR-0094 §4).',
    description:
      'A READ — no write, no migration, nothing pushed to any host (ADR-0094 shape B). Each row carries ' +
      'its `versionBucket`: `majorBehind` (the #907 nag tier), `behind` (a MINOR/PATCH gap — the table, ' +
      'never a nag), `unknown` (a side did not parse — `dev`, unstamped, an odd tag) or `current` ' +
      '(up to date, or ahead mid-upgrade). FAIL-SOFT is unchanged from `isNewerVersion`/`isMajorBehind`: ' +
      'an unparseable version is NEVER "behind" — what ADR-0094 §3 changes is only that "unknown" is a ' +
      'visible bucket instead of silence. Until #1203 every Docker-served binary reports `dev`, so an ' +
      'estate honestly reads as entirely "version unknown". `osFamily` is projected out of the stored ' +
      '`specs` blob per read (the ADR-0090 display-only computed-read-field mold — no column, no ' +
      'migration) so the caller can build the correctly-flagged per-platform install command; a null ' +
      'family means show BOTH commands, never guess. CONTAINER children are excluded: they inherit ' +
      "their host's `agentVersion` and would inflate every bucket. TWO GATES: the table is " +
      '`infra:read`, but the agent CREDENTIAL inventory (`identities` + `identitiesNeverUsed`) is the ' +
      'same service-account data `/service-accounts` returns, so it additionally requires ' +
      '`settings:manage` and is OMITTED — not emptied — for a caller without it. `infra:read` reaches ' +
      'MEMBER and VIEWER by default; enumerating agent credentials must not.',
  })
  @ApiOkResponse({ type: AgentFleetViewDto })
  getAgentFleet(@CurrentPrincipal() principal?: Principal) {
    return this.agentFleet.getFleet(principal);
  }

  // ── Server-driven agent policy (ADR-0074 §7 amendment, #1140) ────────────────
  //
  // EVERY write here is HUMAN-ONLY and none of them is reachable with `infra:report`. That is the
  // load-bearing security property of the whole feature: the reporting agent's Service Account can
  // RECEIVE a policy on its ack and can never author one, so a leaked agent token cannot reconfigure
  // the fleet it belongs to. The policy schema itself is a closed set of booleans, integers and glob
  // strings — no commands, no scripts, no paths, no regex — so even a compromised ADMIN session
  // cannot turn this channel into remote execution on the estate.

  @Get('agent-policy')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      'The INSTANCE DEFAULT agent policy + the instance-wide policy revision (ADR-0074 §7 / #1140). `settings` is the stored layer an operator edits; `effective` is that layer resolved over the built-in defaults — it is NOT what a host with a service-account or node override runs, since those layers are narrower. Read-tolerant: a stored layer this build cannot parse resolves as "no override" rather than failing.',
  })
  @ApiOkResponse({ type: AgentPolicySettingsDto })
  getAgentPolicy() {
    return this.agentPolicy.getSettings();
  }

  @Put('agent-policy')
  @RequirePermission('settings:manage')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Replace the INSTANCE DEFAULT agent policy and bump the instance-wide revision (ADR-0074 §7 / #1140). The body is a PARTIAL policy — every omitted field falls back to the built-in default, and `{}` restores all of them. Agents pick the new policy up on their NEXT report (the ack is the channel), so a change propagates within one reporting interval and can never brick a fleet mid-collection. HUMAN-ONLY and settings:manage — a reporting agent can receive a policy, never author one.',
  })
  @ApiOkResponse({ type: AgentPolicySettingsDto })
  putAgentPolicy(@Body() dto: AgentPolicyOverrideDto) {
    return this.agentPolicy.setInstanceOverride(dto);
  }

  @Put('agent-policy/service-accounts/:id')
  @RequirePermission('settings:manage')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Set the per-SERVICE-ACCOUNT agent policy layer (ADR-0074 §7 / #1140) — the middle scope, and the only one that can configure a host before it has a node, since the "Add a server" wizard mints one service account per agent. Overrides the instance default; a node override still wins over it. 404 on an unknown or revoked account.',
  })
  @ApiOkResponse({ type: AgentPolicySettingsDto })
  putServiceAccountAgentPolicy(
    @Param('id') id: string,
    @Body() dto: AgentPolicyOverrideDto,
  ) {
    return this.agentPolicy.setServiceAccountOverride(id, dto);
  }

  @Delete('agent-policy/service-accounts/:id')
  @RequirePermission('settings:manage')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      'Clear the per-service-account agent policy layer, so that account inherits the instance default again. Bumps the revision like any other policy write.',
  })
  @ApiOkResponse({ type: AgentPolicySettingsDto })
  deleteServiceAccountAgentPolicy(@Param('id') id: string) {
    return this.agentPolicy.setServiceAccountOverride(id, null);
  }

  @Put('nodes/:id/agent-policy')
  @RequirePermission('infra:manage')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      "Set the per-NODE agent policy layer (ADR-0074 §7 / #1140) — the narrowest scope, which wins over the service account and the instance default. `effective` in the response resolves this layer over the INSTANCE DEFAULT only: it deliberately omits the reporting account's layer, because the server does not know which account reports a node until one does.",
  })
  @ApiOkResponse({ type: AgentPolicySettingsDto })
  putNodeAgentPolicy(
    @Param('id') id: string,
    @Body() dto: AgentPolicyOverrideDto,
  ) {
    return this.agentPolicy.setNodeOverride(id, dto);
  }

  @Delete('nodes/:id/agent-policy')
  @RequirePermission('infra:manage')
  @UseGuards(HumanOnlyGuard)
  @ApiOperation({
    summary:
      "Clear a node's agent policy override, so it inherits its service account's layer and the instance default again. Bumps the revision like any other policy write.",
  })
  @ApiOkResponse({ type: AgentPolicySettingsDto })
  deleteNodeAgentPolicy(@Param('id') id: string) {
    return this.agentPolicy.setNodeOverride(id, null);
  }

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
      'List topology nodes, PAGED on the house Page<T> contract (ADR-0030): { items, total, limit, offset }, default 50, hard max 200 (an over-max limit is a 400, never clamped). Filter by kind/status/state/source/assetIds, search with q (label / IP / linked asset name / owner name+email), sort on the allowlist. `total` counts the FILTERED set. Excludes archived/soft-deleted. Default order: newest first with a unique id tiebreaker. BREAKING (#1152): this returned a bare array before — the topology canvas moved to GET /infra/graph/nodes.',
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
  @ApiQuery({
    name: 'source',
    required: false,
    enum: [...InfraNodeSourceSchema.options],
    description:
      'MANUAL (hand-drawn) or AGENT (reported). Pair with limit=1 to ask "does this estate have any agent node yet?" without reading the list.',
  })
  @ApiQuery({
    name: 'ids',
    required: false,
    description:
      'Comma-encoded cuids: restrict to these node ids. For a caller that already knows which nodes it needs and only wants their labels (the drill-in edge panel).',
  })
  @ApiQuery({
    name: 'assetIds',
    required: false,
    description:
      'Comma-encoded cuids: restrict to the nodes backing these Assets. Bounded by the page limit; an unknown id matches nothing. Powers the Assets list "on topology" glyph over the rows it is showing.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      "Case-insensitive substring over label / ipAddress / the linked Asset's name / each active owner's name+email.",
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(INFRA_NODE_SORT_ALLOWLIST),
    description:
      'Server-side sort field. Unknown field → 400. Default: createdAt desc (with a unique id tiebreaker, which is appended to every sort).',
  })
  @ApiQuery({
    name: 'dir',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort direction (default asc when sort is set).',
  })
  @ApiOkResponse({ type: InfraNodeListPageDto })
  listNodes(
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('state') state?: string,
    @Query('source') source?: string,
    @Query('ids') ids?: string | string[],
    @Query('assetIds') assetIds?: string | string[],
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
  ) {
    // `deleted` is deliberately NOT forwarded (ADR-0030 §7): the web has no archived-nodes view, so
    // the slice would be contract surface nothing consumes. Not accepting the param is also why
    // nothing is silently ignored — a caller cannot ask for a slice this endpoint doesn't serve.
    return this.infra.listNodes(
      {
        kind: this.parseEnum(kind, InfraNodeKindSchema, 'kind'),
        status: this.parseEnum(status, InfraNodeStatusSchema, 'status'),
        state: this.parseEnum(state, InfraNodeStateSchema, 'state'),
        source: this.parseEnum(source, InfraNodeSourceSchema, 'source'),
        ids: parseCuidArrayQuery(ids, 'ids'),
        assetIds: parseCuidArrayQuery(assetIds, 'assetIds'),
        q,
      },
      parsePageQuery({ limit, offset, page, sort, dir }),
    );
  }

  @Get('graph/nodes')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      "The topology canvas's own read (#1152): every live node, PROJECTED to just what the board draws (id/label/kind/status/ipAddress/x/y + chassis for the endpoint filter) — no owners/assetName join, no shortcuts, no specs. Deliberately NOT paged, because a map missing a node is a wrong map, not a shorter one. Bounded at INFRA_GRAPH_NODES_MAX and honest about it: the envelope carries `truncated` plus the real `total`, so a ceiling that bites is visible rather than silent. Same infra:read gate as the node list.",
  })
  @ApiOkResponse({ type: InfraGraphDto })
  listGraphNodes() {
    return this.infra.listGraphNodes();
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

  @Get('nodes/:id/changes')
  @RequirePermission('infra:read')
  @ApiOperation({
    summary:
      "A node's recorded fact history, newest first — what MOVED (packages added/removed/upgraded; OS, kernel, memory, disk, serial, container image), never one row per report. Keyset-paginated on the append-only id (ADR-0074 §3 amendment).",
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: Number })
  @ApiOkResponse({ type: InfraNodeFactChangeListDto })
  listNodeChanges(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.infra.listNodeFactChanges(id, {
      ...(limit !== undefined
        ? { limit: this.parsePositiveInt(limit, 'limit') }
        : {}),
      ...(cursor !== undefined
        ? { cursor: this.parsePositiveInt(cursor, 'cursor') }
        : {}),
    });
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
      'Update a node. assetId:null DETACHES the link (soft-deletes an auto-created Asset, un-links a pre-existing one — ADR-0070 §5); an assetId on a node that carries NONE attaches it (404 if that asset is missing or discarded). Re-pointing a node that ALREADY has an asset is a 400 — it would orphan the one it is carrying; detach first, then attach (#1117).',
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
      'Save an auto-confirm rule (ADR-0074 §1 amendment, #1145). NOT RETROACTIVE: rules are evaluated only on reports that arrive AFTER they are saved, so proposals already in the review tray are never confirmed behind the operator. A rule MUST state at least one condition that can rule a proposal OUT — a hostname glob carrying a LITERAL character, a subnet narrower than `/0`, or the kind the server proposed. A glob made only of wildcards is refused: most of them (`*`, `**`, `*?*`) match every name there is, and the few that do narrow (`?` alone matches only one-character names) are refused with them conservatively, so "carries a literal" stays a line you can check by looking. `0.0.0.0/0` is refused on the exact claim — it is every address there is. A rule stating no condition at all IS blanket auto-confirm however it is spelled, and ADR-0074 §1 rejected that; a rule the predicate refuses never fires either way, since the matcher applies the same test on read. `trackAsAsset` defaults ON for a HOST rule and OFF for any rule that can also reach a container child (CONTAINER or ANY). The authoring user is recorded and the Assets an auto-confirm mints are attributed to them. A key a human already DISCARDED is never auto-confirmed on a later report.',
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
      'Update a rule — including the `enabled` toggle, which is the fastest revocation (a disabled rule stops matching immediately). 400 if the patch would leave the MERGED rule with no condition that can rule a proposal out — nulling the last one, or widening it to a wildcard-only pattern or `/0`. Dropping ONE of several conditions is fine: the rule that survives still excludes proposals, and the check judges the merged rule, not the patch in isolation.',
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

  /**
   * A positive integer query param (the Changes tab's `limit`/`cursor`). REJECTED rather than coerced:
   * these two reach a `take` and a keyset `WHERE id <`, and a silent NaN would page unpredictably.
   * The service still clamps `limit` to its own ceiling — this only refuses what is not a number.
   */
  private parsePositiveInt(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`Invalid ${name}`);
    }
    return parsed;
  }
}
