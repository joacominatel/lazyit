import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AiApprovalDecisionValue, AiRunStatus } from '@lazyit/shared';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiToolService } from '../core/ai-tool.service';
import {
  requiresStepUp,
  toPendingAction,
  type AiPendingAction,
} from '../core/pending-action';
import type { AiExecutionContext } from '../core/tool-descriptor';
import { toolResultEvent } from './agent-loop';
import { AiRunLifecycle } from './run-lifecycle';
import { AiStepUpVerifier } from './step-up.verifier';

export interface AiDecisionInput {
  runId: string;
  /** The provider tool-use id the card was announced with (`tool.approval_required.toolCallId`). */
  toolCallId: string;
  decision: AiApprovalDecisionValue;
  reason?: string;
  /** The password step-up, for an action whose preview requires it. Never stored or logged. */
  password?: string;
  /** The deciding session: a human, with the session's `sessionEpoch`. */
  identity: DelegatedIdentity;
}

export interface AiDecisionOutcome {
  /** The action after the decision (a double decision returns the stored outcome, `replayed`). */
  action: AiPendingAction;
  /** The run's status afterwards (QUEUED when this decision resumed it). */
  runStatus: AiRunStatus | null;
}

function refused(
  status: HttpStatus,
  code: string,
  message: string,
  extra = {},
) {
  return new HttpException({ code, message, ...extra }, status);
}

/**
 * THE RUNTIME SIDE OF AN APPROVAL (tools §9 "Boundary between core and the runtime"; provider §8;
 * security.md §6.2) — the service the decision endpoint (`POST /ai/runs/:id/tool-calls/:toolCallId/decision`,
 * W3-1) calls. Core owns the atomic claim, the re-authorization and the ledger; this service owns:
 *
 *   1. who may decide: a human session deciding on its OWN chat run (anything else is 404 or 403 —
 *      never a hint that someone else's run exists);
 *   2. the password step-up: an approval whose stored preview requires it is verified here with the
 *      local-auth password verifier (rate-limited) before core's `approve(…, { stepUpVerified: true })`;
 *      a missing or wrong password never reaches core, so the action stays pending for a retry;
 *   3. the events (`tool.approval_resolved`, `tool.result`) and the resume: when the last call of the
 *      step is decided, the run moves AWAITING_APPROVAL → QUEUED and the resume job is enqueued.
 *
 * The request carries only the decision: the approved arguments are the server-stored ones (INV-AI-3).
 * Refusals throw Nest HTTP exceptions with `{ code, message }` bodies; core's own refusals pass through.
 */
@Injectable()
export class AiApprovalService {
  private readonly logger = new Logger(AiApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: AiToolService,
    private readonly loader: PrincipalLoaderService,
    private readonly stepUp: AiStepUpVerifier,
    private readonly lifecycle: AiRunLifecycle,
  ) {}

  async decide(input: AiDecisionInput): Promise<AiDecisionOutcome> {
    const identity = input.identity;
    if (identity.kind !== 'human') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message:
          'Only the requesting user, from a signed-in session, can decide this action',
      });
    }
    const run = await this.prisma.aiRun.findUnique({
      where: { id: input.runId },
    });
    if (!run || run.userId !== identity.userId || run.channel !== 'CHAT') {
      throw notFound();
    }
    const row = await this.prisma.aiToolInvocation.findFirst({
      where: { runId: run.id, toolUseId: input.toolCallId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.userId !== identity.userId) throw notFound();

    const ctx: AiExecutionContext = {
      identity,
      channel: 'CHAT',
      runId: run.id,
      ...(run.conversationId ? { conversationId: run.conversationId } : {}),
      provenance: { provider: run.provider, model: run.model },
    };

    let action: AiPendingAction;
    try {
      if (input.decision === 'reject') {
        action = await this.tools.reject(row.id, ctx, input.reason);
        if (!action.replayed) {
          this.lifecycle.emitResolved(run.id, input.toolCallId, 'rejected');
        }
      } else {
        const pending = toPendingAction(row);
        let stepUpVerified = false;
        if (
          pending.status === 'AWAITING_APPROVAL' &&
          pending.preview &&
          requiresStepUp(pending.preview)
        ) {
          await this.verifyStepUp(identity, input.password);
          stepUpVerified = true;
        }
        action = await this.tools.approve(row.id, ctx, { stepUpVerified });
        if (!action.replayed) {
          this.lifecycle.emitResolved(run.id, input.toolCallId, 'approved');
          if (action.result) {
            this.lifecycle.emit(
              run.id,
              toolResultEvent(input.toolCallId, action.result),
            );
          }
        }
      }
    } catch (err) {
      await this.expireRunIfLapsed(run.id, row.id, input.toolCallId);
      throw err;
    }
    const runStatus = await this.lifecycle.resumeIfDecided(run.id);
    return { action, runStatus };
  }

  /**
   * A decision that arrived after the approval window: core expired the action and refused (409
   * `EXPIRED`). The run ends EXPIRED like the sweeper's expiry, with every call answered.
   */
  private async expireRunIfLapsed(
    runId: string,
    invocationId: string,
    toolCallId: string,
  ): Promise<void> {
    try {
      const row = await this.prisma.aiToolInvocation.findUnique({
        where: { id: invocationId },
        select: { status: true },
      });
      if (row?.status !== 'EXPIRED') return;
      this.lifecycle.emitResolved(runId, toolCallId, 'expired');
      await this.lifecycle.finalize(runId, 'EXPIRED', {
        from: ['AWAITING_APPROVAL'],
        finishReason: 'approval_expired',
        fallback: {
          code: 'EXPIRED',
          message: 'The approval window for this action has passed',
        },
      });
    } catch (err) {
      this.logger.error(
        `AI run ${runId}: expiry after a late decision could not be finalized: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Verify the step-up password of the deciding user (loaded fresh, at the session's epoch). Throws:
   * 403 `STEP_UP_REQUIRED` (none sent), 403 `STEP_UP_FAILED` (wrong), 429 `STEP_UP_RATE_LIMITED`
   * (backoff), 403 `STEP_UP_UNAVAILABLE` (no local password in this sign-in mode).
   */
  private async verifyStepUp(
    identity: Extract<DelegatedIdentity, { kind: 'human' }>,
    password: string | undefined,
  ): Promise<void> {
    if (!password) {
      throw new ForbiddenException({
        code: 'STEP_UP_REQUIRED',
        message: 'This action requires your password to be confirmed',
      });
    }
    const loaded = await this.loader.loadHuman(
      identity.userId,
      identity.sessionEpoch,
    );
    if (!loaded.ok) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'The session is no longer valid',
      });
    }
    const result = await this.stepUp.verify(loaded.principal.user, password);
    if (result.ok) return;
    switch (result.reason) {
      case 'locked':
        this.logger.warn(
          `ai.approval.step_up_locked user=${identity.userId} retryAfterSec=${result.retryAfterSec}`,
        );
        throw refused(
          HttpStatus.TOO_MANY_REQUESTS,
          'STEP_UP_RATE_LIMITED',
          'Too many wrong passwords; wait before trying again',
          { retryAfterSec: result.retryAfterSec },
        );
      case 'unavailable':
        throw new ForbiddenException({
          code: 'STEP_UP_UNAVAILABLE',
          message:
            'Password confirmation is not available in this sign-in mode; this action cannot be approved from the chat',
        });
      default:
        this.logger.warn(`ai.approval.step_up_failed user=${identity.userId}`);
        throw new ForbiddenException({
          code: 'STEP_UP_FAILED',
          message: 'The password is not correct',
        });
    }
  }
}

function notFound(): NotFoundException {
  return new NotFoundException({
    code: 'NOT_FOUND',
    message: 'Pending action not found',
  });
}
