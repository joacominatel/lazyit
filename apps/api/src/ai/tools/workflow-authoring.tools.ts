import { WorkflowConnectionsController } from '../../workflow-engine/definitions/workflow-connections.controller';
import { WorkflowsController } from '../../workflow-engine/definitions/workflows.controller';
import { WorkflowDryRunController } from '../../workflow-engine/dry-run/workflow-dry-run.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

const PENDING =
  'Pending: the workflow authoring toolset (W2-14) binds or excludes it.';

/**
 * The WORKFLOW AUTHORING toolset (W2-14): creating and changing workflows and their versions, connections
 * (incl. the connection test), the dry-run, and enabling or disabling a workflow. CHAT ONLY in v1: every
 * tool here declares `channels: ['CHAT']` — MCP and headless authoring are deferred (#1344), and a Service
 * Account never authors, connects or enables (ADR-0097 decision 3, amended 2026-09-24). Pre-created by
 * W2-12; its unit fills `tools` and replaces the pending entries with a decision per handler.
 *
 * Declared in the `access` domain, like `workflows.tools.ts`. Workflow secrets are NOT here: they stay a
 * structural exclusion (`platform.tools.ts`, `core/exclusions.ts`).
 *
 * Rules for the unit that fills it (tools-and-execution.md §7 "Workflow engine", §9):
 *   - every tool is `elevated`;
 *   - creating or changing a connection, its host or its credential reference, authoring a version on an
 *     enabled workflow, or enabling a workflow emits `OUTBOUND_INTEGRATION` (no step-up by itself); the
 *     preview lists every outbound host and every mapped field → token;
 *   - any write on an application with `isCritical = true` emits `CRITICAL_APPLICATION` (core requires
 *     step-up);
 *   - a workflow is created disabled; enabling is its own proposal, and its preview embeds a dry-run.
 */
export const workflowAuthoringToolset: AiToolset = {
  domain: 'access',
  tools: [],
  unexposed: [
    unexposed(
      WorkflowsController,
      ['create', 'update', 'remove', 'authorVersion'],
      PENDING,
    ),
    unexposed(
      WorkflowConnectionsController,
      ['create', 'update', 'test', 'remove'],
      PENDING,
    ),
    unexposed(WorkflowDryRunController, ['run'], PENDING),
  ],
};
