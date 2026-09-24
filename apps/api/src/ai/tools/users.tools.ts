import { BadRequestException, HttpException } from '@nestjs/common';
import { z } from 'zod';
import {
  EmailSchema,
  LegajoSchema,
  RoleSchema,
  UsernameSchema,
  type AiActionPreview,
  type AiEntityRef,
  type AiPreviewWarningCode,
} from '@lazyit/shared';
import { UsersController } from '../../users/users.controller';
import { USER_SORT_ALLOWLIST } from '../../users/users.service';
import {
  AI_TOOL_LIST_DEFAULT_LIMIT,
  AI_TOOL_LIST_MAX_LIMIT,
} from '../ai.constants';
import type {
  AiReferenceCandidate,
  AiResolvedReference,
} from '../core/reference-resolver';
import { untrusted } from '../core/result-shaper';
import {
  bind,
  defineTool,
  unexposed,
  type AiToolPreview,
  type AiToolRuntime,
  type AiToolset,
} from '../core/tool-descriptor';

/**
 * The USERS toolset (W2-9; tools-and-execution.md §7 rows 37–42): the directory and the user lifecycle.
 *
 * Every call goes through `rt.call` — the route's own guards, pipes and `UsersService` logic, as the
 * principal — so the RBAC safety guards live in exactly one place and a tool cannot skip them: the
 * self-role-change refusal (403), the last-admin guard on demotion, deactivation and offboarding (409,
 * SEC-021) and the manager cycle check (400) all run inside the route the tool calls.
 *
 * Classes (security.md §6.2 T3): creating a user, editing one and restoring an offboarded one are
 * `elevated`. Their previews carry `ROLE_CHANGE` for a role change and `IDENTITY_CHANGE` for any change to
 * who the account is or whether it can sign in; core derives the password step-up from those codes (CEO
 * decision 2026-09-24, "Opción 2"), so the previews leave `stepUpRequired` to core. Offboarding is a
 * destructive, cascading `write` (T2) whose preview lists what it releases and revokes.
 *
 * What never leaves this file: the IdP linkage (`externalId`), any credential material, and the
 * Secret-vault names an offboarding returns (Secret Manager adjacency, ADR-0061 — only counts). No tool
 * accepts a password: the create route's optional temporary password is a credential (INV-AI-5), and the
 * credential-returning handlers are structural exclusions.
 */

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return typeof value === 'object' && value !== null ? (value as Row) : {};
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow) : [];
}

/** Keep only the named fields of a row (a concise projection; unknown rows become `{}`). */
function pick(row: unknown, fields: readonly string[]): Row {
  const source = asRow(row);
  const out: Row = {};
  for (const field of fields) {
    if (field in source) out[field] = source[field];
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A handler's date (a `Date` in-process, a string over the wire) as ISO-8601, or null. */
function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How the model names a user (tools-and-execution.md §7 "References"). */
const userRef = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .describe(
    'The user: id, email, username, legajo (employee number) or "me" (the person you act for).',
  );

/** "Ana Ops <ana@example.com>" — what a person recognizes on a card or a chip. */
function userLabel(row: Row): string {
  const name = [str(row.firstName), str(row.lastName)]
    .filter((part): part is string => !!part)
    .join(' ');
  const email = str(row.email);
  return email ? `${name} <${email}>`.trim() : name || String(row.id);
}

function userRefOf(row: Row, op: AiEntityRef['op']): AiEntityRef {
  return { type: 'user', id: String(row.id), op, label: userLabel(row) };
}

/** The manager descriptor the route resolves (display fields only, ADR-0058). */
function managerOf(value: unknown): Row | null {
  const manager = asRow(value);
  if (manager.type === 'user') {
    return pick(manager, [
      'type',
      'id',
      'firstName',
      'lastName',
      'isOffboarded',
    ]);
  }
  if (manager.type === 'external') return pick(manager, ['type', 'name']);
  return null;
}

function managerText(value: unknown): string | null {
  const manager = asRow(value);
  if (manager.type === 'user') {
    return `${str(manager.firstName) ?? ''} ${str(manager.lastName) ?? ''}`.trim();
  }
  return manager.type === 'external' ? str(manager.name) : null;
}

/** The concise user shape every tool shares. Never `externalId`, a hash, an epoch or a credential flag. */
function userSummary(row: Row): Row {
  return {
    ...pick(row, [
      'id',
      'email',
      'firstName',
      'lastName',
      'role',
      'isActive',
      'directoryOnly',
      'legajo',
      'username',
    ]),
    manager: managerOf(row.manager),
    ...(row.deletedAt ? { archivedAt: iso(row.deletedAt) } : {}),
  };
}

/** `detail: full` adds the timestamps and the imported directory attributes (free text: untrusted). */
function userFull(row: Row): Row {
  const attrs = row.directoryAttrs;
  return {
    ...userSummary(row),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    directoryAttrs:
      attrs && typeof attrs === 'object' && Object.keys(attrs).length > 0
        ? untrusted(JSON.stringify(attrs))
        : null,
  };
}

// ─── Reference resolution (always through the bound, guarded list route) ──────────────────────────

/** The list route's page size cap, and how many pages a username / legajo lookup may scan. */
const DIRECTORY_PAGE = 200;
const DIRECTORY_SCAN_PAGES = 5;

type DirectorySlice = 'active' | 'only';

/**
 * The users matching `reference` exactly, read through `GET /users` as the caller (so a caller without
 * `user:read`, or without ADMIN for the archived slice, gets the route's 403). An email uses the route's
 * search; a username or legajo — which the route does not search — scans a bounded number of pages.
 */
async function lookupUsers(
  rt: AiToolRuntime,
  reference: string,
  slice: DirectorySlice,
): Promise<AiReferenceCandidate[]> {
  const wanted = reference.toLowerCase();
  const candidate = (row: Row): AiReferenceCandidate => ({
    id: String(row.id),
    label: userLabel(row),
  });
  if (reference.includes('@')) {
    const page = await rt.call(UsersController, 'findAll', {
      query: { q: reference, deleted: slice, limit: String(DIRECTORY_PAGE) },
    });
    return asRows(page.items)
      .filter((row) => str(row.email)?.toLowerCase() === wanted)
      .map(candidate);
  }
  const found: AiReferenceCandidate[] = [];
  for (let pageNo = 0; pageNo < DIRECTORY_SCAN_PAGES; pageNo += 1) {
    const offset = pageNo * DIRECTORY_PAGE;
    const page = await rt.call(UsersController, 'findAll', {
      query: {
        deleted: slice,
        limit: String(DIRECTORY_PAGE),
        offset: String(offset),
        sort: 'createdAt',
        dir: 'asc',
      },
    });
    const rows = asRows(page.items);
    for (const row of rows) {
      if (
        str(row.username)?.toLowerCase() === wanted ||
        str(row.legajo) === reference
      ) {
        found.push(candidate(row));
      }
    }
    const total = typeof page.total === 'number' ? page.total : 0;
    if (rows.length === 0 || offset + rows.length >= total) break;
  }
  return found;
}

/** Resolve a user reference; `"me"` is the human caller (a Service Account has no "me"). */
async function resolveUser(
  rt: AiToolRuntime,
  reference: string,
  slice: DirectorySlice = 'active',
): Promise<AiResolvedReference> {
  if (reference.trim().toLowerCase() === 'me') {
    const identity = rt.ctx.identity;
    if (identity.kind !== 'human') {
      throw new BadRequestException(
        '"me" names a signed-in person; a Service Account must name the user by id or email.',
      );
    }
    return { type: 'user', id: identity.userId };
  }
  return rt.resolve({
    type: 'user',
    reference,
    isId: (r) => UUID.test(r),
    lookup: (r) => lookupUsers(rt, r, slice),
  });
}

/** The live user a reference names, as the route returns it (404 when missing or offboarded). */
async function readUser(rt: AiToolRuntime, reference: string): Promise<Row> {
  const resolved = await resolveUser(rt, reference);
  return asRow(
    await rt.call(UsersController, 'findOne', { params: { id: resolved.id } }),
  );
}

/** The optimistic-concurrency anchor every targeted preview carries (§9 "Approve" step 3). */
function preconditionOf(target: AiEntityRef, row: Row) {
  const updatedAt = iso(row.updatedAt);
  if (!updatedAt) {
    throw new Error('The user row has no updatedAt');
  }
  return { entity: target, updatedAt };
}

/** A facet the caller may lack (`accessGrant:read` on the grants facet): a 403 becomes `null`. */
async function optionalFacet<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof HttpException && err.getStatus() === 403) return null;
    throw err;
  }
}

// ─── Inputs shared by create and update ───────────────────────────────────────────────────────────

const managerInput = z
  .union([
    z.strictObject({
      user: userRef.describe(
        'The manager, a lazyit user: id, email, username or legajo.',
      ),
    }),
    z.strictObject({
      name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('The manager as free text, when they are not a lazyit user.'),
    }),
  ])
  .describe('The manager: a lazyit user, or a free-text name.');
type ManagerInput = z.output<typeof managerInput>;

/**
 * The route's `manager` body for a manager input (the user reference resolved through the list). A
 * preview also wants a label a person recognizes: a manager named by raw id is read through `findOne`
 * (so a missing one fails the preview as the route's 404).
 */
async function managerBody(
  rt: AiToolRuntime,
  manager: ManagerInput | null,
  options: { label?: boolean } = {},
): Promise<{
  body: { managerId: string } | { managerName: string } | null;
  label: string | null;
}> {
  if (manager === null) return { body: null, label: null };
  if ('name' in manager) {
    return { body: { managerName: manager.name }, label: manager.name };
  }
  const resolved = await resolveUser(rt, manager.user);
  let label = resolved.label ?? resolved.id;
  if (options.label && resolved.label === undefined) {
    const row = asRow(
      await rt.call(UsersController, 'findOne', {
        params: { id: resolved.id },
      }),
    );
    label = userLabel(row);
  }
  return { body: { managerId: resolved.id }, label };
}

const firstName = z.string().trim().min(1).max(100);
const lastName = z.string().trim().min(1).max(100);

const pageSize = z
  .number()
  .int()
  .min(1)
  .max(AI_TOOL_LIST_MAX_LIMIT)
  .optional()
  .describe(
    `Page size (default ${AI_TOOL_LIST_DEFAULT_LIMIT}, max ${AI_TOOL_LIST_MAX_LIMIT}).`,
  );

const SORT_FIELDS = Object.keys(USER_SORT_ALLOWLIST) as [
  keyof typeof USER_SORT_ALLOWLIST,
  ...(keyof typeof USER_SORT_ALLOWLIST)[],
];

const detail = z
  .enum(['concise', 'full'])
  .default('concise')
  .describe('"full" adds timestamps, directory attributes and the lists.');

// ─── Reads ────────────────────────────────────────────────────────────────────────────────────────

const userSearch = defineTool({
  name: 'user_search',
  title: 'Search users',
  description:
    'Search the user directory: people with a login and directory-only persons (imported, no login). ' +
    '`query` matches first name, last name and email (every word must match). Filter by role or by ' +
    'directory-only; `archived: true` lists offboarded users instead (administrators only). Returns a ' +
    'page with ids, roles, activation state and how many assets and application accesses each person ' +
    'holds. Use it to find a user before user_get or a user write; never guess an id.',
  domain: 'users',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Case-insensitive words to look for.'),
    role: RoleSchema.optional(),
    directoryOnly: z
      .boolean()
      .optional()
      .describe(
        'true: only directory persons (no login); false: only accounts.',
      ),
    archived: z
      .boolean()
      .default(false)
      .describe('true lists offboarded users (administrators only).'),
    sort: z.enum(SORT_FIELDS).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    limit: pageSize,
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Rows to skip (default 0).'),
  }),
  bindings: [bind(UsersController, 'findAll')],
  async run(input, rt) {
    const limit = input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const page = await rt.call(UsersController, 'findAll', {
      query: {
        q: input.query,
        role: input.role,
        directoryOnly:
          input.directoryOnly === undefined
            ? undefined
            : String(input.directoryOnly),
        deleted: input.archived ? 'only' : 'active',
        sort: input.sort,
        dir: input.dir,
        limit: String(limit),
        offset: String(offset),
      },
    });
    const items = asRows(page.items).map((row) => ({
      ...userSummary(row),
      ...pick(row, ['assetsInPossession', 'appAccesses']),
    }));
    const total = typeof page.total === 'number' ? page.total : items.length;
    const nextOffset = offset + items.length;
    return {
      data: { total, offset, items },
      ...(nextOffset < total
        ? { truncated: { shown: items.length, total, nextOffset } }
        : {}),
    };
  },
});

const userGet = defineTool({
  name: 'user_get',
  title: 'Get a user',
  description:
    'One live user by id, email, username, legajo or "me": profile, role, activation state, manager, ' +
    'and what they hold — active asset assignments and active application access grants (the grants ' +
    'need accessGrant:read; without it they are reported as unavailable). detail "full" lists them ' +
    '(up to 50 each) and adds timestamps and directory attributes. Offboarded users are not found here: ' +
    'use user_search with archived true.',
  domain: 'users',
  class: 'read',
  idempotent: true,
  input: z.strictObject({ user: userRef, detail }),
  bindings: [
    bind(UsersController, 'findOne'),
    bind(UsersController, 'findAll'),
    bind(UsersController, 'findAssignments'),
    bind(UsersController, 'findAccessGrants'),
  ],
  async run(input, rt) {
    const user = await readUser(rt, input.user);
    const params = { id: String(user.id) };
    const assignments = asRows(
      await rt.call(UsersController, 'findAssignments', {
        params,
        query: { activeOnly: 'true' },
      }),
    );
    const grants = await optionalFacet(async () =>
      asRows(
        await rt.call(UsersController, 'findAccessGrants', {
          params,
          query: { activeOnly: 'true' },
        }),
      ),
    );
    const full = input.detail === 'full';
    const data: Row = {
      user: full ? userFull(user) : userSummary(user),
      assignments: {
        total: assignments.length,
        ...(full
          ? {
              items: assignments.slice(0, AI_TOOL_LIST_MAX_LIMIT).map((a) => ({
                ...pick(a, ['id', 'assetId']),
                assignedAt: iso(a.assignedAt),
                acknowledgedAt: iso(a.acknowledgedAt),
                notes: untrusted(str(a.notes)),
              })),
            }
          : {}),
      },
      accessGrants:
        grants === null
          ? { unavailable: 'Requires the accessGrant:read permission.' }
          : {
              total: grants.length,
              ...(full
                ? {
                    items: grants.slice(0, AI_TOOL_LIST_MAX_LIMIT).map((g) => ({
                      ...pick(g, ['id', 'applicationId', 'accessLevel']),
                      grantedAt: iso(g.grantedAt),
                      expiresAt: iso(g.expiresAt),
                      notes: untrusted(str(g.notes)),
                    })),
                  }
                : {}),
            },
    };
    return { data };
  },
});

// ─── Writes ───────────────────────────────────────────────────────────────────────────────────────

/** The preview fields core fills or derives; tools only set what they decide. */
function previewOf(
  parts: Pick<AiToolPreview, 'changes' | 'warnings'> &
    Partial<Pick<AiToolPreview, 'target' | 'precondition' | 'impacted'>>,
  elevated: boolean,
): AiToolPreview {
  return {
    impacted: [],
    untrustedSources: [],
    ...parts,
    elevated,
    // Derived by core from the warnings (AI_STEP_UP_WARNINGS): ROLE_CHANGE and IDENTITY_CHANGE require
    // the password step-up whatever a tool says here, and a tool may only add it, never remove it.
    stepUpRequired: false,
  };
}

type Change = AiActionPreview['changes'][number];

const userCreate = defineTool({
  name: 'user_create',
  title: 'Create a user',
  description:
    'Create a user account (administrators). Takes email, first and last name, and optionally a role ' +
    '(default VIEWER, read-only), username, legajo and manager. No password is set here: the person ' +
    'signs in through the identity provider, or an administrator provisions their credential in the ' +
    'lazyit UI. Creating an identity is an elevated action: the person you act for confirms it with ' +
    'their password.',
  domain: 'users',
  class: 'elevated',
  input: z.strictObject({
    email: EmailSchema,
    firstName,
    lastName,
    role: RoleSchema.optional().describe(
      'ADMIN, MEMBER or VIEWER (default VIEWER).',
    ),
    username: UsernameSchema.optional(),
    legajo: LegajoSchema.optional().describe('The employee number.'),
    manager: managerInput.optional(),
  }),
  bindings: [
    bind(UsersController, 'create'),
    bind(UsersController, 'findAll'),
    bind(UsersController, 'findOne'),
  ],
  async preview(input, rt) {
    const manager = await managerBody(rt, input.manager ?? null, {
      label: true,
    });
    const role = input.role ?? 'VIEWER';
    const changes: Change[] = [
      { field: 'email', after: input.email },
      { field: 'firstName', after: input.firstName },
      { field: 'lastName', after: input.lastName },
      { field: 'role', after: role },
      ...(input.username !== undefined
        ? [{ field: 'username', after: input.username }]
        : []),
      ...(input.legajo !== undefined
        ? [{ field: 'legajo', after: input.legajo }]
        : []),
      ...(manager.label !== null
        ? [{ field: 'manager', after: manager.label }]
        : []),
    ];
    const warnings: AiPreviewWarningCode[] = ['IDENTITY_CHANGE'];
    // Anything above the least-privileged default is a privilege decision (ROLE_CHANGE).
    if (role !== 'VIEWER') warnings.push('ROLE_CHANGE');
    return previewOf({ changes, warnings }, true);
  },
  async run(input, rt) {
    const manager = await managerBody(rt, input.manager ?? null);
    const created = asRow(
      await rt.call(UsersController, 'create', {
        body: {
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.username !== undefined ? { username: input.username } : {}),
          ...(input.legajo !== undefined ? { legajo: input.legajo } : {}),
          ...(manager.body !== null ? { manager: manager.body } : {}),
        },
      }),
    );
    return {
      data: userSummary(created),
      summary: `Created ${userLabel(created)} as ${String(created.role)}.`,
      entityRefs: [userRefOf(created, 'created')],
    };
  },
});

const USER_UPDATE_FIELDS = [
  'email',
  'firstName',
  'lastName',
  'role',
  'isActive',
  'username',
  'legajo',
  'manager',
] as const;

const userUpdate = defineTool({
  name: 'user_update',
  title: 'Update a user',
  description:
    'Edit a user (administrators): email, first or last name, role, username, legajo, manager, or ' +
    'activation (isActive false disables sign-in and ends their sessions; true re-enables it). Send ' +
    'only what changes; null clears username, legajo or manager. lazyit refuses to change your own ' +
    'role and to demote or deactivate the last active administrator. Role and identity changes are ' +
    'elevated: the person you act for confirms them with their password. To offboard someone use ' +
    'user_offboard.',
  domain: 'users',
  class: 'elevated',
  destructive: true,
  input: z
    .strictObject({
      user: userRef,
      email: EmailSchema.optional(),
      firstName: firstName.optional(),
      lastName: lastName.optional(),
      role: RoleSchema.optional(),
      isActive: z
        .boolean()
        .optional()
        .describe('false disables sign-in; true re-enables it.'),
      username: UsernameSchema.nullable().optional(),
      legajo: LegajoSchema.nullable()
        .optional()
        .describe('The employee number (null clears it).'),
      manager: managerInput.nullable().optional(),
    })
    .refine(
      (input) => USER_UPDATE_FIELDS.some((field) => input[field] !== undefined),
      { message: 'Name at least one field to change.' },
    ),
  bindings: [
    bind(UsersController, 'update'),
    bind(UsersController, 'findOne'),
    bind(UsersController, 'findAll'),
  ],
  async preview(input, rt) {
    const current = await readUser(rt, input.user);
    const changes: Change[] = [];
    const warnings = new Set<AiPreviewWarningCode>();
    const differs = (
      field: 'email' | 'firstName' | 'lastName' | 'username' | 'legajo',
    ) =>
      input[field] !== undefined && input[field] !== (current[field] ?? null);

    if (input.role !== undefined && input.role !== current.role) {
      changes.push({ field: 'role', before: current.role, after: input.role });
      warnings.add('ROLE_CHANGE');
    }
    for (const field of [
      'email',
      'firstName',
      'lastName',
      'username',
      'legajo',
    ] as const) {
      if (differs(field)) {
        changes.push({
          field,
          before: current[field] ?? null,
          after: input[field] ?? null,
        });
        warnings.add('IDENTITY_CHANGE');
      }
    }
    if (input.isActive !== undefined && input.isActive !== current.isActive) {
      changes.push({
        field: 'isActive',
        before: current.isActive,
        after: input.isActive,
        valueKind: 'boolean',
      });
      // Whether the account can sign in at all: an identity change (deactivation also ends its sessions).
      warnings.add('IDENTITY_CHANGE');
    }
    if (input.manager !== undefined) {
      const manager = await managerBody(rt, input.manager, { label: true });
      const before = managerText(current.manager);
      if (manager.label !== before) {
        changes.push({ field: 'manager', before, after: manager.label });
        // Who a person reports to is a directory identity attribute of the account.
        warnings.add('IDENTITY_CHANGE');
      }
    }
    if (changes.length === 0) {
      throw new BadRequestException(
        'Nothing to change: every value given already matches the user.',
      );
    }
    // A role, name or email change on an IdP-linked account is mirrored to the identity provider.
    const mirrored = changes.some((c) =>
      ['role', 'email', 'firstName', 'lastName'].includes(c.field),
    );
    if (mirrored && current.externalId) warnings.add('EXTERNAL_PROVISIONING');

    const target = userRefOf(current, 'updated');
    return previewOf(
      {
        target,
        changes,
        warnings: [...warnings],
        precondition: preconditionOf(target, current),
      },
      true,
    );
  },
  async run(input, rt) {
    const resolved = await resolveUser(rt, input.user);
    const manager =
      input.manager === undefined
        ? undefined
        : (await managerBody(rt, input.manager)).body;
    const body: Row = {};
    for (const field of [
      'email',
      'firstName',
      'lastName',
      'role',
      'isActive',
      'username',
      'legajo',
    ] as const) {
      if (input[field] !== undefined) body[field] = input[field];
    }
    if (manager !== undefined) body.manager = manager;
    const updated = asRow(
      await rt.call(UsersController, 'update', {
        params: { id: resolved.id },
        body,
      }),
    );
    return {
      data: userSummary(updated),
      summary: `Updated ${userLabel(updated)}.`,
      entityRefs: [userRefOf(updated, 'updated')],
    };
  },
});

const userOffboard = defineTool({
  name: 'user_offboard',
  title: 'Offboard a user',
  description:
    'Offboard (archive) a user who left (administrators), in one step: their active application ' +
    'access grants are revoked, their assigned assets are released back to inventory, their Secret ' +
    'Manager vault memberships are dropped, their sessions end and, when linked, their identity-provider ' +
    'account is deactivated. It can be undone only partly: user_restore brings the account back but ' +
    'not the grants or the assets. lazyit refuses to offboard the last active administrator.',
  domain: 'users',
  class: 'write',
  destructive: true,
  externalEffects: true,
  input: z.strictObject({ user: userRef }),
  bindings: [
    bind(UsersController, 'offboard'),
    bind(UsersController, 'findOne'),
    bind(UsersController, 'findAll'),
    bind(UsersController, 'findAssignments'),
    bind(UsersController, 'findAccessGrants'),
  ],
  async preview(input, rt) {
    const current = await readUser(rt, input.user);
    const params = { id: String(current.id) };
    const assignments = asRows(
      await rt.call(UsersController, 'findAssignments', {
        params,
        query: { activeOnly: 'true' },
      }),
    );
    // Without accessGrant:read the grants cannot be counted: warn anyway (the cascade still runs).
    const grants = await optionalFacet(async () =>
      asRows(
        await rt.call(UsersController, 'findAccessGrants', {
          params,
          query: { activeOnly: 'true' },
        }),
      ),
    );
    const warnings: AiPreviewWarningCode[] = ['SOFT_DELETE'];
    const impacted: AiToolPreview['impacted'] = [];
    if (assignments.length > 0) {
      warnings.push('CASCADE_RELEASES_ASSIGNMENTS');
      impacted.push({
        type: 'asset',
        count: assignments.length,
        sample: assignments.slice(0, 5).map((a) => ({
          type: 'asset' as const,
          id: String(a.assetId),
          op: 'updated' as const,
        })),
      });
    }
    if (grants === null || grants.length > 0) {
      warnings.push('CASCADE_REVOKES_GRANTS');
    }
    if (grants && grants.length > 0) {
      impacted.push({
        type: 'accessGrant',
        count: grants.length,
        sample: grants.slice(0, 5).map((g) => ({
          type: 'accessGrant' as const,
          id: String(g.id),
          op: 'updated' as const,
          parent: { type: 'application' as const, id: String(g.applicationId) },
        })),
      });
    }
    if (current.externalId) warnings.push('EXTERNAL_DEPROVISIONING');

    const target = userRefOf(current, 'archived');
    return previewOf(
      {
        target,
        changes: [{ field: 'status', before: 'active', after: 'offboarded' }],
        warnings,
        impacted,
        precondition: preconditionOf(target, current),
      },
      false,
    );
  },
  async run(input, rt) {
    const resolved = await resolveUser(rt, input.user);
    const result = asRow(
      await rt.call(UsersController, 'offboard', {
        params: { id: resolved.id },
      }),
    );
    const released = asRows(result.releasedAssignments);
    const revokedGrants =
      typeof result.revokedGrants === 'number' ? result.revokedGrants : 0;
    const vaults = asRows(result.rotationVaults);
    return {
      data: {
        userId: resolved.id,
        releasedAssignments: released.length,
        releasedAssetIds: released.map((a) => a.assetId),
        revokedGrants,
        revokedVaultMemberships: result.revokedVaultMemberships ?? 0,
        // Secret Manager adjacency (ADR-0061): the count only, never vault names.
        vaultsToRotate: vaults.length,
      },
      summary:
        `Offboarded ${resolved.label ?? resolved.id}: released ${released.length} asset(s), revoked ` +
        `${revokedGrants} access grant(s).` +
        (vaults.length > 0
          ? ` They could read ${vaults.length} Secret Manager vault(s): an administrator should rotate those secrets in the lazyit UI.`
          : ''),
      entityRefs: [
        {
          type: 'user',
          id: resolved.id,
          op: 'archived',
          ...(resolved.label ? { label: resolved.label } : {}),
        },
        ...released.map((a) => ({
          type: 'asset' as const,
          id: String(a.assetId),
          op: 'updated' as const,
        })),
      ],
    };
  },
});

/** An offboarded user, read through the archived slice of the list (administrators only). */
async function readArchivedUser(
  rt: AiToolRuntime,
  reference: string,
): Promise<Row> {
  const resolved = await resolveUser(rt, reference, 'only');
  const page = await rt.call(UsersController, 'findAll', {
    query: { ids: resolved.id, deleted: 'only', limit: '1' },
  });
  const [row] = asRows(page.items);
  if (!row) {
    throw new BadRequestException(
      `No offboarded user matches "${reference}": only an archived user can be restored.`,
    );
  }
  return row;
}

const userRestore = defineTool({
  name: 'user_restore',
  title: 'Restore an offboarded user',
  description:
    'Bring back an offboarded user (administrators): the account exists and can sign in again. It does ' +
    'NOT restore the access grants or asset assignments offboarding removed — re-grant and re-assign ' +
    'them deliberately. Name the user by id or email (find them with user_search archived true). ' +
    'Restoring sign-in is elevated: the person you act for confirms it with their password.',
  domain: 'users',
  class: 'elevated',
  input: z.strictObject({ user: userRef }),
  bindings: [
    bind(UsersController, 'restore'),
    bind(UsersController, 'findAll'),
  ],
  async preview(input, rt) {
    const current = await readArchivedUser(rt, input.user);
    const target = userRefOf(current, 'restored');
    return previewOf(
      {
        target,
        changes: [
          { field: 'status', before: 'offboarded', after: 'active' },
          // The role the account comes back with (unchanged by the restore).
          { field: 'role', after: current.role },
        ],
        warnings: ['IDENTITY_CHANGE'],
        precondition: preconditionOf(target, current),
      },
      true,
    );
  },
  async run(input, rt) {
    const resolved = await resolveUser(rt, input.user, 'only');
    const restored = asRow(
      await rt.call(UsersController, 'restore', {
        params: { id: resolved.id },
      }),
    );
    return {
      data: userSummary(restored),
      summary: `Restored ${userLabel(restored)}. Access grants and asset assignments were not restored.`,
      entityRefs: [userRefOf(restored, 'restored')],
    };
  },
});

/**
 * The users toolset. `UsersController.me` is bound by `session_context` (context.tools.ts).
 */
export const usersToolset: AiToolset = {
  domain: 'users',
  tools: [
    userSearch,
    userGet,
    userCreate,
    userUpdate,
    userOffboard,
    userRestore,
  ],
  unexposed: [
    unexposed(
      UsersController,
      ['roleCounts'],
      'Not in the v1 cut (tools-and-execution.md §7): user_search with a role filter returns the same count as its total.',
    ),
    unexposed(
      UsersController,
      ['remove'],
      'The DELETE alias of offboard: user_offboard binds the intention-revealing POST :id/offboard (same handler logic).',
    ),
    unexposed(
      UsersController,
      ['clone'],
      'Deferred to v1.1: user clone (tools-and-execution.md §3, §7).',
    ),
    unexposed(
      UsersController,
      ['provisionAccount', 'passwordResetCapabilities'],
      'Deferred to v1.1 as elevated with step-up, only where no credential is returned (tools-and-execution.md §3, §7 "elevated, after v1").',
    ),
    unexposed(
      UsersController,
      ['resetPassword', 'provisionLocalAccount'],
      'Excluded: may return a temporary password in cleartext (ADR-0097 decision 11; structural exclusion).',
    ),
  ],
};
