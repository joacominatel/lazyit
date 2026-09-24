import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AssetStatusSchema,
  AssetWarrantyFilterSchema,
  type AiActionPreview,
  type AiEntityRef,
} from '@lazyit/shared';
import { AssetAssignmentsController } from '../../asset-assignments/asset-assignments.controller';
import { AssetCategoriesController } from '../../asset-categories/asset-categories.controller';
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
import { mapToolError } from '../core/error-mapper';
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

/**
 * The status a new asset gets when none is given (#1386): new stock goes to storage until someone checks
 * it out. The ROUTE still requires a status (every asset is classified — asset.md); the tool fills it in
 * and the card says so (`defaultsApplied`), so the person can override it before approving.
 */
export const DEFAULT_NEW_ASSET_STATUS = 'IN_STORAGE' as const;

const defaultedStatus = editableFields.status
  .optional()
  .describe(
    `Default ${DEFAULT_NEW_ASSET_STATUS} (new stock), shown on the card as a default the person can override.`,
  );

const assetCreate = defineTool({
  name: 'asset_create',
  title: 'Create an asset',
  description:
    'Register ONE new asset (for several, use asset_create_batch). name is required; status defaults to ' +
    `${DEFAULT_NEW_ASSET_STATUS}. Give its model and location by id or exact name (see reference_lookup); ` +
    'a missing model or location can be created first with asset_model_create / location_create. Omit ' +
    'assetTag unless the person gives one: the instance tag scheme assigns it; never build one from a ' +
    'pattern. To give it to someone afterwards, use asset_check_out.',
  domain: 'assets',
  class: 'write',
  input: z
    .strictObject({
      ...editableFields,
      name: editableFields.name.describe('What it is, e.g. "Laptop — Ana".'),
      status: defaultedStatus,
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
    const body = scalarBody({
      ...input,
      status: input.status ?? DEFAULT_NEW_ASSET_STATUS,
    });
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
    const defaulted = fields.status === undefined;
    const changes = createdFields(
      { ...fields, status: fields.status ?? DEFAULT_NEW_ASSET_STATUS },
      { ...VALUE_KINDS, specs: 'text' },
    );
    if (defaulted) {
      changes.push({
        field: 'defaultsApplied',
        after: [`status: ${DEFAULT_NEW_ASSET_STATUS}`],
        valueKind: 'text',
      });
    }
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

// ─── asset_create_batch ──────────────────────────────────────────────────────────────────────────────

/** The most rows one batch proposal carries (#1387): one reviewable card, bounded work per approval. */
export const ASSET_BATCH_MAX_ROWS = 200;

/** The values a batch may set once for every row (a row's own value wins). */
const batchSharedFields = {
  status: defaultedStatus,
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
};

const batchRowInput = z
  .strictObject({
    ...batchSharedFields,
    name: editableFields.name.describe('What it is, e.g. "Laptop Pro 14 #3".'),
    assetTag: editableFields.assetTag.optional(),
    serial: editableFields.serial.optional(),
    skip: z
      .boolean()
      .optional()
      .describe(
        'true = leave this row out: the card lists it as skipped and it is never created. Use it for a ' +
          'row the check refused when the user wants the others created without it.',
      ),
  })
  .superRefine((row, ctx) => refuseReservedSpecKeys(row.specs, ctx));

const assetCreateBatchInput = z.strictObject({
  rows: z
    .array(batchRowInput)
    .min(1)
    .max(ASSET_BATCH_MAX_ROWS)
    .describe(
      `One entry per asset to create, in the order the user gave them (1–${ASSET_BATCH_MAX_ROWS}). ` +
        'Pass every row the user gave: the card counts them, so never summarize or drop rows.',
    ),
  common: z
    .strictObject(batchSharedFields)
    .superRefine((shared, ctx) => refuseReservedSpecKeys(shared.specs, ctx))
    .optional()
    .describe(
      'Values shared by every row (status, model, location, company, dates, cost, specs…); a row’s own ' +
        'value overrides it, and specs are merged.',
    ),
});

type AssetCreateBatchInput = z.output<typeof assetCreateBatchInput>;
type BatchRowInput = AssetCreateBatchInput['rows'][number];

/** A referenced model, location or category as a batch row names it, with its version. */
interface BatchReference {
  ref: { type: AiResolvedReference['type']; id: string; label?: string };
  updatedAt: string | null;
}

/** One row of a batch, resolved and checked: the route body, or why it cannot be created. */
interface BatchRowPlan {
  /** 1-based, in the order the user gave the rows. */
  row: number;
  /** Marked `skip` in the input: shown, never created. */
  skip: boolean;
  name: string;
  assetTag: string | null;
  serial: string | null;
  status: string;
  statusDefaulted: boolean;
  model: BatchReference | null;
  category: BatchReference | null;
  location: BatchReference | null;
  /** Existing live assets, or earlier (not skipped) rows, holding this row's tag or serial. */
  duplicates: Row[];
  errors: string[];
  body: Row;
}

interface BatchPlan {
  rows: BatchRowPlan[];
  /**
   * False when the duplicate pre-check could not run for every value: the caller may not read assets
   * (`asset:read`), or a value contains a comma (the exact-values filter's separator). The route's own
   * uniqueness (409 at create) still decides; the card says the check is incomplete.
   */
  duplicatesChecked: boolean;
}

/** A reference resolved once per distinct spelling, or the reason it did not resolve. */
type Lookup<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A reference that does not resolve (no match, several matches, a 404 or a 400) is that row's error, not
 * the whole batch's; anything else — a 403 above all — propagates, as the route would answer it.
 */
async function lookup<T>(
  read: () => Promise<T>,
  hint: string,
): Promise<Lookup<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    const status =
      err instanceof AiReferenceError
        ? 404
        : err instanceof HttpException
          ? err.getStatus()
          : 0;
    if (status === 404 || status === 400 || status === 409) {
      const mapped = mapToolError(err);
      return { ok: false, error: `${mapped.message}${hint}` };
    }
    throw err;
  }
}

const versionOf = (row: Row): string | null => {
  const value = iso(row.updatedAt);
  return typeof value === 'string' ? value : null;
};

const referenceKey = (reference: string): string =>
  reference.trim().toLowerCase();

const DUPLICATE_FIELDS = [
  { field: 'assetTag', filter: 'assetTags' },
  { field: 'serial', filter: 'serials' },
] as const;

/**
 * The live assets holding any of these exact values, through ONE `GET /assets?<filter>=a,b,c` (the
 * exact-values list filter, ≤ 200 values — tags and serials are unique among live assets, so every match
 * fits one page). Read through {@link facet}: a caller without `asset:read` gets `null` ("unknown to
 * you") instead of a failed batch.
 */
async function liveHolders(
  rt: AiToolRuntime,
  filter: 'assetTags' | 'serials',
  values: readonly string[],
): Promise<Row[] | null> {
  if (values.length === 0) return [];
  const page = await facet(() =>
    rt.call(AssetsController, 'findAll', {
      query: { [filter]: values.join(','), limit: RESOLVE_PAGE },
    }),
  );
  return 'unavailable' in page ? null : asRows(page.items);
}

/**
 * Resolve and check every row of a batch (#1387), the same way for the preview and the execution:
 *   - the model and location of each row (its own, else `common`'s): each distinct spelling resolved ONCE
 *     per plan through the single create's resolvers; the model's category from the category list (a
 *     caller without `category:read` sees no category, not an error);
 *   - duplicates: one exact-values lookup per field for the whole batch (a tag or serial a LIVE asset
 *     already holds), and a value an earlier, not skipped, row uses;
 *   - the status: the row's, else `common`'s, else {@link DEFAULT_NEW_ASSET_STATUS} (flagged).
 */
async function planBatch(
  input: AssetCreateBatchInput,
  rt: AiToolRuntime,
): Promise<BatchPlan> {
  const common = input.common ?? {};
  const rows = input.rows.map((row) => ({
    ...common,
    ...row,
    ...(common.specs || row.specs
      ? { specs: { ...common.specs, ...row.specs } }
      : {}),
  })) as BatchRowInput[];

  const models = new Map<
    string,
    Lookup<Row & { resolved: AiResolvedReference }>
  >();
  const locations = new Map<string, Lookup<BatchReference>>();
  for (const row of rows) {
    if (row.model && !models.has(referenceKey(row.model))) {
      const reference = row.model;
      models.set(
        referenceKey(reference),
        await lookup(async () => {
          const resolved = await resolveModel(rt, reference, true);
          const model = asRow(
            await rt.call(AssetModelsController, 'findOne', {
              params: { id: resolved.id },
            }),
          );
          return { ...model, resolved };
        }, ' — create the model first (asset_model_create) or use an existing one'),
      );
    }
    if (row.location && !locations.has(referenceKey(row.location))) {
      const reference = row.location;
      locations.set(
        referenceKey(reference),
        await lookup(async () => {
          const resolved = await resolveLocation(rt, reference, true);
          const location = asRow(
            await rt.call(LocationsController, 'findOne', {
              params: { id: resolved.id },
            }),
          );
          return { ref: entityValue(resolved), updatedAt: versionOf(location) };
        }, ' — create the location first (location_create) or use an existing one'),
      );
    }
  }

  // The models' categories, read once. A caller who may not read categories still gets the batch.
  const categories = new Map<string, Row>();
  const needsCategories = [...models.values()].some(
    (m) => m.ok && typeof m.value.categoryId === 'string',
  );
  if (needsCategories) {
    const list = await facet(() =>
      rt.call(AssetCategoriesController, 'findAll'),
    );
    if (!('unavailable' in list)) {
      for (const category of asRows(list)) {
        categories.set(String(category.id), category);
      }
    }
  }

  // Existing live assets holding a tag or serial a row uses: one exact lookup per field.
  let duplicatesChecked = true;
  const holders = new Map<string, Row[]>();
  for (const { field, filter } of DUPLICATE_FIELDS) {
    const all = [
      ...new Set(rows.map((r) => r[field]).filter((v) => v !== undefined)),
    ];
    const checkable = all.filter((v) => !v.includes(','));
    if (checkable.length < all.length) duplicatesChecked = false;
    const found = await liveHolders(rt, filter, checkable);
    if (found === null) {
      duplicatesChecked = false;
      continue;
    }
    for (const asset of found) {
      const value = asset[field];
      if (typeof value !== 'string' || !checkable.includes(value)) continue;
      const key = `${field}:${value}`;
      holders.set(key, [...(holders.get(key) ?? []), asset]);
    }
  }

  const seen = new Map<string, number>();
  const plans = rows.map((row, index): BatchRowPlan => {
    const number = index + 1;
    const skip = row.skip === true;
    const errors: string[] = [];
    const duplicates: Row[] = [];
    for (const { field } of DUPLICATE_FIELDS) {
      const value = row[field];
      if (value === undefined) continue;
      const key = `${field}:${value}`;
      for (const asset of holders.get(key) ?? []) {
        duplicates.push({
          field,
          value,
          existing: {
            type: 'asset',
            id: String(asset.id),
            label: assetLabel(asset),
          },
        });
        errors.push(
          `${field} "${value}" already belongs to ${assetLabel(asset)}`,
        );
      }
      // A skipped row never claims a value: it is not created.
      if (skip) continue;
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        duplicates.push({ field, value, row: earlier });
        errors.push(`${field} "${value}" is also used by row ${earlier}`);
      } else {
        seen.set(key, number);
      }
    }

    let model: BatchReference | null = null;
    let category: BatchReference | null = null;
    if (row.model) {
      const found = models.get(referenceKey(row.model))!;
      if (found.ok) {
        const { resolved, ...modelRow } = found.value;
        model = { ref: entityValue(resolved), updatedAt: versionOf(modelRow) };
        const cat =
          typeof modelRow.categoryId === 'string'
            ? categories.get(modelRow.categoryId)
            : undefined;
        if (cat) {
          category = {
            ref: {
              type: 'category',
              id: String(cat.id),
              label: String(cat.name),
            },
            updatedAt: versionOf(cat),
          };
        }
      } else {
        errors.push(found.error);
      }
    }
    let location: BatchReference | null = null;
    if (row.location) {
      const found = locations.get(referenceKey(row.location))!;
      if (found.ok) location = found.value;
      else errors.push(found.error);
    }

    const status = row.status ?? DEFAULT_NEW_ASSET_STATUS;
    const body = scalarBody({ ...row, status });
    if (row.specs && Object.keys(row.specs).length > 0) body.specs = row.specs;
    if (model) body.modelId = model.ref.id;
    if (location) body.locationId = location.ref.id;
    return {
      row: number,
      skip,
      name: row.name,
      assetTag: row.assetTag ?? null,
      serial: row.serial ?? null,
      status,
      statusDefaulted: row.status === undefined,
      model,
      category,
      location,
      duplicates,
      errors,
      body,
    };
  });
  return { rows: plans, duplicatesChecked };
}

/** One row as the card's table shows it. */
function batchRowView(plan: BatchRowPlan): Row {
  const { row, name, assetTag, serial, status, statusDefaulted, errors } = plan;
  const extra = pick(plan.body, [
    'company',
    'notes',
    'purchaseDate',
    'warrantyEnd',
    'purchaseCost',
    'usefulLifeMonths',
    'salvageValue',
    'specs',
  ]);
  return {
    row,
    name,
    assetTag,
    serial,
    status,
    ...(statusDefaulted ? { statusDefaulted: true } : {}),
    model: plan.model?.ref ?? null,
    category: plan.category?.ref ?? null,
    location: plan.location?.ref ?? null,
    ...extra,
    skipped: plan.skip,
    valid: !plan.skip && errors.length === 0,
    errors,
    duplicates: plan.duplicates,
  };
}

/**
 * The version a batch is approved against (see tools-and-execution.md, "asset_create_batch"). A card only
 * ever holds rows that were valid when it was built (the preview refuses any other unless it is marked
 * `skip`, and a skipped row never runs), so what can diverge at approval is the entities the rows to
 * create reference. The precondition contract carries ONE `{ entity, updatedAt }`, so the batch pins the
 * most recently changed of them (a model, its category or a location — ties broken by type and id). An
 * entity that starts matching a row's name after the proposal (created, renamed or restored) has a newer
 * `updatedAt` than anything the card saw, and an edited one changes its own: either way the newest entity
 * or its version changes and the approval is `STALE`. An entity that stops matching makes that row fail
 * (the approval-time preview refuses the batch). A batch whose rows reference nothing has no
 * precondition, like a single create.
 */
function batchPrecondition(
  plans: readonly BatchRowPlan[],
): AiActionPreview['precondition'] {
  const refs = new Map<string, BatchReference>();
  for (const plan of plans) {
    if (plan.skip) continue;
    for (const r of [plan.model, plan.category, plan.location]) {
      if (r?.updatedAt) refs.set(`${r.ref.type}:${r.ref.id}`, r);
    }
  }
  const newest = [...refs.values()].sort(
    (a, b) =>
      b.updatedAt!.localeCompare(a.updatedAt!) ||
      `${a.ref.type}:${a.ref.id}`.localeCompare(`${b.ref.type}:${b.ref.id}`),
  )[0];
  if (!newest) return undefined;
  return {
    entity: {
      type: newest.ref.type,
      id: newest.ref.id,
      op: 'updated',
      ...(newest.ref.label !== undefined ? { label: newest.ref.label } : {}),
    },
    updatedAt: newest.updatedAt!,
  };
}

/** The rows' errors for a refusal message: rows with the same problem grouped, capped at `max` groups. */
function rowErrors(bad: readonly BatchRowPlan[], max: number): string {
  const groups = new Map<string, number[]>();
  for (const plan of bad) {
    const key = plan.errors.join('; ');
    groups.set(key, [...(groups.get(key) ?? []), plan.row]);
  }
  const entries = [...groups];
  const shown = entries
    .slice(0, max)
    .map(
      ([message, rows]) =>
        `${rows.length === 1 ? 'row' : 'rows'} ${rows.join(', ')}: ${message}`,
    )
    .join(' | ');
  return entries.length > max
    ? `${shown} | …and ${entries.length - max} more problems`
    : shown;
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** An authorization failure will not change from one row to the next: stop instead of repeating it. */
const STOP_STATUSES = new Set([401, 403]);

const assetCreateBatch = defineTool({
  name: 'asset_create_batch',
  title: 'Create several assets',
  description:
    `Register several assets at once (up to ${ASSET_BATCH_MAX_ROWS}; e.g. rows pasted from a spreadsheet) as ONE ` +
    'proposal with one approval. Put shared values in `common` and per-asset values in `rows`; status ' +
    `defaults to ${DEFAULT_NEW_ASSET_STATUS}. Every row is checked first: its model and location must ` +
    'exist (create a missing one first with asset_model_create / location_create), and a tag or serial ' +
    'an existing asset or another row already has is refused. A proposal with a refused row is not ' +
    "shown: fix the row, or mark it `skip: true` to create the others without it. Omit a row's " +
    'assetTag unless the person gives one: the instance tag scheme assigns it; never build one from a ' +
    'pattern. The result lists what was created and what was not.',
  domain: 'assets',
  class: 'write',
  input: assetCreateBatchInput,
  bindings: [
    bind(AssetsController, 'create'),
    bind(AssetsController, 'findAll'),
    bind(AssetModelsController, 'findAll'),
    bind(AssetModelsController, 'findOne'),
    bind(LocationsController, 'findAll'),
    bind(LocationsController, 'findOne'),
    bind(AssetCategoriesController, 'findAll'),
  ],
  async run(input, rt) {
    const { rows: plans } = await planBatch(input, rt);
    // Rows marked `skip` are never created, whatever their state now. A row to create that fails its
    // check here (headless and MCP have no card; in the chat the approval-time preview already refused
    // it) is reported, not created.
    const ready = plans.filter((p) => !p.skip && p.errors.length === 0);
    if (ready.length === 0) {
      const bad = plans.filter((p) => !p.skip);
      throw new BadRequestException(
        bad.length === 0
          ? 'Every row is marked skip: nothing to create'
          : `No row can be created: ${rowErrors(bad, 5)}`,
      );
    }
    const created: Row[] = [];
    const problems: Row[] = plans
      .filter((p) => p.skip || p.errors.length > 0)
      .map((p) => ({
        row: p.row,
        ...(p.skip ? { skipped: true } : {}),
        errors: p.errors,
      }));
    const entityRefs: AiEntityRef[] = [];
    let stoppedAt: number | null = null;
    for (const plan of ready) {
      try {
        const asset = asRow(
          await rt.call(AssetsController, 'create', { body: plan.body }),
        );
        created.push({
          row: plan.row,
          id: asset.id,
          assetTag: asset.assetTag ?? null,
        });
        entityRefs.push(assetRef(asset, 'created'));
      } catch (err) {
        const mapped = mapToolError(err);
        if (created.length === 0 && STOP_STATUSES.has(mapped.status ?? 0)) {
          throw err;
        }
        problems.push({ row: plan.row, errors: [mapped.message] });
        if (STOP_STATUSES.has(mapped.status ?? 0)) {
          stoppedAt = plan.row;
          break;
        }
      }
    }
    problems.sort((a, b) => Number(a.row) - Number(b.row));
    const notAttempted =
      stoppedAt === null ? 0 : ready.filter((p) => p.row > stoppedAt).length;
    const notCreated = plans.length - created.length;
    return {
      data: {
        requested: plans.length,
        created: created.length,
        notCreated,
        ...(notAttempted > 0 ? { stoppedAtRow: stoppedAt, notAttempted } : {}),
        createdAssets: created,
        problems,
      },
      summary:
        `Created ${created.length} of ${plans.length} assets` +
        (notCreated > 0 ? `; ${notCreated} not created (see problems).` : '.'),
      entityRefs,
    };
  },
  async preview(input, rt) {
    const { rows: plans, duplicatesChecked } = await planBatch(input, rt);
    const toCreate = plans.filter((p) => !p.skip);
    if (toCreate.length === 0) {
      throw new BadRequestException(
        'Every row is marked skip: nothing to create',
      );
    }
    // A card never shows a row it would not create as shown: a row to create that fails its check
    // refuses the whole proposal, with every reason, until it is fixed or marked `skip`.
    const refused = toCreate.filter((p) => p.errors.length > 0);
    if (refused.length > 0) {
      throw new BadRequestException(
        `${plural(refused.length, 'row', 'rows')} of ${plans.length} cannot be created as given: ` +
          `${rowErrors(refused, 20)}. Fix them (e.g. create the missing model first), or mark them ` +
          'skip: true to create the others without them, and propose again.',
      );
    }
    const skipped = plans.length - toCreate.length;
    const defaulted = toCreate.filter((p) => p.statusDefaulted).length;
    const changes: Change[] = [
      {
        field: 'action',
        after:
          `Create ${toCreate.length} of ${plans.length} assets` +
          (skipped > 0
            ? `; ${plural(skipped, 'row', 'rows')} skipped as requested.`
            : '.'),
        valueKind: 'text',
      },
      { field: 'rowCount', after: plans.length, valueKind: 'number' },
      { field: 'validRows', after: toCreate.length, valueKind: 'number' },
      { field: 'invalidRows', after: skipped, valueKind: 'number' },
    ];
    if (defaulted > 0) {
      changes.push({
        field: 'defaultsApplied',
        after: [
          `status: ${DEFAULT_NEW_ASSET_STATUS} (${defaulted} of ${toCreate.length} rows)`,
        ],
        valueKind: 'text',
      });
    }
    if (!duplicatesChecked) {
      changes.push({
        field: 'duplicatesUnchecked',
        after: true,
        valueKind: 'boolean',
      });
    }
    changes.push({
      field: 'rows',
      after: plans.map(batchRowView),
      valueKind: 'text',
    });
    const precondition = batchPrecondition(plans);
    return {
      changes,
      warnings: [],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
      ...(precondition ? { precondition } : {}),
    };
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
    assetCreateBatch,
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
