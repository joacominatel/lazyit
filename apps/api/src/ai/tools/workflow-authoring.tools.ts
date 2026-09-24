import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import {
  ManualConnectionConfigSchema,
  RestConnectionConfigSchema,
  WebhookOutConnectionConfigSchema,
  WorkflowDeprovisionPolicySchema,
  WorkflowStepsSchema,
  WorkflowTriggerV1Schema,
  type AiActionPreview,
  type AiEntityRef,
  type AiPreviewWarningCode,
  type WorkflowStep,
} from '@lazyit/shared';
import { ApplicationsController } from '../../applications/applications.controller';
import { assertUrlAllowed, EgressError } from '../../common/egress';
import { ConfigController } from '../../config/config.controller';
import { WorkflowConnectionsController } from '../../workflow-engine/definitions/workflow-connections.controller';
import { WorkflowsController } from '../../workflow-engine/definitions/workflows.controller';
import { WorkflowDryRunController } from '../../workflow-engine/dry-run/workflow-dry-run.controller';
import { assertChannelAllows } from '../core/pending-action';
import type { AiResolvedReference } from '../core/reference-resolver';
import { untrusted } from '../core/result-shaper';
import {
  bind,
  defineTool,
  type AiToolPreview,
  type AiToolRuntime,
  type AiToolset,
} from '../core/tool-descriptor';
import {
  asRow,
  asRows,
  exactOnPage,
  isCuidId,
  iso,
  RESOLVE_PAGE,
  str,
  type Row,
} from './reference.tools';

/**
 * The WORKFLOW AUTHORING toolset (W2-14; tools-and-execution.md §7 "Workflow engine" rows W10–W17, §9;
 * security.md §6.9, T-40..T-42; ADR-0097 decision 3 as amended 2026-09-24): creating and changing workflows
 * and their versions, connections (incl. the connection test), and enabling or disabling a workflow, whose
 * preview embeds the dry-run.
 *
 * This is the highest-risk toolset of the catalog: a connection plus an enabled workflow is a persistent
 * outbound channel that fires on every future grant (T-40). What bounds it here:
 *
 *   - CHAT ONLY. Every tool is `elevated` and declares `channels: ['CHAT']`; core refuses to propose on any
 *     other channel and a Service Account never proposes. Each tool re-checks it in `preview` and `run`
 *     (defence in depth): MCP and headless authoring are deferred (#1344) and a Service Account never
 *     authors, connects or enables a workflow.
 *   - A plain-language, server-built card. Every preview says what the automation will do in words
 *     ("every time someone is granted access to Jira, lazyit will send … to https://…"), lists every
 *     outbound host and every mapped field → token, shows old → new host on a re-point, and names the
 *     default headers that would follow a re-point (their values are never shown).
 *   - `OUTBOUND_INTEGRATION` when a connection is created, its host / URL / credential reference changes,
 *     a version is authored on an enabled workflow, or a workflow is enabled (no step-up by itself, CEO).
 *     Every connection write carries it. `CRITICAL_APPLICATION` on every write on an `isCritical`
 *     application (core requires the password step-up; `assertChannelAllows` is called in `run` too).
 *     Every workflow write also carries the trigger's `EXTERNAL_PROVISIONING` / `EXTERNAL_DEPROVISIONING`.
 *   - Disabled first. `workflow_create` always creates the workflow disabled (the input has no `enabled`).
 *     Enabling is `workflow_set_enabled`, whose preview runs the dry-run route against a named sample grant
 *     and shows exactly what would be sent where; the card is not shown when the dry-run fails.
 *   - The egress guard, before the card. A destination the runtime guard would refuse (not HTTPS, a
 *     private, loopback, link-local or metadata address, a name that does not resolve) fails the proposal
 *     with the reason; the guard itself still applies at execution (it is never bypassed).
 *   - Secrets by reference only. A credential is attached by id (the route enforces `workflow:secrets`,
 *     CSEC-1); no tool reads, creates or rotates a secret, and results say only "credential configured".
 *     Connection `defaultHeaders` are neither settable nor echoed: only their NAMES appear.
 *   - STALE on any change. Every preview names the application as its target and anchors the precondition
 *     on the latest of the application's, the workflow's, its latest version's and the involved
 *     connections' timestamps — so a change to anything the card showed, including the application being
 *     marked critical, refuses the approval as STALE.
 *
 * Other-authored text in RESULTS (names, descriptions, prompts, templates, run advisories) goes through
 * `untrusted()`. Previews are rendered to a person on the card, never to the model, and carry the plain
 * values.
 *
 * The standalone dry-run (row W17) is folded into `workflow_set_enabled`: a dry-run changes nothing, so an
 * `elevated` approval card for it would carry no honest warning. `executedAsServiceAccountId` (row W12) is
 * not exposed: the route accepts only the engine Service Account, which is already the default (CSEC-3).
 */

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────────

type Change = AiActionPreview['changes'][number];

const TRIGGER_WORDS: Record<string, string> = {
  ACCESS_GRANTED: 'granted access to',
  ACCESS_REVOKED: 'has their access revoked from',
};

function triggerLabel(trigger: unknown): string {
  return trigger === 'ACCESS_REVOKED'
    ? 'on access revoked'
    : 'on access granted';
}

/** "every time someone is granted access to Jira". */
function whenSentence(trigger: unknown, appName: string): string {
  return `every time someone is ${TRIGGER_WORDS[String(trigger)] ?? 'granted access to'} ${appName}`;
}

/** The provisioning warning of a workflow's trigger. */
function triggerWarning(trigger: unknown): AiPreviewWarningCode {
  return trigger === 'ACCESS_REVOKED'
    ? 'EXTERNAL_DEPROVISIONING'
    : 'EXTERNAL_PROVISIONING';
}

/** The latest of several timestamps, as ISO-8601: the STALE anchor (see the file comment). */
function anchorOf(...values: unknown[]): string {
  let latest = 0;
  for (const value of values) {
    const text = iso(value);
    const time = typeof text === 'string' ? Date.parse(text) : NaN;
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  if (latest === 0) {
    throw new Error('No timestamp to anchor the precondition on');
  }
  return new Date(latest).toISOString();
}

/**
 * The origin a URL sends to (`https://host[:port]`) — never userinfo, a path or a query, which can carry
 * a credential. `null` when it does not parse.
 */
function originOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A URL for display: origin + path, and the query's parameter NAMES only (values may be credentials). */
function displayUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    const names = [...parsed.searchParams.keys()];
    return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}${
      names.length > 0 ? `?${names.map((n) => `${n}=…`).join('&')}` : ''
    }`;
  } catch {
    return null;
  }
}

/** Where a connection sends: `baseUrl` (REST), `url` (WEBHOOK_OUT), none (MANUAL). */
function endpointOf(config: unknown): string | null {
  const c = asRow(config);
  if (c.kind === 'REST') return str(c.baseUrl);
  if (c.kind === 'WEBHOOK_OUT') return str(c.url);
  return null;
}

/** The names (never the values) of a connection's default headers. */
function headerNames(config: unknown): string[] {
  const headers = asRow(asRow(config).defaultHeaders);
  return Object.keys(headers).sort();
}

const EGRESS_REASONS: Record<string, string> = {
  'invalid-url': 'it is not a valid URL',
  'scheme-not-allowed': 'only https:// destinations are allowed',
  'empty-host': 'it has no host',
  'dns-resolution-failed': 'its host name does not resolve',
  'blocked-address':
    'it points at a private, loopback, link-local or cloud-metadata address',
};

/**
 * Flag a destination the runtime egress guard would refuse BEFORE a card is shown (security.md §6.9). The
 * same guard (`assertUrlAllowed`, public HTTPS only in v1, no internal allowlist) runs again at execution,
 * so this never replaces it.
 */
async function assertEgressAllowed(url: string): Promise<void> {
  try {
    await assertUrlAllowed(url);
  } catch (err) {
    if (err instanceof EgressError) {
      throw new BadRequestException(
        `lazyit would refuse to send to ${originOf(url) ?? 'this destination'}: ${
          EGRESS_REASONS[err.reason] ?? err.reason
        }. In this version workflows reach public HTTPS destinations only.`,
      );
    }
    throw err;
  }
}

/** Authoring is chat-only and human-only; core already enforces it — this is the tool's own check. */
function assertChatHuman(rt: AiToolRuntime): void {
  if (rt.ctx.channel !== 'CHAT' || rt.ctx.identity.kind !== 'human') {
    throw new ForbiddenException(
      'Workflow authoring happens only in the lazyit chat, confirmed by a person.',
    );
  }
}

/**
 * Before any side effect: the chat/human check, and the channel refusal core lists for critical
 * applications (a no-op in the chat, where step-up applies instead).
 */
function assertMayRun(rt: AiToolRuntime, app: Row): void {
  assertChatHuman(rt);
  if (app.isCritical === true) {
    assertChannelAllows(rt.ctx.channel, ['CRITICAL_APPLICATION']);
  }
}

// ─── Mapped data: what leaves lazyit, in words ───────────────────────────────────────────────────

const TOKEN_WORDS: Record<string, string> = {
  event: 'the event name',
  'grantee.id': "the person's lazyit id",
  'grantee.email': "the person's email",
  'grantee.firstName': "the person's first name",
  'grantee.lastName': "the person's last name",
  'grantee.legajo': "the person's employee number",
  'grantee.username': "the person's username",
  'grantee.manager.name': "the person's manager's name",
  'grantee.manager.email': "the person's manager's email",
  'grantee.manager.isOffboarded': "whether the person's manager left",
  'application.id': "the application's lazyit id",
  'application.name': "the application's name",
  'grant.id': "the access grant's lazyit id",
  'grant.accessLevel': 'the access level',
  'grant.grantedAt': 'when access was granted',
  'grant.expiresAt': 'when access expires',
};

const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;

/** The context paths a template reads (filters after `|` dropped). */
function tokensOf(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const path = match[1].split('|')[0].trim();
    if (path) out.push(path);
  }
  return out;
}

function tokenWords(path: string): string {
  if (TOKEN_WORDS[path]) return TOKEN_WORDS[path];
  if (path.startsWith('steps.')) {
    const [, step] = path.split('.');
    return `a value returned by the earlier step "${step ?? '?'}"`;
  }
  return 'an unknown value (renders empty)';
}

/** "email ← {{ grantee.email }} (the person's email)" per mapped field; literals say so. */
function mappingLines(mapping: Record<string, string> | undefined): string[] {
  return Object.entries(mapping ?? {}).map(([field, template]) => {
    const tokens = tokensOf(template);
    const words =
      tokens.length > 0
        ? tokens.map(tokenWords).join(', ')
        : 'a fixed text, no lazyit data';
    return `${field} ← ${template} (${words})`;
  });
}

/** The distinct lazyit data a set of steps sends out, in words. */
function dataSentWords(steps: readonly WorkflowStep[]): string[] {
  const words = new Set<string>();
  for (const step of steps) {
    if (step.kind === 'MANUAL') continue;
    const templates = [
      ...Object.values(step.dataMapping ?? {}),
      ...(step.kind === 'REST' ? [step.path] : []),
    ];
    for (const template of templates) {
      for (const token of tokensOf(template)) words.add(tokenWords(token));
    }
  }
  return [...words];
}

// ─── Reads through bound, guarded handlers ────────────────────────────────────────────────────────

const applicationRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('The application: its id or its exact name.');

/** Resolve an application by id or exact name through the guarded list route. */
function resolveApplication(
  rt: AiToolRuntime,
  reference: string,
): Promise<AiResolvedReference> {
  return rt.resolve({
    type: 'application',
    reference,
    isId: isCuidId,
    lookup: async (name) => {
      const page = asRow(
        await rt.call(ApplicationsController, 'findAll', {
          query: { q: name, limit: RESOLVE_PAGE },
        }),
      );
      const wanted = name.trim().toLowerCase();
      return exactOnPage(
        { items: page.items, total: page.total },
        (row) => str(row.name)?.trim().toLowerCase() === wanted,
        name,
        'name the application by id',
      ).map((row) => ({ id: String(row.id), label: String(row.name) }));
    },
  });
}

/** The live application row (404 when missing or archived), read as the caller. */
async function readApplication(rt: AiToolRuntime, id: string): Promise<Row> {
  return asRow(
    await rt.call(ApplicationsController, 'findOne', { params: { id } }),
  );
}

function appName(app: Row): string {
  return str(app.name) ?? String(app.id);
}

/** The application every preview targets: the page that hosts its workflows and connections. */
function appTarget(app: Row, label?: string): AiEntityRef {
  return {
    type: 'application',
    id: String(app.id),
    op: 'updated',
    label: label ?? appName(app),
  };
}

const workflowRef = z
  .union([
    z.strictObject({
      id: z.cuid().describe('The workflow id.'),
    }),
    z.strictObject({
      application: applicationRef,
      trigger: WorkflowTriggerV1Schema.describe(
        'Which of the application’s two workflows: ACCESS_GRANTED or ACCESS_REVOKED.',
      ),
    }),
  ])
  .describe(
    'The workflow: { id } or { application, trigger } (an application has at most one workflow per trigger).',
  );
type WorkflowRefInput = z.output<typeof workflowRef>;

interface WorkflowState {
  workflow: Row;
  app: Row;
  /** The latest version (null before the first one), with its steps. */
  latest: Row | null;
  steps: WorkflowStep[];
}

/** Resolve and read a workflow, its latest version and its application — all through guarded routes. */
async function readWorkflow(
  rt: AiToolRuntime,
  ref: WorkflowRefInput,
): Promise<WorkflowState> {
  let id: string;
  if ('id' in ref) {
    id = ref.id;
  } else {
    const app = await resolveApplication(rt, ref.application);
    const page = asRow(
      await rt.call(WorkflowsController, 'findAll', {
        query: { applicationId: app.id, limit: RESOLVE_PAGE },
      }),
    );
    const match = asRows(page.items).find((w) => w.trigger === ref.trigger);
    if (!match) {
      throw new BadRequestException(
        `${app.label ?? app.id} has no ${triggerLabel(ref.trigger)} workflow; create it with workflow_create.`,
      );
    }
    id = String(match.id);
  }
  const workflow = asRow(
    await rt.call(WorkflowsController, 'findOne', { params: { id } }),
  );
  const app = await readApplication(rt, String(workflow.applicationId));
  const latest =
    workflow.latestVersion && typeof workflow.latestVersion === 'object'
      ? asRow(workflow.latestVersion)
      : null;
  // A stored version is read tolerantly: a legacy graph that no longer parses shows no steps.
  const parsed = WorkflowStepsSchema.safeParse(latest?.steps);
  return {
    workflow,
    app,
    latest,
    steps: parsed.success ? parsed.data : [],
  };
}

function workflowLabel(workflow: Row, app: Row): string {
  return `Workflow "${str(workflow.name) ?? String(workflow.id)}" (${appName(app)}, ${triggerLabel(workflow.trigger)})`;
}

/** A connection by id, read as the caller (404 when missing or archived). */
async function readConnection(rt: AiToolRuntime, id: string): Promise<Row> {
  return asRow(
    await rt.call(WorkflowConnectionsController, 'findOne', { params: { id } }),
  );
}

/** The connections a set of steps calls, by id — read once each. */
async function readStepConnections(
  rt: AiToolRuntime,
  steps: readonly WorkflowStep[],
): Promise<Map<string, Row>> {
  const ids = new Set<string>();
  for (const step of steps) {
    if (step.kind !== 'MANUAL') ids.add(step.connectionId);
  }
  const out = new Map<string, Row>();
  for (const id of ids) out.set(id, await readConnection(rt, id));
  return out;
}

function connectionLabel(connection: Row): string {
  return `Connection "${str(connection.name) ?? String(connection.id)}" (${String(connection.kind)})`;
}

/** A connection as a RESULT shows it: the host, whether a credential is configured, header names only. */
function connectionSummary(connection: Row): Row {
  const config = asRow(connection.config);
  return {
    id: connection.id,
    applicationId: connection.applicationId,
    kind: connection.kind,
    name: untrusted(str(connection.name)),
    destination: displayUrl(endpointOf(config)),
    authScheme: config.kind === 'REST' ? (config.authScheme ?? 'NONE') : null,
    defaultHeaderNames: headerNames(config),
    credentialConfigured:
      connection.secretId !== null && connection.secretId !== undefined,
  };
}

function workflowSummary(workflow: Row): Row {
  return {
    id: workflow.id,
    applicationId: workflow.applicationId,
    trigger: workflow.trigger,
    name: untrusted(str(workflow.name)),
    description: untrusted(str(workflow.description)),
    enabled: workflow.enabled,
    deprovisionPolicy: workflow.deprovisionPolicy,
  };
}

// ─── Describing a step graph ──────────────────────────────────────────────────────────────────────

interface GraphDescription {
  /** Distinct outbound origins, in step order. */
  hosts: string[];
  /** Every destination a step sends to (for the egress check). */
  urls: string[];
  /** One line per step, in plain words. */
  stepLines: string[];
  /** "field ← token (words)" per mapped field, per destination. */
  sends: string[];
}

function describeGraph(
  steps: readonly WorkflowStep[],
  connections: Map<string, Row>,
): GraphDescription {
  const hosts: string[] = [];
  const urls: string[] = [];
  const stepLines: string[] = [];
  const sends: string[] = [];
  steps.forEach((step, index) => {
    const n = `${index + 1}. ${step.name ?? step.key}`;
    if (step.kind === 'MANUAL') {
      stepLines.push(`${n}: pauses and asks a person: "${step.prompt}"`);
      return;
    }
    const connection = connections.get(step.connectionId) ?? {};
    const config = asRow(connection.config);
    const endpoint = endpointOf(config);
    const origin = originOf(endpoint) ?? '(unknown destination)';
    if (!hosts.includes(origin)) hosts.push(origin);
    if (endpoint) urls.push(endpoint);
    const target =
      step.kind === 'REST'
        ? `${step.method} ${displayUrl(endpoint) ?? origin} + path ${step.path}`
        : `POST ${displayUrl(endpoint) ?? origin} (webhook)`;
    const fields = Object.keys(step.dataMapping ?? {});
    stepLines.push(
      `${n}: ${target}${fields.length > 0 ? `, sending ${fields.join(', ')}` : ''}`,
    );
    const lines = mappingLines(step.dataMapping);
    if (step.kind === 'REST' && tokensOf(step.path).length > 0) {
      lines.unshift(
        `URL path ← ${step.path} (${tokensOf(step.path).map(tokenWords).join(', ')})`,
      );
    }
    for (const line of lines) sends.push(`${origin}: ${line}`);
    const credential = connection.secretId
      ? 'with its stored credential'
      : null;
    const headers = headerNames(config);
    if (credential || headers.length > 0) {
      sends.push(
        `${origin}: ${[
          credential,
          headers.length > 0 ? `default headers ${headers.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('; ')}`,
      );
    }
  });
  return { hosts, urls, stepLines, sends };
}

/** "…, lazyit will send the person's email, … to https://a, https://b." */
function outboundSentence(
  trigger: unknown,
  app: Row,
  steps: readonly WorkflowStep[],
  hosts: string[],
): string {
  const when = whenSentence(trigger, appName(app));
  if (hosts.length === 0) {
    return `${when[0].toUpperCase()}${when.slice(1)}, lazyit will only create manual tasks; nothing is sent outside lazyit.`;
  }
  const data = dataSentWords(steps);
  return `${when[0].toUpperCase()}${when.slice(1)}, lazyit will send ${
    data.length > 0 ? data.join(', ') : 'requests with no lazyit data'
  } to ${hosts.join(', ')}.`;
}

// ─── The preview skeleton ─────────────────────────────────────────────────────────────────────────

function previewOf(parts: {
  app: Row;
  targetLabel: string;
  anchor: string;
  changes: Change[];
  warnings: Iterable<AiPreviewWarningCode>;
}): AiToolPreview {
  const warnings = new Set(parts.warnings);
  // Every write on a critical application (CEO: "Toda escritura"): core derives the step-up from it.
  if (parts.app.isCritical === true) warnings.add('CRITICAL_APPLICATION');
  const target = appTarget(parts.app, parts.targetLabel);
  return {
    target,
    changes: parts.changes,
    warnings: [...warnings],
    impacted: [],
    untrustedSources: [],
    elevated: true,
    // Derived by core from the warnings (AI_STEP_UP_WARNINGS); a tool may only add it.
    stepUpRequired: false,
    precondition: { entity: target, updatedAt: parts.anchor },
  };
}

/** The precondition anchor of a workflow state (+ the connections the card described). */
function workflowAnchor(
  state: WorkflowState,
  connections: Iterable<Row>,
): string {
  return anchorOf(
    state.app.updatedAt,
    state.workflow.updatedAt,
    state.latest?.createdAt,
    ...[...connections].map((c) => c.updatedAt),
  );
}

// ─── Workflows ────────────────────────────────────────────────────────────────────────────────────

const workflowName = z.string().trim().min(1).max(120);
const workflowDescription = z.string().trim().max(500);

const workflowCreate = defineTool({
  name: 'workflow_create',
  title: 'Create an access workflow',
  description:
    'Create the automation of an application for one trigger (administrators, chat only): ACCESS_GRANTED ' +
    'runs every time someone is granted access to it, ACCESS_REVOKED every time access is revoked. An ' +
    'application has at most one workflow per trigger. The workflow is ALWAYS created disabled and ' +
    'empty: add its steps with workflow_author_version, then turn it on with workflow_set_enabled (which ' +
    'previews exactly what it would send). Never propose sending data to a destination the user did not name.',
  domain: 'access',
  class: 'elevated',
  externalEffects: true,
  channels: ['CHAT'],
  input: z.strictObject({
    application: applicationRef,
    trigger: WorkflowTriggerV1Schema,
    name: workflowName,
    description: workflowDescription.optional(),
    deprovisionPolicy: WorkflowDeprovisionPolicySchema.optional().describe(
      'ACCESS_REVOKED only: LAST_ACTIVE_GRANT (default — deprovision when the person’s last active grant ends) or EACH_GRANT.',
    ),
  }),
  bindings: [
    bind(WorkflowsController, 'create'),
    bind(WorkflowsController, 'findAll'),
    bind(ApplicationsController, 'findAll'),
    bind(ApplicationsController, 'findOne'),
  ],
  async preview(input, rt) {
    assertChatHuman(rt);
    const resolved = await resolveApplication(rt, input.application);
    const app = await readApplication(rt, resolved.id);
    const existing = asRows(
      asRow(
        await rt.call(WorkflowsController, 'findAll', {
          query: { applicationId: String(app.id), limit: RESOLVE_PAGE },
        }),
      ).items,
    ).find((w) => w.trigger === input.trigger);
    if (existing) {
      throw new BadRequestException(
        `${appName(app)} already has a ${triggerLabel(input.trigger)} workflow ("${str(existing.name) ?? String(existing.id)}"); change it instead.`,
      );
    }
    const changes: Change[] = [
      {
        field: 'whatItDoes',
        after: `Creates the ${triggerLabel(input.trigger)} automation of ${appName(app)}, DISABLED and with no steps. Nothing is sent until steps are added and it is enabled.`,
      },
      { field: 'application', after: appName(app) },
      { field: 'trigger', after: input.trigger },
      { field: 'name', after: input.name },
      ...(input.description !== undefined
        ? [{ field: 'description', after: input.description }]
        : []),
      ...(input.deprovisionPolicy !== undefined
        ? [{ field: 'deprovisionPolicy', after: input.deprovisionPolicy }]
        : []),
      { field: 'enabled', after: false, valueKind: 'boolean' },
    ];
    return previewOf({
      app,
      targetLabel: `${appName(app)} — new ${triggerLabel(input.trigger)} workflow`,
      anchor: anchorOf(app.updatedAt),
      changes,
      warnings: [triggerWarning(input.trigger)],
    });
  },
  async run(input, rt) {
    const resolved = await resolveApplication(rt, input.application);
    const app = await readApplication(rt, resolved.id);
    assertMayRun(rt, app);
    const created = asRow(
      await rt.call(WorkflowsController, 'create', {
        body: {
          applicationId: String(app.id),
          trigger: input.trigger,
          name: input.name,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.deprovisionPolicy !== undefined
            ? { deprovisionPolicy: input.deprovisionPolicy }
            : {}),
          // Disabled first (ADR-0097 decision 3 as amended): never taken from the model.
          enabled: false,
        },
      }),
    );
    return {
      data: {
        workflow: workflowSummary(created),
        next: 'It is disabled and has no steps: add them with workflow_author_version, then enable it with workflow_set_enabled.',
      },
      summary: `Created the ${triggerLabel(input.trigger)} workflow of ${appName(app)} (disabled).`,
      entityRefs: [appTarget(app)],
    };
  },
});

const workflowUpdate = defineTool({
  name: 'workflow_update',
  title: 'Rename or re-configure a workflow',
  description:
    'Change a workflow’s name, description or deprovision policy (administrators, chat only). To turn it ' +
    'on or off use workflow_set_enabled; to change its steps use workflow_author_version.',
  domain: 'access',
  class: 'elevated',
  externalEffects: true,
  channels: ['CHAT'],
  input: z
    .strictObject({
      workflow: workflowRef,
      name: workflowName.optional(),
      description: workflowDescription.nullable().optional(),
      deprovisionPolicy: WorkflowDeprovisionPolicySchema.optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.description !== undefined ||
        v.deprovisionPolicy !== undefined,
      { message: 'Name at least one field to change.' },
    ),
  bindings: [
    bind(WorkflowsController, 'update'),
    bind(WorkflowsController, 'findOne'),
    bind(WorkflowsController, 'findAll'),
    bind(ApplicationsController, 'findAll'),
    bind(ApplicationsController, 'findOne'),
  ],
  async preview(input, rt) {
    assertChatHuman(rt);
    const state = await readWorkflow(rt, input.workflow);
    const { workflow, app } = state;
    const changes: Change[] = [];
    for (const field of ['name', 'description', 'deprovisionPolicy'] as const) {
      const after = input[field];
      if (after !== undefined && after !== (workflow[field] ?? null)) {
        changes.push({ field, before: workflow[field] ?? null, after });
      }
    }
    if (changes.length === 0) {
      throw new BadRequestException(
        'Nothing to change: every value given already matches the workflow.',
      );
    }
    return previewOf({
      app,
      targetLabel: workflowLabel(workflow, app),
      anchor: workflowAnchor(state, []),
      changes,
      warnings: [triggerWarning(workflow.trigger)],
    });
  },
  async run(input, rt) {
    const { workflow, app } = await readWorkflow(rt, input.workflow);
    assertMayRun(rt, app);
    const body: Row = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.description !== undefined) body.description = input.description;
    if (input.deprovisionPolicy !== undefined) {
      body.deprovisionPolicy = input.deprovisionPolicy;
    }
    const updated = asRow(
      await rt.call(WorkflowsController, 'update', {
        params: { id: String(workflow.id) },
        body,
      }),
    );
    return {
      data: { workflow: workflowSummary(updated) },
      summary: `Updated the ${triggerLabel(workflow.trigger)} workflow of ${appName(app)}.`,
      entityRefs: [appTarget(app)],
    };
  },
});

const workflowArchive = defineTool({
  name: 'workflow_archive',
  title: 'Archive a workflow',
  description:
    'Archive (soft-delete) a workflow (administrators, chat only): it stops running on future grants and ' +
    'frees the application’s slot for that trigger. Its runs stay in the history. lazyit has no restore ' +
    'for it: to automate again, create a new workflow.',
  domain: 'access',
  class: 'elevated',
  destructive: true,
  externalEffects: true,
  channels: ['CHAT'],
  input: z.strictObject({ workflow: workflowRef }),
  bindings: [
    bind(WorkflowsController, 'remove'),
    bind(WorkflowsController, 'findOne'),
    bind(WorkflowsController, 'findAll'),
    bind(ApplicationsController, 'findAll'),
    bind(ApplicationsController, 'findOne'),
  ],
  async preview(input, rt) {
    assertChatHuman(rt);
    const state = await readWorkflow(rt, input.workflow);
    const { workflow, app } = state;
    return previewOf({
      app,
      targetLabel: workflowLabel(workflow, app),
      anchor: workflowAnchor(state, []),
      changes: [
        {
          field: 'whatItDoes',
          after: `Archives this workflow: from now on nothing runs ${whenSentence(workflow.trigger, appName(app))}. It cannot be restored from lazyit.`,
        },
        { field: 'status', before: 'active', after: 'archived' },
        {
          field: 'enabled',
          before: workflow.enabled === true,
          after: false,
          valueKind: 'boolean',
        },
      ],
      warnings: [
        'SOFT_DELETE',
        'IRREVERSIBLE',
        triggerWarning(workflow.trigger),
      ],
    });
  },
  async run(input, rt) {
    const { workflow, app } = await readWorkflow(rt, input.workflow);
    assertMayRun(rt, app);
    await rt.call(WorkflowsController, 'remove', {
      params: { id: String(workflow.id) },
    });
    return {
      data: { workflowId: workflow.id, archived: true },
      summary: `Archived the ${triggerLabel(workflow.trigger)} workflow of ${appName(app)}.`,
      entityRefs: [appTarget(app)],
    };
  },
});

const workflowAuthorVersion = defineTool({
  name: 'workflow_author_version',
  title: 'Save a workflow’s steps',
  description:
    'Save a new version of a workflow’s steps (administrators, chat only). The steps replace the whole ' +
    'graph; the latest version is the one that runs, so on an ENABLED workflow it is live immediately. ' +
    'REST and WEBHOOK_OUT steps call a connection of the same application (by id — create one with ' +
    'workflow_connection_create); a MANUAL step pauses the run and asks a person. A `dataMapping` maps ' +
    'each outgoing field to a template over the event: {{ grantee.email }}, {{ grantee.firstName }}, ' +
    '{{ grantee.lastName }}, {{ grantee.username }}, {{ grantee.legajo }}, {{ grantee.manager.name }}, ' +
    '{{ grantee.manager.email }}, {{ application.name }}, {{ grant.accessLevel }}, {{ grant.expiresAt }}, ' +
    '{{ steps.<key>.<field> }}. Steps run in order unless onSuccess / onFailure name another step key or ' +
    'END_SUCCESS / STOP_FAIL / ESCALATE_TO_MANUAL / COMPENSATE. Map only the data the user asked to send.',
  domain: 'access',
  class: 'elevated',
  externalEffects: true,
  channels: ['CHAT'],
  input: z.strictObject({
    workflow: workflowRef,
    steps: WorkflowStepsSchema,
  }),
  bindings: [
    bind(WorkflowsController, 'authorVersion'),
    bind(WorkflowsController, 'findOne'),
    bind(WorkflowsController, 'findAll'),
    bind(WorkflowConnectionsController, 'findOne'),
    bind(ApplicationsController, 'findAll'),
    bind(ApplicationsController, 'findOne'),
  ],
  async preview(input, rt) {
    assertChatHuman(rt);
    const state = await readWorkflow(rt, input.workflow);
    const { workflow, app } = state;
    const connections = await readStepConnections(rt, input.steps);
    for (const [id, connection] of connections) {
      if (connection.applicationId !== app.id) {
        throw new BadRequestException(
          `Connection ${id} belongs to another application; a workflow may only call its own application’s connections.`,
        );
      }
    }
    const next = describeGraph(input.steps, connections);
    for (const url of next.urls) await assertEgressAllowed(url);
    const previousConnections = await readStepConnections(rt, state.steps);
    const previous = describeGraph(state.steps, previousConnections);

    const enabled = workflow.enabled === true;
    const version =
      typeof state.latest?.version === 'number' ? state.latest.version : 0;
    const changes: Change[] = [
      {
        field: 'whatItDoes',
        after:
          outboundSentence(workflow.trigger, app, input.steps, next.hosts) +
          (enabled
            ? ' The workflow is ENABLED: this version is live as soon as it is saved.'
            : ' The workflow is disabled: nothing runs until it is enabled.'),
      },
      { field: 'version', before: version || null, after: version + 1 },
      {
        field: 'outboundHosts',
        ...(state.latest ? { before: previous.hosts } : {}),
        after: next.hosts,
      },
      {
        field: 'steps',
        ...(state.latest ? { before: previous.stepLines } : {}),
        after: next.stepLines,
      },
      { field: 'dataSent', after: next.sends },
    ];
    const warnings: AiPreviewWarningCode[] = [triggerWarning(workflow.trigger)];
    if (enabled) warnings.push('OUTBOUND_INTEGRATION');
    return previewOf({
      app,
      targetLabel: workflowLabel(workflow, app),
      anchor: workflowAnchor(state, [
        ...connections.values(),
        ...previousConnections.values(),
      ]),
      changes,
      warnings,
    });
  },
  async run(input, rt) {
    const { workflow, app } = await readWorkflow(rt, input.workflow);
    assertMayRun(rt, app);
    const version = asRow(
      await rt.call(WorkflowsController, 'authorVersion', {
        params: { id: String(workflow.id) },
        body: { steps: input.steps },
      }),
    );
    return {
      data: {
        workflowId: workflow.id,
        version: version.version,
        steps: input.steps.length,
        enabled: workflow.enabled === true,
        ...(workflow.enabled === true
          ? {}
          : {
              next: 'The workflow is disabled: enable it with workflow_set_enabled (its preview dry-runs it against a sample grant).',
            }),
      },
      summary: `Saved version ${String(version.version)} of the ${triggerLabel(workflow.trigger)} workflow of ${appName(app)}${
        workflow.enabled === true ? ' (live now)' : ''
      }.`,
      entityRefs: [appTarget(app)],
    };
  },
});

/** A dry-run step as the ENABLE card shows it: the real request, header NAMES only. */
function dryRunLines(dry: Row): string[] {
  const lines: string[] = [];
  for (const raw of asRows(dry.steps)) {
    const n = `${Number(raw.stepIndex) + 1}. ${str(raw.name) ?? String(raw.stepKey)}`;
    const request = raw.request ? asRow(raw.request) : null;
    const manual = raw.manual ? asRow(raw.manual) : null;
    if (request) {
      const body = asRow(request.body);
      const headers = Object.keys(asRow(request.headers)).sort();
      lines.push(
        `${n}: ${String(request.method)} ${displayUrl(request.url) ?? '(unknown)'}` +
          (Object.keys(body).length > 0
            ? ` — body ${JSON.stringify(body)}`
            : ' — no body') +
          (headers.length > 0 ? ` — headers ${headers.join(', ')}` : '') +
          (request.signed === true ? ' — signed' : ''),
      );
    } else if (manual) {
      lines.push(`${n}: pauses and asks a person: "${String(manual.prompt)}"`);
    } else {
      lines.push(`${n}: ${String(raw.status)}`);
    }
    for (const advisory of Array.isArray(raw.warnings) ? raw.warnings : []) {
      lines.push(`   ⚠ ${String(advisory)}`);
    }
  }
  lines.push(
    `Ends: ${String(dry.endState)}${dry.wouldPause === true ? ' (pauses for a person)' : ''}`,
  );
  return lines;
}

function sampleLabel(dry: Row): string {
  const context = asRow(dry.context);
  const grantee = asRow(context.grantee);
  const grant = asRow(context.grant);
  const name = [str(grantee.firstName), str(grantee.lastName)]
    .filter(Boolean)
    .join(' ');
  return `${name} <${str(grantee.email) ?? '?'}> — access level ${str(grant.accessLevel) ?? 'none'} (grant ${String(dry.sampleAccessGrantId)})`;
}

const workflowSetEnabled = defineTool({
  name: 'workflow_set_enabled',
  title: 'Turn a workflow on or off',
  description:
    'Enable or disable a workflow (administrators, chat only). Enabling makes it run on every future ' +
    'grant (or revoke) of the application, so it needs `sampleAccessGrantId`: an existing access grant of ' +
    'that application (find one with access_grant_list). The approval card dry-runs the workflow against ' +
    'that grant and shows exactly what would be sent where; nothing is sent by the dry-run. Disabling ' +
    'needs no sample.',
  domain: 'access',
  class: 'elevated',
  externalEffects: true,
  channels: ['CHAT'],
  input: z
    .strictObject({
      workflow: workflowRef,
      enabled: z.boolean(),
      sampleAccessGrantId: z
        .cuid()
        .optional()
        .describe(
          'Enabling only: the access grant the card dry-runs the workflow against.',
        ),
    })
    .refine((v) => !v.enabled || v.sampleAccessGrantId !== undefined, {
      message:
        'Enabling needs sampleAccessGrantId: the card dry-runs the workflow against that grant.',
      path: ['sampleAccessGrantId'],
    }),
  bindings: [
    bind(WorkflowsController, 'update'),
    bind(WorkflowsController, 'findOne'),
    bind(WorkflowsController, 'findAll'),
    bind(WorkflowDryRunController, 'run'),
    bind(WorkflowConnectionsController, 'findOne'),
    bind(ApplicationsController, 'findAll'),
    bind(ApplicationsController, 'findOne'),
  ],
  async preview(input, rt) {
    assertChatHuman(rt);
    const state = await readWorkflow(rt, input.workflow);
    const { workflow, app } = state;
    const current = workflow.enabled === true;
    if (current === input.enabled) {
      throw new BadRequestException(
        `The workflow is already ${current ? 'enabled' : 'disabled'}.`,
      );
    }
    const label = workflowLabel(workflow, app);
    if (!input.enabled) {
      return previewOf({
        app,
        targetLabel: label,
        anchor: workflowAnchor(state, []),
        changes: [
          {
            field: 'whatItDoes',
            after: `Turns the workflow off: from now on nothing runs ${whenSentence(workflow.trigger, appName(app))}. Runs already started finish.`,
          },
          {
            field: 'enabled',
            before: true,
            after: false,
            valueKind: 'boolean',
          },
        ],
        warnings: [triggerWarning(workflow.trigger)],
      });
    }
    if (!state.latest || state.steps.length === 0) {
      throw new BadRequestException(
        'The workflow has no steps yet: save them with workflow_author_version before enabling it.',
      );
    }
    const connections = await readStepConnections(rt, state.steps);
    const graph = describeGraph(state.steps, connections);
    for (const url of graph.urls) await assertEgressAllowed(url);
    // The dry-run route: a real sample grant, no external call, no rows written, secrets as placeholders.
    const dry = asRow(
      await rt.call(WorkflowDryRunController, 'run', {
        body: {
          workflowId: String(workflow.id),
          sampleAccessGrantId: input.sampleAccessGrantId,
        },
      }),
    );
    return previewOf({
      app,
      targetLabel: label,
      anchor: workflowAnchor(state, connections.values()),
      changes: [
        {
          field: 'whatItDoes',
          after: `From now on, ${outboundSentence(workflow.trigger, app, state.steps, graph.hosts).replace(/^./, (c) => c.toLowerCase())}`,
        },
        { field: 'enabled', before: false, after: true, valueKind: 'boolean' },
        { field: 'version', after: state.latest.version },
        { field: 'outboundHosts', after: graph.hosts },
        { field: 'dataSent', after: graph.sends },
        { field: 'dryRunSample', after: sampleLabel(dry) },
        { field: 'dryRun', after: dryRunLines(dry) },
      ],
      warnings: ['OUTBOUND_INTEGRATION', triggerWarning(workflow.trigger)],
    });
  },
  async run(input, rt) {
    const { workflow, app } = await readWorkflow(rt, input.workflow);
    assertMayRun(rt, app);
    const updated = asRow(
      await rt.call(WorkflowsController, 'update', {
        params: { id: String(workflow.id) },
        body: { enabled: input.enabled },
      }),
    );
    return {
      data: { workflow: workflowSummary(updated) },
      summary: `${input.enabled ? 'Enabled' : 'Disabled'} the ${triggerLabel(workflow.trigger)} workflow of ${appName(app)}.`,
      entityRefs: [appTarget(app)],
    };
  },
});

// ─── Connections ──────────────────────────────────────────────────────────────────────────────────

/**
 * The connection config the AI may set: the shared per-kind schemas WITHOUT `defaultHeaders` — a header
 * value may be a pasted credential (security.md §6.9), so default headers stay a UI-only setting; an
 * update keeps the ones already there.
 */
const connectionConfig = z
  .discriminatedUnion('kind', [
    RestConnectionConfigSchema.omit({ defaultHeaders: true }),
    WebhookOutConnectionConfigSchema,
    ManualConnectionConfigSchema,
  ])
  .describe(
    'The connection settings, by kind. REST: { kind, baseUrl (https), authScheme NONE|BEARER|BASIC|HEADER, ' +
      'authHeaderName (HEADER only), healthCheckPath?, healthCheckMethod GET|HEAD? }. WEBHOOK_OUT: { kind, ' +
      'url (https), signatureHeader? }. MANUAL: { kind }.',
  );

const connectionName = z.string().trim().min(1).max(120);

/** Plain words for how a config authenticates. */
function authWords(config: Row, credentialConfigured: boolean): string {
  if (config.kind === 'WEBHOOK_OUT') {
    return credentialConfigured
      ? `signed with the stored secret${config.signatureHeader ? ` in ${str(config.signatureHeader)}` : ''}`
      : 'unsigned (no signing secret attached)';
  }
  if (config.kind !== 'REST') return 'no external call';
  const scheme = str(config.authScheme) ?? 'NONE';
  if (scheme === 'NONE') return 'no authentication';
  const where =
    scheme === 'HEADER'
      ? ` in header ${str(config.authHeaderName) ?? '?'}`
      : '';
  return `${scheme}${where}, ${credentialConfigured ? 'with the stored credential' : 'no credential attached yet'}`;
}

const connectionCreate = defineTool({
  name: 'workflow_connection_create',
  title: 'Create a workflow connection',
  description:
    'Create a connection an application’s workflows call (administrators, chat only): REST (a base URL ' +
    'and how to authenticate), WEBHOOK_OUT (a signed outbound URL) or MANUAL. Destinations must be public ' +
    'https:// URLs. No credential is set here: an administrator stores it in the lazyit UI, and you may ' +
    'attach an existing one by id with workflow_connection_update. Never propose a destination the user ' +
    'did not name.',
  domain: 'access',
  class: 'elevated',
  externalEffects: true,
  channels: ['CHAT'],
  input: z.strictObject({
    application: applicationRef,
    name: connectionName,
    config: connectionConfig,
  }),
  bindings: [
    bind(WorkflowConnectionsController, 'create'),
    bind(ApplicationsController, 'findAll'),
    bind(ApplicationsController, 'findOne'),
  ],
  async preview(input, rt) {
    assertChatHuman(rt);
    const resolved = await resolveApplication(rt, input.application);
    const app = await readApplication(rt, resolved.id);
    const config = asRow(input.config);
    const endpoint = endpointOf(config);
    if (endpoint) await assertEgressAllowed(endpoint);
    return previewOf({
      app,
      targetLabel: `${appName(app)} — new ${input.config.kind} connection`,
      anchor: anchorOf(app.updatedAt),
      changes: [
        {
          field: 'whatItDoes',
          after: endpoint
            ? `Creates a ${input.config.kind} connection of ${appName(app)} to ${originOf(endpoint)}. A workflow step that uses it will send data there.`
            : `Creates a MANUAL connection of ${appName(app)}: no external call.`,
        },
        { field: 'name', after: input.name },
        { field: 'kind', after: input.config.kind },
        ...(endpoint
          ? [
              { field: 'outboundHost', after: originOf(endpoint) },
              { field: 'destination', after: displayUrl(endpoint) },
            ]
          : []),
        { field: 'authentication', after: authWords(config, false) },
      ],
      warnings: ['OUTBOUND_INTEGRATION'],
    });
  },
  async run(input, rt) {
    const resolved = await resolveApplication(rt, input.application);
    const app = await readApplication(rt, resolved.id);
    assertMayRun(rt, app);
    const created = asRow(
      await rt.call(WorkflowConnectionsController, 'create', {
        body: {
          applicationId: String(app.id),
          kind: input.config.kind,
          name: input.name,
          config: input.config,
        },
      }),
    );
    return {
      data: {
        connection: connectionSummary(created),
        next: 'Use its id in workflow_author_version steps. A credential, if the destination needs one, is stored by an administrator in the lazyit UI.',
      },
      summary: `Created the ${input.config.kind} connection of ${appName(app)}${
        endpointOf(created.config)
          ? ` to ${originOf(endpointOf(created.config))}`
          : ''
      }.`,
      entityRefs: [appTarget(app)],
    };
  },
});

const connectionRef = z.cuid().describe('The connection id.');

/** A connection and its application, read as the caller. */
async function readConnectionState(
  rt: AiToolRuntime,
  id: string,
): Promise<{ connection: Row; app: Row }> {
  const connection = await readConnection(rt, id);
  const app = await readApplication(rt, String(connection.applicationId));
  return { connection, app };
}

const connectionUpdate = defineTool({
  name: 'workflow_connection_update',
  title: 'Change a workflow connection',
  description:
    'Change a connection (administrators, chat only): its name, its settings (send the whole `config` for ' +
    'its kind; the kind cannot change; default headers are kept and set only in the UI), or its ' +
    'credential reference — `secretId` attaches an EXISTING stored credential by id, null detaches it. ' +
    'You never see or set a credential’s value. Attaching a credential, or moving a connection that ' +
    'carries one to another host, also needs the workflow:secrets permission.',
  domain: 'access',
  class: 'elevated',
  externalEffects: true,
  channels: ['CHAT'],
  input: z
    .strictObject({
      connection: connectionRef,
      name: connectionName.optional(),
      config: connectionConfig.optional(),
      secretId: z
        .cuid()
        .nullable()
        .optional()
        .describe(
          'An existing stored credential’s id to attach, or null to detach it.',
        ),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.config !== undefined ||
        v.secretId !== undefined,
      { message: 'Name at least one field to change.' },
    ),
  bindings: [
    bind(WorkflowConnectionsController, 'update'),
    bind(WorkflowConnectionsController, 'findOne'),
    bind(ApplicationsController, 'findOne'),
    bind(ConfigController, 'myPermissions'),
  ],
  async preview(input, rt) {
    assertChatHuman(rt);
    const { connection, app } = await readConnectionState(rt, input.connection);
    const currentConfig = asRow(connection.config);
    if (input.config && input.config.kind !== connection.kind) {
      throw new BadRequestException(
        `The connection is ${String(connection.kind)}; its kind cannot change (create another connection).`,
      );
    }
    const nextConfig = input.config
      ? asRow({ ...input.config, ...keptHeaders(currentConfig) })
      : currentConfig;
    const hadCredential = !!connection.secretId;
    const willHaveCredential =
      input.secretId !== undefined ? input.secretId !== null : hadCredential;
    const beforeEndpoint = endpointOf(currentConfig);
    const afterEndpoint = endpointOf(nextConfig);
    const beforeHost = originOf(beforeEndpoint);
    const afterHost = originOf(afterEndpoint);
    const repoint =
      input.config !== undefined && beforeEndpoint !== afterEndpoint;
    if (repoint && afterEndpoint) await assertEgressAllowed(afterEndpoint);
    // CSEC-1, read before the card so a card is never shown for a change the route would refuse: attaching
    // a credential, or re-pointing a connection that bears one, also needs `workflow:secrets`. The route
    // enforces it again at execution — this only mirrors its rule.
    const attaching = input.secretId !== undefined && input.secretId !== null;
    if (attaching || (willHaveCredential && repoint)) {
      const mine = asRow(await rt.call(ConfigController, 'myPermissions'));
      const held = Array.isArray(mine.permissions) ? mine.permissions : [];
      if (!held.includes('workflow:secrets')) {
        throw new ForbiddenException(
          'Attaching a credential to a connection, or re-pointing the host of a secret-bearing connection, requires the workflow:secrets permission',
        );
      }
    }

    const changes: Change[] = [];
    const sentences: string[] = [];
    if (input.name !== undefined && input.name !== connection.name) {
      changes.push({
        field: 'name',
        before: connection.name,
        after: input.name,
      });
    }
    if (repoint) {
      changes.push({
        field: 'outboundHost',
        before: beforeHost,
        after: afterHost,
      });
      changes.push({
        field: 'destination',
        before: displayUrl(beforeEndpoint),
        after: displayUrl(afterEndpoint),
      });
      sentences.push(
        beforeHost === afterHost
          ? `Changes where on ${afterHost} the connection sends.`
          : `Re-points the connection from ${beforeHost} to ${afterHost}: every workflow step using it will send there instead.`,
      );
      const headers = headerNames(nextConfig);
      if (beforeHost !== afterHost && headers.length > 0) {
        changes.push({ field: 'defaultHeadersSentToNewHost', after: headers });
      }
      if (beforeHost !== afterHost && willHaveCredential) {
        sentences.push(`The stored credential will be sent to ${afterHost}.`);
      }
    }
    if (input.config !== undefined) {
      const beforeAuth = authWords(currentConfig, hadCredential);
      const afterAuth = authWords(nextConfig, willHaveCredential);
      if (beforeAuth !== afterAuth) {
        changes.push({
          field: 'authentication',
          before: beforeAuth,
          after: afterAuth,
        });
      }
      for (const field of [
        'healthCheckPath',
        'healthCheckMethod',
        'signatureHeader',
      ] as const) {
        if ((currentConfig[field] ?? null) !== (nextConfig[field] ?? null)) {
          changes.push({
            field,
            before: currentConfig[field] ?? null,
            after: nextConfig[field] ?? null,
          });
        }
      }
    }
    if (
      input.secretId !== undefined &&
      input.secretId !== (connection.secretId ?? null)
    ) {
      changes.push({
        field: 'credential',
        before: hadCredential
          ? `stored credential ${String(connection.secretId)}`
          : 'none',
        after: input.secretId ? `stored credential ${input.secretId}` : 'none',
      });
      sentences.push(
        input.secretId
          ? `Attaches the stored credential ${input.secretId}: it will be sent to ${afterHost ?? 'the connection'} on every call.`
          : 'Detaches the credential: calls will be sent without it.',
      );
    }
    if (changes.length === 0) {
      throw new BadRequestException(
        'Nothing to change: every value given already matches the connection.',
      );
    }
    changes.unshift({
      field: 'whatItDoes',
      after:
        sentences.length > 0
          ? sentences.join(' ')
          : `Changes the settings of this connection to ${afterHost ?? 'no external host'}.`,
    });
    return previewOf({
      app,
      targetLabel: `${connectionLabel(connection)} of ${appName(app)}`,
      anchor: anchorOf(app.updatedAt, connection.updatedAt),
      changes,
      warnings: ['OUTBOUND_INTEGRATION'],
    });
  },
  async run(input, rt) {
    const { connection, app } = await readConnectionState(rt, input.connection);
    assertMayRun(rt, app);
    const body: Row = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.config !== undefined) {
      body.config = {
        ...input.config,
        ...keptHeaders(asRow(connection.config)),
      };
    }
    if (input.secretId !== undefined) body.secretId = input.secretId;
    const updated = asRow(
      await rt.call(WorkflowConnectionsController, 'update', {
        params: { id: String(connection.id) },
        body,
      }),
    );
    return {
      data: { connection: connectionSummary(updated) },
      summary: `Updated the ${String(updated.kind)} connection of ${appName(app)}.`,
      entityRefs: [appTarget(app)],
    };
  },
});

/** The default headers an update keeps (REST only): the AI never sets them, and never drops them. */
function keptHeaders(config: Row): Row {
  return config.kind === 'REST' && config.defaultHeaders !== undefined
    ? { defaultHeaders: config.defaultHeaders }
    : {};
}

const connectionArchive = defineTool({
  name: 'workflow_connection_archive',
  title: 'Archive a workflow connection',
  description:
    'Archive (soft-delete) a connection (administrators, chat only). A workflow step that still calls it ' +
    'will fail; the card lists the workflows that use it. lazyit has no restore for it.',
  domain: 'access',
  class: 'elevated',
  destructive: true,
  externalEffects: true,
  channels: ['CHAT'],
  input: z.strictObject({ connection: connectionRef }),
  bindings: [
    bind(WorkflowConnectionsController, 'remove'),
    bind(WorkflowConnectionsController, 'findOne'),
    bind(WorkflowsController, 'findAll'),
    bind(WorkflowsController, 'findOne'),
    bind(ApplicationsController, 'findOne'),
  ],
  async preview(input, rt) {
    assertChatHuman(rt);
    const { connection, app } = await readConnectionState(rt, input.connection);
    const users: string[] = [];
    const warnings: AiPreviewWarningCode[] = ['SOFT_DELETE', 'IRREVERSIBLE'];
    const page = asRow(
      await rt.call(WorkflowsController, 'findAll', {
        query: { applicationId: String(app.id), limit: RESOLVE_PAGE },
      }),
    );
    const anchors: unknown[] = [app.updatedAt, connection.updatedAt];
    for (const header of asRows(page.items)) {
      const wf = asRow(
        await rt.call(WorkflowsController, 'findOne', {
          params: { id: String(header.id) },
        }),
      );
      const steps = WorkflowStepsSchema.safeParse(
        asRow(wf.latestVersion).steps,
      );
      const uses =
        steps.success &&
        steps.data.some(
          (s) => s.kind !== 'MANUAL' && s.connectionId === connection.id,
        );
      if (uses) {
        users.push(
          `${str(wf.name) ?? String(wf.id)} (${triggerLabel(wf.trigger)}, ${wf.enabled === true ? 'enabled' : 'disabled'})`,
        );
        anchors.push(wf.updatedAt, asRow(wf.latestVersion).createdAt);
        if (wf.enabled === true) warnings.push(triggerWarning(wf.trigger));
      }
    }
    return previewOf({
      app,
      targetLabel: `${connectionLabel(connection)} of ${appName(app)}`,
      anchor: anchorOf(...anchors),
      changes: [
        {
          field: 'whatItDoes',
          after:
            users.length > 0
              ? `Archives the connection to ${originOf(endpointOf(connection.config)) ?? 'no external host'}. ${users.length} workflow(s) still call it and their steps will fail.`
              : `Archives the connection to ${originOf(endpointOf(connection.config)) ?? 'no external host'}. No workflow uses it.`,
        },
        { field: 'status', before: 'active', after: 'archived' },
        ...(users.length > 0 ? [{ field: 'usedBy', after: users }] : []),
      ],
      warnings,
    });
  },
  async run(input, rt) {
    const { connection, app } = await readConnectionState(rt, input.connection);
    assertMayRun(rt, app);
    await rt.call(WorkflowConnectionsController, 'remove', {
      params: { id: String(connection.id) },
    });
    return {
      data: { connectionId: connection.id, archived: true },
      summary: `Archived the ${String(connection.kind)} connection of ${appName(app)}.`,
      entityRefs: [appTarget(app)],
    };
  },
});

const connectionTest = defineTool({
  name: 'workflow_connection_test',
  title: 'Test a workflow connection',
  description:
    'Test a REST connection (administrators, chat only): one read-only GET or HEAD to its host (its ' +
    'health-check path, else its base URL), with its stored credential if one is attached. It never ' +
    'sends a change. Webhook and manual connections have nothing to probe read-only.',
  domain: 'access',
  class: 'elevated',
  externalEffects: true,
  channels: ['CHAT'],
  input: z.strictObject({ connection: connectionRef }),
  bindings: [
    bind(WorkflowConnectionsController, 'test'),
    bind(WorkflowConnectionsController, 'findOne'),
    bind(ApplicationsController, 'findOne'),
  ],
  async preview(input, rt) {
    assertChatHuman(rt);
    const { connection, app } = await readConnectionState(rt, input.connection);
    const config = asRow(connection.config);
    if (config.kind !== 'REST') {
      throw new BadRequestException(
        connection.kind === 'WEBHOOK_OUT'
          ? 'A webhook connection is write-only (a signed POST): there is nothing to probe read-only. Enable its workflow with a dry-run instead.'
          : 'A manual connection makes no external call: there is nothing to test.',
      );
    }
    const baseUrl = str(config.baseUrl) ?? '';
    await assertEgressAllowed(baseUrl);
    const path = str(config.healthCheckPath) ?? '/';
    const method = str(config.healthCheckMethod) ?? 'GET';
    const credential = !!connection.secretId;
    return previewOf({
      app,
      targetLabel: `${connectionLabel(connection)} of ${appName(app)}`,
      anchor: anchorOf(app.updatedAt, connection.updatedAt),
      changes: [
        {
          field: 'whatItDoes',
          after: `Sends one read-only ${method} request to ${originOf(baseUrl)} (path ${path})${
            credential
              ? ', with the stored credential'
              : ', without a credential'
          }. Nothing is changed there.`,
        },
        { field: 'outboundHost', after: originOf(baseUrl) },
        { field: 'probe', after: `${method} ${displayUrl(baseUrl)} + ${path}` },
        { field: 'authentication', after: authWords(config, credential) },
      ],
      warnings: ['OUTBOUND_INTEGRATION'],
    });
  },
  async run(input, rt) {
    const { connection, app } = await readConnectionState(rt, input.connection);
    assertMayRun(rt, app);
    const outcome = asRow(
      await rt.call(WorkflowConnectionsController, 'test', {
        params: { id: String(connection.id) },
      }),
    );
    return {
      data: {
        ok: outcome.ok === true,
        ...(typeof outcome.status === 'number'
          ? { status: outcome.status }
          : {}),
        ...(typeof outcome.probedPath === 'string'
          ? { probedPath: outcome.probedPath }
          : {}),
        // The diagnostic may echo the remote system's words: data, never instructions.
        message: untrusted(str(outcome.message)),
        requestId: outcome.requestId,
      },
      summary: `Tested the connection of ${appName(app)} to ${originOf(endpointOf(connection.config)) ?? 'its host'}: ${
        outcome.ok === true ? 'it answered' : 'it failed'
      }.`,
      entityRefs: [appTarget(app)],
    };
  },
});

/**
 * The workflow authoring toolset. `WorkflowsController.findAll` / `.findOne` and
 * `WorkflowConnectionsController.findOne` are bound here as the previews' reads (the workflow operations
 * toolset, W2-13, binds them as tools too); the connection list stays with W2-13.
 */
export const workflowAuthoringToolset: AiToolset = {
  domain: 'access',
  tools: [
    workflowCreate,
    workflowUpdate,
    workflowSetEnabled,
    workflowArchive,
    workflowAuthorVersion,
    connectionCreate,
    connectionUpdate,
    connectionArchive,
    connectionTest,
  ],
  unexposed: [],
};
