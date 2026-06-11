import {
  BadRequestException,
  ForbiddenException,
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
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { type Principal, isServicePrincipal } from '../../auth/principal';
import { ConnectorRegistry } from '../connectors.registry';
import { SecretService } from '../secrets/secret.service';
import type {
  RevealSecret,
  TestConnectionResult,
} from '../handlers/step-handler';

/** The api-internal connection patch (name / config / credential reference). Kind is immutable. */
export interface UpdateWorkflowConnectionInput {
  name?: string;
  config?: WorkflowConnectionConfig;
  secretId?: string | null;
}

/**
 * Bounded timeout for the C3 connectivity probe — snappier than the 30s run-time outbound default, so
 * an interactive "Test connection" click fails fast rather than hanging the builder.
 */
const TEST_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * The C3 test-connection outcome (frontend §4c). Redacted by construction — `message` is a short,
 * non-secret diagnostic and `requestId` is surfaced for client-side correlation (ADR-0031). The
 * credential is NEVER echoed (INV-6).
 */
export interface TestConnectionOutcome {
  ok: boolean;
  /** HTTP status of the probe, when an HTTP call was actually made. */
  status?: number;
  /**
   * The non-secret PATH the probe targeted (the connection's configured health path, or `/`), surfaced
   * for an HTTP probe so the operator sees WHICH path was hit (#344). Absent for a "nothing to test" kind.
   */
  probedPath?: string;
  /** A short, non-secret message (success / failure reason / "nothing to test"). */
  message: string;
  /** The originating request id, surfaced for client-side correlation (ADR-0031). */
  requestId: string;
}

/**
 * The connector host a revealed credential is sent to (the BEARER target at run time) — `baseUrl` for
 * REST, `url` for WEBHOOK_OUT, none for MANUAL. Used to detect a host RE-POINT of a secret-bearing
 * connection (CSEC-1), the move that would exfiltrate a same-app secret to an attacker endpoint.
 */
function hostOf(config: WorkflowConnectionConfig): string | null {
  if (config.kind === 'REST') return config.baseUrl;
  if (config.kind === 'WEBHOOK_OUT') return config.url;
  return null;
}

/**
 * WorkflowConnection CRUD (contract C1, ADR-0054 §4) — the per-app connector INSTANCE. `config` is the
 * zod-validated-per-kind non-secret settings (base URL, auth scheme, header names) — NEVER a credential
 * (that is a `secretId` reference into the encrypted store, INV-6). Mutable + soft-delete.
 */
@Injectable()
export class WorkflowConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
    private readonly registry: ConnectorRegistry,
    private readonly secrets: SecretService,
  ) {}

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

  /**
   * Patch name / config / credential reference. A `config` change may not change the connection kind.
   *
   * SoD (CSEC-1): `workflow:manage` configures the engine, but ATTACHING/CHANGING a connection's
   * `secretId` — or RE-POINTING the host of a connection that bears a secret — would let a manage-only
   * principal exfiltrate a same-app secret (the engine attaches the revealed credential as BEARER to
   * whatever host the config names). Those two moves additionally require `workflow:secrets`, so the
   * manage/secrets separation holds. Both permissions are ADMIN-by-default, so the default admin path
   * is unchanged. Name-only / non-host config edits / clearing the credential stay manage-only.
   */
  async update(
    id: string,
    dto: UpdateWorkflowConnectionInput,
    principal?: Principal,
  ) {
    const connection = await this.findOne(id);
    if (dto.config && dto.config.kind !== connection.kind) {
      throw new BadRequestException(
        `config.kind (${dto.config.kind}) must match the connection kind (${connection.kind})`,
      );
    }
    await this.assertMaySetCredentialBinding(dto, connection, principal);
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

  /**
   * C3 — TEST A CONNECTION (ADR-0054 §11 / frontend §4c). A SINGLE bounded, READ-ONLY probe of the
   * connection's connectivity + credential, delegated to the connector handler's side-effect-free
   * {@link import('../handlers/step-handler').StepHandler.testConnection} capability — for REST, an
   * authenticated GET to the base URL routed THROUGH the egress guard (`guardedFetch`: https-only,
   * private/loopback/metadata denied, DNS-rebinding pinned, bounded deadline). It NEVER provisions /
   * POSTs a mutation and NEVER echoes the secret: the credential is revealed in memory ONLY for the
   * probe and the result carries redacted diagnostics + the request id (ADR-0031).
   *
   * A kind with NO read-only probe returns a clear "nothing to test" result rather than guessing:
   * MANUAL performs no external call, and WEBHOOK_OUT is write-only (a signed POST) — a read-only
   * probe would either send a real event or cannot validate the signing secret. Gated `workflow:manage`
   * at the controller. 404 if the connection is missing/deleted.
   */
  async test(id: string, requestId: string): Promise<TestConnectionOutcome> {
    const connection = await this.findOne(id);
    const handler = this.registry.get(connection.kind);
    if (!handler?.testConnection) {
      return {
        ok: true,
        message: nothingToTestMessage(connection.kind),
        requestId,
      };
    }

    const parsed = WorkflowConnectionConfigSchema.safeParse(connection.config);
    if (!parsed.success) {
      return {
        ok: false,
        message:
          'The connection configuration is invalid — fix it before testing.',
        requestId,
      };
    }

    // Reveal the stored credential in memory ONLY (INV-6) — the handler attaches it for the probe and
    // it never leaves through the redacted result. No secret configured ⇒ an unauthenticated probe.
    const secretId = connection.secretId;
    const revealSecret: RevealSecret = secretId
      ? () => this.secrets.revealById(secretId)
      : () => Promise.resolve(null);

    const result = await handler.testConnection({
      connection: parsed.data,
      revealSecret,
      meta: { requestId, timeoutMs: TEST_CONNECTION_TIMEOUT_MS },
    });
    return {
      ok: result.ok,
      ...(result.statusCode !== undefined ? { status: result.statusCode } : {}),
      ...(result.probedPath !== undefined
        ? { probedPath: result.probedPath }
        : {}),
      message: testOutcomeMessage(result),
      requestId,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Enforce the manage/secrets SoD (CSEC-1). Requires `workflow:secrets` when the patch would either
   * (a) attach/change the credential reference to a real secret (`secretId` set to non-null), or
   * (b) RE-POINT the host of a connection that bears (or will bear) a secret — the exact move that
   * sends the revealed BEARER credential to a new endpoint. Clearing the credential (`secretId: null`),
   * renaming, and non-host config edits stay manage-only. 403 when the gate is not met.
   */
  private async assertMaySetCredentialBinding(
    dto: UpdateWorkflowConnectionInput,
    connection: {
      config: Prisma.JsonValue;
      kind: string;
      secretId: string | null;
    },
    principal?: Principal,
  ): Promise<void> {
    const attachingSecret = dto.secretId !== undefined && dto.secretId !== null;
    // Whether the connection carries a credential AFTER this patch (an in-patch attach, else the
    // current binding — a `null` in this patch clears it, so it then bears none).
    const willBearSecret =
      dto.secretId !== undefined
        ? dto.secretId !== null
        : connection.secretId !== null;
    const changingHost =
      dto.config !== undefined &&
      hostOf(dto.config) !==
        hostOf(connection.config as unknown as WorkflowConnectionConfig);
    const needsSecretsPermission =
      attachingSecret || (willBearSecret && changingHost);
    if (!needsSecretsPermission) {
      return;
    }
    if (!(await this.principalHoldsSecretsPermission(principal))) {
      throw new ForbiddenException(
        'Attaching a credential to a connection, or re-pointing the host of a secret-bearing connection, requires the workflow:secrets permission',
      );
    }
  }

  /**
   * Whether the caller holds `workflow:secrets`, for BOTH principal kinds (ADR-0048): a human resolves
   * via the RolePermission matrix (ADMIN is full), a service account via its direct grants. A missing
   * principal (anonymous shim) holds nothing → false (fail-closed).
   */
  private async principalHoldsSecretsPermission(
    principal?: Principal,
  ): Promise<boolean> {
    if (!principal) {
      return false;
    }
    if (isServicePrincipal(principal)) {
      return principal.permissions.has('workflow:secrets');
    }
    return this.permissions.hasAll(principal.user.role, ['workflow:secrets']);
  }

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

/** The "nothing to probe" message for a connection kind that has no read-only test (non-secret). */
function nothingToTestMessage(kind: string): string {
  if (kind === 'WEBHOOK_OUT') {
    return (
      'Webhook connections are write-only (a signed POST), so there is nothing to probe read-only — ' +
      'run a dry-run to preview the payload, or send a real test event to verify delivery.'
    );
  }
  // MANUAL (and any other kind that exposes no testConnection capability).
  return 'Manual connections perform no external call — there is nothing to test.';
}

/** Render a redacted handler probe result into a short, non-secret user message. */
function testOutcomeMessage(result: TestConnectionResult): string {
  const status =
    result.statusCode !== undefined ? ` (HTTP ${result.statusCode})` : '';
  // The non-secret path the probe targeted (#344), so the message says WHICH path was hit.
  const at = result.probedPath ? ` at ${result.probedPath}` : '';
  if (result.ok) {
    return `Connection succeeded${status}${at}.`;
  }
  const reason = result.reason ? `: ${result.reason}` : '.';
  return `Connection failed${status}${at}${reason}`;
}
