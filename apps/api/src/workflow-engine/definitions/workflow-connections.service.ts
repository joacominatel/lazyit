import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  offsetOf,
  pageOf,
  WorkflowConnectionConfigSchema,
  type CreateWorkflowConnection,
  type PageQuery,
  type WorkflowConnectionConfig,
} from '@lazyit/shared';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** The api-internal connection patch (name / config / credential reference). Kind is immutable. */
export interface UpdateWorkflowConnectionInput {
  name?: string;
  config?: WorkflowConnectionConfig;
  secretId?: string | null;
}

/**
 * WorkflowConnection CRUD (contract C1, ADR-0054 §4) — the per-app connector INSTANCE. `config` is the
 * zod-validated-per-kind non-secret settings (base URL, auth scheme, header names) — NEVER a credential
 * (that is a `secretId` reference into the encrypted store, INV-6). Mutable + soft-delete.
 */
@Injectable()
export class WorkflowConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a connection. `config.kind` must equal `kind` (the shared DTO refine already guarantees it). */
  async create(dto: CreateWorkflowConnection) {
    await this.assertApplicationUsable(dto.applicationId);
    return this.prisma.workflowConnection.create({
      data: {
        applicationId: dto.applicationId,
        kind: dto.kind,
        name: dto.name,
        config: dto.config,
      },
    });
  }

  async findPage(applicationId: string | undefined, page: PageQuery) {
    const where: Prisma.WorkflowConnectionWhereInput = {
      deletedAt: null,
      ...(applicationId ? { applicationId } : {}),
    };
    const { take, skip } = offsetOf(page);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workflowConnection.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.workflowConnection.count({ where }),
    ]);
    return pageOf(items, total, page);
  }

  async findOne(id: string) {
    const connection = await this.prisma.workflowConnection.findFirst({
      where: { id, deletedAt: null },
    });
    if (!connection) {
      throw new NotFoundException(`WorkflowConnection ${id} not found`);
    }
    return connection;
  }

  /** Patch name / config / credential reference. A `config` change may not change the connection kind. */
  async update(id: string, dto: UpdateWorkflowConnectionInput) {
    const connection = await this.findOne(id);
    if (dto.config && dto.config.kind !== connection.kind) {
      throw new BadRequestException(
        `config.kind (${dto.config.kind}) must match the connection kind (${connection.kind})`,
      );
    }
    if (dto.secretId !== undefined && dto.secretId !== null) {
      await this.assertSecretUsable(dto.secretId, connection.applicationId);
    }
    return this.prisma.workflowConnection.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.config !== undefined ? { config: dto.config } : {}),
        ...(dto.secretId !== undefined ? { secretId: dto.secretId } : {}),
      },
    });
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.prisma.workflowConnection.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException(`WorkflowConnection ${id} not found`);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Validate a config blob against the per-kind discriminated union (defense beyond the DTO). */
  static validateConfig(config: unknown): WorkflowConnectionConfig {
    const parsed = WorkflowConnectionConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new BadRequestException('Invalid connection config');
    }
    return parsed.data;
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

  private async assertSecretUsable(
    secretId: string,
    applicationId: string,
  ): Promise<void> {
    const secret = await this.prisma.workflowSecret.findFirst({
      where: { id: secretId, deletedAt: null },
      select: { applicationId: true },
    });
    if (!secret) {
      throw new BadRequestException(
        `secretId ${secretId} does not reference a live secret`,
      );
    }
    if (secret.applicationId !== applicationId) {
      throw new BadRequestException(
        'The secret belongs to a different application',
      );
    }
  }
}
