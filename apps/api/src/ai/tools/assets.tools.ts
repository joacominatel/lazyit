import { BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import {
  AssetStatusSchema,
  AssetWarrantyFilterSchema,
  type AiActionPreview,
  type AiEntityRef,
} from '@lazyit/shared';
import { AssetAssignmentsController } from '../../asset-assignments/asset-assignments.controller';
import { AssetModelsController } from '../../asset-models/asset-models.controller';
import { AssetsController } from '../../assets/assets.controller';
import { ASSET_SORT_ALLOWLIST } from '../../assets/assets.service';
import { AssetAttachmentsController } from '../../attachments/asset-attachments.controller';
import { LocationsController } from '../../locations/locations.controller';
import { UsersController } from '../../users/users.controller';
import { AI_TOOL_LIST_DEFAULT_LIMIT } from '../ai.constants';
import {
  AiReferenceError,
  AI_AMBIGUITY_SAMPLE,
  type AiResolvedReference,
} from '../core/reference-resolver';
import { untrusted } from '../core/result-shaper';
import {
  bind,
  defineTool,
  unexposed,
  type AiToolRuntime,
  type AiToolset,
} from '../core/tool-descriptor';
import { searchText } from './search-text';
import {
  asRow,
  asRows,
  createdFields,
  createPreview,
  detailLevel,
  entityValue,
  exactOnPage,
  flatSpecs,
  isCuidId,
  isUuidId,
  iso,
  modelLabel,
  orNull,
  pageLimit,
  pageOffset,
  pageTruncation,
  pick,
  referenceString,
  resolveLocation,
  resolveModel,
  RESOLVE_PAGE,
  sameText,
  str,
  untrustedJson,
  type Row,
} from './reference.tools';

/**
 * The ASSETS toolset (W2-5; tools-and-execution.md §7 rows 7–14): the asset register and its ownership.
 * Asset is the first-class citizen; ownership is the timestamped `AssetAssignment` join, never a column —
 * so checking an asset out opens an assignment and checking it in releases one (asset-centric.md).
 *
 * Every call goes through `rt.call` — the route's own guards, pipes and controller logic, as the
 * principal. Writes carry a server-built preview (before → after, and the target's `updatedAt` as the
 * precondition an approval re-checks). References are human-readable (§7): an asset by id, asset tag or
 * serial; a person by id, email, exact name or `"me"`; a model or location by id or exact name — each
 * resolved through a handler the tool binds, so a resolution the caller may not read fails as the route
 * would. Free text other people wrote (notes, specs, history payloads) is wrapped as untrusted.
 */

// ─── Labels and projections ──────────────────────────────────────────────────────────────────────────

/**
 * Did a reporting agent write this asset's name or serial? An infra node AUTO-CREATES its backing asset
 * from what the host reported (the name is the hostname; `specs._infraAutoCreated` marks it), and an
 * agent-LINKED asset has its specs (`specs.host`) and possibly its serial synced from reports — text the
 * host chose for itself (mirrors `infra.tools.ts`). `null` when the row carries no specs at all (the lean
 * list row), i.e. the route does not say.
 */
function agentWritten(asset: Row): boolean | null {
  if (!('specs' in asset)) return null;
  const specs = asRow(asset.specs);
  return (
    specs._infraAutoCreated === true ||
    (typeof specs.host === 'object' && specs.host !== null)
  );
}

/**
 * `Laptop (LT-0042)`: how a person recognizes an asset — its name and its tag, else its serial. When an
 * agent may have written the name or serial (or the row does not say), only the tag — which lazyit or an
 * operator issued — is used, so a hostname never reaches a label, a summary or an ambiguity hint.
 */
function assetLabel(asset: Row): string {
  const tag = str(asset.assetTag);
  if (agentWritten(asset) !== false) return tag ?? `asset ${String(asset.id)}`;
  const name = str(asset.name) ?? String(asset.id);
  const code = tag ?? str(asset.serial);
  return code ? `${name} (${code})` : name;
}

/** The asset's own fields; the name and serial wrapped as untrusted unless an operator wrote them. */
function assetCore(asset: Row, extra: readonly string[] = []): Row {
  const out = pick(asset, [...ASSET_CORE, ...extra]);
  if (agentWritten(asset) !== false) {
    if ('name' in out) out.name = untrusted(str(out.name));
    if ('serial' in out) out.serial = untrusted(str(out.serial));
  }
  return out;
}

function personName(user: Row): string {
  return `${str(user.firstName) ?? ''} ${str(user.lastName) ?? ''}`.trim();
}

/** `Ana Ops <ana@example.com>`. */
function userLabel(user: Row): string {
  const name = personName(user);
  const email = str(user.email);
  if (!email) return name || String(user.id);
  return name ? `${name} <${email}>` : email;
}

/** An inlined active owner: the assignment and who holds it. */
function owner(assignment: Row): Row {
  const user = asRow(assignment.user);
  return {
    assignmentId: assignment.id,
    userId: assignment.userId,
    name: personName(user),
    email: user.email ?? null,
    ...(user.deletedAt ? { departed: true } : {}),
  };
}

const ASSET_CORE = [
  'id',
  'name',
  'assetTag',
  'serial',
  'status',
  'company',
  'purchaseDate',
  'warrantyEnd',
];

/** One row of `asset_search`. */
function searchItem(row: Row): Row {
  const model = row.model ? asRow(row.model) : null;
  const location = row.location ? asRow(row.location) : null;
  return {
    ...assetCore(row),
    ...(row.deletedAt ? { archivedAt: iso(row.deletedAt) } : {}),
    model: model
      ? {
          ...pick(model, ['id', 'name', 'manufacturer']),
          category: model.category
            ? pick(model.category, ['id', 'name'])
            : null,
        }
      : null,
    location: location ? pick(location, ['id', 'name', 'type']) : null,
    owners: asRows(row.activeAssignments).map(owner),
  };
}

/** The lean asset a write returns. */
function writtenAsset(row: Row): Row {
  return assetCore(row, ['modelId', 'locationId', 'updatedAt', 'deletedAt']);
}

function assetRef(asset: Row, op: AiEntityRef['op']): AiEntityRef {
  return { type: 'asset', id: String(asset.id), op, label: assetLabel(asset) };
}

// ─── References ──────────────────────────────────────────────────────────────────────────────────────

/**
 * An asset by id, asset tag or serial (§7). A tag or serial is found through `GET /assets?q=` and matched
 * exactly (case-insensitive) — the route's `q` is a substring search, so a partial tag never resolves.
 * With `withLabel: false` a raw id passes straight to the write handler; the preview always reads it.
 */
function resolveAsset(
  rt: AiToolRuntime,
  reference: string,
  withLabel: boolean,
): Promise<AiResolvedReference> {
  return rt.resolve({
    type: 'asset',
    reference,
    ...(withLabel ? {} : { isId: isCuidId }),
    lookup: async (ref) => {
      if (isCuidId(ref)) {
        const asset = await orNull(() =>
          rt.call(AssetsController, 'findOne', { params: { id: ref } }),
        );
        return asset ? [{ id: asset.id, label: assetLabel(asRow(asset)) }] : [];
      }
      const page = await rt.call(AssetsController, 'findAll', {
        query: { q: ref, limit: RESOLVE_PAGE },
      });
      return exactOnPage(
        page,
        (a) => sameText(a.assetTag, ref) || sameText(a.serial, ref),
        ref,
        "give the asset's id (from asset_search)",
      ).map((a) => ({ id: String(a.id), label: assetLabel(a) }));
    },
  });
}

/** How many archived pages a restore by raw id scans (newest-archived first) before giving up. */
const ARCHIVED_SCAN_PAGES = 5;

/**
 * An ARCHIVED asset by id, tag or serial, through `GET /assets?deleted=only` — the only read that returns
 * a soft-deleted asset (ADMIN-only by role, unlike the restore route — tools-and-execution.md §8.1, F5). A
 * tag or serial is a `q` search; a raw id scans the
 * newest-archived pages, since the list has no id filter.
 */
async function findArchived(rt: AiToolRuntime, ref: string): Promise<Row[]> {
  const list = (query: Record<string, string>) =>
    rt.call(AssetsController, 'findAll', {
      query: { deleted: 'only', limit: RESOLVE_PAGE, ...query },
    });
  if (!isCuidId(ref)) {
    const page = await list({ q: ref });
    return exactOnPage(
      page,
      (a) => sameText(a.assetTag, ref) || sameText(a.serial, ref),
      ref,
      "give the archived asset's id (from asset_search with archived: true)",
    );
  }
  const size = Number(RESOLVE_PAGE);
  for (let i = 0; i < ARCHIVED_SCAN_PAGES; i += 1) {
    const page = await list({
      offset: String(i * size),
      sort: 'updatedAt',
      dir: 'desc',
    });
    const hit = asRows(page.items).find((a) => a.id === ref);
    if (hit) return [hit];
    if ((i + 1) * size >= page.total) return [];
  }
  // Not among the newest-archived pages, and more archived assets exist: it cannot be confirmed either
  // way, so ask for a reference the search can match exactly instead of answering "not found".
  throw new AiReferenceError(
    'AMBIGUOUS_REFERENCE',
    `Asset ${ref} is not among the ${ARCHIVED_SCAN_PAGES * size} most recently archived assets; give its asset tag or serial`,
  );
}

/**
 * A person by id, email, exact full name or `"me"` (§7), through `GET /users` (`user:read`) — or
 * `GET /users/me` for `"me"`, which a Service Account has no answer to (the route refuses it). A
 * username or legajo matches only when the route's `q` (name and email) surfaced the row.
 */
function resolveUser(
  rt: AiToolRuntime,
  reference: string,
  withLabel: boolean,
): Promise<AiResolvedReference> {
  return rt.resolve({
    type: 'user',
    reference,
    ...(withLabel ? {} : { isId: isUuidId }),
    lookup: async (ref) => {
      if (ref.toLowerCase() === 'me') {
        const me = asRow(await rt.call(UsersController, 'me'));
        return [{ id: String(me.id), label: userLabel(me) }];
      }
      const page = isUuidId(ref)
        ? await rt.call(UsersController, 'findAll', {
            query: { ids: ref, limit: '1' },
          })
        : await rt.call(UsersController, 'findAll', {
            query: { q: ref, limit: RESOLVE_PAGE },
          });
      return exactOnPage(
        page,
        (u) =>
          u.id === ref ||
          sameText(u.email, ref) ||
          sameText(personName(u), ref) ||
          sameText(u.username, ref) ||
          sameText(u.legajo, ref),
        ref,
        "give the person's email or user id",
      ).map((u) => ({ id: String(u.id), label: userLabel(u) }));
    },
  });
}

// ─── Shared input pieces ─────────────────────────────────────────────────────────────────────────────

const assetReference = referenceString(
  'The asset: its id, asset tag or serial.',
);
const personReference = referenceString(
  'The person: their user id, email, exact full name, or "me" for yourself.',
);
const money = z
  .number()
  .int()
  .min(0)
  .max(2_147_483_647)
  .describe('In minor units (cents) of the instance currency.');
const months = z.number().int().min(0).max(2_147_483_647);
const dateTime = z.iso
  .datetime()
  .describe('An ISO-8601 date-time, e.g. 2026-01-31T00:00:00.000Z.');

const editableFields = {
  name: z.string().trim().min(1).max(200),
  status: AssetStatusSchema,
  assetTag: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('The physical label; unique among live assets.'),
  serial: z.string().trim().min(1).max(200),
  company: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('A grouping value, not an access boundary.'),
  notes: z.string().trim().min(1).max(2000),
  purchaseDate: dateTime,
  warrantyEnd: dateTime,
  model: referenceString('The asset model: its id or exact name.'),
  location: referenceString('The location: its id or exact name.'),
};

/** The route body's scalar fields (everything but the references and specs). */
const SCALAR_FIELDS = [
  'name',
  'status',
  'assetTag',
  'serial',
  'company',
  'notes',
  'purchaseDate',
  'warrantyEnd',
  'purchaseCost',
  'usefulLifeMonths',
  'salvageValue',
] as const;

const VALUE_KINDS: Readonly<Record<string, 'date' | 'number' | 'text'>> = {
  purchaseDate: 'date',
  warrantyEnd: 'date',
  purchaseCost: 'number',
  usefulLifeMonths: 'number',
  salvageValue: 'number',
};

function scalarBody(input: Row): Row {
  const body: Row = {};
  for (const field of SCALAR_FIELDS) {
    if (input[field] !== undefined) body[field] = input[field];
  }
  return body;
}

type Change = AiActionPreview['changes'][number];

function sameValue(rawBefore: unknown, after: unknown): boolean {
  // A Decimal or bigint compares by its value, as the wire would carry it.
  const before = iso(rawBefore);
  if (before === after) return true;
  if (typeof before === 'string' && typeof after === 'number') {
    return before === String(after);
  }
  if (typeof before === 'string' && typeof after === 'string') {
    const a = Date.parse(before);
    const b = Date.parse(after);
    // Two spellings of the same instant are no change.
    return /^\d{4}-\d\d-\d\dT/.test(before) && !Number.isNaN(a) && a === b;
  }
  return false;
}

/**
 * Spec keys an AI edit may not set: `host` carries the facts a reporting agent owns (it rewrites them on
 * every report), and an `_`-prefixed key is provenance (`_infraAutoCreated`, which decides whether
 * detaching the node soft-deletes the asset). Refused on input, so no tool can forge or strip them.
 */
const RESERVED_SPEC_KEY = (key: string): boolean =>
  key.startsWith('_') || key.trim().toLowerCase() === 'host';

function refuseReservedSpecKeys(
  specs: Readonly<Record<string, unknown>> | undefined,
  ctx: z.RefinementCtx,
): void {
  for (const key of Object.keys(specs ?? {})) {
    if (RESERVED_SPEC_KEY(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['specs', key],
        message:
          'reserved: "host" and "_"-prefixed attributes belong to the reporting agent and lazyit',
      });
    }
  }
}

// ─── asset_search ────────────────────────────────────────────────────────────────────────────────────

const SORT_FIELDS = Object.keys(ASSET_SORT_ALLOWLIST) as [
  keyof typeof ASSET_SORT_ALLOWLIST,
  ...(keyof typeof ASSET_SORT_ALLOWLIST)[],
];

const assetSearchInput = z
  .strictObject({
    query: searchText(
      'Substring of the name, serial, asset tag, or the model name or manufacturer.',
    ),
    status: AssetStatusSchema.optional(),
    modelId: z
      .cuid()
      .optional()
      .describe('Exact model (see reference_lookup).'),
    categoryId: z.cuid().optional().describe("The model's asset category."),
    locationId: z.cuid().optional(),
    company: z.string().trim().min(1).max(200).optional(),
    assignedToUserId: z
      .uuid()
      .optional()
      .describe('Only assets currently checked out to this user.'),
    ownership: z
      .enum(['HAS', 'NONE'])
      .optional()
      .describe('HAS = checked out to someone; NONE = unassigned.'),
    warranty: AssetWarrantyFilterSchema.optional(),
    archived: z
      .boolean()
      .optional()
      .describe('true = list archived assets instead (administrators only).'),
    mine: z
      .boolean()
      .optional()
      .describe(
        'true = only the assets checked out to you (takes no other filter).',
      ),
    sort: z.enum(SORT_FIELDS).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    limit: pageLimit,
    offset: pageOffset,
  })
  .superRefine((input, ctx) => {
    if (!input.mine) return;
    // A blank `query` is parsed to undefined (#1374): only a filter actually given counts.
    const other = Object.entries(input)
      .filter(
        ([key, value]) =>
          value !== undefined && !['mine', 'limit', 'offset'].includes(key),
      )
      .map(([key]) => key);
    if (other.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['mine'],
        message: `mine takes no other filter (got ${other.join(', ')})`,
      });
    }
  });

const assetSearch = defineTool({
  name: 'asset_search',
  title: 'Search assets',
  description:
    'List assets (laptops, servers, phones, licences…) with filters: text, status, model, category, ' +
    'location, company, owner, warranty window. Omit `query` to list by the other filters alone. ' +
    '`mine: true` lists the assets checked out to you. ' +
    'Returns each asset with its model, location and current owners; paginate with offset.',
  domain: 'assets',
  class: 'read',
  idempotent: true,
  input: assetSearchInput,
  bindings: [
    bind(AssetsController, 'findAll'),
    bind(AssetsController, 'findMine'),
  ],
  async run(input, rt) {
    const limit = input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const paging = { limit: String(limit), offset: String(offset) };
    const page = input.mine
      ? await rt.call(AssetsController, 'findMine', { query: paging })
      : await rt.call(AssetsController, 'findAll', {
          query: {
            ...paging,
            q: input.query,
            status: input.status,
            modelId: input.modelId,
            categoryId: input.categoryId,
            locationId: input.locationId,
            company: input.company,
            assignedToUserId: input.assignedToUserId,
            ownership: input.ownership,
            warranty: input.warranty,
            deleted: input.archived ? 'only' : undefined,
            sort: input.sort,
            dir: input.dir,
          },
        });
    const items = asRows(page.items).map(searchItem);
    const truncated = pageTruncation(items.length, page.total, offset);
    return {
      data: { total: page.total, offset, items },
      ...(truncated ? { truncated } : {}),
    };
  },
});

// ─── asset_get ───────────────────────────────────────────────────────────────────────────────────────

/** Lists inside `asset_get` are capped, with their totals. */
const FACET_CAP = 50;
const HISTORY_EVENTS = 20;

/** A facet the caller may not read is reported, not failed: the rest of the asset is still theirs. */
async function facet<T>(
  read: () => Promise<T>,
): Promise<T | { unavailable: string }> {
  try {
    return await read();
  } catch (err) {
    const status =
      typeof (err as { getStatus?: unknown }).getStatus === 'function'
        ? (err as { getStatus: () => number }).getStatus()
        : 0;
    if (status === 403) return { unavailable: 'forbidden for this caller' };
    throw err;
  }
}

const assetGet = defineTool({
  name: 'asset_get',
  title: 'Get an asset',
  description:
    'Read one asset by id, asset tag or serial: its details, model, category, location, current owners ' +
    'and notes. detail "full" adds its attributes (specs), its ownership history, its recent change ' +
    'history and the knowledge-base articles linked to it.',
  domain: 'assets',
  class: 'read',
  idempotent: true,
  input: z.strictObject({ asset: assetReference, detail: detailLevel }),
  bindings: [
    bind(AssetsController, 'findOne'),
    bind(AssetsController, 'findAll'),
    bind(AssetsController, 'findAssignments'),
    bind(AssetsController, 'findHistory'),
    bind(AssetsController, 'findArticles'),
  ],
  async run(input, rt) {
    const { id } = await resolveAsset(rt, input.asset, false);
    const row = asRow(
      await rt.call(AssetsController, 'findOne', { params: { id } }),
    );
    const model = row.model ? asRow(row.model) : null;
    const location = row.location ? asRow(row.location) : null;
    const data: Row = {
      asset: {
        ...assetCore(row, [
          'purchaseCost',
          'usefulLifeMonths',
          'salvageValue',
          'currentBookValue',
          'createdAt',
          'updatedAt',
        ]),
        notes: untrusted(str(row.notes)),
      },
      model: model
        ? {
            ...pick(model, ['id', 'name', 'manufacturer', 'sku']),
            category: model.category
              ? pick(model.category, ['id', 'name'])
              : null,
          }
        : null,
      location: location ? pick(location, ['id', 'name', 'type']) : null,
      owners: asRows(row.activeAssignments).map(owner),
    };
    if (input.detail === 'full') {
      (data.asset as Row).specs = untrustedJson(row.specs);
      const assignments = asRows(
        await rt.call(AssetsController, 'findAssignments', {
          params: { id },
          query: { activeOnly: 'false' },
        }),
      );
      data.ownershipHistory = {
        total: assignments.length,
        items: assignments.slice(0, FACET_CAP).map((a) => ({
          ...owner(a),
          ...pick(a, ['assignedAt', 'releasedAt', 'acknowledgedAt']),
          notes: untrusted(str(a.notes)),
        })),
      };
      const events = asRows(
        await rt.call(AssetsController, 'findHistory', {
          params: { id },
          query: { limit: String(HISTORY_EVENTS) },
        }),
      );
      data.history = events.map((e) => ({
        ...pick(e, ['id', 'eventType', 'createdAt', 'performedById']),
        payload: untrustedJson(e.payload, 1000),
      }));
      const articles = await facet(() =>
        rt.call(AssetsController, 'findArticles', {
          params: { id },
          query: { limit: String(AI_TOOL_LIST_DEFAULT_LIMIT) },
        }),
      );
      data.articles =
        'unavailable' in articles
          ? articles
          : {
              total: articles.total,
              items: asRows(articles.items).map((a) =>
                pick(a, ['id', 'slug', 'title']),
              ),
            };
    }
    return { data };
  },
});

// ─── asset_create ────────────────────────────────────────────────────────────────────────────────────

const assetCreate = defineTool({
  name: 'asset_create',
  title: 'Create an asset',
  description:
    'Register a new asset. name and status are required; give its model and location by id or exact ' +
    'name (see reference_lookup). An asset tag may be assigned automatically when the instance uses a ' +
    'tag scheme. To give it to someone afterwards, use asset_check_out.',
  domain: 'assets',
  class: 'write',
  input: z
    .strictObject({
      ...editableFields,
      name: editableFields.name.describe('What it is, e.g. "Laptop — Ana".'),
      status: editableFields.status,
      assetTag: editableFields.assetTag.optional(),
      serial: editableFields.serial.optional(),
      company: editableFields.company.optional(),
      notes: editableFields.notes.optional(),
      purchaseDate: editableFields.purchaseDate.optional(),
      warrantyEnd: editableFields.warrantyEnd.optional(),
      purchaseCost: money.optional(),
      usefulLifeMonths: months.optional(),
      salvageValue: money.optional(),
      model: editableFields.model.optional(),
      location: editableFields.location.optional(),
      specs: flatSpecs.optional(),
    })
    .superRefine((input, ctx) => refuseReservedSpecKeys(input.specs, ctx)),
  bindings: [
    bind(AssetsController, 'create'),
    bind(AssetModelsController, 'findAll'),
    bind(AssetModelsController, 'findOne'),
    bind(LocationsController, 'findAll'),
    bind(LocationsController, 'findOne'),
  ],
  async run(input, rt) {
    const body = scalarBody(input);
    if (input.specs) body.specs = input.specs;
    if (input.model) {
      body.modelId = (await resolveModel(rt, input.model, false)).id;
    }
    if (input.location) {
      body.locationId = (await resolveLocation(rt, input.location, false)).id;
    }
    const asset = asRow(await rt.call(AssetsController, 'create', { body }));
    return {
      data: writtenAsset(asset),
      summary: `Created the asset ${assetLabel(asset)}.`,
      entityRefs: [assetRef(asset, 'created')],
    };
  },
  async preview(input, rt) {
    const { model, location, ...fields } = input;
    const changes = createdFields(fields, { ...VALUE_KINDS, specs: 'text' });
    if (model) {
      changes.push({
        field: 'model',
        after: entityValue(await resolveModel(rt, model, true)),
        valueKind: 'entity',
      });
    }
    if (location) {
      changes.push({
        field: 'location',
        after: entityValue(await resolveLocation(rt, location, true)),
        valueKind: 'entity',
      });
    }
    return createPreview(changes);
  },
});

// ─── asset_update ────────────────────────────────────────────────────────────────────────────────────

const assetUpdateInput = z
  .strictObject({
    asset: assetReference,
    name: editableFields.name.optional(),
    status: editableFields.status.optional(),
    assetTag: editableFields.assetTag.optional(),
    serial: editableFields.serial.optional(),
    company: editableFields.company.optional(),
    notes: editableFields.notes.optional().describe('Replaces the notes.'),
    purchaseDate: editableFields.purchaseDate.optional(),
    warrantyEnd: editableFields.warrantyEnd.optional(),
    purchaseCost: money.nullable().optional().describe('null clears it.'),
    usefulLifeMonths: months.nullable().optional().describe('null clears it.'),
    salvageValue: money.nullable().optional().describe('null clears it.'),
    model: editableFields.model.optional(),
    location: editableFields.location.optional(),
    specs: z
      .record(
        z.string().trim().min(1).max(100),
        z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]),
      )
      .optional()
      .describe(
        'Attributes to set, merged into the existing ones; a null value removes that attribute.',
      ),
  })
  .superRefine((input, ctx) => {
    refuseReservedSpecKeys(input.specs, ctx);
    if (Object.keys(input).every((key) => key === 'asset')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Give at least one field to change',
      });
    }
  });

type AssetUpdateInput = z.output<typeof assetUpdateInput>;

/** The route body for an update; `specs` is merged over the asset's current specs. */
async function updateBody(
  input: AssetUpdateInput,
  rt: AiToolRuntime,
  current: () => Promise<Row>,
): Promise<Row> {
  const body = scalarBody(input);
  if (input.model) {
    body.modelId = (await resolveModel(rt, input.model, false)).id;
  }
  if (input.location) {
    body.locationId = (await resolveLocation(rt, input.location, false)).id;
  }
  if (input.specs) {
    // Own entries only, rebuilt with `fromEntries` (which defines each key as an own property), so no key
    // reaches a prototype.
    const edits = new Map(Object.entries(input.specs));
    const kept = Object.entries(asRow((await current()).specs)).filter(
      ([key]) => !edits.has(key),
    );
    const set = [...edits].filter(([, value]) => value !== null);
    body.specs = Object.fromEntries([...kept, ...set]);
  }
  return body;
}

const assetUpdate = defineTool({
  name: 'asset_update',
  title: 'Update an asset',
  description:
    'Change an asset (by id, asset tag or serial): any of its name, status, tag, serial, company, notes, ' +
    'dates, cost, model, location or attributes. Only the fields you give change; specs are merged. ' +
    'Ownership is not a field: use asset_check_out / asset_check_in.',
  domain: 'assets',
  class: 'write',
  destructive: true,
  idempotent: true,
  input: assetUpdateInput,
  bindings: [
    bind(AssetsController, 'update'),
    bind(AssetsController, 'findOne'),
    bind(AssetsController, 'findAll'),
    bind(AssetModelsController, 'findAll'),
    bind(AssetModelsController, 'findOne'),
    bind(LocationsController, 'findAll'),
    bind(LocationsController, 'findOne'),
  ],
  async run(input, rt) {
    const { id } = await resolveAsset(rt, input.asset, false);
    const body = await updateBody(input, rt, async () =>
      asRow(await rt.call(AssetsController, 'findOne', { params: { id } })),
    );
    const asset = asRow(
      await rt.call(AssetsController, 'update', { params: { id }, body }),
    );
    return {
      data: writtenAsset(asset),
      summary: `Updated the asset ${assetLabel(asset)}.`,
      entityRefs: [assetRef(asset, 'updated')],
    };
  },
  async preview(input, rt) {
    const resolved = await resolveAsset(rt, input.asset, true);
    const current = asRow(
      await rt.call(AssetsController, 'findOne', {
        params: { id: resolved.id },
      }),
    );
    const changes: Change[] = [];
    for (const field of SCALAR_FIELDS) {
      const after = input[field];
      if (after === undefined) continue;
      const before = iso(current[field]) ?? null;
      if (sameValue(before, after)) continue;
      changes.push({
        field,
        before,
        after,
        valueKind: VALUE_KINDS[field] ?? 'text',
      });
    }
    if (input.model) {
      const after = await resolveModel(rt, input.model, true);
      const before = current.model ? asRow(current.model) : null;
      if (before?.id !== after.id) {
        changes.push({
          field: 'model',
          before: before
            ? { type: 'assetModel', id: before.id, label: modelLabel(before) }
            : null,
          after: entityValue(after),
          valueKind: 'entity',
        });
      }
    }
    if (input.location) {
      const after = await resolveLocation(rt, input.location, true);
      const before = current.location ? asRow(current.location) : null;
      if (before?.id !== after.id) {
        changes.push({
          field: 'location',
          before: before
            ? { type: 'location', id: before.id, label: before.name }
            : null,
          after: entityValue(after),
          valueKind: 'entity',
        });
      }
    }
    const specs = asRow(current.specs);
    for (const [key, after] of Object.entries(input.specs ?? {})) {
      const before = Object.hasOwn(specs, key) ? (specs[key] ?? null) : null;
      if (before === after) continue;
      changes.push({ field: `specs.${key}`, before, after, valueKind: 'text' });
    }
    if (changes.length === 0) {
      throw new BadRequestException(
        `Nothing to change: ${assetLabel(current)} already has these values`,
      );
    }
    const target = assetRef(current, 'updated');
    return {
      target,
      changes,
      warnings: [],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
      precondition: {
        entity: target,
        updatedAt: String(iso(current.updatedAt)),
      },
    };
  },
});

// ─── asset_archive / asset_restore ───────────────────────────────────────────────────────────────────

const assetArchive = defineTool({
  name: 'asset_archive',
  title: 'Archive an asset',
  description:
    'Archive (soft-delete) an asset by id, asset tag or serial: it leaves the inventory and search, its ' +
    'history is kept, and an administrator can restore it. It does not check the asset in: release its ' +
    'owners first with asset_check_in if it is being returned.',
  domain: 'assets',
  class: 'write',
  destructive: true,
  input: z.strictObject({ asset: assetReference }),
  bindings: [
    bind(AssetsController, 'remove'),
    bind(AssetsController, 'findOne'),
    bind(AssetsController, 'findAll'),
  ],
  async run(input, rt) {
    const { id } = await resolveAsset(rt, input.asset, false);
    const asset = asRow(
      await rt.call(AssetsController, 'remove', { params: { id } }),
    );
    return {
      data: writtenAsset(asset),
      summary: `Archived the asset ${assetLabel(asset)}.`,
      entityRefs: [assetRef(asset, 'archived')],
    };
  },
  async preview(input, rt) {
    const resolved = await resolveAsset(rt, input.asset, true);
    const current = asRow(
      await rt.call(AssetsController, 'findOne', {
        params: { id: resolved.id },
      }),
    );
    const owners = asRows(current.activeAssignments);
    const target = assetRef(current, 'archived');
    return {
      target,
      changes: [
        { field: 'archived', before: false, after: true, valueKind: 'boolean' },
        // Archiving does not release ownership: the card says who still holds it.
        ...(owners.length > 0
          ? [
              {
                field: 'owners',
                before: owners.map((o) => userLabel(asRow(o.user))),
                after: owners.map((o) => userLabel(asRow(o.user))),
                valueKind: 'text' as const,
              },
            ]
          : []),
      ],
      warnings: ['SOFT_DELETE'],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
      precondition: {
        entity: target,
        updatedAt: String(iso(current.updatedAt)),
      },
    };
  },
});

/** The archived asset a restore names, with its row (for the label and the version). */
async function resolveArchived(
  rt: AiToolRuntime,
  reference: string,
  withLabel: boolean,
): Promise<{ resolved: AiResolvedReference; row?: Row }> {
  const rows = new Map<string, Row>();
  const resolved = await rt.resolve({
    type: 'asset',
    reference,
    ...(withLabel ? {} : { isId: isCuidId }),
    lookup: async (ref) =>
      (await findArchived(rt, ref)).map((row) => {
        rows.set(String(row.id), row);
        return { id: String(row.id), label: assetLabel(row) };
      }),
  });
  return { resolved, row: rows.get(resolved.id) };
}

const assetRestore = defineTool({
  name: 'asset_restore',
  title: 'Restore an archived asset',
  description:
    'Bring an archived asset back into the inventory, by id, asset tag or serial. Only archived assets ' +
    'can be restored (see asset_search with archived: true). Administrators only.',
  domain: 'assets',
  class: 'write',
  idempotent: true,
  input: z.strictObject({ asset: assetReference }),
  bindings: [
    bind(AssetsController, 'restore'),
    bind(AssetsController, 'findAll'),
  ],
  async run(input, rt) {
    const { resolved } = await resolveArchived(rt, input.asset, false);
    const asset = asRow(
      await rt.call(AssetsController, 'restore', {
        params: { id: resolved.id },
      }),
    );
    return {
      data: writtenAsset(asset),
      summary: `Restored the asset ${assetLabel(asset)}.`,
      entityRefs: [assetRef(asset, 'restored')],
    };
  },
  async preview(input, rt) {
    const { row } = await resolveArchived(rt, input.asset, true);
    const current = row!;
    const target = assetRef(current, 'restored');
    return {
      target,
      changes: [
        { field: 'archived', before: true, after: false, valueKind: 'boolean' },
      ],
      warnings: [],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
      precondition: {
        entity: target,
        updatedAt: String(iso(current.updatedAt)),
      },
    };
  },
});

// ─── asset_check_out / asset_check_in ────────────────────────────────────────────────────────────────

/** The refs an ownership change carries: the assignment (on its asset's page), the asset and the person. */
function ownershipRefs(
  assignmentId: string,
  op: 'created' | 'updated',
  asset: AiResolvedReference,
  user: AiResolvedReference,
): AiEntityRef[] {
  return [
    {
      type: 'assetAssignment',
      id: assignmentId,
      op,
      ...(asset.label && user.label
        ? { label: `${asset.label} → ${user.label}` }
        : {}),
      parent: { type: 'asset', id: asset.id },
    },
    {
      type: 'asset',
      id: asset.id,
      op: 'updated',
      ...(asset.label ? { label: asset.label } : {}),
    },
    {
      type: 'user',
      id: user.id,
      op: 'updated',
      ...(user.label ? { label: user.label } : {}),
    },
  ];
}

const assetCheckOut = defineTool({
  name: 'asset_check_out',
  title: 'Check an asset out to someone',
  description:
    'Give an asset (by id, asset tag or serial) to a person (by id, email, exact full name or "me"): ' +
    'opens an ownership assignment, recorded in the asset history. An asset may have several owners; ' +
    'to hand it over, check it in from the current owner first.',
  domain: 'assets',
  class: 'write',
  input: z.strictObject({
    asset: assetReference,
    user: personReference,
    notes: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe('Why, or what was handed over.'),
  }),
  bindings: [
    bind(AssetAssignmentsController, 'create'),
    bind(AssetsController, 'findOne'),
    bind(AssetsController, 'findAll'),
    bind(UsersController, 'findAll'),
    bind(UsersController, 'me'),
  ],
  async run(input, rt) {
    const asset = await resolveAsset(rt, input.asset, false);
    const user = await resolveUser(rt, input.user, false);
    const assignment = asRow(
      await rt.call(AssetAssignmentsController, 'create', {
        body: {
          assetId: asset.id,
          userId: user.id,
          ...(input.notes ? { notes: input.notes } : {}),
        },
      }),
    );
    return {
      data: pick(assignment, ['id', 'assetId', 'userId', 'assignedAt']),
      summary: `Checked ${asset.label ?? asset.id} out to ${user.label ?? user.id}.`,
      entityRefs: ownershipRefs(String(assignment.id), 'created', asset, user),
    };
  },
  async preview(input, rt) {
    const asset = await resolveAsset(rt, input.asset, true);
    const current = asRow(
      await rt.call(AssetsController, 'findOne', { params: { id: asset.id } }),
    );
    const user = await resolveUser(rt, input.user, true);
    const owners = asRows(current.activeAssignments);
    if (owners.some((o) => o.userId === user.id)) {
      throw new ConflictException(
        `${assetLabel(current)} is already checked out to ${user.label ?? user.id}`,
      );
    }
    const ownerLabels = owners.map((o) => userLabel(asRow(o.user)));
    const target = assetRef(current, 'updated');
    return {
      target,
      changes: [
        {
          field: 'checkedOutTo',
          before: null,
          after: entityValue(user),
          valueKind: 'entity',
        },
        {
          field: 'owners',
          before: ownerLabels,
          after: [...ownerLabels, user.label ?? user.id],
          valueKind: 'text',
        },
        ...(input.notes
          ? [{ field: 'notes', after: input.notes, valueKind: 'text' as const }]
          : []),
      ],
      warnings: [],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
      precondition: {
        entity: target,
        updatedAt: String(iso(current.updatedAt)),
      },
    };
  },
});

/** Does an active owner match a person reference (id, email, exact name, "me")? */
function ownerMatches(
  assignment: Row,
  ref: string,
  rt: AiToolRuntime,
): boolean {
  const user = asRow(assignment.user);
  if (ref.toLowerCase() === 'me') {
    const identity = rt.ctx.identity;
    return identity.kind === 'human' && assignment.userId === identity.userId;
  }
  return (
    assignment.userId === ref ||
    sameText(user.email, ref) ||
    sameText(personName(user), ref) ||
    sameText(user.username, ref) ||
    sameText(user.legajo, ref)
  );
}

/**
 * The active assignment a check-in releases: the asset's live owners (`GET /assets/:id/assignments`,
 * each with its user), narrowed by the person reference. With no person, the asset must have exactly one
 * owner — several is `AMBIGUOUS_REFERENCE` naming them, so the model asks instead of guessing.
 */
async function assignmentToRelease(
  rt: AiToolRuntime,
  input: { asset: string; user?: string },
  withLabel: boolean,
): Promise<{
  asset: AiResolvedReference;
  assignment: Row;
  owners: Row[];
  user: AiResolvedReference;
}> {
  const asset = await resolveAsset(rt, input.asset, withLabel);
  const owners = asRows(
    await rt.call(AssetsController, 'findAssignments', {
      params: { id: asset.id },
      query: { activeOnly: 'true' },
    }),
  );
  const assetName = asset.label ?? asset.id;
  let assignmentId: string;
  if (input.user) {
    assignmentId = (
      await rt.resolve({
        type: 'assetAssignment',
        reference: input.user,
        lookup: (ref) =>
          Promise.resolve(
            owners
              .filter((o) => ownerMatches(o, ref, rt))
              .map((o) => ({
                id: String(o.id),
                label: userLabel(asRow(o.user)),
              })),
          ),
      })
    ).id;
  } else if (owners.length === 1) {
    assignmentId = String(owners[0].id);
  } else if (owners.length === 0) {
    throw new ConflictException(`${assetName} is not checked out to anyone`);
  } else {
    throw new AiReferenceError(
      'AMBIGUOUS_REFERENCE',
      `${assetName} is checked out to ${owners.length} people; say whose to check in`,
      owners.slice(0, AI_AMBIGUITY_SAMPLE).map((o) => ({
        type: 'user',
        id: String(o.userId),
        label: userLabel(asRow(o.user)),
      })),
    );
  }
  const assignment = owners.find((o) => o.id === assignmentId)!;
  const holder = asRow(assignment.user);
  return {
    asset,
    assignment,
    owners,
    user: {
      type: 'user',
      id: String(assignment.userId),
      label: userLabel(holder),
    },
  };
}

const assetCheckIn = defineTool({
  name: 'asset_check_in',
  title: 'Check an asset in',
  description:
    'Take an asset (by id, asset tag or serial) back from a person: releases their ownership ' +
    'assignment, recorded in the asset history. Give the person (id, email, exact full name or "me") ' +
    'when the asset has more than one owner.',
  domain: 'assets',
  class: 'write',
  input: z.strictObject({
    asset: assetReference,
    user: personReference.optional(),
    notes: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe('The return reason; replaces the assignment note.'),
  }),
  bindings: [
    bind(AssetAssignmentsController, 'release'),
    bind(AssetsController, 'findAssignments'),
    bind(AssetsController, 'findOne'),
    bind(AssetsController, 'findAll'),
  ],
  async run(input, rt) {
    const { asset, assignment, user } = await assignmentToRelease(
      rt,
      input,
      false,
    );
    const released = asRow(
      await rt.call(AssetAssignmentsController, 'release', {
        params: { id: String(assignment.id) },
        body: input.notes ? { notes: input.notes } : {},
      }),
    );
    return {
      data: pick(released, [
        'id',
        'assetId',
        'userId',
        'assignedAt',
        'releasedAt',
      ]),
      summary: `Checked ${asset.label ?? asset.id} in from ${user.label ?? user.id}.`,
      entityRefs: ownershipRefs(String(assignment.id), 'updated', asset, user),
    };
  },
  async preview(input, rt) {
    const { asset, assignment, owners, user } = await assignmentToRelease(
      rt,
      input,
      true,
    );
    const ownerLabels = owners.map((o) => userLabel(asRow(o.user)));
    const target: AiEntityRef = {
      type: 'assetAssignment',
      id: String(assignment.id),
      op: 'updated',
      label: `${asset.label ?? asset.id} → ${user.label}`,
      parent: { type: 'asset', id: asset.id },
    };
    return {
      target,
      changes: [
        {
          field: 'checkedInFrom',
          before: entityValue(user),
          after: null,
          valueKind: 'entity',
        },
        {
          field: 'owners',
          before: ownerLabels,
          after: owners
            .filter((o) => o.id !== assignment.id)
            .map((o) => userLabel(asRow(o.user))),
          valueKind: 'text',
        },
        ...(input.notes
          ? [
              {
                field: 'notes',
                before: str(assignment.notes),
                after: input.notes,
                valueKind: 'text' as const,
              },
            ]
          : []),
      ],
      warnings: [],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
      precondition: {
        entity: target,
        updatedAt: String(iso(assignment.updatedAt)),
      },
    };
  },
});

export const assetsToolset: AiToolset = {
  domain: 'assets',
  tools: [
    assetSearch,
    assetGet,
    assetCreate,
    assetUpdate,
    assetArchive,
    assetRestore,
    assetCheckOut,
    assetCheckIn,
  ],
  unexposed: [
    unexposed(
      AssetsController,
      ['listCompanies'],
      'The distinct-company autocomplete behind the web form; asset_search filters by company.',
    ),
    unexposed(
      AssetsController,
      ['batchRemove', 'batchRestore', 'batchSetStatus'],
      'Batch archive, restore and status: v1.1 (blast radius; tools-and-execution.md §7).',
    ),
    unexposed(
      AssetsController,
      ['receiveBatch'],
      'Bulk receive (N assets from one model): v1.1 (tools-and-execution.md §7).',
    ),
    unexposed(
      AssetsController,
      ['export'],
      'A bulk CSV file export (@Res stream); use search and list tools instead.',
    ),
    unexposed(
      AssetAssignmentsController,
      ['findAll', 'findOne'],
      'Served as facets: asset_get reads ownership through GET /assets/:id/assignments (and user_get ' +
        'through GET /users/:id/assignments).',
    ),
    unexposed(
      AssetAssignmentsController,
      ['updateNotes'],
      'Assignment notes: v1.1 (tools-and-execution.md §3).',
    ),
    unexposed(
      AssetAssignmentsController,
      ['acknowledge'],
      'Acknowledging receipt is the holder’s own human act (self-service, human-only): v1.1.',
    ),
    unexposed(
      AssetAttachmentsController,
      ['list', 'remove'],
      'Attachments: v1.1 (tools-and-execution.md §7).',
    ),
    unexposed(
      AssetAttachmentsController,
      ['upload', 'content'],
      'Binary upload and download: no file tools (synthesis §9.2).',
    ),
  ],
};
