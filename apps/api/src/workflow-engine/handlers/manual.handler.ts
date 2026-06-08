import { Injectable } from '@nestjs/common';
import type { ManualConnectionConfig, ManualStep } from '@lazyit/shared';
import { renderTemplate } from '../mapping/data-mapper';
import {
  type StepContext,
  type StepHandler,
  type StepResult,
} from './step-handler';

/**
 * MANUAL connector handler (ADR-0054 §7) — no external call. It is how an app with NO API (or a step
 * needing human judgement, e.g. "which team?") still belongs to an automated, audited flow: lazyit
 * orchestrates + records, a human executes + (optionally) types data back.
 *
 * `execute` returns `status: 'AWAITING_INPUT'` plus a {@link StepResult.manualTask} spec, signalling
 * the CORE (Phase 1b-B) to create a `ManualTask`, PAUSE the run in Postgres (no held BullMQ job —
 * `AWAITING_INPUT` costs one row, not a worker), and surface it on the bell/SSE inbox. On completion
 * the typed input feeds later steps (via `ctx.steps[<key>]`).
 *
 * SCOPE GUARDRAIL (ADR-0054 §6c): the input form's `suggestions` are STATIC, admin-typed values from
 * the step config — never a directory/role/team lookup (anti-IGA). This handler passes them through
 * unchanged; it adds no dynamic suggestion source.
 */
@Injectable()
export class ManualStepHandler implements StepHandler<
  ManualConnectionConfig,
  ManualStep
> {
  readonly kind = 'MANUAL' as const;

  execute(
    ctx: StepContext<ManualConnectionConfig, ManualStep>,
  ): Promise<StepResult> {
    const { step, data, meta } = ctx;

    // The prompt may reference ctx (e.g. "Create a Jira account for {{ grantee.email }}"). It is
    // lazyit-internal display text — rendered with `text` encoding (the web escapes on render); the
    // frozen-ctx + single-pass guards still apply (no SSTI, no prototype access).
    const prompt = renderTemplate(step.prompt, data, 'text');

    return Promise.resolve({
      status: 'AWAITING_INPUT',
      manualTask: {
        stepKey: meta.stepKey,
        prompt,
        // The typed input schema + STATIC suggestions are passed straight from the step config.
        inputFields: step.inputFields,
        cohort: step.cohort,
      },
      metadata: {
        reason: 'manual step — awaiting human input',
      },
    });
  }
}
