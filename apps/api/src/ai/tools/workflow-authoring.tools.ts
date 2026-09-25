import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
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
import { WorkflowRunsController } from '../../workflow-engine/runs/workflow-runs.controller';
import { templatePaths } from '../../workflow-engine/mapping/data-mapper';
import { UsersController } from '../../users/users.controller';
import { assertChannelAllows } from '../core/pending-action';
import type { AiResolvedReference } from '../core/reference-resolver';
import { untrusted } from '../core/result-shaper';
import {
  afterPhrase,
  beforePhrase,
  joinPhrases,
  phrase,
  summaryPhrase,
  yesNo,
  type Phrase,
} from '../core/sentences';
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

function triggerLabel(trigger: unknown): string {
  return trigger === 'ACCESS_REVOKED'
    ? 'on access revoked'
    : 'on access granted';
}

/** A workflow trigger as a sentence param (the templates `select` on it). */
function triggerParam(trigger: unknown): string {
  return String(trigger);
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
  'userinfo-not-allowed':
    'it carries a user name or password (store the credential in the lazyit UI)',
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
  if (hasUserinfo(url)) {
    throw new BadRequestException(USERINFO_REFUSAL);
  }
  try {
    await assertUrlAllowed(url, { refuseUserinfo: true });
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

const USERINFO_REFUSAL =
  'A destination URL may not carry a user name or password (https://user:pass@host): store the credential in the lazyit UI and attach it by id.';

/** Whether a URL carries userinfo (`https://user[:pass]@host`) — a credential in plain sight. */
function hasUserinfo(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
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

/**
 * The context paths a template reads, parsed by the RUNTIME mapper's own parser (`templatePaths`,
 * `mapping/data-mapper.ts`): segments trimmed, filters dropped — so `{{ grantee . email | lower }}` is
 * described as the email, exactly what the engine sends.
 */
function tokensOf(template: string): string[] {
  return templatePaths(template);
}

/** Whether the engine can resolve `path` to a known value (`steps.<key>.…` needs a step of this graph). */
/**
 * Whether the engine can resolve `path` to a known value. Only a COMPLETED MANUAL step fills
 * `ctx.steps` (`run/run-context.ts`: the typed input of the task), so `steps.<key>.<field>` must name a
 * MANUAL step of this graph and one of its input fields; a REST or webhook step's response is never in
 * the context and would render empty.
 */
function isKnownToken(
  path: string,
  manualFields: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (TOKEN_WORDS[path]) return true;
  const [root, key, field, ...rest] = path.split('.');
  return (
    root === 'steps' &&
    key !== undefined &&
    field !== undefined &&
    rest.length === 0 &&
    manualFields.get(key)?.has(field) === true
  );
}

/** The MANUAL steps of a graph and the input fields a person fills in each. */
function manualFieldsOf(
  steps: readonly WorkflowStep[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const step of steps) {
    if (step.kind === 'MANUAL') {
      out.set(step.key, new Set(step.inputFields.map((f) => f.name)));
    }
  }
  return out;
}

/**
 * Refuse a template the card could not describe honestly: every `{{ … }}` must name a known value (a
 * typo or an unknown path would render empty at run time, and the card would have to guess).
 */
function assertKnownTokens(steps: readonly WorkflowStep[]): void {
  const keys = manualFieldsOf(steps);
  for (const step of steps) {
    if (step.kind === 'MANUAL') continue;
    const templates = [
      ...Object.values(step.dataMapping ?? {}),
      ...(step.kind === 'REST' ? [step.path] : []),
    ];
    for (const template of templates) {
      for (const token of tokensOf(template)) {
        if (!isKnownToken(token, keys)) {
          throw new BadRequestException(
            `Step "${step.key}" reads {{ ${token} }}, which lazyit does not know (it would be sent empty). Known values: ${Object.keys(
              TOKEN_WORDS,
            ).join(
              ', ',
            )}, and steps.<manual step key>.<one of its input fields> (only a manual step's typed input is available to later steps).`,
          );
        }
      }
    }
  }
}

/** A URL path for display: the query's parameter NAMES only (a value may be a pasted credential). */
function displayPath(path: string): string {
  const q = path.indexOf('?');
  if (q === -1) return path;
  const names = path
    .slice(q + 1)
    .split('&')
    .map((pair) => pair.split('=')[0])
    .filter(Boolean);
  return `${path.slice(0, q)}${names.length > 0 ? `?${names.map((n) => `${n}=…`).join('&')}` : ''}`;
}

function tokenWords(path: string): string {
  if (TOKEN_WORDS[path]) return TOKEN_WORDS[path];
  if (path.startsWith('steps.')) {
    const [, step, field] = path.split('.');
    return `the "${field ?? '?'}" a person typed in the manual step "${step ?? '?'}"`;
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

/**
 * Whether a step's `dataMapping` is actually sent: a webhook always posts it; a REST step sends a JSON
 * body only for POST / PUT / PATCH (`rest.handler.ts`) — a GET or DELETE mapping is never sent.
 */
function sendsBody(step: WorkflowStep): boolean {
  if (step.kind === 'WEBHOOK_OUT') return true;
  return (
    step.kind === 'REST' &&
    (step.method === 'POST' || step.method === 'PUT' || step.method === 'PATCH')
  );
}

/** A value a workflow sends, as a `workflow.outbound.dataWord` sentence names it (#1384). */
interface DataWord {
  /** The template path with dots as underscores, `steps` for a manual step's input, or `unknown`. */
  token: string;
  step: string;
  field: string;
}

function dataWordOf(path: string): DataWord {
  if (TOKEN_WORDS[path]) {
    return { token: path.replace(/\./g, '_'), step: '', field: '' };
  }
  if (path.startsWith('steps.')) {
    const [, step, field] = path.split('.');
    return { token: 'steps', step: step ?? '?', field: field ?? '?' };
  }
  return { token: 'unknown', step: '', field: '' };
}

/** The distinct lazyit data a set of steps sends out, in words (distinct by their English words). */
function dataSentWords(steps: readonly WorkflowStep[]): DataWord[] {
  const words = new Map<string, DataWord>();
  for (const step of steps) {
    if (step.kind === 'MANUAL') continue;
    const templates = [
      ...(sendsBody(step) ? Object.values(step.dataMapping ?? {}) : []),
      ...(step.kind === 'REST' ? [step.path] : []),
    ];
    for (const template of templates) {
      for (const token of tokensOf(template)) {
        const text = tokenWords(token);
        if (!words.has(text)) words.set(text, dataWordOf(token));
      }
    }
  }
  return [...words.values()];
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

/** An application name as the MODEL reads it (summaries, refusals): other-authored, so untrusted. */
function appForModel(app: Row): string {
  return untrusted(appName(app)) ?? String(app.id);
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
        `${untrusted(app.label ?? app.id) ?? app.id} has no ${triggerLabel(ref.trigger)} workflow; create it with workflow_create.`,
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

/** The latest version number of a read workflow (0 when none is authored) — the SEC-077 precondition. */
function versionNumberOf(latest: Row | null): number {
  return typeof latest?.version === 'number' ? latest.version : 0;
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
        ? `${step.method} ${displayUrl(endpoint) ?? origin} + path ${displayPath(step.path)}`
        : `POST ${displayUrl(endpoint) ?? origin} (webhook)`;
    const body = sendsBody(step);
    const fields = Object.keys(step.dataMapping ?? {});
    stepLines.push(
      `${n}: ${target}${
        fields.length === 0
          ? ''
          : body
            ? `, sending ${fields.join(', ')}`
            : ` (its mapped fields ${fields.join(', ')} are NOT sent: a ${step.kind === 'REST' ? step.method : ''} request has no body)`
      }`,
    );
    const lines = body ? mappingLines(step.dataMapping) : [];
    if (step.kind === 'REST' && tokensOf(step.path).length > 0) {
      lines.unshift(
        `URL path ← ${displayPath(step.path)} (${tokensOf(step.path).map(tokenWords).join(', ')})`,
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

/**
 * "Every time someone is granted access to Jira, lazyit will send the person's email, … to https://a,
 * https://b." — or, with `fromNowOn`, "From now on, every time …".
 */
function outboundSentence(
  trigger: unknown,
  app: Row,
  steps: readonly WorkflowStep[],
  hosts: string[],
  fromNowOn = false,
): Phrase {
  const when = {
    fromNowOn: yesNo(fromNowOn),
    trigger: triggerParam(trigger),
    application: appName(app),
  };
  if (hosts.length === 0) {
    return phrase('workflow.outbound.manualOnly', when);
  }
  const data = dataSentWords(steps);
  return joinPhrases(
    phrase('workflow.outbound.sends', when),
    ...(data.length > 0
      ? data.map((word, i) => dataWordPhrase(word, i < data.length - 1))
      : [phrase('workflow.outbound.noData')]),
    phrase('workflow.outbound.to', { hosts: hosts.join(', ') }),
  );
}

/** One value of {@link dataSentWords} as a sentence, followed by a comma when more follow. */
function dataWordPhrase(word: DataWord, comma: boolean): Phrase {
  return phrase('workflow.outbound.dataWord', {
    token: word.token,
    field: word.field,
    step: word.step,
    then: comma ? 'comma' : 'end',
  });
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
        `${appForModel(app)} already has a ${triggerLabel(input.trigger)} workflow (${untrusted(str(existing.name)) ?? String(existing.id)}); change it instead.`,
      );
    }
    const changes: Change[] = [
      {
        field: 'whatItDoes',
        ...afterPhrase(
          phrase('workflow_create.whatItDoes', {
            trigger: triggerParam(input.trigger),
            application: appName(app),
          }),
        ),
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
      ...summaryPhrase(
        phrase('workflow_create.summary', {
          trigger: triggerParam(input.trigger),
          application: appForModel(app),
        }),
      ),
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
      ...summaryPhrase(
        phrase('workflow_update.summary', {
          trigger: triggerParam(workflow.trigger),
          application: appForModel(app),
        }),
      ),
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
          ...afterPhrase(
            phrase('workflow_archive.whatItDoes', {
              trigger: triggerParam(workflow.trigger),
              application: appName(app),
            }),
          ),
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
      ...summaryPhrase(
        phrase('workflow_archive.summary', {
          trigger: triggerParam(workflow.trigger),
          application: appForModel(app),
        }),
      ),
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
    assertKnownTokens(input.steps);
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
        ...afterPhrase(
          joinPhrases(
            outboundSentence(workflow.trigger, app, input.steps, next.hosts),
            phrase(
              enabled
                ? 'workflow_author_version.enabled'
                : 'workflow_author_version.disabled',
            ),
          ),
        ),
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
    const { workflow, app, latest } = await readWorkflow(rt, input.workflow);
    assertMayRun(rt, app);
    // SEC-077: author on top of the version just read (the card's STALE anchor already pinned it); the
    // route 409s if another version landed in between.
    const version = asRow(
      await rt.call(WorkflowsController, 'authorVersion', {
        params: { id: String(workflow.id) },
        body: { steps: input.steps, baseVersion: versionNumberOf(latest) },
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
      ...summaryPhrase(
        phrase('workflow_author_version.summary', {
          version: String(version.version),
          trigger: triggerParam(workflow.trigger),
          application: appForModel(app),
          live: yesNo(workflow.enabled === true),
        }),
      ),
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

/**
 * The dry-run resolves its sample grant's grantee even when that person was offboarded (the grantee is
 * a nested read, outside the soft-delete filter). A card built on a departed person's data is not a
 * useful preview — and shows data nobody should be handling — so it is refused. The grantee is read
 * through the guarded user route: a 404 (offboarded) refuses; a caller without `user:read` (403) cannot
 * check, and the card is shown as the dry-run built it.
 */
async function assertSampleGranteeLive(
  rt: AiToolRuntime,
  dry: Row,
): Promise<void> {
  const granteeId = str(asRow(asRow(dry.context).grantee).id);
  if (!granteeId) return;
  try {
    await rt.call(UsersController, 'findOne', { params: { id: granteeId } });
  } catch (err) {
    const status = err instanceof HttpException ? err.getStatus() : undefined;
    if (status === 404) {
      throw new BadRequestException(
        'The sample grant belongs to a person who was offboarded: pick an access grant of a current user.',
      );
    }
    if (status !== 403) throw err;
  }
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
    bind(UsersController, 'findOne'),
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
            ...afterPhrase(
              phrase('workflow_set_enabled.whatItDoesOff', {
                trigger: triggerParam(workflow.trigger),
                application: appName(app),
              }),
            ),
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
    await assertSampleGranteeLive(rt, dry);
    return previewOf({
      app,
      targetLabel: label,
      anchor: workflowAnchor(state, connections.values()),
      changes: [
        {
          field: 'whatItDoes',
          ...afterPhrase(
            outboundSentence(
              workflow.trigger,
              app,
              state.steps,
              graph.hosts,
              true,
            ),
          ),
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
    const { workflow, app, latest } = await readWorkflow(rt, input.workflow);
    assertMayRun(rt, app);
    // SEC-077: enabling pins the version the card reviewed (re-read here, after the STALE check), so a
    // version authored in between makes the route 409 instead of going live unseen.
    const updated = asRow(
      await rt.call(WorkflowsController, 'update', {
        params: { id: String(workflow.id) },
        body: input.enabled
          ? { enabled: true, expectedVersion: versionNumberOf(latest) }
          : { enabled: false },
      }),
    );
    return {
      data: { workflow: workflowSummary(updated) },
      ...summaryPhrase(
        phrase('workflow_set_enabled.summary', {
          enabled: yesNo(input.enabled),
          trigger: triggerParam(workflow.trigger),
          application: appForModel(app),
        }),
      ),
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
  .refine((config) => !hasUserinfo(endpointOf(config)), {
    message: USERINFO_REFUSAL,
  })
  .describe(
    'The connection settings, by kind. REST: { kind, baseUrl (https), authScheme NONE|BEARER|BASIC|HEADER, ' +
      'authHeaderName (HEADER only), healthCheckPath?, healthCheckMethod GET|HEAD? }. WEBHOOK_OUT: { kind, ' +
      'url (https), signatureHeader? }. MANUAL: { kind }.',
  );

const connectionName = z.string().trim().min(1).max(120);

/** Plain words for how a config authenticates. */
function authWords(config: Row, credentialConfigured: boolean): Phrase {
  if (config.kind === 'WEBHOOK_OUT') {
    return credentialConfigured
      ? phrase('workflow.auth.webhookSigned', {
          hasHeader: yesNo(!!config.signatureHeader),
          header: String(str(config.signatureHeader)),
        })
      : phrase('workflow.auth.webhookUnsigned');
  }
  if (config.kind !== 'REST') return phrase('workflow.auth.noCall');
  const scheme = str(config.authScheme) ?? 'NONE';
  if (scheme === 'NONE') return phrase('workflow.auth.none');
  return phrase('workflow.auth.rest', {
    scheme,
    isHeader: yesNo(scheme === 'HEADER'),
    header: str(config.authHeaderName) ?? '?',
    credential: yesNo(credentialConfigured),
  });
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
        {
          field: 'authentication',
          ...afterPhrase(authWords(config, false)),
        },
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
      ...summaryPhrase(
        phrase('workflow_connection_create.summary', {
          kind: input.config.kind,
          application: appForModel(app),
          hasHost: yesNo(!!endpointOf(created.config)),
          host: String(originOf(endpointOf(created.config))),
        }),
      ),
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

/**
 * Runs that can still call a connection: a run is pinned to a version but reads each step's connection
 * LIVE, so a run in flight (PENDING / RUNNING), paused on a person (AWAITING_INPUT) or FAILED (a retry
 * resumes it) sends its remaining steps to wherever the connection points when they execute.
 */
const ACTIVE_RUN_STATUSES = [
  ['PENDING', 'about to start'],
  ['RUNNING', 'running'],
  ['AWAITING_INPUT', 'waiting for a person'],
  ['FAILED', 'failed — a retry resumes it'],
] as const;

interface ActiveRuns {
  /** "Provision Jira: 1 running, 2 waiting for a person" per workflow; null when it could not be read. */
  lines: string[] | null;
  total: number;
  /** The workflows (by id) with an active run. */
  workflowIds: Set<string>;
  /** The triggers of the live workflows with an active run (their provisioning warning). */
  triggers: Set<string>;
  anchors: unknown[];
}

/**
 * The application's active runs, through the guarded run list (`workflow:read`). A caller without it
 * (403) gets `lines: null`: the card says the runs could not be checked. Runs of ANY workflow of the
 * application are counted — a run's pinned version cannot be read through a route, and connections
 * belong to one application — so the card says they "may" call the connection.
 */
async function activeRunsOf(
  rt: AiToolRuntime,
  applicationId: string,
): Promise<ActiveRuns> {
  const perWorkflow = new Map<string, string[]>();
  const workflowIds = new Set<string>();
  const anchors: unknown[] = [];
  let total = 0;
  try {
    for (const [status, words] of ACTIVE_RUN_STATUSES) {
      const page = asRow(
        await rt.call(WorkflowRunsController, 'findAll', {
          query: { applicationId, status, limit: RESOLVE_PAGE },
        }),
      );
      const items = asRows(page.items);
      const count = typeof page.total === 'number' ? page.total : items.length;
      total += count;
      const byWorkflow = new Map<string, number>();
      for (const run of items) {
        const id = String(run.workflowId);
        byWorkflow.set(id, (byWorkflow.get(id) ?? 0) + 1);
        workflowIds.add(id);
        anchors.push(run.updatedAt);
      }
      for (const [id, n] of byWorkflow) {
        perWorkflow.set(id, [...(perWorkflow.get(id) ?? []), `${n} ${words}`]);
      }
      if (count > items.length) {
        perWorkflow.set('…', [
          ...(perWorkflow.get('…') ?? []),
          `${count - items.length} more ${words}`,
        ]);
      }
    }
  } catch (err) {
    if (err instanceof HttpException && err.getStatus() === 403) {
      return {
        lines: null,
        total: 0,
        workflowIds,
        triggers: new Set(),
        anchors,
      };
    }
    throw err;
  }
  const names = new Map<string, string>();
  const page = asRow(
    await rt.call(WorkflowsController, 'findAll', {
      query: { applicationId, limit: RESOLVE_PAGE },
    }),
  );
  const triggers = new Set<string>();
  for (const wf of asRows(page.items)) {
    names.set(String(wf.id), str(wf.name) ?? String(wf.id));
    if (workflowIds.has(String(wf.id))) triggers.add(String(wf.trigger));
  }
  const lines = [...perWorkflow].map(
    ([id, parts]) =>
      `${id === '…' ? 'Other runs' : (names.get(id) ?? `workflow ${id} (archived)`)}: ${parts.join(', ')}`,
  );
  return { lines, total, workflowIds, triggers, anchors };
}

/** A workflow of the application whose latest version calls a connection. */
interface ConnectionUser {
  workflow: Row;
  steps: WorkflowStep[];
  latestCreatedAt: unknown;
}

/** The application's workflows whose LATEST version calls `connectionId` (read as the caller). */
async function workflowsUsing(
  rt: AiToolRuntime,
  applicationId: string,
  connectionId: string,
): Promise<ConnectionUser[]> {
  const page = asRow(
    await rt.call(WorkflowsController, 'findAll', {
      query: { applicationId, limit: RESOLVE_PAGE },
    }),
  );
  const users: ConnectionUser[] = [];
  for (const header of asRows(page.items)) {
    const workflow = asRow(
      await rt.call(WorkflowsController, 'findOne', {
        params: { id: String(header.id) },
      }),
    );
    const latest = asRow(workflow.latestVersion);
    const steps = WorkflowStepsSchema.safeParse(latest.steps);
    if (
      steps.success &&
      steps.data.some(
        (s) => s.kind !== 'MANUAL' && s.connectionId === connectionId,
      )
    ) {
      users.push({
        workflow,
        steps: steps.data,
        latestCreatedAt: latest.createdAt,
      });
    }
  }
  return users;
}

function usedByLine(user: ConnectionUser): string {
  const wf = user.workflow;
  return `${str(wf.name) ?? String(wf.id)} (${triggerLabel(wf.trigger)}, ${wf.enabled === true ? 'enabled' : 'disabled'})`;
}

const connectionUpdate = defineTool({
  name: 'workflow_connection_update',
  title: 'Change a workflow connection',
  description:
    'Change a connection (administrators, chat only): its name, its settings (send the whole `config` for ' +
    'its kind; the kind cannot change; default headers are kept and set only in the UI), or its ' +
    'credential reference — `secretId` attaches an EXISTING stored credential by id, null detaches it. ' +
    'You never see or set a credential’s value. Attaching a credential, or moving a connection that ' +
    'carries one — or default headers — to another host, also needs the workflow:secrets permission.',
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
    bind(WorkflowRunsController, 'findAll'),
    bind(WorkflowsController, 'findAll'),
    bind(WorkflowsController, 'findOne'),
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
    // A legacy row whose stored destination carries a user name or password: any change to it (even a
    // rename or a credential attach) would approve a connection that sends a credential in plain sight.
    // The URL is fixed first, by sending a new `config` without it.
    if (hasUserinfo(beforeEndpoint) && hasUserinfo(afterEndpoint)) {
      throw new BadRequestException(
        `This connection's stored destination (${beforeHost ?? 'its URL'}) carries a user name or password in the URL. Fix the URL first: send a new config without it (store the credential in the lazyit UI and attach it by id).`,
      );
    }
    const repoint =
      input.config !== undefined && beforeEndpoint !== afterEndpoint;
    if (repoint && afterEndpoint) await assertEgressAllowed(afterEndpoint);
    // CSEC-1, read before the card so a card is never shown for a change the route would refuse: attaching
    // a credential, or re-pointing a connection that bears one, also needs `workflow:secrets`. The route
    // enforces it again at execution — this only mirrors its rule, including re-pointing a connection
    // that carries default headers (SEC-075): a header value may be a pasted token and the headers follow
    // the connection to its new host.
    const attaching = input.secretId !== undefined && input.secretId !== null;
    const carriedHeaders = headerNames(nextConfig);
    const headersFollow = repoint && carriedHeaders.length > 0;
    if (attaching || (willHaveCredential && repoint) || headersFollow) {
      const mine = asRow(await rt.call(ConfigController, 'myPermissions'));
      const held = Array.isArray(mine.permissions) ? mine.permissions : [];
      if (!held.includes('workflow:secrets')) {
        throw new ForbiddenException(
          attaching || (willHaveCredential && repoint)
            ? 'Attaching a credential to a connection, or re-pointing the host of a secret-bearing connection, requires the workflow:secrets permission'
            : `Re-pointing this connection requires the workflow:secrets permission: its default headers (${carriedHeaders.join(', ')}) would be sent to the new host and may hold a credential. Remove them in the lazyit UI first, or ask someone who holds workflow:secrets.`,
        );
      }
    }
    // Every workflow whose latest version calls this connection: the card lists them, shows what each
    // ENABLED one would send to the new host, and anchors STALE on them.
    const users = await workflowsUsing(
      rt,
      String(app.id),
      String(connection.id),
    );
    const anchors: unknown[] = [app.updatedAt, connection.updatedAt];
    const warnings = new Set<AiPreviewWarningCode>(['OUTBOUND_INTEGRATION']);
    const sentToNewHost: string[] = [];
    const active = repoint ? await activeRunsOf(rt, String(app.id)) : null;
    if (active) {
      anchors.push(...active.anchors);
      for (const trigger of active.triggers) {
        warnings.add(triggerWarning(trigger));
      }
    }
    for (const user of users) {
      anchors.push(user.workflow.updatedAt, user.latestCreatedAt);
      if (user.workflow.enabled !== true) continue;
      warnings.add(triggerWarning(user.workflow.trigger));
      if (!repoint) continue;
      const stepConnections = await readStepConnections(rt, user.steps);
      for (const other of stepConnections.values())
        anchors.push(other.updatedAt);
      stepConnections.set(String(connection.id), {
        ...connection,
        config: nextConfig,
        secretId: willHaveCredential
          ? (input.secretId ?? connection.secretId)
          : null,
      });
      const described = describeGraph(user.steps, stepConnections);
      for (const line of described.sends) {
        if (afterHost && line.startsWith(`${afterHost}: `)) {
          sentToNewHost.push(
            `${str(user.workflow.name) ?? String(user.workflow.id)} (${triggerLabel(user.workflow.trigger)}): ${line.slice(afterHost.length + 2)}`,
          );
        }
      }
    }

    const changes: Change[] = [];
    const sentences: Phrase[] = [];
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
          ? phrase('workflow_connection_update.movesPath', {
              host: String(afterHost),
            })
          : phrase('workflow_connection_update.repoints', {
              from: String(beforeHost),
              to: String(afterHost),
            }),
      );
      const headers = headerNames(nextConfig);
      if (beforeHost !== afterHost && headers.length > 0) {
        changes.push({ field: 'defaultHeadersSentToNewHost', after: headers });
      }
      if (beforeHost !== afterHost && willHaveCredential) {
        sentences.push(
          phrase('workflow_connection_update.credentialToNewHost', {
            host: String(afterHost),
          }),
        );
      }
    }
    if (input.config !== undefined) {
      const beforeAuth = authWords(currentConfig, hadCredential);
      const afterAuth = authWords(nextConfig, willHaveCredential);
      if (beforeAuth.text !== afterAuth.text) {
        changes.push({
          field: 'authentication',
          ...beforePhrase(beforeAuth),
          ...afterPhrase(afterAuth),
        });
      }
      for (const field of [
        'healthCheckPath',
        'healthCheckMethod',
        'signatureHeader',
      ] as const) {
        if ((currentConfig[field] ?? null) !== (nextConfig[field] ?? null)) {
          // A path's query values may be a pasted credential: names only.
          const shown = (value: unknown) =>
            typeof value === 'string' && field === 'healthCheckPath'
              ? displayPath(value)
              : (value ?? null);
          changes.push({
            field,
            before: shown(currentConfig[field]),
            after: shown(nextConfig[field]),
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
        ...beforePhrase(
          hadCredential
            ? phrase('workflow_connection_update.credentialStored', {
                secretId: String(connection.secretId),
              })
            : phrase('workflow_connection_update.credentialNone'),
        ),
        ...afterPhrase(
          input.secretId
            ? phrase('workflow_connection_update.credentialStored', {
                secretId: input.secretId,
              })
            : phrase('workflow_connection_update.credentialNone'),
        ),
      });
      sentences.push(
        input.secretId
          ? phrase('workflow_connection_update.attachesCredential', {
              secretId: input.secretId,
              hasHost: yesNo(afterHost !== null),
              host: String(afterHost),
            })
          : phrase('workflow_connection_update.detachesCredential'),
      );
    }
    if (changes.length === 0) {
      throw new BadRequestException(
        'Nothing to change: every value given already matches the connection.',
      );
    }
    if (users.length > 0) {
      changes.push({ field: 'usedBy', after: users.map(usedByLine) });
    }
    if (repoint && sentToNewHost.length > 0) {
      changes.push({ field: 'dataSentToNewHost', after: sentToNewHost });
    }
    if (active) {
      if (active.lines === null) {
        changes.push({
          field: 'runsInFlight',
          ...afterPhrase(
            phrase('workflow_connection_update.runsInFlightUnknown'),
          ),
        });
      } else if (active.total > 0) {
        changes.push({ field: 'runsInFlight', after: active.lines });
      }
    }
    if (repoint && (sentToNewHost.length > 0 || (active?.total ?? 0) > 0)) {
      sentences.push(
        phrase('workflow_connection_update.inFlight', {
          count: active?.total ?? 0,
          host: String(afterHost),
        }),
      );
    }
    changes.unshift({
      field: 'whatItDoes',
      ...afterPhrase(
        sentences.length > 0
          ? joinPhrases(...sentences)
          : phrase('workflow_connection_update.settingsOnly', {
              hasHost: yesNo(afterHost !== null),
              host: String(afterHost),
            }),
      ),
    });
    return previewOf({
      app,
      targetLabel: `${connectionLabel(connection)} of ${appName(app)}`,
      anchor: anchorOf(...anchors),
      changes,
      warnings,
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
      ...summaryPhrase(
        phrase('workflow_connection_update.summary', {
          kind: String(updated.kind),
          application: appForModel(app),
        }),
      ),
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
    const warnings: AiPreviewWarningCode[] = ['SOFT_DELETE', 'IRREVERSIBLE'];
    const anchors: unknown[] = [app.updatedAt, connection.updatedAt];
    const using = await workflowsUsing(
      rt,
      String(app.id),
      String(connection.id),
    );
    for (const user of using) {
      anchors.push(user.workflow.updatedAt, user.latestCreatedAt);
      if (user.workflow.enabled === true) {
        warnings.push(triggerWarning(user.workflow.trigger));
      }
    }
    const users = using.map(usedByLine);
    return previewOf({
      app,
      targetLabel: `${connectionLabel(connection)} of ${appName(app)}`,
      anchor: anchorOf(...anchors),
      changes: [
        {
          field: 'whatItDoes',
          ...afterPhrase(
            phrase('workflow_connection_archive.whatItDoes', {
              hasHost: yesNo(originOf(endpointOf(connection.config)) !== null),
              host: String(originOf(endpointOf(connection.config))),
              users: users.length,
            }),
          ),
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
      ...summaryPhrase(
        phrase('workflow_connection_archive.summary', {
          kind: String(connection.kind),
          application: appForModel(app),
        }),
      ),
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
    const path = displayPath(str(config.healthCheckPath) ?? '/');
    const method = str(config.healthCheckMethod) ?? 'GET';
    const credential = !!connection.secretId;
    return previewOf({
      app,
      targetLabel: `${connectionLabel(connection)} of ${appName(app)}`,
      anchor: anchorOf(app.updatedAt, connection.updatedAt),
      changes: [
        {
          field: 'whatItDoes',
          ...afterPhrase(
            phrase('workflow_connection_test.whatItDoes', {
              method,
              host: String(originOf(baseUrl)),
              path,
              credential: yesNo(credential),
            }),
          ),
        },
        { field: 'outboundHost', after: originOf(baseUrl) },
        { field: 'probe', after: `${method} ${displayUrl(baseUrl)} + ${path}` },
        {
          field: 'authentication',
          ...afterPhrase(authWords(config, credential)),
        },
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
          ? { probedPath: untrusted(displayPath(outcome.probedPath)) }
          : {}),
        // The diagnostic may echo the remote system's words: data, never instructions.
        message: untrusted(
          typeof outcome.probedPath === 'string'
            ? (str(outcome.message) ?? '')
                .split(outcome.probedPath)
                .join(displayPath(outcome.probedPath))
            : str(outcome.message),
        ),
        requestId: outcome.requestId,
      },
      ...summaryPhrase(
        phrase('workflow_connection_test.summary', {
          application: appForModel(app),
          hasHost: yesNo(originOf(endpointOf(connection.config)) !== null),
          host: String(originOf(endpointOf(connection.config))),
          ok: yesNo(outcome.ok === true),
        }),
      ),
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
