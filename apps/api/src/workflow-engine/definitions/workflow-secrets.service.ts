import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  offsetOf,
  pageOf,
  type CreateWorkflowSecret,
  type Page,
  type PageQuery,
} from '@lazyit/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SecretService,
  type WorkflowSecretDescriptor,
} from '../secrets/secret.service';

/**
 * Write-only WorkflowSecret CRUD (contract C1 / §4b, INV-6). The cleartext goes in ONCE and is NEVER
 * echoed — every read returns the REDACTED {@link WorkflowSecretDescriptor} (`configured`, `label`,
 * never ciphertext/IV/tag). The actual AES-256-GCM crypto + persistence lives in {@link SecretService};
 * this service adds the redacted list/read and the convenience of linking a new secret to its
 * connection's credential reference in one step.
 */
@Injectable()
export class WorkflowSecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretService,
  ) {}

  /** Create (encrypt) a secret. If scoped to a connection, also points that connection at it. */
  async create(dto: CreateWorkflowSecret): Promise<WorkflowSecretDescriptor> {
    await this.assertApplicationUsable(dto.applicationId);
    if (dto.connectionId) {
      await this.assertConnectionUsable(dto.connectionId, dto.applicationId);
    }
    const descriptor = await this.secrets.create(dto);
    if (dto.connectionId) {
      // Convenience: a freshly-created connection-scoped secret becomes that connection's credential.
      await this.prisma.workflowConnection.updateMany({
        where: { id: dto.connectionId, deletedAt: null },
        data: { secretId: descriptor.id },
      });
    }
    return descriptor;
  }

  /** Rotate a live secret's value in place (re-encrypt). Returns the redacted descriptor. */
  async rotate(id: string, value: string): Promise<WorkflowSecretDescriptor> {
    try {
      return await this.secrets.rotate(id, value);
    } catch {
      throw new NotFoundException(`WorkflowSecret ${id} not found`);
    }
  }

  /** Soft-delete (revoke) a secret. A revoked secret can no longer authenticate a connector. */
  async softDelete(id: string): Promise<void> {
    try {
      await this.secrets.softDelete(id);
    } catch {
      throw new NotFoundException(`WorkflowSecret ${id} not found`);
    }
  }

  /** A page of REDACTED descriptors (never ciphertext), optionally scoped to an application. */
  async findPage(
    applicationId: string | undefined,
    page: PageQuery,
  ): Promise<Page<WorkflowSecretDescriptor>> {
    const where = {
      deletedAt: null,
      ...(applicationId ? { applicationId } : {}),
    };
    const { take, skip } = offsetOf(page);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.workflowSecret.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: REDACTED_SELECT,
      }),
      this.prisma.workflowSecret.count({ where }),
    ]);
    return pageOf(rows.map(toDescriptor), total, page);
  }

  /** A single REDACTED descriptor. 404 if missing. */
  async findOne(id: string): Promise<WorkflowSecretDescriptor> {
    const row = await this.prisma.workflowSecret.findFirst({
      where: { id, deletedAt: null },
      select: REDACTED_SELECT,
    });
    if (!row) {
      throw new NotFoundException(`WorkflowSecret ${id} not found`);
    }
    return toDescriptor(row);
  }

  // ── internals ───────────────────────────────────────────────────────────────

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

  private async assertConnectionUsable(
    connectionId: string,
    applicationId: string,
  ): Promise<void> {
    const connection = await this.prisma.workflowConnection.findFirst({
      where: { id: connectionId, deletedAt: null },
      select: { applicationId: true },
    });
    if (!connection) {
      throw new BadRequestException(
        `connectionId ${connectionId} does not reference a live connection`,
      );
    }
    if (connection.applicationId !== applicationId) {
      throw new BadRequestException(
        'The connection belongs to a different application',
      );
    }
  }
}

/** The non-secret columns a redacted read may project — NEVER ciphertext / iv / authTag. */
const REDACTED_SELECT = {
  id: true,
  applicationId: true,
  connectionId: true,
  label: true,
  keyVersion: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

function toDescriptor(row: {
  id: string;
  applicationId: string;
  connectionId: string | null;
  label: string;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): WorkflowSecretDescriptor {
  return {
    id: row.id,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    label: row.label,
    keyVersion: row.keyVersion,
    configured: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}
