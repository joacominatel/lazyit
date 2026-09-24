import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { LocationTypeSchema, type AiActionPreview } from '@lazyit/shared';
import { ApplicationCategoriesController } from '../../application-categories/application-categories.controller';
import { ArticleCategoriesController } from '../../article-categories/article-categories.controller';
import { AssetCategoriesController } from '../../asset-categories/asset-categories.controller';
import { AssetModelsController } from '../../asset-models/asset-models.controller';
import { ConsumableCategoriesController } from '../../consumable-categories/consumable-categories.controller';
import { LocationsController } from '../../locations/locations.controller';
import {
  AI_TOOL_LIST_DEFAULT_LIMIT,
  AI_TOOL_LIST_MAX_LIMIT,
} from '../ai.constants';
import {
  AiReferenceError,
  type AiResolvedReference,
} from '../core/reference-resolver';
import { untrusted } from '../core/result-shaper';
import {
  bind,
  defineTool,
  unexposed,
  type AiToolRunOutput,
  type AiToolRuntime,
  type AiToolset,
} from '../core/tool-descriptor';
import { searchText } from './search-text';

/**
 * The REFERENCE toolset (W2-5; tools-and-execution.md §7 rows 4, 15, 16): the taxonomy and places assets
 * hang off — asset models, the four category taxonomies (article categories are the KB folders) and
 * locations. One read tool (`reference_lookup`) and two creates (`asset_model_create`,
 * `location_create`). The rest of their lifecycle — category create, update and archive, model and
 * location update, archive and restore — is `taxonomy.tools.ts` (#1390).
 *
 * It also exports the reference helpers the assets toolset shares (a model or a location named by id or
 * exact name). Every lookup reads through `rt.call` on a handler the calling tool binds, so a resolution
 * the caller may not read fails exactly as the route would.
 */

// ─── Row helpers (shared with assets.tools.ts) ──────────────────────────────────────────────────────

export type Row = Record<string, unknown>;

export function asRow(value: unknown): Row {
  return typeof value === 'object' && value !== null ? (value as Row) : {};
}

export function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow) : [];
}

/** Keep only the named fields of a row (a concise projection; unknown rows become `{}`). */
export function pick(row: unknown, fields: readonly string[]): Row {
  const source = asRow(row);
  const out: Row = {};
  for (const field of fields) {
    if (field in source) out[field] = iso(source[field]);
  }
  return out;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A value as the wire carries it. A handler dispatched in-process returns Prisma's own objects, never
 * serialized: a `Date` (the preview schema wants ISO strings, and an approval compares versions as
 * strings), a `bigint` (which `JSON.stringify` throws on) or a `Decimal`. Each becomes what the HTTP
 * response would have carried; anything else is returned as is.
 */
export function iso<T>(value: T): T | string | number {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value))
      ? Number(value)
      : value.toString();
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function' &&
    typeof (value as { toFixed?: unknown }).toFixed === 'function'
  ) {
    // A Prisma `Decimal` (decimal.js): serialized as its exact string, compared as a number.
    const decimal = value as unknown as {
      toNumber(): number;
      toString(): string;
    };
    const n = decimal.toNumber();
    return Number.isFinite(n) && String(n) === decimal.toString()
      ? n
      : decimal.toString();
  }
  return value;
}

/** Other-authored JSON (specs, a history payload), serialized, clipped and wrapped as untrusted. */
export function untrustedJson(value: unknown, max = 4000): string | null {
  if (value === null || value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === '{}' || serialized === '[]') return null;
  return untrusted(
    serialized.length > max
      ? `${serialized.slice(0, max)}… [clipped, ${serialized.length} chars]`
      : serialized,
  );
}

/** Prisma's cuid (v1): what every non-user id in lazyit looks like. Stricter than `z.cuid()` on purpose. */
const CUID_ID = /^c[a-z0-9]{24}$/;
const UUID_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isCuidId = (reference: string): boolean => CUID_ID.test(reference);
export const isUuidId = (reference: string): boolean => UUID_ID.test(reference);

export const sameText = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A 404 from a bound read handler, as "no candidate"; anything else (403 above all) propagates. */
export async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof HttpException && err.getStatus() === 404) {
      return null;
    }
    throw err;
  }
}

/** One page of a lookup: the route's own maximum, so an exact match is not missed past a short page. */
export const RESOLVE_PAGE = '200';

/**
 * The exact matches a reference lookup found on ONE page of a substring search. A partial page never
 * decides (same rule as the consumables tools, #1341): when the route matched more rows than the page
 * holds, the entity meant — or a second one with the same name — may sit past it, so the reference is
 * refused as `AMBIGUOUS_REFERENCE` and the model asks for the id. That matters most for MCP and headless
 * writes, which have no preview card a person could catch a wrong target on. Two or more exact matches
 * on the page are already ambiguous and are returned (the resolver names them).
 */
export function exactOnPage(
  page: { items: unknown; total?: unknown },
  isExact: (row: Row) => boolean,
  what: string,
  hint: string,
): Row[] {
  const shown = asRows(page.items);
  const exact = shown.filter(isExact);
  if (exact.length > 1) return exact;
  if (typeof page.total !== 'number' || page.total > shown.length) {
    throw new AiReferenceError(
      'AMBIGUOUS_REFERENCE',
      `"${what}" matches more records than one lookup reads (${String(page.total)}); ${hint}`,
    );
  }
  return exact;
}

/** A list's truncation marker when more rows exist past this page (tools-and-execution.md §7). */
export function pageTruncation(
  shown: number,
  total: number,
  offset: number,
): { shown: number; total: number; nextOffset: number } | undefined {
  return offset + shown < total
    ? { shown, total, nextOffset: offset + shown }
    : undefined;
}

export const referenceString = (what: string) =>
  z.string().trim().min(1).max(200).describe(what);

export const pageLimit = z
  .number()
  .int()
  .min(1)
  .max(AI_TOOL_LIST_MAX_LIMIT)
  .optional()
  .describe(
    `Page size (default ${AI_TOOL_LIST_DEFAULT_LIMIT}, max ${AI_TOOL_LIST_MAX_LIMIT}).`,
  );

export const pageOffset = z
  .number()
  .int()
  .min(0)
  .max(100_000)
  .optional()
  .describe('Zero-based offset; use the `nextOffset` of a truncated result.');

export const detailLevel = z
  .enum(['concise', 'full'])
  .optional()
  .describe(
    'concise (default): the key fields. full: also descriptions and other detail.',
  );

/** A flat key → value map for specs. Nested structures stay a UI concern. */
export const flatSpecs = z
  .record(
    z.string().trim().min(1).max(100),
    z.union([z.string().max(1000), z.number(), z.boolean()]),
  )
  .describe(
    'Flat attributes, e.g. { "ram": "16 GB", "cpu": "i7-1365U" } (string, number or boolean values).',
  );

// ─── References: a model, a location or an asset category by id or exact name ──────────────────────

/** `name (manufacturer)`: how a model is named on a card. */
export const modelLabel = (m: Row): string =>
  str(m.manufacturer)
    ? `${str(m.name) ?? ''} (${str(m.manufacturer)})`
    : (str(m.name) ?? String(m.id));

/**
 * An asset model by id or exact name, through `AssetModelsController.findOne` / `.findAll` (the calling
 * tool binds both). `withLabel: false` lets a raw id pass straight to the write handler (an SA with
 * write-only grants still works, §7 "References"); a preview always reads it, to name it.
 */
export function resolveModel(
  rt: AiToolRuntime,
  reference: string,
  withLabel: boolean,
): Promise<AiResolvedReference> {
  return rt.resolve({
    type: 'assetModel',
    reference,
    ...(withLabel ? {} : { isId: isCuidId }),
    lookup: async (ref) => {
      if (isCuidId(ref)) {
        const model = await orNull(() =>
          rt.call(AssetModelsController, 'findOne', { params: { id: ref } }),
        );
        return model ? [{ id: model.id, label: modelLabel(asRow(model)) }] : [];
      }
      const page = await rt.call(AssetModelsController, 'findAll', {
        query: { q: ref, limit: RESOLVE_PAGE },
      });
      return exactOnPage(
        page,
        (m) => sameText(m.name, ref),
        ref,
        "give the model's id (from reference_lookup)",
      ).map((m) => ({ id: String(m.id), label: modelLabel(m) }));
    },
  });
}

/** A location by id or exact name, through `LocationsController.findOne` / `.findAll`. */
export function resolveLocation(
  rt: AiToolRuntime,
  reference: string,
  withLabel: boolean,
): Promise<AiResolvedReference> {
  return rt.resolve({
    type: 'location',
    reference,
    ...(withLabel ? {} : { isId: isCuidId }),
    lookup: async (ref) => {
      if (isCuidId(ref)) {
        const location = await orNull(() =>
          rt.call(LocationsController, 'findOne', { params: { id: ref } }),
        );
        return location ? [{ id: location.id, label: location.name }] : [];
      }
      const page = await rt.call(LocationsController, 'findAll', {
        query: { q: ref, limit: RESOLVE_PAGE },
      });
      return exactOnPage(
        page,
        (l) => sameText(l.name, ref),
        ref,
        "give the location's id (from reference_lookup)",
      ).map((l) => ({ id: String(l.id), label: String(l.name) }));
    },
  });
}

/** An asset category by id or exact name, through `AssetCategoriesController.findAll` (unpaged). */
export function resolveAssetCategory(
  rt: AiToolRuntime,
  reference: string,
  withLabel: boolean,
): Promise<AiResolvedReference> {
  return rt.resolve({
    type: 'category',
    reference,
    ...(withLabel ? {} : { isId: isCuidId }),
    lookup: async (ref) => {
      const all = asRows(await rt.call(AssetCategoriesController, 'findAll'));
      return all
        .filter((c) => c.id === ref || sameText(c.name, ref))
        .map((c) => ({ id: String(c.id), label: String(c.name) }));
    },
  });
}

/** The `{ type, id, label }` value a card renders for an entity-valued change. */
export const entityValue = (r: AiResolvedReference) => ({
  type: r.type,
  id: r.id,
  ...(r.label !== undefined ? { label: r.label } : {}),
});

type Change = AiActionPreview['changes'][number];

/** A create's `changes`: every provided field, `after` only. */
export function createdFields(
  input: Row,
  kinds: Readonly<Record<string, Change['valueKind']>> = {},
): Change[] {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => ({
      field,
      after: value,
      valueKind:
        kinds[field] ?? (typeof value === 'number' ? 'number' : 'text'),
    }));
}

/** The preview of a create: no target (the entity does not exist yet), so no precondition. */
export function createPreview(changes: Change[]) {
  return {
    changes,
    warnings: [],
    impacted: [],
    untrustedSources: [],
    elevated: false,
    stepUpRequired: false,
  };
}

// ─── reference_lookup ────────────────────────────────────────────────────────────────────────────────

const REFERENCE_KINDS = [
  'assetModel',
  'location',
  'assetCategory',
  'applicationCategory',
  'consumableCategory',
  'articleFolder',
] as const;
type ReferenceKind = (typeof REFERENCE_KINDS)[number];

const MODEL_FIELDS = ['id', 'name', 'manufacturer', 'sku', 'categoryId'];
const LOCATION_FIELDS = ['id', 'name', 'type', 'parentId', 'address', 'floor'];
const CATEGORY_FIELDS = ['id', 'name'];
const FOLDER_FIELDS = ['id', 'name', 'parentId', 'order', 'articleCount'];

/** One row of a kind, concise or full. Free text other people wrote is wrapped; access rules never leave. */
function projectReference(kind: ReferenceKind, row: Row, full: boolean): Row {
  switch (kind) {
    case 'assetModel': {
      const out = pick(row, MODEL_FIELDS);
      if (full) {
        out.description = untrusted(str(row.description));
        out.specs = untrustedJson(row.specs);
      }
      return out;
    }
    case 'location': {
      const out = pick(row, LOCATION_FIELDS);
      if (Array.isArray(row.path)) {
        out.path = asRows(row.path).map((p) => pick(p, ['id', 'name', 'type']));
      }
      if (full) {
        out.description = untrusted(str(row.description));
        out.notes = untrusted(str(row.notes));
      }
      return out;
    }
    case 'articleFolder': {
      const out = pick(row, FOLDER_FIELDS);
      if (full) out.description = untrusted(str(row.description));
      return out;
    }
    case 'assetCategory': {
      const out = pick(row, CATEGORY_FIELDS);
      if (full) {
        out.description = untrusted(str(row.description));
        // The advisory attribute dictionary (ADR-0007 amendment, #851): taxonomy configuration.
        out.specsSchema = untrustedJson(row.specsSchema);
      }
      return out;
    }
    default: {
      const out = pick(row, [...CATEGORY_FIELDS, 'order']);
      if (full) out.description = untrusted(str(row.description));
      return out;
    }
  }
}

/** The unpaged taxonomy lists, read whole through their route and paged here. */
async function listTaxonomy(
  rt: AiToolRuntime,
  kind: Exclude<ReferenceKind, 'assetModel' | 'location'>,
): Promise<Row[]> {
  switch (kind) {
    case 'assetCategory':
      return asRows(await rt.call(AssetCategoriesController, 'findAll'));
    case 'applicationCategory':
      return asRows(await rt.call(ApplicationCategoriesController, 'findAll'));
    case 'consumableCategory':
      return asRows(await rt.call(ConsumableCategoriesController, 'findAll'));
    case 'articleFolder':
      return asRows(await rt.call(ArticleCategoriesController, 'findAll'));
  }
}

async function getReference(
  rt: AiToolRuntime,
  kind: ReferenceKind,
  id: string,
): Promise<Row> {
  const params = { params: { id } };
  switch (kind) {
    case 'assetModel':
      return asRow(await rt.call(AssetModelsController, 'findOne', params));
    case 'location':
      return asRow(await rt.call(LocationsController, 'findOne', params));
    case 'assetCategory':
      return asRow(await rt.call(AssetCategoriesController, 'findOne', params));
    case 'applicationCategory':
      return asRow(
        await rt.call(ApplicationCategoriesController, 'findOne', params),
      );
    case 'consumableCategory':
      return asRow(
        await rt.call(ConsumableCategoriesController, 'findOne', params),
      );
    case 'articleFolder':
      return asRow(
        await rt.call(ArticleCategoriesController, 'findOne', params),
      );
  }
}

const referenceLookup = defineTool({
  name: 'reference_lookup',
  title: 'Look up reference data',
  description:
    'Find the reference data assets and other records hang off: asset models, locations, asset / ' +
    'application / consumable categories and knowledge-base folders. Give `id` for one record, or ' +
    '`query` (a name fragment) to list matches, or neither to list them all. Use it to find the model ' +
    'or location to use before creating or updating an asset. `detail: "full"` on an asset category ' +
    "also returns its attribute dictionary (`specsSchema`, advisory hints for its assets' attributes).",
  domain: 'reference',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    kind: z.enum(REFERENCE_KINDS).describe('Which reference data to read.'),
    id: z
      .cuid()
      .optional()
      .describe('Read this one record (ignores query and paging).'),
    query: searchText('A name fragment to filter by (case-insensitive).'),
    detail: detailLevel,
    limit: pageLimit,
    offset: pageOffset,
  }),
  bindings: [
    bind(AssetModelsController, 'findAll'),
    bind(AssetModelsController, 'findOne'),
    bind(LocationsController, 'findAll'),
    bind(LocationsController, 'findOne'),
    bind(AssetCategoriesController, 'findAll'),
    bind(AssetCategoriesController, 'findOne'),
    bind(ApplicationCategoriesController, 'findAll'),
    bind(ApplicationCategoriesController, 'findOne'),
    bind(ConsumableCategoriesController, 'findAll'),
    bind(ConsumableCategoriesController, 'findOne'),
    bind(ArticleCategoriesController, 'findAll'),
    bind(ArticleCategoriesController, 'findOne'),
  ],
  async run(input, rt): Promise<AiToolRunOutput<Row>> {
    const full = input.detail === 'full';
    if (input.id) {
      const row = await getReference(rt, input.kind, input.id);
      return {
        data: {
          kind: input.kind,
          item: projectReference(input.kind, row, full),
        },
      };
    }
    const limit = input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    let rows: Row[];
    let total: number;
    if (input.kind === 'assetModel' || input.kind === 'location') {
      const query = {
        q: input.query,
        limit: String(limit),
        offset: String(offset),
        sort: 'name',
        dir: 'asc',
      };
      const page =
        input.kind === 'assetModel'
          ? await rt.call(AssetModelsController, 'findAll', { query })
          : await rt.call(LocationsController, 'findAll', { query });
      rows = asRows(page.items);
      total = page.total;
    } else {
      const needle = input.query?.toLowerCase();
      const all = (await listTaxonomy(rt, input.kind)).filter(
        (row) =>
          needle === undefined ||
          (str(row.name) ?? '').toLowerCase().includes(needle),
      );
      total = all.length;
      rows = all.slice(offset, offset + limit);
    }
    const truncated = pageTruncation(rows.length, total, offset);
    return {
      data: {
        kind: input.kind,
        total,
        offset,
        items: rows.map((row) => projectReference(input.kind, row, full)),
      },
      ...(truncated ? { truncated } : {}),
    };
  },
});

// ─── asset_model_create ──────────────────────────────────────────────────────────────────────────────

const assetModelCreate = defineTool({
  name: 'asset_model_create',
  title: 'Create an asset model',
  description:
    'Create an asset model (a make and model, e.g. "Latitude 7440" by Dell) that assets are instances ' +
    'of. The manufacturer is free text (there is no separate manufacturer record to create). Optionally ' +
    'file it under an asset category (by id or exact name): pick the closest existing one from ' +
    'reference_lookup kind "assetCategory", or create a missing one first with category_create. Check ' +
    'with reference_lookup that the model does not exist yet.',
  domain: 'reference',
  class: 'write',
  input: z.strictObject({
    name: z.string().trim().min(1).max(200).describe('The model name.'),
    manufacturer: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('The manufacturer.'),
    sku: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    category: referenceString(
      'The asset category: its id or exact name.',
    ).optional(),
    specs: flatSpecs.optional(),
  }),
  bindings: [
    bind(AssetModelsController, 'create'),
    bind(AssetCategoriesController, 'findAll'),
  ],
  async run(input, rt) {
    const { category, ...fields } = input;
    const categoryId = category
      ? (await resolveAssetCategory(rt, category, false)).id
      : undefined;
    const model = await rt.call(AssetModelsController, 'create', {
      body: { ...fields, ...(categoryId ? { categoryId } : {}) },
    });
    const row = asRow(model);
    return {
      data: pick(row, [...MODEL_FIELDS, 'createdAt']),
      summary: `Created the asset model ${modelLabel(row)}.`,
      entityRefs: [
        {
          type: 'assetModel',
          id: String(row.id),
          op: 'created',
          label: modelLabel(row),
        },
      ],
    };
  },
  async preview(input, rt) {
    const { category, ...fields } = input;
    const changes = createdFields(fields, { specs: 'text' });
    if (category) {
      changes.push({
        field: 'category',
        after: entityValue(await resolveAssetCategory(rt, category, true)),
        valueKind: 'entity',
      });
    }
    return createPreview(changes);
  },
});

// ─── location_create ─────────────────────────────────────────────────────────────────────────────────

const locationCreate = defineTool({
  name: 'location_create',
  title: 'Create a location',
  description:
    'Create a location (an office, a datacenter, a rack, a storage room…), optionally nested under a ' +
    'parent location (by id or exact name). Check with reference_lookup that it does not exist yet.',
  domain: 'reference',
  class: 'write',
  input: z.strictObject({
    name: z.string().trim().min(1).max(200).describe('The location name.'),
    type: LocationTypeSchema.describe('What kind of place it is.'),
    description: z.string().trim().min(1).max(2000).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    floor: z.string().trim().min(1).max(50).optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
    parent: referenceString(
      'The parent location: its id or exact name.',
    ).optional(),
  }),
  bindings: [
    bind(LocationsController, 'create'),
    bind(LocationsController, 'findAll'),
    bind(LocationsController, 'findOne'),
  ],
  async run(input, rt) {
    const { parent, ...fields } = input;
    const parentId = parent
      ? (await resolveLocation(rt, parent, false)).id
      : undefined;
    const location = asRow(
      await rt.call(LocationsController, 'create', {
        body: { ...fields, ...(parentId ? { parentId } : {}) },
      }),
    );
    return {
      data: pick(location, [...LOCATION_FIELDS, 'createdAt']),
      summary: `Created the location ${str(location.name)}.`,
      entityRefs: [
        {
          type: 'location',
          id: String(location.id),
          op: 'created',
          label: String(location.name),
        },
      ],
    };
  },
  async preview(input, rt) {
    const { parent, ...fields } = input;
    const changes = createdFields(fields);
    if (parent) {
      changes.push({
        field: 'parent',
        after: entityValue(await resolveLocation(rt, parent, true)),
        valueKind: 'entity',
      });
    }
    return createPreview(changes);
  },
});

const NO_ARCHIVED_LIST =
  'Category restore: no route lists archived categories, so a card could not name or version the one restored (#1390); restore it from the lazyit UI.';

export const referenceToolset: AiToolset = {
  domain: 'reference',
  tools: [referenceLookup, assetModelCreate, locationCreate],
  unexposed: [
    unexposed(AssetCategoriesController, ['restore'], NO_ARCHIVED_LIST),
    unexposed(ApplicationCategoriesController, ['restore'], NO_ARCHIVED_LIST),
    unexposed(ConsumableCategoriesController, ['restore'], NO_ARCHIVED_LIST),
    unexposed(
      ArticleCategoriesController,
      ['remove', 'restore'],
      'Knowledge-base folder delete (a cascading one included) and restore: v1.1 (tools-and-execution.md §7); create and rename are kb_folder_create / kb_folder_rename.',
    ),
    unexposed(
      ArticleCategoriesController,
      ['setAccessRules'],
      'Folder access rules: elevated authorization configuration, after v1 (tools-and-execution.md §3).',
    ),
  ],
};
