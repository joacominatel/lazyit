import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  offsetOf,
  pageOf,
  type CreateApplicationWorkflow,
  type CreateWorkflowVersion,
  type PageQuery,
  type UpdateApplicationWorkflow,
} from '@lazyit/shared';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActorService } from '../../common/actor.service';
import type { Principal } from '../../auth/principal';
import { EngineServiceAccountService } from '../engine-service-account.service';
import {
  assertAllStepsReachable,
  stepsNeedingConnection,
} from './workflow-graph.validation';

/**
 * Workflow-definition CRUD (contract C1, ADR-0054 §4). The `ApplicationWorkflow` is the opt-in binding
 * HEADER (trigger + deprovision policy + the engine SA it runs as); the step GRAPH lives in immutable,
 * append-only `WorkflowVersion`s (the ArticleVersion precedent) — every save AUTHORS a new version and a
 * read returns the LATEST version's full graph so the builder can re-open it. At most one LIVE workflow
 * per (applicationId, trigger) — a partial-unique index backs it; we pre-check for a clean 409.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly engineSa: EngineServiceAccountService,
  ) {}

  /**
   * Create a workflow binding. Defaults the executor to the least-privilege engine SA when unset. No
   * actor attribution on the header (the ApplicationWorkflow has no creator column — versions carry the
   * author); the creator's principal is therefore not needed here.
   */
  async create(dto: CreateApplicationWorkflow) {
    await this.assertApplicationUsable(dto.applicationId);
    const existing = await this.prisma.applicationWorkflow.findFirst({
      where: {
        applicationId: dto.applicationId,
        trigger: dto.trigger,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `A workflow already exists for this application + ${dto.trigger} trigger`,
      );
    }
    const executedAsServiceAccountId =
      dto.executedAsServiceAccountId ?? (await this.engineSa.getOrCreate());
    return this.prisma.applicationWorkflow.create({
      data: {
        applicationId: dto.applicationId,
        trigger: dto.trigger,
        name: dto.name,
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        enabled: dto.enabled,
        deprovisionPolicy: dto.deprovisionPolicy,
        executedAsServiceAccountId,
      },
    });
  }

  /** A page of workflows (newest-first), optionally scoped to an application. */
  async findPage(applicationId: string | undefined, page: PageQuery) {
    const where: Prisma.ApplicationWorkflowWhereInput = {
      deletedAt: null,
      ...(applicationId ? { applicationId } : {}),
    };
    const { take, skip } = offsetOf(page);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.applicationWorkflow.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.applicationWorkflow.count({ where }),
    ]);
    return pageOf(items, total, page);
  }

  /** A workflow + its LATEST version's full graph (for the builder to render + re-open). 404 if missing. */
  async findOne(id: string) {
    const workflow = await this.prisma.applicationWorkflow.findFirst({
      where: { id, deletedAt: null },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!workflow) {
      throw new NotFoundException(`ApplicationWorkflow ${id} not found`);
    }
    const { versions, ...header } = workflow;
    return { ...header, latestVersion: versions[0] ?? null };
  }

  /** Patch the header (name / description / enabled / deprovisionPolicy / executor). 404 if missing. */
  async update(id: string, dto: UpdateApplicationWorkflow) {
    await this.assertWorkflowLive(id);
    return this.prisma.applicationWorkflow.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.deprovisionPolicy !== undefined
          ? { deprovisionPolicy: dto.deprovisionPolicy }
          : {}),
        ...(dto.executedAsServiceAccountId !== undefined
          ? { executedAsServiceAccountId: dto.executedAsServiceAccountId }
          : {}),
      },
    });
  }

  /** Soft-delete a workflow (frees the (app, trigger) slot for reuse; ADR-0041). 404 if missing. */
  async softDelete(id: string): Promise<void> {
    const result = await this.prisma.applicationWorkflow.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException(`ApplicationWorkflow ${id} not found`);
    }
  }

  /**
   * Author a new immutable version (the step graph). Validates the graph beyond the shared zod schema
   * (reachability + connection references), then allocates the next monotonic version number inside a
   * tx (the (workflowId, version) unique backstops a race). Attributed to the author (human XOR SA).
   */
  async authorVersion(
    id: string,
    dto: CreateWorkflowVersion,
    principal?: Principal,
  ) {
    const workflow = await this.assertWorkflowLive(id);
    // (1) Reachability over the effective edges (the shared schema already checked acyclicity etc.).
    assertAllStepsReachable(dto.steps);
    // (2) Every REST/WEBHOOK connectionId must be a live connection of THIS app whose kind matches.
    await this.assertConnectionsValid(workflow.applicationId, dto.steps);

    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.workflowVersion.findFirst({
        where: { workflowId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (last?.version ?? 0) + 1;
      return tx.workflowVersion.create({
        data: {
          workflowId: id,
          version,
          steps: dto.steps,
          ...(actor.userId != null ? { createdById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { createdBySaId: actor.serviceAccountId }
            : {}),
        },
      });
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async assertWorkflowLive(id: string) {
    const workflow = await this.prisma.applicationWorkflow.findFirst({
      where: { id, deletedAt: null },
    });
    if (!workflow) {
      throw new NotFoundException(`ApplicationWorkflow ${id} not found`);
    }
    return workflow;
  }

  private async assertApplicationUsable(applicationId: string): Promise<void> {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!application) {
      throw new BadRequestException(
        `applicationId ${applicationId} does not reference a live application`,
      );
    }
  }

  /** Validate each connection-bearing step against live connections of the workflow's application. */
  private async assertConnectionsValid(
    applicationId: string,
    steps: CreateWorkflowVersion['steps'],
  ): Promise<void> {
    const refs = stepsNeedingConnection(steps);
    if (refs.length === 0) {
      return;
    }
    const ids = [...new Set(refs.map((r) => r.connectionId))];
    const connections = await this.prisma.workflowConnection.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, applicationId: true, kind: true },
    });
    const byId = new Map(connections.map((c) => [c.id, c]));
    for (const ref of refs) {
      const conn = byId.get(ref.connectionId);
      if (!conn) {
        throw new BadRequestException({
          message: `Step ${ref.index} references connection ${ref.connectionId} which does not exist`,
          path: ['steps', ref.index, 'connectionId'],
        });
      }
      if (conn.applicationId !== applicationId) {
        throw new BadRequestException({
          message: `Step ${ref.index} references a connection from a different application`,
          path: ['steps', ref.index, 'connectionId'],
        });
      }
      if (conn.kind !== ref.kind) {
        throw new BadRequestException({
          message: `Step ${ref.index} (${ref.kind}) references a ${conn.kind} connection`,
          path: ['steps', ref.index, 'connectionId'],
        });
      }
    }
  }
}
