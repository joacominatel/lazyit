import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  AI_SETTINGS_DEFAULTS,
  AiActionPreviewSchema,
  type AiActionLogEvent,
  type AiActionPreview,
  type AiChannel,
  type AiToolClass,
  type AiToolErrorCode,
  type AiToolInvocationStatus,
  type AiToolResult,
  type Permission,
} from '@lazyit/shared';
import type {
  AiToolInvocation,
  Prisma,
} from '../../../generated/prisma/client';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import type { Principal } from '../../auth/principal';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  actorOf,
  AiActionLogService,
  type AiActionLogEntry,
} from './action-log.service';
import { mapToolError } from './error-mapper';
import {
  inputHashOf,
  mergeRefs,
  requiresStepUp,
  toPendingAction,
  type AiApproveOptions,
  type AiPendingAction,
  type AiProposal,
} from './pending-action';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
} from './ports/ai-settings.port';
import { callKindOf, errorResult } from './result-shaper';
import { AiToolExecutor } from './tool-executor';
import { AiToolRegistry } from './tool-registry';
import type {
  AiExecutionContext,
  AiToolListing,
  RegisteredAiTool,
} from './tool-descriptor';

/** The permission that opens each channel (synthesis §1): `ai:use` for chat and headless, `ai:connect` for MCP. */
function channelPermission(channel: AiChannel): Permission {
  return channel === 'MCP' ? 'ai:connect' : 'ai:use';
}

type ToolError = {
  code: AiToolErrorCode;
  status?: number;
  message: string;
  hint?: string;
};

/**
 * The class ceiling that applies to a call. MCP ALWAYS has one — the token's scopes (R7) — so a missing
 * ceiling on the MCP channel fails closed to `read` instead of meaning "no ceiling".
 */
function effectiveCeiling(
  ctx: AiExecutionContext,
): readonly AiToolClass[] | undefined {
  return ctx.ceiling ?? (ctx.channel === 'MCP' ? ['read'] : undefined);
}

/** Who approved a chat write and how, recorded on its APPROVED / EXECUTED / FAILED ledger events. */
interface ApprovalProvenance {
  approverUserId: string;
  stepUp: boolean;
  approvalMode: 'USER' | 'AUTO';
  autoApproveEnabledAt: Date | null;
}

/**
 * Whether a chat write may be approved automatically (#1376): an ordinary `write` whose preview was not
 * escalated to elevated, needs no step-up and names no untrusted source. Elevated actions — privilege,
 * identity, credentials, configuration and outbound integrations (security.md §6.2 T3/T4, INV-AI-15) —
 * always wait for the user, and so does any write in a turn that read other-authored content: injected
 * text never chains an unattended write (security.md §6.1, §6.2).
 */
function autoEligible(
  toolClass: string,
  preview: Pick<
    AiActionPreview,
    'elevated' | 'stepUpRequired' | 'warnings' | 'untrustedSources'
  >,
): boolean {
  return (
    toolClass === 'write' &&
    !preview.elevated &&
    !requiresStepUp(preview) &&
    preview.untrustedSources.length === 0
  );
}

/** 409 `AUTO_APPROVE_OFF`: the conversation's auto-approve is not on (now). The action stays pending. */
function autoApproveOff(): ConflictException {
  return new ConflictException(
    decisionError(
      'AUTO_APPROVE_OFF',
      'Auto-approve is not on for this conversation',
    ),
  );
}

/** The error a refused decision carries, for the decision endpoint to answer as is. */
function decisionError(code: string, message: string) {
  return { code, message };
}

/**
 * The ONLY façade channels use to reach tools (synthesis §4.2; tools-and-execution.md §8.4, §9). On top
 * of the Nest pipeline every tool call already runs through, it re-checks per call:
 *   - the principal, re-loaded from the database (a stale or revoked identity is refused);
 *   - `ai:use` (chat, headless) or `ai:connect` (MCP), held NOW;
 *   - the channel the tool allows;
 *   - the class ceiling (the MCP scope or the Service Account's AI access setting).
 *
 * Writes (`write`, `elevated`):
 *   - over MCP and headless, `invoke` runs them, recorded in the permanent `AiActionLog` ledger
 *     (`ATTEMPTED` write-ahead, then `EXECUTED` | `FAILED` | `DENIED`) and in `ai_tool_invocations`;
 *   - in the chat, `invoke` REFUSES them. A chat write is `propose`d — stored with its server-built
 *     preview — and runs only through `approve`, by its owner, from a human session, exactly once,
 *     before expiry, re-authorized and version-checked at execute (INV-AI-3). A loop bug cannot skip it.
 *
 * Boundary with the runtime (W2-3): core owns the invocation lifecycle primitives (`propose`, `approve`,
 * `reject`, `expire`, `expireDue`, `cancel`, `markOutcomeUnknown`) and the ledger. The runtime's
 * approval service owns pausing and resuming the run, the SSE events, the password step-up check and
 * the expiry sweeper that calls these primitives.
 */
@Injectable()
export class AiToolService {
  private readonly logger = new Logger(AiToolService.name);
  private readonly actionLog: AiActionLogService;

  constructor(
    private readonly registry: AiToolRegistry,
    private readonly executor: AiToolExecutor,
    private readonly principals: PrincipalLoaderService,
    private readonly permissions: PermissionResolverService,
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    // Optional so a spec that assembles the core by hand (the tool units' parity specs) keeps working;
    // the ledger writer is then built over the same PrismaService.
    @Optional() actionLog?: AiActionLogService,
  ) {
    this.actionLog = actionLog ?? new AiActionLogService(prisma);
  }

  /**
   * The tools this principal may call through this channel, in a deterministic order. Filtered by the
   * channel, the class ceiling, the principal kind the route's guards admit, and a static check of the
   * route's `@RequirePermission` — the same decision `RolesGuard` makes at call time.
   */
  async list(ctx: AiExecutionContext): Promise<AiToolListing[]> {
    const principal = await this.loadPrincipal(ctx);
    if (!principal) return [];
    if (!(await this.holds(principal, [channelPermission(ctx.channel)]))) {
      return [];
    }
    const listing: AiToolListing[] = [];
    for (const tool of this.registry.all()) {
      if (!this.reachable(tool, ctx)) continue;
      if (!this.admitsKind(tool, principal)) continue;
      if (!(await this.holds(principal, tool.permissions))) continue;
      listing.push({
        name: tool.descriptor.name,
        title: tool.descriptor.title,
        description: tool.descriptor.description,
        class: tool.descriptor.class,
        inputSchema: tool.inputSchema,
        permissions: tool.permissions,
        annotations: tool.annotations,
      });
    }
    return listing;
  }

  /**
   * Run a tool now. Reads on every channel the tool allows; writes only over MCP and headless, through
   * the ledger (see the class comment). The route's own authorization runs inside the dispatch — this
   * method never decides a route permission.
   */
  async invoke(
    name: string,
    input: unknown,
    ctx: AiExecutionContext,
  ): Promise<AiToolResult> {
    const tool = this.registry.get(name);
    if (!tool) {
      return errorResult('read', {
        code: 'NOT_AVAILABLE',
        message: `Unknown tool: ${name}`,
      });
    }
    const kind = callKindOf(tool.descriptor.class);
    if (!tool.channels.includes(ctx.channel)) {
      return errorResult(kind, {
        code: 'NOT_AVAILABLE',
        message: `${name} is not available on this channel`,
      });
    }
    if (kind === 'mutation') {
      if (ctx.channel === 'CHAT') {
        return errorResult(kind, {
          code: 'NOT_AVAILABLE',
          message: `${name} changes data: it must be proposed and approved, not invoked`,
        });
      }
      return this.invokeWrite(tool, input, ctx);
    }
    const ceiling = effectiveCeiling(ctx);
    if (ceiling && !ceiling.includes(tool.descriptor.class)) {
      return errorResult(kind, this.ceilingError(name));
    }
    const principal = await this.loadPrincipal(ctx);
    if (!principal) {
      return errorResult(kind, PRINCIPAL_INVALID);
    }
    const gate = channelPermission(ctx.channel);
    if (!(await this.holds(principal, [gate]))) {
      return errorResult(kind, gateError(gate));
    }
    return this.executor.execute(tool, input, ctx);
  }

  /**
   * Propose a chat write (tools-and-execution.md §9 "Propose"): validate, authorize (a card is never
   * shown for an action the route would refuse), build the server-side preview, store the pending
   * action with its expiry and write `PROPOSED`. Nothing is executed. A refusal answers the tool result
   * the model receives instead.
   */
  async propose(
    name: string,
    input: unknown,
    ctx: AiExecutionContext,
    options: { toolUseId?: string } = {},
  ): Promise<AiProposal> {
    const tool = this.registry.get(name);
    if (!tool) {
      return refuse('mutation', {
        code: 'NOT_AVAILABLE',
        message: `Unknown tool: ${name}`,
      });
    }
    const kind = callKindOf(tool.descriptor.class);
    if (kind !== 'mutation') {
      return refuse(kind, {
        code: 'NOT_AVAILABLE',
        message: `${name} does not change data: invoke it`,
      });
    }
    if (
      ctx.channel !== 'CHAT' ||
      ctx.identity.kind !== 'human' ||
      !tool.channels.includes('CHAT')
    ) {
      return refuse(kind, {
        code: 'NOT_AVAILABLE',
        message: `${name} cannot be proposed on this channel`,
      });
    }
    const principal = await this.loadPrincipal(ctx);
    if (!principal) {
      return refuse(kind, PRINCIPAL_INVALID);
    }
    const checked = this.executor.validate(tool, input);
    if (!checked.ok) {
      return { ok: false, result: checked.result };
    }
    const denial = await this.writeDenial(tool, principal, ctx, {
      routeStatic: true,
    });
    if (denial) {
      await this.recordDenied(tool, checked.input, ctx, denial);
      return refuse(kind, denial);
    }

    let built: AiActionPreview;
    try {
      // The preview only reads; its dispatches run under a throwaway invocation id (no row exists yet).
      built = await this.executor.preview(
        tool,
        checked.input,
        ctx,
        randomUUID(),
      );
    } catch (err) {
      return refuse(kind, mapToolError(err));
    }
    const shaped = this.shapePreview(tool, built, ctx);
    if (!shaped.ok) {
      this.logger.error(
        `AI tool ${tool.descriptor.name} built an unusable preview: ${shaped.reason}`,
      );
      return refuse(kind, {
        code: 'INTERNAL',
        status: 500,
        message: 'This action cannot be proposed: its preview is invalid.',
      });
    }
    const preview = shaped.preview;

    const expiresAt = new Date(
      Date.now() + (await this.approvalTtlMinutes()) * 60_000,
    );
    // The pending action and its PROPOSED event commit together: no approvable row without its record.
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.aiToolInvocation.create({
        data: {
          ...this.invocationBase(tool, checked.input, ctx),
          toolUseId: options.toolUseId ?? null,
          status: 'AWAITING_APPROVAL',
          preview: json(preview),
          ...(preview.precondition
            ? { precondition: json(preview.precondition) }
            : {}),
          expiresAt,
        },
      });
      await this.actionLog.append(
        {
          ...this.ledgerBase(created, ctx),
          event: 'PROPOSED',
          input: checked.input,
          entityRefs: preview.target ? [preview.target] : [],
          untrustedSources: preview.untrustedSources,
        },
        tx,
      );
      return created;
    });
    return { ok: true, action: toPendingAction(row) };
  }

  /**
   * Approve a pending chat write and execute it (tools-and-execution.md §9 "Approve"). Only its owner,
   * from a human session, exactly once (an atomic conditional claim), before expiry. A step-up the
   * preview requires must have been verified by the caller. Then: `APPROVED` (write-ahead), re-check the
   * principal, `ai:use` and the route permission, the tool's schema hash, the stored input and the
   * target's version (`STALE`), execute through the same dispatcher and record the outcome.
   *
   * Before the claim the tool's preview runs again: a warning that appeared since propose is added to the
   * stored preview and the action stays pending (`STEP_UP_REQUIRED` or `PREVIEW_CHANGED`, with
   * `addedWarnings`), and step-up is derived over the stored and fresh warnings together.
   *
   * A second approve of a finished action returns the stored outcome (`replayed`) and executes nothing.
   * Refusals throw Nest HTTP exceptions (`{ code, message }` bodies) for the decision endpoint.
   */
  async approve(
    invocationId: string,
    ctx: AiExecutionContext,
    options: AiApproveOptions = {},
  ): Promise<AiPendingAction> {
    const userId = this.requireHumanSession(ctx);
    const row = await this.findOwned(invocationId, userId, ctx);
    // Auto-approve (#1376): the conversation's mode must be on NOW; its enable time goes to the ledger.
    const auto =
      options.auto === true
        ? await this.autoApproval(row, userId, options)
        : null;

    const storedPreview = toPendingAction(row).preview;
    // The FRESH preview, built before the claim (tools-and-execution.md §9, step 0): step-up and "the card
    // changed" are decided on what is true NOW, not only on what was true at propose. A missing or
    // unreadable stored preview is not stopped here: the claim below fails it closed (FAILED).
    let fresh: FreshPreview | null = null;
    if (row.status === 'AWAITING_APPROVAL' && storedPreview) {
      fresh = await this.freshPreview(row, ctx);
      // A target that changed version is STALE (decided after the claim, terminal): that outcome wins
      // over "the card changed", which would only defer the same refusal.
      const added =
        fresh?.ok === true && !isStale(storedPreview, fresh.preview)
          ? fresh.preview.warnings.filter(
              (w) => !storedPreview.warnings.includes(w),
            )
          : [];
      if (added.length > 0) {
        // The situation changed since the user saw the card (e.g. the application became critical):
        // the stored preview gains the new warnings and the action stays pending, so the card
        // re-renders and the user decides again — with the password if a step-up warning appeared.
        const updated = await this.addPreviewWarnings(
          row,
          storedPreview,
          added,
        );
        const stepUpAdded = !options.stepUpVerified && requiresStepUp(updated);
        if (stepUpAdded) {
          throw new ForbiddenException({
            ...decisionError(
              'STEP_UP_REQUIRED',
              'This action now requires your password to be confirmed',
            ),
            addedWarnings: added,
          });
        }
        throw new ConflictException({
          ...decisionError(
            'PREVIEW_CHANGED',
            'This action changed since it was proposed; review it again',
          ),
          addedWarnings: added,
        });
      }
      if (
        auto &&
        (fresh?.ok !== true ||
          !autoEligible(row.toolClass, storedPreview) ||
          !autoEligible(row.toolClass, fresh.preview))
      ) {
        // Never automatic: an elevated action, or a write whose stored or fresh preview needs a step-up
        // (or whose fresh preview cannot be built), stays pending and the runtime shows the user its card.
        throw new ConflictException(
          decisionError(
            'AUTO_APPROVE_NOT_ELIGIBLE',
            'This action needs the user’s approval',
          ),
        );
      }
      if (!options.stepUpVerified && requiresStepUp(storedPreview)) {
        // Refused BEFORE the claim: the action stays pending so the user can retry with the step-up.
        throw new ForbiddenException(
          decisionError(
            'STEP_UP_REQUIRED',
            'This action requires your password to be confirmed',
          ),
        );
      }
    }

    if (auto && row.status === 'AWAITING_APPROVAL' && !storedPreview) {
      // An unreadable stored preview is failed closed by a USER approval; automatically, it is not taken.
      throw new ConflictException(
        decisionError(
          'AUTO_APPROVE_NOT_ELIGIBLE',
          'This action needs the user’s approval',
        ),
      );
    }

    const now = new Date();
    const approvalMode = auto ? 'AUTO' : 'USER';
    const claimArgs = {
      where: {
        id: row.id,
        status: 'AWAITING_APPROVAL',
        userId,
        expiresAt: { gt: now },
      },
      data: { status: 'EXECUTING', decidedAt: now, approvalMode },
    };
    const claim = auto
      ? await this.prisma.$transaction(async (tx) => {
          // Auto-approve is re-checked IN the claim's transaction, holding the conversation row's lock
          // (the lock a toggle takes): a switch-off that committed first refuses, one that commits later
          // is ordered after this approval.
          const on = await tx.aiConversation.updateMany({
            where: {
              id: row.conversationId ?? '',
              userId,
              channel: 'CHAT',
              autoApprove: true,
            },
            data: { autoApprove: true },
          });
          if (on.count === 0) throw autoApproveOff();
          return tx.aiToolInvocation.updateMany(claimArgs);
        })
      : await this.prisma.aiToolInvocation.updateMany(claimArgs);
    if (claim.count === 0) {
      return this.unclaimable(row.id, 'approve');
    }

    const stepUp = options.stepUpVerified === true;
    const approval: ApprovalProvenance = {
      approverUserId: userId,
      stepUp,
      approvalMode,
      autoApproveEnabledAt: auto?.enabledAt ?? null,
    };
    const claimed = {
      ...row,
      status: 'EXECUTING',
      decidedAt: now,
      approvalMode,
    };
    try {
      await this.actionLog.append({
        ...this.ledgerBase(claimed, ctx),
        event: 'APPROVED',
        ...approval,
        untrustedSources: toPendingAction(claimed).preview?.untrustedSources,
      });
    } catch (err) {
      // Write-ahead: an approval that cannot be recorded is not executed. Close the claim as FAILED so
      // the sweeper never mistakes it for an interrupted execution.
      this.logger.error(
        `AI invocation ${row.id} approved but not executed: the ledger could not be written (${err instanceof Error ? err.message : String(err)})`,
      );
      await this.prisma.aiToolInvocation
        .updateMany({
          where: { id: row.id, status: 'EXECUTING' },
          data: {
            status: 'FAILED',
            errorCode: 'INTERNAL',
            result: json(
              errorResult('mutation', {
                code: 'INTERNAL',
                status: 500,
                message:
                  'The approval could not be recorded, so the action was not executed.',
              }),
            ),
          },
        })
        .catch(() => undefined);
      throw err;
    }
    return this.executeApproved(claimed, ctx, approval, fresh);
  }

  /**
   * Reject a pending chat write: its owner, from a human session. Writes `REJECTED`; the stored result
   * tells the model the user declined. Rejecting an already-rejected action answers it again.
   */
  async reject(
    invocationId: string,
    ctx: AiExecutionContext,
    reason?: string,
  ): Promise<AiPendingAction> {
    const userId = this.requireHumanSession(ctx);
    const row = await this.findOwned(invocationId, userId, ctx);
    const result = errorResult('mutation', {
      code: 'FORBIDDEN',
      status: 403,
      message: reason
        ? `The user declined this action: ${reason.slice(0, 500)}`
        : 'The user declined this action',
    });
    const now = new Date();
    const claim = await this.prisma.aiToolInvocation.updateMany({
      where: {
        id: row.id,
        status: 'AWAITING_APPROVAL',
        userId,
        expiresAt: { gt: now },
      },
      data: {
        status: 'REJECTED',
        decidedAt: now,
        result: json(result),
        errorCode: 'REJECTED',
      },
    });
    if (claim.count === 0) {
      return this.unclaimable(row.id, 'reject');
    }
    await this.actionLog.append({
      ...this.ledgerBase(row, ctx),
      event: 'REJECTED',
      approverUserId: userId,
    });
    return toPendingAction(await this.reload(row.id));
  }

  /**
   * Mark one pending action `EXPIRED` (the runtime's sweeper, and the lazy check inside `approve`).
   * Returns the action when this call expired it, `null` when it was no longer pending. System
   * primitive: no ownership check — never expose it to a client or a tool.
   */
  async expire(invocationId: string): Promise<AiPendingAction | null> {
    return this.closePending(invocationId, 'EXPIRED', {
      code: 'EXPIRED',
      message: 'The approval window for this action has passed',
    });
  }

  /** Expire every pending action whose `expiresAt` has passed (at most `limit`); returns them. */
  async expireDue(limit = 100, now = new Date()): Promise<AiPendingAction[]> {
    const due = await this.prisma.aiToolInvocation.findMany({
      where: { status: 'AWAITING_APPROVAL', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const expired: AiPendingAction[] = [];
    for (const { id } of due) {
      const action = await this.expire(id);
      if (action) expired.push(action);
    }
    return expired;
  }

  /**
   * Mark one pending action `CANCELLED` (the run was cancelled or finalized). System primitive: the
   * runtime checks the run's ownership before calling it.
   */
  async cancel(
    invocationId: string,
    reason = 'The run was cancelled',
  ): Promise<AiPendingAction | null> {
    return this.closePending(invocationId, 'CANCELLED', {
      code: 'NOT_AVAILABLE',
      message: reason.slice(0, 500),
    });
  }

  /**
   * Crash recovery (tools-and-execution.md §9): an invocation stuck in `EXECUTING` when the runtime's
   * sweeper finalizes its run becomes `OUTCOME_UNKNOWN` and is NEVER retried. The ledger records
   * `FAILED` with `UNKNOWN_OUTCOME`; the `aiInvocationId` stamp on the history rows lets an operator
   * check whether the change committed.
   */
  async markOutcomeUnknown(
    invocationId: string,
  ): Promise<AiPendingAction | null> {
    const error = {
      code: 'UNKNOWN_OUTCOME' as const,
      message:
        'The action was interrupted; whether it took effect is unknown. It will not be retried.',
    };
    const updated = await this.prisma.aiToolInvocation.updateMany({
      where: { id: invocationId, status: 'EXECUTING' },
      data: {
        status: 'OUTCOME_UNKNOWN',
        result: json(errorResult('mutation', error)),
        errorCode: error.code,
      },
    });
    if (updated.count === 0) return null;
    const row = await this.reload(invocationId);
    await this.actionLog.append({
      ...this.ledgerBase(row),
      event: 'FAILED',
      error,
    });
    return toPendingAction(row);
  }

  // ─── Write execution ───────────────────────────────────────────────────────────────────────────────

  /** MCP and headless writes: `ATTEMPTED` (write-ahead), then exactly one of DENIED / EXECUTED / FAILED. */
  private async invokeWrite(
    tool: RegisteredAiTool,
    input: unknown,
    ctx: AiExecutionContext,
  ): Promise<AiToolResult> {
    const kind = callKindOf(tool.descriptor.class);
    const principal = await this.loadPrincipal(ctx);
    if (!principal) {
      return errorResult(kind, PRINCIPAL_INVALID);
    }
    const checked = this.executor.validate(tool, input);
    if (!checked.ok) {
      // Nothing was attempted: the input never reached a handler.
      return checked.result;
    }
    const denial = await this.writeDenial(tool, principal, ctx, {
      routeStatic: false,
    });

    let row: AiToolInvocation;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.aiToolInvocation.create({
          data: {
            ...this.invocationBase(tool, checked.input, ctx),
            status: 'EXECUTING',
          },
        });
        await this.actionLog.append(
          {
            ...this.ledgerBase(created, ctx),
            event: 'ATTEMPTED',
            input: checked.input,
          },
          tx,
        );
        return created;
      });
    } catch (err) {
      // Write-ahead: a write that cannot be recorded is not executed.
      this.logger.error(
        `AI write ${tool.descriptor.name} not executed: the ledger could not be written (${err instanceof Error ? err.message : String(err)})`,
      );
      return errorResult(kind, {
        code: 'INTERNAL',
        status: 500,
        message: 'The action could not be recorded, so it was not executed.',
      });
    }

    if (denial) {
      const result = errorResult(kind, denial);
      await this.finalize(row, 'DENIED', result, ctx, { event: 'DENIED' });
      return result;
    }
    const started = Date.now();
    const result = await this.executor.execute(tool, checked.input, ctx, {
      invocationId: row.id,
    });
    await this.finalize(row, result.ok ? 'SUCCEEDED' : 'FAILED', result, ctx, {
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** Steps 3–5 of §9 "Approve", on a row this call has claimed (`EXECUTING`). */
  private async executeApproved(
    row: AiToolInvocation,
    ctx: AiExecutionContext,
    provenance: ApprovalProvenance,
    precomputed: FreshPreview | null = null,
  ): Promise<AiPendingAction> {
    const execCtx: AiExecutionContext = {
      ...ctx,
      channel: 'CHAT',
      conversationId: row.conversationId ?? undefined,
      runId: row.runId ?? undefined,
    };
    const fail = async (
      status: AiToolInvocationStatus,
      error: ToolError,
      event?: AiActionLogEvent,
    ) => {
      const result = errorResult('mutation', error);
      await this.finalize(row, status, result, execCtx, {
        ...provenance,
        ...(event ? { event } : {}),
      });
      return toPendingAction(await this.reload(row.id));
    };

    // Integrity of the stored action, fail-closed: what runs is exactly what was shown and approved.
    const stored = toPendingAction(row).preview;
    if (!stored) {
      return fail('FAILED', {
        code: 'INTERNAL',
        status: 500,
        message:
          'The stored preview of this action is unreadable; it was not executed',
      });
    }
    if (inputHashOf(row.input) !== row.inputHash) {
      return fail('FAILED', {
        code: 'INTERNAL',
        status: 500,
        message:
          'The stored input of this action does not match what was approved; it was not executed',
      });
    }
    const tool = this.registry.get(row.toolName);
    if (!tool || tool.schemaHash !== row.schemaHash) {
      return fail(
        'EXPIRED',
        {
          code: 'EXPIRED',
          message: tool
            ? 'The tool changed since this action was proposed; propose it again'
            : 'The tool is no longer available',
        },
        'EXPIRED',
      );
    }
    const principal = await this.loadPrincipal(execCtx);
    if (!principal) {
      return fail('FAILED', PRINCIPAL_INVALID);
    }
    const denial = await this.writeDenial(tool, principal, execCtx, {
      routeStatic: true,
    });
    if (denial) {
      return fail('FAILED', denial);
    }
    const checked = this.executor.validate(tool, row.input);
    if (!checked.ok) {
      return fail(
        'FAILED',
        checked.result.ok
          ? { code: 'INVALID_INPUT', message: 'Invalid stored input' }
          : checked.result.error,
      );
    }
    // The fresh preview built before the claim (or now, when it could not be built then).
    const freshOutcome =
      precomputed ??
      (await this.buildFreshPreview(tool, checked.input, execCtx, row.id));
    if (!freshOutcome.ok) {
      return fail('FAILED', freshOutcome.error);
    }
    const fresh = freshOutcome.preview;
    if (isStale(stored, fresh)) {
      return fail('FAILED', {
        code: 'STALE',
        status: 409,
        message:
          'The target changed after this action was proposed; read it again and propose a new action',
      });
    }

    const started = Date.now();
    const result = await this.executor.execute(tool, row.input, execCtx, {
      invocationId: row.id,
    });
    await this.finalize(
      row,
      result.ok ? 'SUCCEEDED' : 'FAILED',
      result,
      execCtx,
      { ...provenance, durationMs: Date.now() - started },
    );
    return toPendingAction(await this.reload(row.id));
  }

  /**
   * Persist an outcome on the invocation row (only while it is `EXECUTING` — never overwrite a decided
   * row) and append the matching ledger event. The side effect already happened (or was refused), so a
   * failure here is logged, never retried and never turned into a second execution.
   */
  private async finalize(
    row: AiToolInvocation,
    status: AiToolInvocationStatus,
    result: AiToolResult,
    ctx: AiExecutionContext,
    extra: Partial<ApprovalProvenance> & {
      event?: AiActionLogEvent;
      durationMs?: number;
    } = {},
  ): Promise<void> {
    const event: AiActionLogEvent =
      extra.event ?? (result.ok ? 'EXECUTED' : 'FAILED');
    // The two writes are independent: a failed status update must not cost the permanent record.
    try {
      await this.prisma.aiToolInvocation.updateMany({
        where: { id: row.id, status: 'EXECUTING' },
        data: {
          status,
          result: json(result),
          entityRefs: json(result.entityRefs),
          errorCode: result.ok ? null : result.error.code,
          ...(extra.durationMs !== undefined
            ? { durationMs: Math.min(extra.durationMs, 2_147_483_647) }
            : {}),
        },
      });
    } catch (err) {
      this.logger.error(
        `AI invocation ${row.id} (${row.toolName}) finished ${status} but its row could not be updated: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await this.actionLog.append({
        ...this.ledgerBase(row, ctx),
        event,
        entityRefs: result.entityRefs,
        approverUserId: extra.approverUserId,
        stepUp: extra.stepUp,
        approvalMode: extra.approvalMode,
        autoApproveEnabledAt: extra.autoApproveEnabledAt,
        error: result.ok ? null : result.error,
      });
    } catch (err) {
      this.logger.error(
        `AI invocation ${row.id} (${row.toolName}) finished ${status} but its ledger event could not be written: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Decision helpers ──────────────────────────────────────────────────────────────────────────────

  /**
   * The auto-approve check of `approve(…, { auto: true })` (#1376): never together with a verified
   * step-up, and only on a chat invocation whose conversation belongs to the approver and has
   * auto-approve on NOW. Anything else is 409 `AUTO_APPROVE_OFF` and the action stays pending.
   */
  private async autoApproval(
    row: AiToolInvocation,
    userId: string,
    options: AiApproveOptions,
  ): Promise<{ enabledAt: Date | null }> {
    const off = autoApproveOff;
    if (options.stepUpVerified || !row.conversationId) throw off();
    const conversation = await this.prisma.aiConversation.findFirst({
      where: {
        id: row.conversationId,
        userId,
        channel: 'CHAT',
        autoApprove: true,
      },
      select: { autoApproveEnabledAt: true },
    });
    if (!conversation) throw off();
    return { enabledAt: conversation.autoApproveEnabledAt };
  }

  /** Only a human session in the chat decides: never an MCP grant, a Service Account or a tool. */
  private requireHumanSession(ctx: AiExecutionContext): string {
    if (
      ctx.identity.kind !== 'human' ||
      ctx.channel !== 'CHAT' ||
      ctx.mcp !== undefined
    ) {
      throw new ForbiddenException(
        decisionError(
          'FORBIDDEN',
          'Only the requesting user, from a signed-in session, can decide this action',
        ),
      );
    }
    return ctx.identity.userId;
  }

  /**
   * The chat invocation `id` owned by `userId` (and in `ctx.runId`'s run when given). Anything else is
   * 404 — never a hint that someone else's action exists.
   */
  private async findOwned(
    id: string,
    userId: string,
    ctx: AiExecutionContext,
  ): Promise<AiToolInvocation> {
    const row = await this.prisma.aiToolInvocation.findUnique({
      where: { id },
    });
    if (
      !row ||
      row.channel !== 'CHAT' ||
      row.userId !== userId ||
      (ctx.runId !== undefined && row.runId !== ctx.runId)
    ) {
      throw new NotFoundException(
        decisionError('NOT_FOUND', 'Pending action not found'),
      );
    }
    return row;
  }

  /**
   * The claim matched nothing: say why. A finished action replays its stored outcome (a double click is
   * safe); an expired-but-still-pending one is expired now; anything else is a 409 with its status.
   */
  private async unclaimable(
    id: string,
    decision: 'approve' | 'reject',
  ): Promise<AiPendingAction> {
    const row = await this.reload(id);
    const action = toPendingAction(row);
    const replayable =
      decision === 'approve'
        ? ['SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN']
        : ['REJECTED'];
    if (replayable.includes(action.status)) {
      return { ...action, replayed: true };
    }
    if (action.status === 'AWAITING_APPROVAL') {
      // A decision misses a still-pending row only because it expired: expire it now, refuse.
      await this.expire(id);
      throw new ConflictException(
        decisionError('EXPIRED', 'This action has expired'),
      );
    }
    if (action.status === 'EXECUTING') {
      throw new ConflictException(
        decisionError('IN_PROGRESS', 'This action is already running'),
      );
    }
    throw new ConflictException(
      decisionError(
        action.status,
        `This action is ${action.status.toLowerCase()}`,
      ),
    );
  }

  /** `AWAITING_APPROVAL` → `EXPIRED` | `CANCELLED`, atomically, with its ledger event. */
  private async closePending(
    id: string,
    status: 'EXPIRED' | 'CANCELLED',
    error: ToolError,
  ): Promise<AiPendingAction | null> {
    const updated = await this.prisma.aiToolInvocation.updateMany({
      where: { id, status: 'AWAITING_APPROVAL' },
      data: {
        status,
        decidedAt: new Date(),
        result: json(errorResult('mutation', error)),
        errorCode: status,
      },
    });
    if (updated.count === 0) return null;
    const row = await this.reload(id);
    await this.actionLog.append({ ...this.ledgerBase(row), event: status });
    return toPendingAction(row);
  }

  private async reload(id: string): Promise<AiToolInvocation> {
    return this.prisma.aiToolInvocation.findUniqueOrThrow({ where: { id } });
  }

  // ─── Authorization ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The AI-level refusal of a write, if any: the class ceiling, the channel gate held NOW, and — when
   * `routeStatic` (propose and approve, where no card may be shown or executed for an action the route
   * would refuse) — the principal kind and the route's `@RequirePermission`, the decision `RolesGuard`
   * makes. The route's guards run again at dispatch regardless.
   */
  private async writeDenial(
    tool: RegisteredAiTool,
    principal: Principal,
    ctx: AiExecutionContext,
    options: { routeStatic: boolean },
  ): Promise<ToolError | null> {
    const ceiling = effectiveCeiling(ctx);
    if (ceiling && !ceiling.includes(tool.descriptor.class)) {
      return this.ceilingError(tool.descriptor.name);
    }
    // Headless is the Service Account API (synthesis §1): a human never writes through it.
    if (ctx.channel === 'HEADLESS' && principal.kind !== 'service') {
      return {
        code: 'FORBIDDEN',
        status: 403,
        message: 'Headless writes run only as a Service Account',
      };
    }
    const gate = channelPermission(ctx.channel);
    if (!(await this.holds(principal, [gate]))) {
      return gateError(gate);
    }
    if (options.routeStatic) {
      if (
        !this.admitsKind(tool, principal) ||
        !(await this.holds(principal, tool.permissions))
      ) {
        return {
          code: 'FORBIDDEN',
          status: 403,
          message: `You do not have permission to use ${tool.descriptor.name}`,
        };
      }
    }
    return null;
  }

  /** A write refused before anything was stored: a `DENIED` invocation row and ledger event. */
  private async recordDenied(
    tool: RegisteredAiTool,
    input: unknown,
    ctx: AiExecutionContext,
    denial: ToolError,
  ): Promise<void> {
    try {
      const result = errorResult(callKindOf(tool.descriptor.class), denial);
      const row = await this.prisma.aiToolInvocation.create({
        data: {
          ...this.invocationBase(tool, input, ctx),
          status: 'DENIED',
          result: json(result),
          errorCode: denial.code,
        },
      });
      await this.actionLog.append({
        ...this.ledgerBase(row, ctx),
        event: 'DENIED',
        input,
        error: denial,
      });
    } catch (err) {
      this.logger.error(
        `AI write ${tool.descriptor.name} denied, but the denial could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The fresh preview of a pending action, for the pre-claim checks in `approve`. `null` when it cannot be
   * built yet because the tool changed or the stored input no longer parses — the post-claim checks
   * finalize those (`EXPIRED`, `FAILED`).
   */
  private async freshPreview(
    row: AiToolInvocation,
    ctx: AiExecutionContext,
  ): Promise<FreshPreview | null> {
    const tool = this.registry.get(row.toolName);
    if (!tool || tool.schemaHash !== row.schemaHash) return null;
    const checked = this.executor.validate(tool, row.input);
    if (!checked.ok) return null;
    return this.buildFreshPreview(
      tool,
      checked.input,
      {
        ...ctx,
        channel: 'CHAT',
        conversationId: row.conversationId ?? undefined,
        runId: row.runId ?? undefined,
      },
      row.id,
    );
  }

  /** Run the tool's preview again (through the guards) and validate it like `propose` does. */
  private async buildFreshPreview(
    tool: RegisteredAiTool,
    input: unknown,
    ctx: AiExecutionContext,
    invocationId: string,
  ): Promise<FreshPreview> {
    try {
      const built = await this.executor.preview(tool, input, ctx, invocationId);
      const parsed = AiActionPreviewSchema.safeParse(built);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: 'INTERNAL',
            status: 500,
            message:
              'The preview of this action is invalid; it was not executed',
          },
        };
      }
      return { ok: true, preview: parsed.data };
    } catch (err) {
      return { ok: false, error: mapToolError(err) };
    }
  }

  /**
   * Add warnings to a pending action's stored preview, re-deriving `stepUpRequired` over the union
   * (warnings are only ever added: one that disappeared stays, so step-up never relaxes). Conditional on
   * the row still being pending; not a ledger event — nothing was decided or executed.
   */
  private async addPreviewWarnings(
    row: AiToolInvocation,
    stored: AiActionPreview,
    added: readonly string[],
  ): Promise<AiActionPreview> {
    const warnings = [...stored.warnings, ...added];
    const updated: AiActionPreview = {
      ...stored,
      warnings,
      stepUpRequired: requiresStepUp({ ...stored, warnings }),
    };
    await this.prisma.aiToolInvocation.updateMany({
      where: { id: row.id, status: 'AWAITING_APPROVAL' },
      data: { preview: json(updated) },
    });
    return updated;
  }

  /**
   * Validate and complete a tool-built preview (review fixes; CEO decision 2026-09-24 on step-up):
   *   - it must parse as an `AiActionPreview`;
   *   - a preview that names a `target` must carry its `precondition` (the version checked at execute);
   *   - an `elevated` preview must carry at least one warning, so a new elevated tool cannot skip
   *     classification;
   *   - core DERIVES `stepUpRequired` from the closed warning list (`AI_STEP_UP_WARNINGS`): the tool may
   *     add step-up, never remove it;
   *   - the turn's untrusted sources are merged in.
   */
  private shapePreview(
    tool: RegisteredAiTool,
    built: AiActionPreview,
    ctx: AiExecutionContext,
  ): { ok: true; preview: AiActionPreview } | { ok: false; reason: string } {
    const parsed = AiActionPreviewSchema.safeParse({
      ...built,
      untrustedSources: mergeRefs(built.untrustedSources, ctx.untrustedSources),
    });
    if (!parsed.success) {
      return { ok: false, reason: parsed.error.message.slice(0, 500) };
    }
    const preview = parsed.data;
    if (
      preview.toolName !== tool.descriptor.name ||
      preview.class !== tool.descriptor.class
    ) {
      return { ok: false, reason: 'tool name or class mismatch' };
    }
    if (preview.target && !preview.precondition) {
      return { ok: false, reason: 'a target without a precondition' };
    }
    if (preview.elevated && preview.warnings.length === 0) {
      return { ok: false, reason: 'an elevated preview without a warning' };
    }
    return {
      ok: true,
      preview: { ...preview, stepUpRequired: requiresStepUp(preview) },
    };
  }

  private ceilingError(name: string): ToolError {
    return {
      code: 'FORBIDDEN',
      status: 403,
      message: `${name} is outside the access granted to this session`,
    };
  }

  private reachable(tool: RegisteredAiTool, ctx: AiExecutionContext): boolean {
    if (!tool.channels.includes(ctx.channel)) return false;
    const ceiling = effectiveCeiling(ctx);
    return !ceiling || ceiling.includes(tool.descriptor.class);
  }

  private admitsKind(tool: RegisteredAiTool, principal: Principal): boolean {
    return principal.kind === 'service'
      ? tool.principalKinds.service
      : tool.principalKinds.human;
  }

  private async loadPrincipal(
    ctx: AiExecutionContext,
  ): Promise<Principal | null> {
    const identity = ctx.identity;
    const loaded =
      identity.kind === 'human'
        ? await this.principals.loadHuman(
            identity.userId,
            identity.sessionEpoch,
          )
        : await this.principals.loadServiceAccount(identity.serviceAccountId);
    return loaded.ok ? loaded.principal : null;
  }

  private async holds(
    principal: Principal,
    required: readonly Permission[],
  ): Promise<boolean> {
    if (principal.kind === 'service') {
      return required.every((p) => principal.permissions.has(p));
    }
    return this.permissions.hasAll(principal.user.role, required);
  }

  // ─── Rows ──────────────────────────────────────────────────────────────────────────────────────────

  private invocationBase(
    tool: RegisteredAiTool,
    input: unknown,
    ctx: AiExecutionContext,
  ): Prisma.AiToolInvocationUncheckedCreateInput {
    const actor = actorOf(ctx.identity);
    // Hash exactly what is stored (the JSON form), so the approve-time integrity check compares like
    // with like.
    const canonical = json(input);
    return {
      channel: ctx.channel,
      conversationId: ctx.conversationId ?? null,
      runId: ctx.runId ?? null,
      toolName: tool.descriptor.name,
      toolClass: tool.descriptor.class,
      userId: actor.userId ?? null,
      serviceAccountId: actor.serviceAccountId ?? null,
      mcpClientId: ctx.mcp?.clientId ?? null,
      oauthGrantId: ctx.mcp?.grantId ?? null,
      input: canonical,
      inputHash: inputHashOf(canonical),
      schemaHash: tool.schemaHash,
      status: 'EXECUTING',
    };
  }

  /** The ledger columns every event of one invocation shares. The actor is the row's, never the ctx's. */
  private ledgerBase(
    row: AiToolInvocation,
    ctx?: AiExecutionContext,
  ): Omit<AiActionLogEntry, 'event'> {
    return {
      invocationId: row.id,
      channel: row.channel as AiChannel,
      toolName: row.toolName,
      toolClass: row.toolClass as AiActionLogEntry['toolClass'],
      actor: { userId: row.userId, serviceAccountId: row.serviceAccountId },
      conversationId: row.conversationId,
      runId: row.runId,
      mcpClientId: row.mcpClientId,
      oauthGrantId: row.oauthGrantId,
      provider: ctx?.provenance?.provider ?? null,
      model: ctx?.provenance?.model ?? null,
      requestId: ctx?.provenance?.requestId ?? null,
    };
  }

  /**
   * `AiSettings.approvalTtlMinutes` through the settings port when the settings unit has bound it; the
   * shared default (30) otherwise. Resolved lazily so core does not import the settings module.
   */
  private async approvalTtlMinutes(): Promise<number> {
    try {
      const reader = this.moduleRef.get<AiSettingsReader>(AI_SETTINGS_READER, {
        strict: false,
      });
      const minutes = (await reader.getSettings()).approvalTtlMinutes;
      if (Number.isInteger(minutes) && minutes >= 1) return minutes;
    } catch {
      // No reader bound (yet), or it failed: the documented default applies.
    }
    return AI_SETTINGS_DEFAULTS.approvalTtlMinutes;
  }
}

/**
 * Whether the target changed version since the stored preview: the fresh precondition must name the same
 * entity with the same `updatedAt`. A preview without a precondition is never stale.
 */
function isStale(stored: AiActionPreview, fresh: AiActionPreview): boolean {
  if (!stored.precondition) return false;
  return (
    !fresh.precondition ||
    fresh.precondition.entity.type !== stored.precondition.entity.type ||
    fresh.precondition.entity.id !== stored.precondition.entity.id ||
    fresh.precondition.updatedAt !== stored.precondition.updatedAt
  );
}

/** A fresh preview built at approve, or the tool error that building it produced. */
type FreshPreview =
  | { ok: true; preview: AiActionPreview }
  | { ok: false; error: ToolError };

const PRINCIPAL_INVALID: ToolError = {
  code: 'FORBIDDEN',
  status: 401,
  message: 'The acting principal is no longer valid',
};

function gateError(gate: Permission): ToolError {
  return {
    code: 'FORBIDDEN',
    status: 403,
    message: `The ${gate} permission is required`,
  };
}

function refuse(
  kind: Parameters<typeof errorResult>[0],
  error: ToolError,
): AiProposal {
  return { ok: false, result: errorResult(kind, error) };
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
