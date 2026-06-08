import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  offsetOf,
  pageOf,
  resolveStepTransitions,
  WORKFLOW_STOP_FAIL,
  WorkflowStepsSchema,
  type CompleteManualTask,
  type ManualInputField,
  type ManualTaskStatus,
  type PageQuery,
  type WorkflowStep,
} from '@lazyit/shared';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActorService } from '../../common/actor.service';
import { isHumanPrincipal, type Principal } from '../../auth/principal';
import { WorkflowTriggerService } from '../run/workflow-trigger.service';
import type { ManualTaskOrigin } from '../run/workflow-run.types';
import { validateManualInput } from './manual-input.validation';

/** The synthetic input form an ESCALATED_FAILURE task offers (a non-MANUAL step has no `inputFields`). */
const ESCALATION_NOTE_FIELD: ManualInputField = {
  name: 'resolutionNote',
  label: 'Resolution note',
  type: 'text',
  required: false,
};

/**
 * The manual-task inbox backend (contract C5, frontend §6). Lists pending tasks, returns a task with its
 * DERIVED `origin` (MANUAL_STEP vs ESCALATED_FAILURE — read off the pinned step's kind, no column) + the
 * input form + STATIC admin-typed suggestions, and resolves a task (submit / skip / fail) which RESUMES
 * the run at the correct next DAG step. Completion is gated by `workflow:task` (the guard) AND the
 * assignee IDOR check here (permission alone is not enough — synthesis §5).
 */
@Injectable()
export class ManualTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly trigger: WorkflowTriggerService,
  ) {}

  /** A page of tasks (default: PENDING), optionally scoped to an application. Newest-first. */
  async findPage(
    filters: { status?: ManualTaskStatus; applicationId?: string },
    page: PageQuery,
  ) {
    const where: Prisma.ManualTaskWhereInput = {
      status: filters.status ?? 'PENDING',
      ...(filters.applicationId
        ? { run: { applicationId: filters.applicationId } }
        : {}),
    };
    const { take, skip } = offsetOf(page);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.manualTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.manualTask.count({ where }),
    ]);
    return pageOf(items, total, page);
  }

  /** A task + origin + the input form + static suggestions. 404 if missing. */
  async findOne(id: string) {
    const loaded = await this.load(id);
    const { task, origin, inputFields } = loaded;
    return {
      id: task.id,
      runId: task.runId,
      stepKey: task.stepKey,
      assigneeId: task.assigneeId,
      cohort: task.cohort,
      prompt: task.prompt,
      status: task.status,
      input: task.input,
      origin,
      inputFields,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  /** Submit the typed input → record it + resume the run at the manual step's `onSuccess`. */
  async submit(id: string, dto: CompleteManualTask, principal?: Principal) {
    const loaded = await this.load(id);
    this.assertPending(loaded.task.status);
    this.assertCanComplete(loaded.task.assigneeId, principal);
    const cleaned = validateManualInput(loaded.inputFields, dto.input);
    await this.complete(loaded.task.id, 'COMPLETED', cleaned, principal);
    const cursor = resolveStepTransitions(loaded.steps, loaded.index).onSuccess;
    await this.trigger.enqueueResume(loaded.task.runId, cursor);
    return { ok: true, runId: loaded.task.runId, resumeCursor: cursor };
  }

  /** Skip the manual data entry → continue the run at `onSuccess` with an empty input. */
  async skip(id: string, principal?: Principal) {
    const loaded = await this.load(id);
    this.assertPending(loaded.task.status);
    this.assertCanComplete(loaded.task.assigneeId, principal);
    await this.complete(loaded.task.id, 'COMPLETED', {}, principal);
    const cursor = resolveStepTransitions(loaded.steps, loaded.index).onSuccess;
    await this.trigger.enqueueResume(loaded.task.runId, cursor);
    return { ok: true, runId: loaded.task.runId, resumeCursor: cursor };
  }

  /** Fail the task → cancel it + resume the run down the failure edge (MANUAL: `onFailure`; escalated: STOP). */
  async fail(id: string, principal?: Principal) {
    const loaded = await this.load(id);
    this.assertPending(loaded.task.status);
    this.assertCanComplete(loaded.task.assigneeId, principal);
    await this.complete(loaded.task.id, 'CANCELLED', null, principal);
    const cursor =
      loaded.origin === 'ESCALATED_FAILURE'
        ? WORKFLOW_STOP_FAIL
        : resolveStepTransitions(loaded.steps, loaded.index).onFailure;
    await this.trigger.enqueueResume(loaded.task.runId, cursor);
    return { ok: true, runId: loaded.task.runId, resumeCursor: cursor };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Load the task + its pinned step (origin + input form). 404 if the task or its step is missing. */
  private async load(id: string) {
    const task = await this.prisma.manualTask.findFirst({
      where: { id },
      include: { run: { include: { workflowVersion: true } } },
    });
    if (!task) {
      throw new NotFoundException(`ManualTask ${id} not found`);
    }
    const steps = WorkflowStepsSchema.parse(task.run.workflowVersion.steps);
    const index = steps.findIndex((s) => s.key === task.stepKey);
    if (index < 0) {
      throw new NotFoundException(
        `ManualTask ${id} references an unknown step "${task.stepKey}"`,
      );
    }
    const step = steps[index];
    const origin: ManualTaskOrigin =
      step.kind === 'MANUAL' ? 'MANUAL_STEP' : 'ESCALATED_FAILURE';
    const inputFields = inputFormFor(step, origin);
    return { task, steps, step, index, origin, inputFields };
  }

  private assertPending(status: ManualTaskStatus): void {
    if (status !== 'PENDING') {
      throw new ConflictException('This task is no longer pending');
    }
  }

  /**
   * The IDOR guard (synthesis §5): a directly-ASSIGNED task may only be resolved by its assignee.
   * `workflow:task` alone (already enforced by the route guard) is not enough. An unassigned / cohort
   * task is resolvable by any holder of the permission (v1 has no cohort-membership model — a noted
   * scope limit, never a directory lookup).
   */
  private assertCanComplete(
    assigneeId: string | null,
    principal?: Principal,
  ): void {
    if (assigneeId == null) {
      return;
    }
    const completerId = isHumanPrincipal(principal) ? principal.user.id : null;
    if (completerId !== assigneeId) {
      throw new ForbiddenException(
        'Only the assigned user may resolve this manual task',
      );
    }
  }

  /** Record the resolution with actor attribution (human XOR SA; ADR-0048). Guarded on PENDING. */
  private async complete(
    id: string,
    status: 'COMPLETED' | 'CANCELLED',
    input: Record<string, unknown> | null,
    principal?: Principal,
  ): Promise<void> {
    const actor = this.actor.resolveActor(principal);
    const result = await this.prisma.manualTask.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status,
        input:
          input === null ? Prisma.DbNull : (input as Prisma.InputJsonValue),
        ...(actor.userId != null ? { completedById: actor.userId } : {}),
        ...(actor.serviceAccountId != null
          ? { completedBySaId: actor.serviceAccountId }
          : {}),
      },
    });
    if (result.count === 0) {
      // Lost the race to another resolver — surface a clean conflict, do not double-resume.
      throw new ConflictException('This task is no longer pending');
    }
  }
}

/** The input form for a step: the MANUAL step's declared fields, or the escalation note for a failure. */
function inputFormFor(
  step: WorkflowStep,
  origin: ManualTaskOrigin,
): ManualInputField[] {
  if (origin === 'MANUAL_STEP' && step.kind === 'MANUAL') {
    return step.inputFields;
  }
  return [ESCALATION_NOTE_FIELD];
}
