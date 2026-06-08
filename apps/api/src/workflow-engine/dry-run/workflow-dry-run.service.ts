import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  resolveStepTransitions,
  WorkflowConnectionConfigSchema,
  WorkflowStepsSchema,
  WORKFLOW_COMPENSATE,
  WORKFLOW_END_SUCCESS,
  WORKFLOW_ESCALATE_TO_MANUAL,
  WORKFLOW_STOP_FAIL,
  type RestConnectionConfig,
  type WebhookOutConnectionConfig,
  type WorkflowConnectionConfig,
  type WorkflowStep,
} from '@lazyit/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  freezeMappingContext,
  type WorkflowMappingContext,
} from '../handlers/step-handler';
import { joinUrl } from '../handlers/outbound-http';
import { mapData, renderTemplate } from '../mapping/data-mapper';
import {
  classifyFailureEdge,
  classifySuccessEdge,
  isTerminalTarget,
} from '../run/transitions';
import { MAX_WALK_STEPS } from '../run/workflow-run.constants';
import type { TransitionTaken } from '../run/workflow-run.types';
import {
  type DryRunEndState,
  type DryRunRequestPreview,
  type DryRunResult,
  type DryRunStep,
  type WorkflowDryRunInput,
} from './workflow-dry-run.dto';

/** A resolved, parsed connection the dry-run renders a request against (+ its redacted secret label). */
interface ResolvedConnection {
  config: WorkflowConnectionConfig;
  secretLabel: string | null;
}

/**
 * C4 — DRY-RUN resolver (ADR-0054 §8 / §11, frontend §8). A SEPARATE, side-effect-free service that
 * REUSES the shared transition helpers + the logic-less data mapper to PREVIEW a workflow without
 * touching the orchestrator/sweeper/worker. It:
 *
 *  - resolves the workflow (by id, or by applicationId + trigger) and its LATEST `WorkflowVersion`;
 *  - builds the FROZEN, allowlisted mapping context from a REAL sample `AccessGrant` (same fields the
 *    {@link import('../run/run-context').RunContextBuilder} assembles for a live run — but from a grant,
 *    since there is no run);
 *  - walks the DAG via the shared `resolveStepTransitions`, resolving each step's data mapping and
 *    rendering the WOULD-BE request, classifying the success/failure edge with the SAME
 *    `classifySuccessEdge`/`classifyFailureEdge` the timeline renders;
 *  - an optional `simulate` forces ONE step to FAILURE so its failure edge (escalate/compensate/stop)
 *    can be previewed.
 *
 * It makes NO real external call and writes NO `WorkflowRun` / `WorkflowStepRun` / `ManualTask` row —
 * it only READS (workflow, version, grant, connection, secret LABEL). INV-6: a secret-backed header is
 * rendered as a `‹secret:label›` placeholder; the real credential is NEVER revealed or returned.
 */
@Injectable()
export class WorkflowDryRunService {
  constructor(private readonly prisma: PrismaService) {}

  async dryRun(
    input: WorkflowDryRunInput,
    requestId: string,
  ): Promise<DryRunResult> {
    const { workflow, version } = await this.resolveWorkflowAndVersion(input);
    const steps = WorkflowStepsSchema.parse(version.steps);

    if (
      input.simulate &&
      !steps.some((s) => s.key === input.simulate!.stepKey)
    ) {
      throw new BadRequestException(
        `simulate.stepKey "${input.simulate.stepKey}" is not a step in this workflow version`,
      );
    }

    const ctx = await this.buildContext(workflow, input.sampleAccessGrantId);
    const connections = await this.loadConnections(steps);

    const dryRunSteps: DryRunStep[] = [];
    const visited = new Set<string>();
    let cursor: string = steps[0].key;
    let endState: DryRunEndState = 'STOP_FAIL';
    let wouldPause = false;

    for (let guard = 0; guard < MAX_WALK_STEPS; guard++) {
      if (isTerminalTarget(cursor)) {
        endState = terminalToEndState(cursor);
        break;
      }
      const index = steps.findIndex((s) => s.key === cursor);
      // A validated graph is acyclic + reachable; the index/visited guards are purely defensive.
      if (index < 0 || visited.has(cursor)) {
        endState = 'STOP_FAIL';
        break;
      }
      visited.add(cursor);

      const step = steps[index];
      const { onSuccess, onFailure } = resolveStepTransitions(steps, index);
      const forcedFailure = input.simulate?.stepKey === step.key;
      const preview = this.buildStepPreview(step, index, ctx, connections);

      let status: DryRunStep['status'];
      let transitionTaken: TransitionTaken;
      let next: string;
      if (forcedFailure) {
        // Preview the configured failure edge (the operator's "simulate this step failing").
        status = 'FAILED';
        transitionTaken = classifyFailureEdge(onFailure, onSuccess);
        next = onFailure;
      } else if (step.kind === 'MANUAL') {
        // A MANUAL step pauses the real run; the dry-run records the PAUSE (same shape the orchestrator
        // writes) and continues along `onSuccess` so the rest of the DAG is still previewed.
        status = 'AWAITING_INPUT';
        wouldPause = true;
        transitionTaken = { outcome: 'PAUSE', edge: 'PAUSE' };
        next = onSuccess;
      } else {
        status = 'SUCCEEDED';
        transitionTaken = classifySuccessEdge(steps, index, onSuccess);
        next = onSuccess;
      }

      dryRunSteps.push({
        ...preview,
        status,
        simulated: forcedFailure,
        transitionTaken,
      });
      cursor = next;
    }

    return {
      dryRun: true,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      version: version.version,
      applicationId: workflow.applicationId,
      trigger: workflow.trigger,
      sampleAccessGrantId: input.sampleAccessGrantId,
      context: ctx,
      simulate: input.simulate ?? null,
      steps: dryRunSteps,
      endState,
      wouldPause,
      requestId,
    };
  }

  // ── resolution ────────────────────────────────────────────────────────────

  /** Resolve the workflow (by id OR app+trigger) + its latest authored version. */
  private async resolveWorkflowAndVersion(input: WorkflowDryRunInput) {
    const where = input.workflowId
      ? { id: input.workflowId, deletedAt: null }
      : {
          applicationId: input.applicationId,
          trigger: input.trigger,
          deletedAt: null,
        };
    const workflow = await this.prisma.applicationWorkflow.findFirst({
      where,
      include: {
        application: { select: { id: true, name: true } },
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });
    if (!workflow) {
      throw new NotFoundException(
        'No workflow found to dry-run (check workflowId, or applicationId + trigger)',
      );
    }
    const version = workflow.versions[0];
    if (!version) {
      throw new BadRequestException(
        'This workflow has no authored version to dry-run — author a version first',
      );
    }
    return { workflow, version };
  }

  /**
   * Build the FROZEN, allowlisted mapping context from a REAL sample grant — the same fields
   * `RunContextBuilder` assembles for a live run, but sourced from the grant (there is no run). The
   * grant must belong to the workflow's application (a real trigger always fires on that app). `steps`
   * is empty: a dry-run has no prior step outputs (a template reading `steps.*` resolves empty).
   */
  private async buildContext(
    workflow: {
      applicationId: string;
      trigger: WorkflowMappingContext['event'];
      application: { id: string; name: string };
    },
    sampleAccessGrantId: string,
  ): Promise<Readonly<WorkflowMappingContext>> {
    const grant = await this.prisma.accessGrant.findFirst({
      where: { id: sampleAccessGrantId },
      include: {
        user: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });
    if (!grant || !grant.user) {
      throw new BadRequestException(
        `sampleAccessGrantId ${sampleAccessGrantId} does not reference an access grant with a grantee`,
      );
    }
    if (grant.applicationId !== workflow.applicationId) {
      throw new BadRequestException(
        'The sample access grant belongs to a different application than the workflow',
      );
    }
    return freezeMappingContext({
      event: workflow.trigger,
      grantee: {
        id: grant.user.id,
        email: grant.user.email,
        firstName: grant.user.firstName,
        lastName: grant.user.lastName,
      },
      application: {
        id: workflow.application.id,
        name: workflow.application.name,
      },
      grant: {
        id: grant.id,
        accessLevel: grant.accessLevel ?? null,
        grantedAt: grant.grantedAt.toISOString(),
        expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      },
      steps: {},
    });
  }

  /** Batch-load + parse the connections referenced by REST/WEBHOOK steps, with their redacted labels. */
  private async loadConnections(
    steps: readonly WorkflowStep[],
  ): Promise<Map<string, ResolvedConnection>> {
    const ids = [
      ...new Set(
        steps
          .filter(
            (s): s is Extract<WorkflowStep, { connectionId: string }> =>
              s.kind === 'REST' || s.kind === 'WEBHOOK_OUT',
          )
          .map((s) => s.connectionId),
      ),
    ];
    const result = new Map<string, ResolvedConnection>();
    if (ids.length === 0) {
      return result;
    }
    const rows = await this.prisma.workflowConnection.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, config: true, secretId: true },
    });
    const secretIds = [
      ...new Set(
        rows
          .map((r) => r.secretId)
          .filter((x): x is string => typeof x === 'string'),
      ),
    ];
    const secretRows = secretIds.length
      ? await this.prisma.workflowSecret.findMany({
          where: { id: { in: secretIds }, deletedAt: null },
          select: { id: true, label: true },
        })
      : [];
    const labelById = new Map(secretRows.map((r) => [r.id, r.label]));
    for (const row of rows) {
      const parsed = WorkflowConnectionConfigSchema.safeParse(row.config);
      if (!parsed.success) {
        continue; // an unparseable config → treated as "not available" (a warning at preview time)
      }
      result.set(row.id, {
        config: parsed.data,
        secretLabel: row.secretId
          ? (labelById.get(row.secretId) ?? null)
          : null,
      });
    }
    return result;
  }

  // ── per-step preview ────────────────────────────────────────────────────────

  /** Resolve ONE step into its dry-run preview (payload + redacted request OR the manual form). */
  private buildStepPreview(
    step: WorkflowStep,
    index: number,
    ctx: Readonly<WorkflowMappingContext>,
    connections: Map<string, ResolvedConnection>,
  ): Omit<DryRunStep, 'status' | 'simulated' | 'transitionTaken'> {
    const base = {
      stepIndex: index,
      stepKey: step.key,
      kind: step.kind,
      name: step.name ?? null,
      mappedFields: [] as string[],
      request: null as DryRunRequestPreview | null,
      manual: null as DryRunStep['manual'],
      warnings: [] as string[],
    };

    if (step.kind === 'MANUAL') {
      // The prompt may reference ctx; it is lazyit-internal display text (the web escapes on render).
      return {
        ...base,
        manual: {
          prompt: renderTemplate(step.prompt, ctx, 'text'),
          inputFields: step.inputFields,
        },
      };
    }

    const conn = connections.get(step.connectionId);
    if (!conn) {
      return {
        ...base,
        warnings: [
          `Connection ${step.connectionId} is missing, deleted, or has an invalid config — the live run would fail with a config error.`,
        ],
      };
    }

    if (step.kind === 'REST') {
      const config = conn.config as RestConnectionConfig;
      const renderedPath = renderTemplate(step.path, ctx, 'url');
      const url = joinUrl(config.baseUrl, renderedPath);

      // Non-secret default headers first, then the auth header (a placeholder — never the credential).
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(config.defaultHeaders ?? {})) {
        headers[name] = stripControlChars(value);
      }
      const auth = restAuthPreview(config, conn.secretLabel);
      Object.assign(headers, auth.headers);

      const mapped = mapData(step.dataMapping, ctx, 'json');
      const carriesBody =
        step.method === 'POST' ||
        step.method === 'PUT' ||
        step.method === 'PATCH';
      const request: DryRunRequestPreview = {
        kind: 'REST',
        method: step.method,
        url,
        headers,
      };
      if (carriesBody && mapped.fieldNames.length > 0) {
        request.body = mapped.values;
        headers['content-type'] = 'application/json';
      }
      return {
        ...base,
        mappedFields: mapped.fieldNames,
        request,
        warnings: auth.warnings,
      };
    }

    // WEBHOOK_OUT
    const config = conn.config as WebhookOutConnectionConfig;
    const mapped = mapData(step.dataMapping, ctx, 'json');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const warnings: string[] = [];
    let signed = false;
    if (config.signatureHeader) {
      signed = true;
      headers[config.signatureHeader] =
        `sha256=${secretPlaceholder(conn.secretLabel)}`;
      if (!conn.secretLabel) {
        warnings.push(
          'A signatureHeader is configured but no signing secret is set — the live run would fail.',
        );
      }
    }
    return {
      ...base,
      mappedFields: mapped.fieldNames,
      request: {
        kind: 'WEBHOOK_OUT',
        method: 'POST',
        url: config.url,
        headers,
        body: mapped.values,
        signed,
      },
      warnings,
    };
  }
}

/** Map a resolved terminal token to the dry-run `endState` (defensive default STOP_FAIL). */
function terminalToEndState(terminal: string): DryRunEndState {
  switch (terminal) {
    case WORKFLOW_END_SUCCESS:
      return 'END_SUCCESS';
    case WORKFLOW_ESCALATE_TO_MANUAL:
      return 'ESCALATE_TO_MANUAL';
    case WORKFLOW_COMPENSATE:
      return 'COMPENSATE';
    case WORKFLOW_STOP_FAIL:
    default:
      return 'STOP_FAIL';
  }
}

/**
 * Build the REDACTED auth header preview for a REST connection — a `‹secret:label›` placeholder in
 * place of the real credential (INV-6). Never reveals the secret; surfaces a non-secret warning when a
 * scheme needs a credential that is not configured.
 */
function restAuthPreview(
  config: RestConnectionConfig,
  secretLabel: string | null,
): { headers: Record<string, string>; warnings: string[] } {
  const scheme = config.authScheme;
  if (scheme === 'NONE') {
    return { headers: {}, warnings: [] };
  }
  const warnings = secretLabel
    ? []
    : [
        `Auth scheme ${scheme} requires a credential, but none is configured on this connection — the live run would fail.`,
      ];
  const placeholder = secretPlaceholder(secretLabel);
  switch (scheme) {
    case 'BEARER':
      return { headers: { authorization: `Bearer ${placeholder}` }, warnings };
    case 'BASIC':
      return { headers: { authorization: `Basic ${placeholder}` }, warnings };
    case 'HEADER': {
      const name = config.authHeaderName?.trim();
      if (!name) {
        return {
          headers: {},
          warnings: [
            'Auth scheme HEADER requires authHeaderName in the connection config.',
          ],
        };
      }
      return { headers: { [name]: placeholder }, warnings };
    }
    default:
      return { headers: {}, warnings };
  }
}

/** The INV-6 placeholder a secret-backed value is shown as — never the real credential. */
function secretPlaceholder(label: string | null): string {
  return label ? `‹secret:${label}›` : '‹secret:not-configured›';
}

/** Strip CR/LF + control chars from a previewed header value (mirrors the handler's hardening). */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, '');
}
