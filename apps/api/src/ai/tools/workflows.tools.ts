import { WorkflowConnectionsController } from '../../workflow-engine/definitions/workflow-connections.controller';
import { WorkflowsController } from '../../workflow-engine/definitions/workflows.controller';
import { WorkflowRunsController } from '../../workflow-engine/runs/workflow-runs.controller';
import { ManualTasksController } from '../../workflow-engine/tasks/manual-tasks.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

const PENDING =
  'Pending: the workflow operations toolset (W2-13) binds or excludes it.';

/**
 * The WORKFLOW OPERATIONS toolset (W2-13): reading workflows and their connections, runs and their
 * retry/replay, and manual tasks — on every channel (ADR-0097 decision 3, amended 2026-09-24). Pre-created
 * by W2-12; its unit fills `tools` and replaces the pending entries with a decision per handler. The
 * coverage test fails on any handler left undecided.
 *
 * Declared in the `access` domain: the workflow engine is part of application access (no new domain).
 * Authoring lives in `workflow-authoring.tools.ts` (W2-14, chat only). Workflow secrets stay a structural
 * exclusion in `platform.tools.ts`; a connection read may report "credential configured: yes/no" from its
 * `secretId`, never a value.
 *
 * Rules for the unit that fills it (tools-and-execution.md §7 "Workflow engine"):
 *   - retry never exposes the route's `overrides`;
 *   - a write on an application with `isCritical = true` emits `CRITICAL_APPLICATION` (core requires
 *     step-up on any write preview carrying it); retry/replay emit `EXTERNAL_PROVISIONING` or
 *     `EXTERNAL_DEPROVISIONING` by trigger;
 *   - over MCP and headless no preview is built: a write that detects a critical application in `run`
 *     calls `assertChannelAllows(rt.ctx.channel, ['CRITICAL_APPLICATION'])` (core/pending-action.ts)
 *     before any side effect — a no-op today, the seam for a per-channel refusal;
 *   - run errors, step metadata and manual-task inputs and prompts go through `untrusted()`;
 *   - connection `defaultHeaders` values are redacted.
 */
export const workflowsToolset: AiToolset = {
  domain: 'access',
  tools: [],
  unexposed: [
    // `findAll` is bound by the access toolset (W2-6) for grant/revoke previews; W2-13 may bind it too.
    unexposed(WorkflowsController, ['findOne'], PENDING),
    unexposed(WorkflowConnectionsController, ['findAll', 'findOne'], PENDING),
    unexposed(
      WorkflowRunsController,
      ['findAll', 'findOne', 'retry', 'replayLatest'],
      PENDING,
    ),
    unexposed(
      ManualTasksController,
      ['findAll', 'findOne', 'submit', 'skip', 'fail'],
      PENDING,
    ),
  ],
};
