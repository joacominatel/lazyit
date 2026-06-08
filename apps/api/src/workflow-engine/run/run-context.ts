import { Injectable } from '@nestjs/common';
import {
  freezeMappingContext,
  type WorkflowMappingContext,
} from '../handlers/step-handler';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Assembles the FROZEN, allowlisted mapping context a step's data mapping renders against
 * (`StepContext.data`, ADR-0054 §6c). Built SERVER-SIDE from the run's grant + grantee + application,
 * plus the typed input of any already-completed manual task in this run (so a resumed MANUAL step's
 * input feeds later steps via `ctx.steps[<key>]`). Every value is UNTRUSTED; the mapper context-aware
 * encodes each interpolation. NO `role`/`team`/`manager`/AD fields — those are a future model-first
 * ADR, never this engine.
 */
@Injectable()
export class RunContextBuilder {
  constructor(private readonly prisma: PrismaService) {}

  /** Build + deep-freeze the mapping context for a run. Throws if the run's grant/grantee is missing. */
  async build(runId: string): Promise<Readonly<WorkflowMappingContext>> {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId },
      include: {
        application: { select: { id: true, name: true } },
        accessGrant: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    });
    if (!run) {
      throw new Error(`WorkflowRun ${runId} not found while building context`);
    }
    const grant = run.accessGrant;
    if (!grant || !grant.user) {
      // v1 triggers are grant-derived; a run without a grant/grantee can't render a mapping context.
      throw new Error(
        `WorkflowRun ${runId} has no access grant / grantee — cannot build a mapping context`,
      );
    }

    // Prior MANUAL step outputs in THIS run (keyed by step key) — completed tasks only.
    const completedTasks = await this.prisma.manualTask.findMany({
      where: { runId, status: 'COMPLETED' },
      select: { stepKey: true, input: true },
    });
    const steps: Record<string, Record<string, unknown>> = {};
    for (const task of completedTasks) {
      if (task.input && typeof task.input === 'object') {
        steps[task.stepKey] = task.input as Record<string, unknown>;
      }
    }

    const ctx: WorkflowMappingContext = {
      event: run.trigger,
      grantee: {
        id: grant.user.id,
        email: grant.user.email,
        firstName: grant.user.firstName,
        lastName: grant.user.lastName,
      },
      application: {
        id: run.application.id,
        name: run.application.name,
      },
      grant: {
        id: grant.id,
        accessLevel: grant.accessLevel ?? null,
        grantedAt: grant.grantedAt.toISOString(),
        expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      },
      steps,
    };
    return freezeMappingContext(ctx);
  }
}
