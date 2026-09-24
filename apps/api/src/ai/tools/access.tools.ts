import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AccessRequestStatusSchema,
  CreateApplicationSchema,
  int4,
  MAX_PAGE_LIMIT,
  type AiEntityRef,
  type AiPreviewWarningCode,
} from '@lazyit/shared';
import { AccessGrantsController } from '../../access-grants/access-grants.controller';
import { AccessRequestsController } from '../../access-requests/access-requests.controller';
import { ApplicationsController } from '../../applications/applications.controller';
import { UsersController } from '../../users/users.controller';
import { WorkflowsController } from '../../workflow-engine/definitions/workflows.controller';
import { APPLICATION_SORT_ALLOWLIST } from '../../applications/applications.service';
import {
  AI_TOOL_LIST_DEFAULT_LIMIT,
  AI_TOOL_LIST_MAX_LIMIT,
} from '../ai.constants';
import {
  AiReferenceError,
  entityRefOf,
  type AiReferenceCandidate,
  type AiResolvedReference,
} from '../core/reference-resolver';
import { assertChannelAllows } from '../core/pending-action';
import { untrusted } from '../core/result-shaper';
import {
  bind,
  defineTool,
  unexposed,
  type AiToolPreview,
  type AiToolRuntime,
  type AiToolset,
} from '../core/tool-descriptor';
import { searchText } from './search-text';

/**
 * The ACCESS toolset (W2-6; tools-and-execution.md §7 rows 17–26): applications, access grants and
 * access requests. Every call goes through `rt.call` — the route's own guards, pipes and controller
 * logic, as the principal — so an application write passes the same `CreateApplicationSchema` /
 * `UpdateApplicationSchema` pipe (the SEC-051 url-scheme guard) as the web, and a grant runs the same
 * live-checks, actor attribution and workflow outbox (ADR-0054).
 *
 * Privilege: opening a grant and approving an access request GRANT ACCESS, so their previews carry
 * `PRIVILEGE_GRANT` — core derives the password step-up from it (CEO decision 2026-09-24, "Opción 2").
 * The previews deliberately leave `stepUpRequired` false: core, not the tool, is the authority.
 *
 * What never leaves this file: an application's free-form `metadata` blob (neither read nor written),
 * any workflow definition, connection or secret (the workflow engine and the Secret Manager are
 * structurally excluded), and any credential. Free text other people wrote (descriptions, notes,
 * justifications, denial reasons) is wrapped as untrusted content.
 */

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return typeof value === 'object' && value !== null ? (value as Row) : {};
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow) : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A Prisma `Date` (in-process dispatch does not serialize) or an ISO string, as an ISO string. */
function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

/** Keep only the named fields of a row, dates as ISO strings. */
function pick(row: unknown, fields: readonly string[]): Row {
  const source = asRow(row);
  const out: Row = {};
  for (const field of fields) {
    if (field in source) {
      const value = source[field];
      out[field] = value instanceof Date ? value.toISOString() : value;
    }
  }
  return out;
}

/** The status of an HTTP refusal a dispatched handler threw, if it was one. */
function httpStatus(err: unknown): number | undefined {
  return err instanceof HttpException ? err.getStatus() : undefined;
}

/**
 * A facet read the caller may not be allowed to make (a route with another permission than the tool's
 * primary one): its 403 becomes a marker in the result, never a failure of the whole tool.
 */
async function facet<T>(
  read: () => Promise<T>,
): Promise<T | { unavailable: 'FORBIDDEN' }> {
  try {
    return await read();
  } catch (err) {
    if (httpStatus(err) === 403) return { unavailable: 'FORBIDDEN' };
    throw err;
  }
}

/**
 * A Prisma `cuid()` exactly: `c` + 24 lower-case base-36 characters. Deliberately stricter than
 * `z.cuid()` (`^[cC][^\s-]{8,}$`), which takes names such as "Confluence" or "Crowdstrike" for ids. The
 * same test runs in the preview and the run, so both resolve a reference the same way (G2 review F3).
 */
const STRICT_CUID = /^c[a-z0-9]{24}$/;
const isCuid = (value: string) => STRICT_CUID.test(value);

/** A person, in the words a preview or a result states: "you" or "user <id>". */
function who(user: AiResolvedReference): string {
  return user.label === 'me' ? 'you' : `user ${user.id}`;
}

/** A person named by id: "you" when it is the caller, else "user <id>". */
function whoId(rt: AiToolRuntime, id: unknown): string {
  const identity = rt.ctx.identity;
  return identity.kind === 'human' && identity.userId === id
    ? 'you'
    : `user ${String(id)}`;
}

/** `"admin" access` / `access` — the access level as the application names it, when there is one. */
function accessPhrase(level: unknown): string {
  return typeof level === 'string' && level.length > 0
    ? `"${level}" access`
    : 'access';
}

/** What a grant or a revoke will do outside lazyit, in plain words (ADR-0054). */
interface ProvisioningOutlook {
  /** The sentence the preview's `action` row ends with. */
  sentence: string;
  /** Whether to warn EXTERNAL_PROVISIONING / EXTERNAL_DEPROVISIONING: it will, or may, run. */
  external: boolean;
  /** The enabled workflow names the caller may read, as untrusted text (admin-authored). */
  workflows: string[];
}

/**
 * Whether granting (`ACCESS_GRANTED`) or revoking (`ACCESS_REVOKED`) access on an application starts an
 * automatic (de)provisioning workflow. Looked up through the guarded workflow list (`workflow:read`):
 *   - readable → precise: the enabled workflow runs, or nothing happens outside lazyit;
 *   - forbidden → hedged ("may … if a workflow is configured") and still warned — never a detail the
 *     caller could not read;
 *   - a revoke whose user keeps other active grants on the application does not deprovision under the
 *     default LAST_ACTIVE_GRANT policy (`otherActiveGrants`, when the caller may read the access map).
 * Only headers are read: never a definition, a connection or a secret.
 */
async function provisioningOutlook(
  rt: AiToolRuntime,
  applicationId: string,
  appName: string,
  trigger: 'ACCESS_GRANTED' | 'ACCESS_REVOKED',
  otherActiveGrants?: number,
): Promise<ProvisioningOutlook> {
  const revoke = trigger === 'ACCESS_REVOKED';
  const what = revoke
    ? `automatic deprovisioning (removing the account in ${appName})`
    : `automatic provisioning (creating the account in ${appName})`;
  let enabled: Row[];
  try {
    const page = asRow(
      await rt.call(WorkflowsController, 'findAll', {
        query: { applicationId, limit: String(MAX_PAGE_LIMIT) },
      }),
    );
    enabled = asRows(page.items).filter(
      (w) => w.trigger === trigger && w.enabled === true,
    );
  } catch (err) {
    if (httpStatus(err) !== 403) throw err;
    return {
      external: true,
      workflows: [],
      sentence: `This may trigger ${what} if a workflow is configured for this application.`,
    };
  }
  if (enabled.length === 0) {
    return {
      external: false,
      workflows: [],
      sentence: `No automatic ${revoke ? 'deprovisioning' : 'provisioning'} workflow is set up for ${appName}: nothing changes outside lazyit.`,
    };
  }
  const workflows = enabled.map((w) => untrusted(str(w.name)) ?? '(unnamed)');
  if (!revoke) {
    return {
      external: true,
      workflows,
      sentence: `This triggers ${what} after approval, through the workflow set up for ${appName}.`,
    };
  }
  const perGrant = enabled.some((w) => w.deprovisionPolicy === 'EACH_GRANT');
  if (!perGrant && otherActiveGrants !== undefined && otherActiveGrants > 0) {
    return {
      external: false,
      workflows,
      sentence: `The user keeps other access to ${appName}, so its deprovisioning workflow does not run.`,
    };
  }
  return {
    external: true,
    workflows,
    sentence:
      perGrant || otherActiveGrants !== undefined
        ? `This triggers ${what}, through the workflow set up for ${appName}.`
        : `This triggers ${what} if it is the user's last access to ${appName}, through the workflow set up for it.`,
  };
}

// ─── References ──────────────────────────────────────────────────────────────────────────────────────

/** A user reference: an email, an exact full name, an id or `"me"` (see {@link resolveUser}). */
const userReference = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .describe(
    'The user: their email, their exact full name ("Ana Ops"), their id, or "me" for yourself.',
  );

const applicationReference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    'The application: its id or its exact name (case-insensitive). Find it with application_search.',
  );

/** Resolve `"me"` or a user id. `"me"` is the calling human; a Service Account has no person. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Ana Ops <ana@example.com>" — how a directory row is named in a candidate list. */
function personLabel(row: Row): string {
  const name = [str(row.firstName), str(row.lastName)]
    .filter((part): part is string => !!part)
    .join(' ');
  const email = str(row.email);
  return (
    [name || null, email ? `<${email}>` : null].filter(Boolean).join(' ') ||
    String(row.id)
  );
}

/**
 * The users a reference names exactly — an email, or a full name ("Ana Ops") — read through the bound,
 * guarded `GET /users` (`user:read`: a caller without it gets the route's 403, never a match). The route
 * searches first name, last name and email by substring; the match here is exact and case-insensitive.
 *
 * A partial page never decides (the W2-7 rule): when the route reports more rows than the one page read
 * holds, a match could have a twin beyond it, so the reference is refused as `AMBIGUOUS_REFERENCE`
 * ("use the id or email") — unless the page already holds more than one exact match (reported as
 * ambiguous with its candidates by the resolver). An exact EMAIL match stays decisive: emails are unique
 * among live users.
 */
async function lookupUsers(
  rt: AiToolRuntime,
  reference: string,
): Promise<AiReferenceCandidate[]> {
  const wanted = reference.trim().replace(/\s+/g, ' ').toLowerCase();
  const byEmail = wanted.includes('@');
  const page = asRow(
    await rt.call(UsersController, 'findAll', {
      query: {
        q: byEmail ? wanted : wanted.split(' ')[0],
        limit: String(MAX_PAGE_LIMIT),
      },
    }),
  );
  const rows = asRows(page.items);
  const found = rows
    .filter((row) =>
      byEmail
        ? str(row.email)?.toLowerCase() === wanted
        : `${str(row.firstName) ?? ''} ${str(row.lastName) ?? ''}`
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase() === wanted,
    )
    .map((row) => ({ id: String(row.id), label: personLabel(row) }));
  const total = typeof page.total === 'number' ? page.total : rows.length;
  const partial = total > rows.length;
  if (partial && found.length <= 1 && !(byEmail && found.length === 1)) {
    throw new AiReferenceError(
      'AMBIGUOUS_REFERENCE',
      `Too many users match "${reference}" to be sure; use the user's id or email`,
      found.map((c) => ({ type: 'user' as const, ...c })),
    );
  }
  return found;
}

/**
 * Resolve a user: `"me"` (the calling human), an id (passed straight through — the write handler is the
 * authority), or an email / exact full name looked up through the guarded directory list. The preview and
 * the run call this same function, so both resolve a reference the same way.
 */
async function resolveUser(
  rt: AiToolRuntime,
  reference: string,
): Promise<AiResolvedReference> {
  if (reference.trim().toLowerCase() === 'me') {
    const identity = rt.ctx.identity;
    if (identity.kind !== 'human') {
      throw new AiReferenceError(
        'NOT_FOUND',
        '"me" names a person; a Service Account has no user — pass the user id',
      );
    }
    return { type: 'user', id: identity.userId, label: 'me' };
  }
  return rt.resolve({
    type: 'user',
    reference,
    isId: (r) => UUID.test(r),
    lookup: (r) => lookupUsers(rt, r),
  });
}

/** The person a grant names, as the card shows them (G2 review F1, security.md §6.1 chain 1). */
interface Person {
  id: string;
  /** "Ana Ops <ana@example.com>". */
  display: string;
  status: 'active' | 'inactive' | 'directory only' | 'missing';
  usable: boolean;
}

/**
 * Read a user through the guarded `GET /users/:id` (`user:read`), for a preview: name, email and status.
 * A 404 is a `missing` person; any other refusal (a caller without `user:read`) propagates, so an
 * elevated card is never shown without naming who it is for.
 */
async function readPerson(rt: AiToolRuntime, id: string): Promise<Person> {
  let row: Row;
  try {
    row = asRow(await rt.call(UsersController, 'findOne', { params: { id } }));
  } catch (err) {
    if (httpStatus(err) !== 404) throw err;
    return { id, display: `user ${id}`, status: 'missing', usable: false };
  }
  const name = [str(row.firstName), str(row.lastName)]
    .filter((part): part is string => !!part)
    .join(' ');
  const email = str(row.email);
  const display =
    [name || null, email ? `<${email}>` : null].filter(Boolean).join(' ') ||
    `user ${id}`;
  const status =
    row.directoryOnly === true
      ? 'directory only'
      : row.isActive === false
        ? 'inactive'
        : 'active';
  return { id, display, status, usable: status === 'active' };
}

/** Refuse, at propose, to put access in front of a person who cannot use it (G2 review F1). */
function assertUsable(person: Person): void {
  if (person.status === 'missing') {
    throw new NotFoundException(`User ${person.id} not found`);
  }
  if (!person.usable) {
    throw new BadRequestException(
      `${person.display} is ${person.status}: access can only be granted to an active user`,
    );
  }
}

/**
 * Resolve an application by id or exact name, through the bound (guarded) list route — a caller who may
 * not read applications gets the route's 403, never a match.
 */
function resolveApplication(
  rt: AiToolRuntime,
  reference: string,
): Promise<AiResolvedReference> {
  return rt.resolve({
    type: 'application',
    reference,
    isId: isCuid,
    lookup: async (name) => {
      const page = asRow(
        await rt.call(ApplicationsController, 'findAll', {
          query: { q: name, limit: String(MAX_PAGE_LIMIT) },
        }),
      );
      const wanted = name.trim().toLowerCase();
      return asRows(page.items)
        .filter((row) => str(row.name)?.trim().toLowerCase() === wanted)
        .map((row) => ({ id: String(row.id), label: String(row.name) }));
    },
  });
}

/** The live application row, read through its guarded route (404 when missing or archived). */
async function readApplication(rt: AiToolRuntime, id: string): Promise<Row> {
  return asRow(
    await rt.call(ApplicationsController, 'findOne', { params: { id } }),
  );
}

function applicationEntity(app: Row, op: AiEntityRef['op']): AiEntityRef {
  return {
    type: 'application',
    id: String(app.id),
    op,
    ...(str(app.name) ? { label: str(app.name)! } : {}),
  };
}

// ─── Critical applications (ADR-0097 decision 3 as amended, CEO 2026-09-24) ──────────────────────────

const CRITICAL: AiPreviewWarningCode = 'CRITICAL_APPLICATION';

/**
 * Before any side effect of a write on an application: when the application is critical, refuse the
 * write on a channel that cannot confirm it with the password (MCP, headless — `assertChannelAllows`);
 * in the chat the approved preview already carried `CRITICAL_APPLICATION`, so core asked for the step-up.
 *
 * The criticality is read through the guarded `GET /applications/:id`. When it cannot be read (the caller
 * lacks `application:read`) a non-chat write is refused: it cannot be shown not to be critical (fail
 * closed). A missing or archived application is left to the write route's own 400/404.
 */
async function assertCriticalAllowed(
  rt: AiToolRuntime,
  applicationId: string,
  alsoCritical = false,
): Promise<void> {
  // The chat never refuses: the approved preview carried the warning and core required the step-up.
  if (rt.ctx.channel === 'CHAT') return;
  if (alsoCritical) {
    assertChannelAllows(rt.ctx.channel, [CRITICAL]);
    return;
  }
  let critical: boolean;
  try {
    critical = (await readApplication(rt, applicationId)).isCritical === true;
  } catch (err) {
    const status = httpStatus(err);
    if (status === 404) return;
    if (status === 403) throw cannotCheckCritical('application:read');
    throw err;
  }
  if (critical) assertChannelAllows(rt.ctx.channel, [CRITICAL]);
}

/** The sentence a critical application's card ends with. */
function criticalNote(critical: boolean, app: string): string {
  return critical
    ? ` ${app} is a critical application: confirm with your password.`
    : '';
}

/** The fail-closed refusal of a non-chat write whose application's criticality cannot be read. */
function cannotCheckCritical(permission: string): ForbiddenException {
  return new ForbiddenException(
    `Cannot check whether this application is critical (${permission} is needed); do it from the lazyit chat.`,
  );
}

/**
 * The application a grant or a request belongs to, read before a non-chat write to check its
 * criticality. A missing target is left to the write route (its own 404 / 409).
 */
async function applicationOfTarget(
  rt: AiToolRuntime,
  read: () => Promise<Row>,
  permission: string,
): Promise<string | null> {
  if (rt.ctx.channel === 'CHAT') return null;
  try {
    return String((await read()).applicationId);
  } catch (err) {
    const status = httpStatus(err);
    if (status === 404 || status === 409) return null;
    if (status === 403) throw cannotCheckCritical(permission);
    throw err;
  }
}

// ─── Projections ─────────────────────────────────────────────────────────────────────────────────────

const APPLICATION_FIELDS = [
  'id',
  'name',
  'vendor',
  'url',
  'categoryId',
  'isCritical',
  'seatsPurchased',
  'seatsUsed',
  'costPerSeat',
  'renewalDate',
  'updatedAt',
] as const;

function applicationSummary(row: unknown): Row {
  return pick(row, APPLICATION_FIELDS);
}

const GRANT_FIELDS = [
  'id',
  'userId',
  'applicationId',
  'accessLevel',
  'grantedAt',
  'expiresAt',
  'revokedAt',
  'grantedById',
  'revokedById',
] as const;

/** Only the date part of an ISO timestamp, for the plain-language states. */
function day(value: unknown): string | null {
  return iso(value)?.slice(0, 10) ?? null;
}

/**
 * A grant's state in plain words, for an operator who does not read timestamps. `expiresAt` does not end
 * a grant by itself: the expiry sweeper revokes it (access-grant.md), so a past date is still active.
 */
function grantState(row: Row, now: Date = new Date()): string {
  const revokedAt = iso(row.revokedAt);
  if (revokedAt) {
    return row.revokedById
      ? `revoked on ${day(revokedAt)} by user ${str(row.revokedById)}`
      : `revoked on ${day(revokedAt)}`;
  }
  const expiresAt = iso(row.expiresAt);
  if (!expiresAt) return 'active (no end date)';
  return Date.parse(expiresAt) <= now.getTime()
    ? `active, but its end date (${day(expiresAt)}) has passed — it is revoked automatically shortly`
    : `active until ${day(expiresAt)}`;
}

function grantSummary(row: unknown): Row {
  const source = asRow(row);
  const out = pick(source, GRANT_FIELDS);
  out.state = grantState(source);
  out.notes = untrusted(str(source.notes));
  return out;
}

const REQUEST_FIELDS = [
  'id',
  'requesterId',
  'applicationId',
  'accessLevel',
  'status',
  'decidedById',
  'decidedAt',
  'grantId',
  'createdAt',
] as const;

/** A request's state in plain words: who is waiting for whom, or who decided and what came of it. */
function requestState(row: Row): string {
  const by = str(row.decidedById) ? ` by user ${str(row.decidedById)}` : '';
  const on = row.decidedAt ? ` on ${day(row.decidedAt)}` : '';
  if (row.status === 'APPROVED') {
    return `approved${by}${on}; access grant ${String(row.grantId)} was created`;
  }
  if (row.status === 'DENIED') {
    return `denied${by}${on} (see deniedReason)`;
  }
  return 'pending: waiting for someone who can grant access to approve or deny it';
}

function requestSummary(row: unknown): Row {
  const source = asRow(row);
  const out = pick(source, REQUEST_FIELDS);
  out.state = requestState(source);
  out.justification = untrusted(str(source.justification));
  out.deniedReason = untrusted(str(source.deniedReason));
  return out;
}

const pageSize = z
  .number()
  .int()
  .min(1)
  .max(AI_TOOL_LIST_MAX_LIMIT)
  .optional()
  .describe(
    `Page size (default ${AI_TOOL_LIST_DEFAULT_LIMIT}, max ${AI_TOOL_LIST_MAX_LIMIT}).`,
  );
const pageOffset = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Rows to skip (default 0).');

/** Shape a route page (`{ items, total }`) into the tool's page with its truncation marker. */
function pageOutput(
  page: unknown,
  offset: number,
  project: (row: unknown) => Row,
) {
  const source = asRow(page);
  const items = asRows(source.items).map(project);
  const total = typeof source.total === 'number' ? source.total : items.length;
  const nextOffset = offset + items.length;
  return {
    data: { total, offset, items },
    ...(nextOffset < total
      ? { truncated: { shown: items.length, total, nextOffset } }
      : {}),
  };
}

// ─── Applications ────────────────────────────────────────────────────────────────────────────────────

const SORT_FIELDS = Object.keys(APPLICATION_SORT_ALLOWLIST) as [
  string,
  ...string[],
];

const applicationSearch = defineTool({
  name: 'application_search',
  title: 'Search applications',
  description:
    'Search the application catalog (SaaS products, internal systems, VPNs, directory groups — anything a ' +
    'user can be granted access to). `query` matches name, vendor, url and description; omit it to list ' +
    'the whole catalog. Returns a page of ' +
    'applications with their ids, criticality and seat counts. Use it before application_get or any ' +
    'access tool; never guess an id.',
  domain: 'access',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    query: searchText('Case-insensitive text to look for.'),
    sort: z.enum(SORT_FIELDS).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    limit: pageSize,
    offset: pageOffset,
  }),
  bindings: [bind(ApplicationsController, 'findAll')],
  async run(input, rt) {
    const limit = input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const page = await rt.call(ApplicationsController, 'findAll', {
      query: {
        q: input.query,
        sort: input.sort,
        dir: input.dir,
        limit: String(limit),
        offset: String(offset),
      },
    });
    return pageOutput(page, offset, applicationSummary);
  },
});

const applicationGet = defineTool({
  name: 'application_get',
  title: 'Get an application',
  description:
    'One application by id or exact name: what it is, its criticality and license seats, and who holds ' +
    'access to it (active grants; needs permission to read the access map). detail "full" adds its ' +
    'description, notes and the published knowledge-base articles linked to it.',
  domain: 'access',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    application: applicationReference,
    detail: z
      .enum(['concise', 'full'])
      .default('concise')
      .describe('"full" adds the description, notes and linked articles.'),
    includeRevokedGrants: z
      .boolean()
      .default(false)
      .describe('Also list revoked grants (the access history).'),
  }),
  bindings: [
    bind(ApplicationsController, 'findOne'),
    bind(ApplicationsController, 'findAll'),
    bind(ApplicationsController, 'findGrants'),
    bind(ApplicationsController, 'findArticles'),
  ],
  async run(input, rt) {
    const resolved = await resolveApplication(rt, input.application);
    const app = await readApplication(rt, resolved.id);
    const params = { id: resolved.id };
    const grants = await facet(async () =>
      asRows(
        await rt.call(ApplicationsController, 'findGrants', {
          params,
          query: { activeOnly: String(!input.includeRevokedGrants) },
        }),
      ),
    );
    const data: Row = {
      application: applicationSummary(app),
      grants: Array.isArray(grants)
        ? {
            total: grants.length,
            items: grants.slice(0, AI_TOOL_LIST_MAX_LIMIT).map(grantSummary),
          }
        : grants,
    };
    if (input.detail === 'full') {
      (data.application as Row).description = untrusted(str(app.description));
      (data.application as Row).notes = untrusted(str(app.notes));
      data.articles = await facet(async () => {
        const page = asRow(
          await rt.call(ApplicationsController, 'findArticles', {
            params,
            query: { limit: String(AI_TOOL_LIST_DEFAULT_LIMIT) },
          }),
        );
        return {
          total: typeof page.total === 'number' ? page.total : 0,
          items: asRows(page.items).map((a) =>
            pick(a, ['id', 'slug', 'title']),
          ),
        };
      });
    }
    return { data };
  },
});

/** The fields a tool may set on an application — never the free-form `metadata` blob. */
const applicationCreateInput = CreateApplicationSchema.omit({ metadata: true });

const APPLICATION_WRITABLE = [
  'name',
  'description',
  'url',
  'vendor',
  'categoryId',
  'isCritical',
  'notes',
  'seatsPurchased',
  'costPerSeat',
  'renewalDate',
] as const;

const applicationCreate = defineTool({
  name: 'application_create',
  title: 'Create an application',
  description:
    'Add an application to the catalog so access to it can be granted and tracked. Only `name` is ' +
    'required. `url` must be a host (vpn.corp.local, jenkins:8080) or an http(s) url. Costs are integer ' +
    'minor units (cents). Find the category id with reference_lookup.',
  domain: 'access',
  class: 'write',
  input: applicationCreateInput,
  bindings: [bind(ApplicationsController, 'create')],
  async run(input, rt) {
    // Creating a CRITICAL application is a write on a critical application (chat-only, with step-up).
    if (input.isCritical) assertChannelAllows(rt.ctx.channel, [CRITICAL]);
    const app = asRow(
      await rt.call(ApplicationsController, 'create', { body: input }),
    );
    return {
      data: { application: applicationSummary(app) },
      summary: `Added the application "${String(app.name)}" to the catalog.`,
      entityRefs: [applicationEntity(app, 'created')],
    };
  },
  preview(input) {
    const values = input as Row;
    return Promise.resolve({
      changes: [
        {
          field: 'action',
          after:
            `Add the application "${String(values.name)}" to the catalog.` +
            (values.isCritical === true
              ? ' It is marked critical: every later AI change to it needs your password in the chat.'
              : ''),
        },
        ...APPLICATION_WRITABLE.filter((f) => values[f] !== undefined).map(
          (field) => ({ field, after: values[field] }),
        ),
      ],
      warnings: values.isCritical === true ? [CRITICAL] : [],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
    });
  },
});

const applicationUpdateSet = z
  .strictObject({
    name: CreateApplicationSchema.shape.name.optional(),
    description: CreateApplicationSchema.shape.description,
    url: CreateApplicationSchema.shape.url,
    vendor: CreateApplicationSchema.shape.vendor,
    categoryId: CreateApplicationSchema.shape.categoryId,
    isCritical: z.boolean().optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
    seatsPurchased: int4({ min: 0 }).nullable().optional(),
    costPerSeat: int4({ min: 0 }).nullable().optional(),
    renewalDate: z.iso.datetime().nullable().optional(),
  })
  .refine((set) => Object.keys(set).length > 0, {
    error: 'At least one field must be provided to update',
  })
  .describe(
    'Only the fields to change. `null` clears seatsPurchased, costPerSeat or renewalDate.',
  );

const applicationUpdate = defineTool({
  name: 'application_update',
  title: 'Update an application',
  description:
    'Change fields of an application (name, vendor, url, category, criticality, notes, license seats…). ' +
    'Pass only what changes in `set`. The preview shows each value before and after.',
  domain: 'access',
  class: 'write',
  destructive: true,
  input: z.strictObject({
    application: applicationReference,
    set: applicationUpdateSet,
  }),
  bindings: [
    bind(ApplicationsController, 'update'),
    bind(ApplicationsController, 'findOne'),
    bind(ApplicationsController, 'findAll'),
  ],
  async run(input, rt) {
    const resolved = await resolveApplication(rt, input.application);
    // Critical now, or made critical by this change: chat-only (with step-up).
    await assertCriticalAllowed(rt, resolved.id, input.set.isCritical === true);
    const app = asRow(
      await rt.call(ApplicationsController, 'update', {
        params: { id: resolved.id },
        body: input.set,
      }),
    );
    return {
      data: { application: applicationSummary(app) },
      summary: `Updated the application "${String(app.name)}" (${Object.keys(input.set).join(', ')}).`,
      entityRefs: [applicationEntity(app, 'updated')],
    };
  },
  async preview(input, rt) {
    const resolved = await resolveApplication(rt, input.application);
    const current = await readApplication(rt, resolved.id);
    const target = applicationEntity(current, 'updated');
    const set = input.set as Row;
    return {
      target,
      changes: [
        {
          field: 'action',
          after:
            `Change ${Object.keys(set).join(', ')} of the application "${String(current.name)}".` +
            (current.isCritical === true || set.isCritical === true
              ? ' It is a critical application: confirm with your password.'
              : ''),
        },
        ...APPLICATION_WRITABLE.filter((f) => f in set).map((field) => ({
          field,
          before:
            current[field] instanceof Date
              ? iso(current[field])
              : (current[field] ?? null),
          after: set[field],
        })),
      ],
      warnings:
        current.isCritical === true || set.isCritical === true
          ? [CRITICAL]
          : [],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
      precondition: { entity: target, updatedAt: iso(current.updatedAt)! },
    };
  },
});

// ─── Access grants ───────────────────────────────────────────────────────────────────────────────────

const accessGrantList = defineTool({
  name: 'access_grant_list',
  title: 'List access grants',
  description:
    'Who has access to what: access grants, newest first, filtered by user and/or application. Active ' +
    'grants only by default; activeOnly=false adds the revoked history. Answers "what can this person ' +
    'access?" and "who can reach this application?".',
  domain: 'access',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    user: userReference.optional(),
    application: applicationReference.optional(),
    activeOnly: z
      .boolean()
      .default(true)
      .describe('false also lists revoked grants.'),
    includeExpired: z
      .boolean()
      .default(true)
      .describe('false hides active grants already past their expiry date.'),
    limit: pageSize,
    offset: pageOffset,
  }),
  bindings: [
    bind(AccessGrantsController, 'findAll'),
    bind(ApplicationsController, 'findAll'),
    bind(UsersController, 'findAll'),
  ],
  async run(input, rt) {
    const limit = input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const user = input.user ? await resolveUser(rt, input.user) : undefined;
    const application = input.application
      ? await resolveApplication(rt, input.application)
      : undefined;
    const page = await rt.call(AccessGrantsController, 'findAll', {
      query: {
        userId: user?.id,
        applicationId: application?.id,
        activeOnly: String(input.activeOnly),
        includeExpired: String(input.includeExpired),
        limit: String(limit),
        offset: String(offset),
      },
    });
    return pageOutput(page, offset, grantSummary);
  },
});

/** Access levels whose grant nudges the admins (`admin_granted`, AccessGrantsService). */
const ADMIN_LEVELS = new Set(['admin', 'administrator']);

const accessGrantCreate = defineTool({
  name: 'access_grant_create',
  title: 'Grant access to an application',
  description:
    'Give a user access to an application (open an access grant). This GRANTS PRIVILEGE: the person ' +
    'approving confirms with their password. It may start the application’s automatic provisioning ' +
    'workflow (creating the account in the external system). A user may hold several grants on one application at different ' +
    'access levels. `accessLevel` is free text the application defines (admin, developer, viewer…).',
  domain: 'access',
  class: 'elevated',
  externalEffects: true,
  input: z.strictObject({
    user: userReference,
    application: applicationReference,
    accessLevel: z.string().trim().min(1).max(100).optional(),
    expiresAt: z.iso
      .datetime()
      .optional()
      .describe('When the grant ends (ISO date-time); it is revoked then.'),
    notes: z.string().trim().min(1).max(2000).optional(),
  }),
  bindings: [
    bind(AccessGrantsController, 'create'),
    bind(ApplicationsController, 'findOne'),
    bind(ApplicationsController, 'findAll'),
    bind(AccessGrantsController, 'findAll'),
    bind(WorkflowsController, 'findAll'),
    bind(UsersController, 'findOne'),
    bind(UsersController, 'findAll'),
  ],
  async run(input, rt) {
    const user = await resolveUser(rt, input.user);
    const application = await resolveApplication(rt, input.application);
    await assertCriticalAllowed(rt, application.id);
    const grant = asRow(
      await rt.call(AccessGrantsController, 'create', {
        body: {
          userId: user.id,
          applicationId: application.id,
          ...(input.accessLevel !== undefined
            ? { accessLevel: input.accessLevel }
            : {}),
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      }),
    );
    return {
      data: { grant: grantSummary(grant) },
      summary: `Granted ${who(user)} ${accessPhrase(grant.accessLevel)} to ${application.label ?? `application ${application.id}`}.`,
      entityRefs: [
        {
          type: 'accessGrant',
          id: String(grant.id),
          op: 'created',
          parent: { type: 'application', id: application.id },
        },
        entityRefOf(application, 'updated'),
        entityRefOf(user, 'updated'),
      ],
    };
  },
  async preview(input, rt): Promise<AiToolPreview> {
    const user = await resolveUser(rt, input.user);
    const grantee = await readPerson(rt, user.id);
    assertUsable(grantee);
    const resolved = await resolveApplication(rt, input.application);
    const app = await readApplication(rt, resolved.id);
    const target = applicationEntity(app, 'updated');
    const existing = await facet(async () =>
      asRow(
        await rt.call(AccessGrantsController, 'findAll', {
          query: {
            userId: user.id,
            applicationId: resolved.id,
            activeOnly: 'true',
            limit: '1',
          },
        }),
      ),
    );
    const appName = str(app.name) ?? resolved.id;
    const outlook = await provisioningOutlook(
      rt,
      resolved.id,
      appName,
      'ACCESS_GRANTED',
    );
    const warnings: AiPreviewWarningCode[] = ['PRIVILEGE_GRANT'];
    if (outlook.external) warnings.push('EXTERNAL_PROVISIONING');
    const adminLevel =
      input.accessLevel !== undefined &&
      ADMIN_LEVELS.has(input.accessLevel.trim().toLowerCase());
    if (app.isCritical === true || adminLevel) warnings.push('NOTIFIES_USERS');
    if (app.isCritical === true) warnings.push(CRITICAL);
    const until = input.expiresAt ? ` until ${day(input.expiresAt)}` : '';
    const self = whoId(rt, user.id) === 'you';
    const changes: AiToolPreview['changes'] = [
      {
        field: 'action',
        after:
          (self ? 'You are granting access to yourself. ' : '') +
          `Give ${self ? 'yourself' : grantee.display} ${accessPhrase(input.accessLevel)} to ${appName}${until}. ` +
          outlook.sentence +
          criticalNote(app.isCritical === true, appName),
      },
      {
        field: 'user',
        after: self ? `${grantee.display} (you)` : grantee.display,
        valueKind: 'entity',
      },
      { field: 'userStatus', after: grantee.status },
      { field: 'userId', after: user.id },
      {
        field: 'application',
        after: str(app.name) ?? resolved.id,
        valueKind: 'entity',
      },
      {
        field: 'isCritical',
        after: app.isCritical === true,
        valueKind: 'boolean',
      },
      { field: 'accessLevel', after: input.accessLevel ?? null },
      { field: 'expiresAt', after: input.expiresAt ?? null, valueKind: 'date' },
    ];
    if (input.notes !== undefined) {
      changes.push({ field: 'notes', after: input.notes });
    }
    if (outlook.workflows.length > 0) {
      changes.push({ field: 'workflow', after: outlook.workflows.join(', ') });
    }
    const total = asRow(existing).total;
    if (typeof total === 'number') {
      changes.push({
        field: 'userActiveGrantsOnApplication',
        before: total,
        after: total + 1,
        valueKind: 'number',
      });
    }
    return {
      target,
      changes,
      warnings,
      impacted: [
        {
          type: 'user',
          count: 1,
          sample: [{ ...entityRefOf(user, 'updated'), label: grantee.display }],
        },
      ],
      untrustedSources: [],
      elevated: true,
      // Core derives the step-up from PRIVILEGE_GRANT; the tool never decides it (Opción 2).
      stepUpRequired: false,
      precondition: { entity: target, updatedAt: iso(app.updatedAt)! },
    };
  },
});

const accessGrantRevoke = defineTool({
  name: 'access_grant_revoke',
  title: 'Revoke an access grant',
  description:
    'End an active access grant (it stays in the history as revoked). It may start the application’s ' +
    'deprovisioning workflow (removing the account in the external system) when it was the user’s last ' +
    'active grant there. Other grants the user holds on the application are untouched. Find the grant id ' +
    'with access_grant_list.',
  domain: 'access',
  class: 'write',
  destructive: true,
  externalEffects: true,
  input: z.strictObject({
    grantId: z.cuid().describe('The grant id (from access_grant_list).'),
    notes: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe('Why it is revoked; replaces the grant’s notes.'),
  }),
  bindings: [
    bind(AccessGrantsController, 'revoke'),
    bind(AccessGrantsController, 'findOne'),
    bind(ApplicationsController, 'findOne'),
    bind(AccessGrantsController, 'findAll'),
    bind(WorkflowsController, 'findAll'),
    bind(UsersController, 'findOne'),
  ],
  async run(input, rt) {
    const ofGrant = await applicationOfTarget(
      rt,
      async () =>
        asRow(
          await rt.call(AccessGrantsController, 'findOne', {
            params: { id: input.grantId },
          }),
        ),
      'accessGrant:read',
    );
    if (ofGrant) await assertCriticalAllowed(rt, ofGrant);
    const grant = asRow(
      await rt.call(AccessGrantsController, 'revoke', {
        params: { id: input.grantId },
        body: input.notes !== undefined ? { notes: input.notes } : {},
      }),
    );
    const applicationId = String(grant.applicationId);
    return {
      data: { grant: grantSummary(grant) },
      summary: `Revoked ${whoId(rt, grant.userId)}'s ${accessPhrase(grant.accessLevel)} to application ${applicationId}.`,
      entityRefs: [
        {
          type: 'accessGrant',
          id: String(grant.id),
          op: 'updated',
          parent: { type: 'application', id: applicationId },
        },
        { type: 'application', id: applicationId, op: 'updated' },
        { type: 'user', id: String(grant.userId), op: 'updated' },
      ],
    };
  },
  async preview(input, rt): Promise<AiToolPreview> {
    const grant = asRow(
      await rt.call(AccessGrantsController, 'findOne', {
        params: { id: input.grantId },
      }),
    );
    if (grant.revokedAt !== null && grant.revokedAt !== undefined) {
      throw new ConflictException(
        `AccessGrant ${input.grantId} is already revoked`,
      );
    }
    const applicationId = String(grant.applicationId);
    // The application may have been archived since the grant: the grant is still revocable.
    let appName: string | null = null;
    let critical = false;
    try {
      const app = await readApplication(rt, applicationId);
      appName = str(app.name);
      critical = app.isCritical === true;
    } catch (err) {
      if (httpStatus(err) !== 404) throw err;
    }
    const target: AiEntityRef = {
      type: 'accessGrant',
      id: input.grantId,
      op: 'updated',
      label: `${appName ?? applicationId}${str(grant.accessLevel) ? ` (${str(grant.accessLevel)})` : ''}`,
      parent: { type: 'application', id: applicationId },
    };
    const name = appName ?? `application ${applicationId}`;
    // Who loses access, by name when the caller may read the directory (a revoke never needs it to run).
    const person = await facet(() => readPerson(rt, String(grant.userId)));
    const loser =
      whoId(rt, grant.userId) === 'you'
        ? 'you'
        : 'display' in person
          ? person.display
          : `user ${String(grant.userId)}`;
    // The user's active grants on the application, this one included (403 → unknown).
    const active = await facet(async () =>
      asRow(
        await rt.call(AccessGrantsController, 'findAll', {
          query: {
            userId: String(grant.userId),
            applicationId,
            activeOnly: 'true',
            limit: '1',
          },
        }),
      ),
    );
    const activeTotal = asRow(active).total;
    const outlook = await provisioningOutlook(
      rt,
      applicationId,
      name,
      'ACCESS_REVOKED',
      typeof activeTotal === 'number'
        ? Math.max(activeTotal - 1, 0)
        : undefined,
    );
    const changes: AiToolPreview['changes'] = [
      {
        field: 'action',
        after:
          `Remove ${loser === 'you' ? 'your' : `${loser}'s`} ${accessPhrase(grant.accessLevel)} to ${name}. ` +
          outlook.sentence +
          criticalNote(critical, name),
      },
      { field: 'user', after: loser, valueKind: 'entity' },
      ...('status' in person
        ? [{ field: 'userStatus', after: person.status }]
        : []),
      { field: 'userId', after: String(grant.userId) },
      {
        field: 'application',
        after: appName ?? applicationId,
        valueKind: 'entity',
      },
      { field: 'accessLevel', after: grant.accessLevel ?? null },
      { field: 'isCritical', after: critical, valueKind: 'boolean' },
      { field: 'status', before: 'active', after: 'revoked' },
    ];
    // The revoke REPLACES the grant's notes: show what is lost (other-authored → untrusted; G2 review F7).
    const replacesNotes =
      input.notes !== undefined && str(grant.notes) !== null;
    if (input.notes !== undefined) {
      changes.push({
        field: 'notes',
        before: untrusted(str(grant.notes)),
        after: input.notes,
      });
    }
    if (outlook.workflows.length > 0) {
      changes.push({ field: 'workflow', after: outlook.workflows.join(', ') });
    }
    return {
      target,
      changes,
      warnings: [
        ...(outlook.external ? (['EXTERNAL_DEPROVISIONING'] as const) : []),
        ...(critical ? [CRITICAL] : []),
      ],
      impacted: [
        {
          type: 'user',
          count: 1,
          sample: [{ type: 'user', id: String(grant.userId), op: 'updated' }],
        },
      ],
      untrustedSources: replacesNotes
        ? [{ type: 'accessGrant', id: input.grantId, op: 'updated' }]
        : [],
      elevated: false,
      stepUpRequired: false,
      precondition: { entity: target, updatedAt: iso(grant.updatedAt)! },
    };
  },
});

// ─── Access requests ─────────────────────────────────────────────────────────────────────────────────

const accessRequestList = defineTool({
  name: 'access_request_list',
  title: 'List access requests',
  description:
    'Self-service access requests, newest first: who asked for which application, why, and whether it ' +
    'was approved or denied. Filter by status, application or requester. mine=true lists only your own ' +
    'requests (any person may read their own; the estate-wide list needs permission to read requests).',
  domain: 'access',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    mine: z
      .boolean()
      .default(false)
      .describe('Only your own requests (ignores the other filters).'),
    status: z.enum(AccessRequestStatusSchema.options).optional(),
    application: applicationReference.optional(),
    requester: userReference.optional(),
    limit: pageSize,
    offset: pageOffset,
  }),
  bindings: [
    bind(AccessRequestsController, 'findAll'),
    bind(AccessRequestsController, 'findMine'),
    bind(ApplicationsController, 'findAll'),
    bind(UsersController, 'findAll'),
  ],
  async run(input, rt) {
    const limit = input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const window = { limit: String(limit), offset: String(offset) };
    if (input.mine) {
      const page = await rt.call(AccessRequestsController, 'findMine', {
        query: window,
      });
      return pageOutput(page, offset, requestSummary);
    }
    const requester = input.requester
      ? await resolveUser(rt, input.requester)
      : undefined;
    const application = input.application
      ? await resolveApplication(rt, input.application)
      : undefined;
    const page = await rt.call(AccessRequestsController, 'findAll', {
      query: {
        status: input.status,
        applicationId: application?.id,
        requesterId: requester?.id,
        ...window,
      },
    });
    return pageOutput(page, offset, requestSummary);
  },
});

const accessRequestCreate = defineTool({
  name: 'access_request_create',
  title: 'Request access to an application',
  description:
    'Ask for access to an application for yourself. The people who can grant access are notified and ' +
    'approve or deny it. One open request per application: a second one is refused while the first is ' +
    'pending.',
  domain: 'access',
  class: 'write',
  input: z.strictObject({
    application: applicationReference,
    accessLevel: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'The access level asked for (the application’s own word: admin, viewer…).',
      ),
    justification: z.string().trim().min(1).max(2000).optional(),
  }),
  bindings: [
    bind(AccessRequestsController, 'create'),
    bind(ApplicationsController, 'findAll'),
    bind(ApplicationsController, 'findOne'),
  ],
  async run(input, rt) {
    const application = await resolveApplication(rt, input.application);
    const request = asRow(
      await rt.call(AccessRequestsController, 'create', {
        body: {
          applicationId: application.id,
          ...(input.accessLevel !== undefined
            ? { accessLevel: input.accessLevel }
            : {}),
          ...(input.justification !== undefined
            ? { justification: input.justification }
            : {}),
        },
      }),
    );
    return {
      data: { request: requestSummary(request) },
      summary: `Requested ${accessPhrase(request.accessLevel)} to ${application.label ?? `application ${application.id}`}; it now waits for an approver.`,
      entityRefs: [
        {
          type: 'accessRequest',
          id: String(request.id),
          op: 'created',
          parent: { type: 'application', id: application.id },
        },
      ],
    };
  },
  async preview(input, rt): Promise<AiToolPreview> {
    const resolved = await resolveApplication(rt, input.application);
    const app = await readApplication(rt, resolved.id);
    const appName = str(app.name) ?? resolved.id;
    return {
      changes: [
        {
          field: 'action',
          after:
            `Ask for ${accessPhrase(input.accessLevel)} to ${appName} for yourself. ` +
            'The people who can grant access are notified and approve or deny it.',
        },
        { field: 'application', after: appName, valueKind: 'entity' },
        { field: 'accessLevel', after: input.accessLevel ?? null },
        { field: 'justification', after: input.justification ?? null },
      ],
      warnings: ['NOTIFIES_USERS'],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
    };
  },
});

/** Pages of the (unpaged-by-id) request list scanned to find one request: 5 × 200 per status slice. */
const REQUEST_SCAN_PAGES = 5;

/**
 * One access request by id. The API has no `GET /access-requests/:id`, so it is found through the
 * guarded list route (`accessRequest:read`): the PENDING slice first (the one a decision acts on), then
 * the whole list — bounded, newest first. A decided request is the route's own 409.
 */
async function findRequest(rt: AiToolRuntime, id: string): Promise<Row> {
  for (const status of ['PENDING', undefined]) {
    for (let page = 0; page < REQUEST_SCAN_PAGES; page += 1) {
      const result = asRow(
        await rt.call(AccessRequestsController, 'findAll', {
          query: {
            status,
            limit: String(MAX_PAGE_LIMIT),
            offset: String(page * MAX_PAGE_LIMIT),
          },
        }),
      );
      const items = asRows(result.items);
      const hit = items.find((row) => row.id === id);
      if (hit) {
        if (hit.status !== 'PENDING') {
          throw new ConflictException(
            `AccessRequest ${id} has already been decided (${String(hit.status)})`,
          );
        }
        return hit;
      }
      if (items.length < MAX_PAGE_LIMIT) break;
    }
  }
  throw new NotFoundException(`AccessRequest ${id} not found`);
}

const accessRequestDecide = defineTool({
  name: 'access_request_decide',
  title: 'Approve or deny an access request',
  description:
    'Decide a pending access request. "approve" GRANTS the requested access (an access grant is created; ' +
    'the person approving confirms with their password; it may start the application’s automatic ' +
    'provisioning workflow). ' +
    '"deny" requires a reason, which the requester sees. Both notify the requester. Find the request id ' +
    'with access_request_list (status PENDING).',
  domain: 'access',
  class: 'elevated',
  externalEffects: true,
  input: z
    .strictObject({
      requestId: z
        .cuid()
        .describe('The request id (from access_request_list).'),
      decision: z.enum(['approve', 'deny']),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          'Required to deny, refused to approve; the requester sees it.',
        ),
    })
    .refine((v) => (v.decision === 'deny') === (v.reason !== undefined), {
      error: 'A denial needs a reason; an approval takes none',
      path: ['reason'],
    }),
  bindings: [
    bind(AccessRequestsController, 'approve'),
    bind(AccessRequestsController, 'deny'),
    bind(AccessRequestsController, 'findAll'),
    bind(ApplicationsController, 'findOne'),
    bind(WorkflowsController, 'findAll'),
    bind(UsersController, 'findOne'),
  ],
  async run(input, rt) {
    const params = { id: input.requestId };
    const ofRequest = await applicationOfTarget(
      rt,
      () => findRequest(rt, input.requestId),
      'accessRequest:read',
    );
    if (ofRequest) await assertCriticalAllowed(rt, ofRequest);
    const request = asRow(
      input.decision === 'approve'
        ? await rt.call(AccessRequestsController, 'approve', { params })
        : await rt.call(AccessRequestsController, 'deny', {
            params,
            body: { reason: input.reason ?? '' },
          }),
    );
    const applicationId = String(request.applicationId);
    const refs: AiEntityRef[] = [
      {
        type: 'accessRequest',
        id: input.requestId,
        op: 'updated',
        parent: { type: 'application', id: applicationId },
      },
    ];
    if (typeof request.grantId === 'string') {
      refs.push({
        type: 'accessGrant',
        id: request.grantId,
        op: 'created',
        parent: { type: 'application', id: applicationId },
      });
    }
    const summary =
      input.decision === 'approve'
        ? `Approved the request: ${whoId(rt, request.requesterId)} now has ${accessPhrase(request.accessLevel)} to application ${applicationId} (grant ${String(request.grantId)}).`
        : `Denied the request of ${whoId(rt, request.requesterId)} for application ${applicationId}; they are notified with the reason.`;
    return {
      data: { request: requestSummary(request) },
      summary,
      entityRefs: refs,
    };
  },
  async preview(input, rt): Promise<AiToolPreview> {
    const request = await findRequest(rt, input.requestId);
    const applicationId = String(request.applicationId);
    let appName: string | null = null;
    let critical = false;
    try {
      const app = await readApplication(rt, applicationId);
      appName = str(app.name);
      critical = app.isCritical === true;
    } catch (err) {
      // An archived application: the approval itself will be refused by the route (400).
      if (httpStatus(err) !== 404) throw err;
    }
    const approve = input.decision === 'approve';
    const person = await readPerson(rt, String(request.requesterId));
    // Approving grants access: the requester must still be an active user. Denying stays possible.
    if (approve) assertUsable(person);
    const target: AiEntityRef = {
      type: 'accessRequest',
      id: input.requestId,
      op: 'updated',
      label: `${appName ?? applicationId} — ${person.display}`,
      parent: { type: 'application', id: applicationId },
    };
    const name = appName ?? `application ${applicationId}`;
    const requester =
      whoId(rt, request.requesterId) === 'you' ? 'you' : person.display;
    // Nothing stops an approver deciding their own request (route behaviour, ADR-0085); say it plainly.
    const own =
      requester === 'you' ? 'You are deciding your own request. ' : '';
    const outlook = approve
      ? await provisioningOutlook(rt, applicationId, name, 'ACCESS_GRANTED')
      : null;
    const changes: AiToolPreview['changes'] = [
      {
        field: 'action',
        after: approve
          ? `${own}Approve the request: give ${requester} ${accessPhrase(request.accessLevel)} to ${name}. ` +
            `An access grant is created and ${requester} ${requester === 'you' ? 'are' : 'is'} notified. ` +
            outlook!.sentence +
            criticalNote(critical, name)
          : `${own}Deny ${requester === 'you' ? 'your' : `${requester}'s`} request for ${accessPhrase(request.accessLevel)} to ${name}. ` +
            `${requester === 'you' ? 'You are' : `${requester} is`} notified with your reason.` +
            criticalNote(critical, name),
      },
      {
        field: 'requester',
        after: requester === 'you' ? `${person.display} (you)` : person.display,
        valueKind: 'entity',
      },
      { field: 'requesterStatus', after: person.status },
      { field: 'requesterId', after: String(request.requesterId) },
      {
        field: 'application',
        after: appName ?? applicationId,
        valueKind: 'entity',
      },
      { field: 'isCritical', after: critical, valueKind: 'boolean' },
      { field: 'accessLevel', after: request.accessLevel ?? null },
      { field: 'justification', after: untrusted(str(request.justification)) },
      {
        field: 'status',
        before: 'PENDING',
        after: approve ? 'APPROVED' : 'DENIED',
      },
    ];
    if (!approve) {
      changes.push({ field: 'deniedReason', after: input.reason });
    }
    if (outlook && outlook.workflows.length > 0) {
      changes.push({ field: 'workflow', after: outlook.workflows.join(', ') });
    }
    const warnings: AiPreviewWarningCode[] = approve
      ? ['PRIVILEGE_GRANT', 'NOTIFIES_USERS']
      : ['NOTIFIES_USERS'];
    if (outlook?.external) warnings.splice(1, 0, 'EXTERNAL_PROVISIONING');
    // Approving AND denying on a critical application need the password (CEO decision).
    if (critical) warnings.push(CRITICAL);
    return {
      target,
      changes,
      // Approving GRANTS access (PRIVILEGE_GRANT → core requires the step-up); both notify the requester.
      warnings,
      impacted: approve
        ? [
            {
              type: 'user',
              count: 1,
              sample: [
                {
                  type: 'user',
                  id: String(request.requesterId),
                  op: 'updated',
                  label: person.display,
                },
              ],
            },
          ]
        : [],
      // The card shows the requester's own justification: other-authored text (G2 review F2).
      untrustedSources: [
        { type: 'accessRequest', id: input.requestId, op: 'updated' },
      ],
      elevated: true,
      stepUpRequired: false,
      // A pending request never changes until it is decided (no `updatedAt`; `createdAt` is its version).
      // A decision in between is the route's 409 when the preview re-runs at approve.
      precondition: { entity: target, updatedAt: iso(request.createdAt)! },
    };
  },
});

export const accessToolset: AiToolset = {
  domain: 'access',
  tools: [
    applicationSearch,
    applicationGet,
    applicationCreate,
    applicationUpdate,
    accessGrantList,
    accessGrantCreate,
    accessGrantRevoke,
    accessRequestList,
    accessRequestCreate,
    accessRequestDecide,
  ],
  unexposed: [
    unexposed(
      ApplicationsController,
      ['remove', 'restore'],
      'Deferred to v1.1: application archive and restore (tools-and-execution.md §3, §7).',
    ),
    unexposed(
      AccessGrantsController,
      ['batchRevoke', 'updateNotes', 'updateExpiry'],
      'Deferred to v1.1: grant batch revoke (blast radius), notes and expiry edits (tools-and-execution.md §3, §7).',
    ),
  ],
};
