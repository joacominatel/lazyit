import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AssetSpecsDictionarySchema,
  LocationTypeSchema,
  type AiActionPreview,
  type AiEntityRef,
  type AiEntityType,
} from '@lazyit/shared';
import { ApplicationCategoriesController } from '../../application-categories/application-categories.controller';
import { ApplicationsController } from '../../applications/applications.controller';
import { AssetCategoriesController } from '../../asset-categories/asset-categories.controller';
import { AssetModelsController } from '../../asset-models/asset-models.controller';
import { AssetsController } from '../../assets/assets.controller';
import { ConsumableCategoriesController } from '../../consumable-categories/consumable-categories.controller';
import { ConsumablesController } from '../../consumables/consumables.controller';
import { LocationsController } from '../../locations/locations.controller';
import { AiReferenceError } from '../core/reference-resolver';
import { untrusted } from '../core/result-shaper';
import {
  bind,
  defineTool,
  type AiToolPreview,
  type AiToolRuntime,
  type AiToolset,
} from '../core/tool-descriptor';
import {
  RESOLVE_PAGE,
  asRow,
  asRows,
  entityValue,
  exactOnPage,
  iso,
  isCuidId,
  modelLabel,
  pick,
  referenceString,
  resolveAssetCategory,
  resolveLocation,
  resolveModel,
  sameText,
  str,
  untrustedJson,
  type Row,
} from './reference.tools';

/**
 * The TAXONOMY toolset (#1390): managing the reference data assets, applications and consumables hang
 * off — the asset / application / consumable categories (one set of tools with a `kind`, since the three
 * share the `category:*` permissions), asset models and locations. Creating a model or a location is in
 * `reference.tools.ts` (W2-5), reading all of them is `reference_lookup`; this file adds the rest of the
 * lifecycle the routes allow: create (categories), update / rename, archive and restore.
 *
 * Every call is `rt.call` on the real route, so a tool answers 403 exactly where the route does. Every
 * write on an existing row names its target and carries a precondition on its `updatedAt`; an archive
 * shows what still uses the row (models, assets, applications, consumables, child locations) as impact
 * counts, read through the lists the caller may read — a list the caller may not read is reported as
 * unknown, never guessed as zero. Knowledge-base folders (also categories) are the KB toolset's.
 */

type Change = AiActionPreview['changes'][number];
type Impacted = AiToolPreview['impacted'][number];

// ─── Category kinds ──────────────────────────────────────────────────────────────────────────────────

const CATEGORY_KINDS = [
  'assetCategory',
  'applicationCategory',
  'consumableCategory',
] as const;
type CategoryKind = (typeof CATEGORY_KINDS)[number];

const KIND_LABEL: Record<CategoryKind, string> = {
  assetCategory: 'asset category',
  applicationCategory: 'application category',
  consumableCategory: 'consumable category',
};

const categoryKind = z
  .enum(CATEGORY_KINDS)
  .describe(
    'Which taxonomy: assetCategory (groups asset models: Laptops, Servers…), applicationCategory ' +
      '(groups applications) or consumableCategory (groups consumables). Knowledge-base folders are ' +
      'kb_folder_create / kb_folder_rename.',
  );

const categoryName = z.string().trim().min(1).max(100);
const categoryDescription = z.string().trim().min(1).max(1000);
const categoryOrder = z
  .number()
  .int()
  .min(0)
  .max(100_000)
  .describe(
    'Sort position in lists, lower first (application and consumable categories only).',
  );
const specsSchema = AssetSpecsDictionarySchema.describe(
  'Asset categories only: the ADVISORY attribute dictionary for the assets of this category — a list ' +
    'of { key, label, type: string|number|boolean|enum, required?, enumValues? }. It only drives hints ' +
    'and soft warnings in the asset form; it never blocks a save. Replaces the whole list; [] clears it.',
);

async function listCategories(
  rt: AiToolRuntime,
  kind: CategoryKind,
): Promise<Row[]> {
  switch (kind) {
    case 'assetCategory':
      return asRows(await rt.call(AssetCategoriesController, 'findAll'));
    case 'applicationCategory':
      return asRows(await rt.call(ApplicationCategoriesController, 'findAll'));
    case 'consumableCategory':
      return asRows(await rt.call(ConsumableCategoriesController, 'findAll'));
  }
}

async function createCategory(
  rt: AiToolRuntime,
  kind: CategoryKind,
  body: Row,
): Promise<Row> {
  switch (kind) {
    case 'assetCategory':
      return asRow(
        await rt.call(AssetCategoriesController, 'create', { body }),
      );
    case 'applicationCategory':
      return asRow(
        await rt.call(ApplicationCategoriesController, 'create', { body }),
      );
    case 'consumableCategory':
      return asRow(
        await rt.call(ConsumableCategoriesController, 'create', { body }),
      );
  }
}

async function updateCategory(
  rt: AiToolRuntime,
  kind: CategoryKind,
  id: string,
  body: Row,
): Promise<Row> {
  const shape = { params: { id }, body };
  switch (kind) {
    case 'assetCategory':
      return asRow(await rt.call(AssetCategoriesController, 'update', shape));
    case 'applicationCategory':
      return asRow(
        await rt.call(ApplicationCategoriesController, 'update', shape),
      );
    case 'consumableCategory':
      return asRow(
        await rt.call(ConsumableCategoriesController, 'update', shape),
      );
  }
}

async function removeCategory(
  rt: AiToolRuntime,
  kind: CategoryKind,
  id: string,
): Promise<Row> {
  const shape = { params: { id } };
  switch (kind) {
    case 'assetCategory':
      return asRow(await rt.call(AssetCategoriesController, 'remove', shape));
    case 'applicationCategory':
      return asRow(
        await rt.call(ApplicationCategoriesController, 'remove', shape),
      );
    case 'consumableCategory':
      return asRow(
        await rt.call(ConsumableCategoriesController, 'remove', shape),
      );
  }
}

/**
 * A category of one kind by id or exact name, read from its (unpaged, whole) list — so there is no
 * partial page to decide on. `withRow: false` lets a raw id pass straight to the write handler (a
 * Service Account with write-only grants still works); a preview always reads the row, to name and
 * version it.
 */
async function resolveCategory(
  rt: AiToolRuntime,
  kind: CategoryKind,
  reference: string,
  withRow: boolean,
): Promise<{ id: string; row?: Row }> {
  const rows = new Map<string, Row>();
  const resolved = await rt.resolve({
    type: 'category',
    reference,
    ...(withRow ? {} : { isId: isCuidId }),
    lookup: async (ref) =>
      (await listCategories(rt, kind))
        .filter((c) => c.id === ref || sameText(c.name, ref))
        .map((c) => {
          rows.set(String(c.id), c);
          return { id: String(c.id), label: String(c.name) };
        }),
  });
  return { id: resolved.id, row: rows.get(resolved.id) };
}

/** The fields only one kind has: refused for the others before any card or write. */
function assertKindFields(
  kind: CategoryKind,
  input: { order?: number; specsSchema?: unknown },
): void {
  if (input.order !== undefined && kind === 'assetCategory') {
    throw new BadRequestException(
      '`order` applies to application and consumable categories only.',
    );
  }
  if (input.specsSchema !== undefined && kind !== 'assetCategory') {
    throw new BadRequestException(
      '`specsSchema` (the attribute dictionary) applies to asset categories only.',
    );
  }
}

/** A dictionary as one readable line for the card: `ram (RAM, number, required), os (OS, enum: …)`. */
function describeDictionary(value: unknown): string {
  const fields = asRows(value);
  if (fields.length === 0) return 'None';
  return fields
    .map((f) => {
      const parts = [str(f.label) ?? '', str(f.type) ?? ''];
      if (f.required === true) parts.push('required');
      if (Array.isArray(f.enumValues) && f.enumValues.length > 0) {
        parts[1] = `${parts[1]}: ${f.enumValues.map(String).join(' | ')}`;
      }
      return `${str(f.key) ?? '?'} (${parts.filter(Boolean).join(', ')})`;
    })
    .join('; ');
}

const categoryRef = (
  row: Row,
  op: AiEntityRef['op'],
): AiEntityRef & { type: 'category' } => ({
  type: 'category',
  id: String(row.id),
  op,
  label: String(row.name),
});

function preconditionOf(target: AiEntityRef, row: Row) {
  const updatedAt = iso(row.updatedAt);
  if (typeof updatedAt !== 'string') {
    // Never a card without a version check: a row without a timestamp is a tool/handler bug.
    throw new Error(`${target.type} ${target.id} carries no updatedAt`);
  }
  return { entity: target, updatedAt };
}

const CATEGORY_RESULT_FIELDS = [
  'id',
  'name',
  'order',
  'createdAt',
  'updatedAt',
  'deletedAt',
];

function categoryResult(kind: CategoryKind, row: Row): Row {
  const out = pick(row, CATEGORY_RESULT_FIELDS);
  out.kind = kind;
  out.name = untrusted(str(row.name));
  if (row.description !== undefined) {
    out.description = untrusted(str(row.description));
  }
  if (kind === 'assetCategory')
    out.specsSchema = untrustedJson(row.specsSchema);
  return out;
}

// ─── Impact: what still uses a row that is about to be archived ──────────────────────────────────────

/** A read the caller may not make (403) is "unknown", not a failure: the card says so. */
async function unlessForbidden<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof HttpException && err.getStatus() === 403) return null;
    throw err;
  }
}

/** One impacted row from a filtered page: its total and up to five of its items. */
function impactOf(
  type: AiEntityType,
  page: { items: unknown; total?: unknown },
  label: (row: Row) => string | undefined = (row) => str(row.name) ?? undefined,
): Impacted | null {
  const total = typeof page.total === 'number' ? page.total : 0;
  if (total === 0) return null;
  return {
    type,
    count: total,
    sample: asRows(page.items)
      .slice(0, 5)
      .map((row) => {
        const text = label(row);
        return {
          type,
          id: String(row.id),
          op: 'updated' as const,
          ...(text ? { label: text } : {}),
        };
      }),
  };
}

/** Scans at most this many rows of an unfiltered list to count the ones pointing at a row. */
const SCAN_PAGES = 5;

/**
 * Count the rows of a paged list that point at `id` through `field`, scanning up to five pages of 200.
 * Past that the count is unknown (`null`): a partial scan never reports a number it did not see.
 */
async function scanCount(
  read: (offset: number) => Promise<{ items: unknown; total?: unknown }>,
  matches: (row: Row) => boolean,
): Promise<{ total: number; items: Row[] } | null> {
  const hits: Row[] = [];
  for (let pageNo = 0; pageNo < SCAN_PAGES; pageNo++) {
    const offset = pageNo * Number(RESOLVE_PAGE);
    const page = await read(offset);
    const rows = asRows(page.items);
    hits.push(...rows.filter(matches));
    const total = typeof page.total === 'number' ? page.total : 0;
    if (offset + rows.length >= total || rows.length === 0) {
      return { total: hits.length, items: hits };
    }
  }
  return null;
}

interface Impact {
  impacted: Impacted[];
  /** The kinds of dependents the caller could not count (their list is not readable, or too long). */
  unknown: string[];
}

function collect(
  impact: Impact,
  what: string,
  result: Impacted | null | undefined,
): void {
  if (result === undefined) impact.unknown.push(what);
  else if (result) impact.impacted.push(result);
}

/** `undefined` = could not count; `null` = nothing uses it. */
async function counted(
  read: () => Promise<Impacted | null>,
): Promise<Impacted | null | undefined> {
  const result = await unlessForbidden(async () => ({ value: await read() }));
  return result === null ? undefined : result.value;
}

async function categoryImpact(
  rt: AiToolRuntime,
  kind: CategoryKind,
  id: string,
): Promise<Impact> {
  const impact: Impact = { impacted: [], unknown: [] };
  switch (kind) {
    case 'assetCategory': {
      collect(
        impact,
        'asset models',
        await counted(async () =>
          impactOf(
            'assetModel',
            await rt.call(AssetModelsController, 'findAll', {
              query: { categoryId: id, limit: '5' },
            }),
            modelLabel,
          ),
        ),
      );
      collect(
        impact,
        'assets',
        await counted(async () =>
          impactOf(
            'asset',
            await rt.call(AssetsController, 'findAll', {
              query: { categoryId: id, limit: '5' },
            }),
            (a) => str(a.assetTag) ?? undefined,
          ),
        ),
      );
      break;
    }
    case 'applicationCategory': {
      // The applications list has no category filter: count by scanning it (bounded).
      collect(
        impact,
        'applications',
        await counted(async () => {
          const scan = await scanCount(
            (offset) =>
              rt.call(ApplicationsController, 'findAll', {
                query: { limit: RESOLVE_PAGE, offset: String(offset) },
              }),
            (app) => app.categoryId === id,
          );
          if (scan === null) throw new ScanTooLong();
          return impactOf('application', scan);
        }).catch(unknownOnLongScan),
      );
      break;
    }
    case 'consumableCategory': {
      collect(
        impact,
        'consumables',
        await counted(async () =>
          impactOf(
            'consumable',
            await rt.call(ConsumablesController, 'findAll', {
              query: { category: id, limit: '5' },
            }),
          ),
        ),
      );
      break;
    }
  }
  return impact;
}

class ScanTooLong extends Error {}
const unknownOnLongScan = (err: unknown): undefined => {
  if (err instanceof ScanTooLong) return undefined;
  throw err;
};

/** The card rows an archive carries: archived false → true, plus what could not be counted. */
function archiveChanges(impact: Impact): Change[] {
  return [
    { field: 'archived', before: false, after: true, valueKind: 'boolean' },
    ...(impact.unknown.length > 0
      ? [
          {
            field: 'usedBy',
            after: `Unknown to you: ${impact.unknown.join(', ')}`,
            valueKind: 'text' as const,
          },
        ]
      : []),
  ];
}

function previewOf(
  parts: Pick<AiToolPreview, 'changes' | 'warnings'> &
    Partial<Pick<AiToolPreview, 'target' | 'precondition' | 'impacted'>>,
): AiToolPreview {
  return {
    impacted: [],
    untrustedSources: [],
    ...parts,
    elevated: false,
    stepUpRequired: false,
  };
}

/** `before → after` rows for the scalar fields that change; unchanged fields are not on the card. */
function diff(
  current: Row,
  fields: ReadonlyArray<{ field: string; kind?: Change['valueKind'] }>,
  input: Row,
): Change[] {
  const changes: Change[] = [];
  for (const { field, kind } of fields) {
    const after = input[field];
    if (after === undefined) continue;
    const before = iso(current[field]) ?? null;
    if (before === after) continue;
    changes.push({
      field,
      before,
      after,
      valueKind: kind ?? (typeof after === 'number' ? 'number' : 'text'),
    });
  }
  return changes;
}

function nothingToChange(label: string): never {
  throw new BadRequestException(
    `Nothing to change: ${label} already has these values`,
  );
}

// ─── category_create ─────────────────────────────────────────────────────────────────────────────────

const categoryCreate = defineTool({
  name: 'category_create',
  title: 'Create a category',
  description:
    'Create an asset, application or consumable category (`kind`). Check with reference_lookup that it ' +
    'does not exist yet — a live category with the same name is refused. An asset category may carry ' +
    'an advisory attribute dictionary (`specsSchema`) for its assets; application and consumable ' +
    'categories may carry a sort `order`.',
  domain: 'reference',
  class: 'write',
  input: z.strictObject({
    kind: categoryKind,
    name: categoryName.describe('The category name (unique per kind).'),
    description: categoryDescription.optional(),
    order: categoryOrder.optional(),
    specsSchema: specsSchema.optional(),
  }),
  bindings: [
    bind(AssetCategoriesController, 'create'),
    bind(ApplicationCategoriesController, 'create'),
    bind(ConsumableCategoriesController, 'create'),
    bind(AssetCategoriesController, 'findAll'),
    bind(ApplicationCategoriesController, 'findAll'),
    bind(ConsumableCategoriesController, 'findAll'),
  ],
  async run(input, rt) {
    const { kind, ...body } = input;
    assertKindFields(kind, input);
    const created = await createCategory(rt, kind, body);
    return {
      data: categoryResult(kind, created),
      summary: `Created the ${KIND_LABEL[kind]} ${untrusted(str(created.name))}.`,
      entityRefs: [categoryRef(created, 'created')],
    };
  },
  async preview(input, rt) {
    const { kind } = input;
    assertKindFields(kind, input);
    // A card is never shown for a create the route would refuse: the live name is unique per kind.
    const clash = (await listCategories(rt, kind)).find((c) =>
      sameText(c.name, input.name),
    );
    if (clash) {
      throw new ConflictException(
        `An ${KIND_LABEL[kind]} named "${input.name}" already exists (${String(clash.id)}).`,
      );
    }
    const changes: Change[] = [
      { field: 'kind', after: KIND_LABEL[kind], valueKind: 'text' },
      { field: 'name', after: input.name, valueKind: 'text' },
    ];
    if (input.description !== undefined) {
      changes.push({
        field: 'description',
        after: input.description,
        valueKind: 'text',
      });
    }
    if (input.order !== undefined) {
      changes.push({ field: 'order', after: input.order, valueKind: 'number' });
    }
    if (input.specsSchema !== undefined) {
      changes.push({
        field: 'specsSchema',
        after: describeDictionary(input.specsSchema),
        valueKind: 'text',
      });
    }
    return previewOf({ changes, warnings: [] });
  },
});

// ─── category_update ─────────────────────────────────────────────────────────────────────────────────

const CATEGORY_SCALARS = [
  { field: 'name' },
  { field: 'description' },
  { field: 'order', kind: 'number' as const },
];

const categoryUpdate = defineTool({
  name: 'category_update',
  title: 'Update a category',
  description:
    'Rename an asset, application or consumable category, or change its description, sort order ' +
    '(application / consumable) or advisory attribute dictionary (asset categories: `specsSchema` ' +
    'replaces the whole list). Name the category by id or exact name. Everything filed under it stays ' +
    'there.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z.strictObject({
    kind: categoryKind,
    category: referenceString('The category: its id or exact name.'),
    name: categoryName.optional().describe('The new name.'),
    description: categoryDescription.optional(),
    order: categoryOrder.optional(),
    specsSchema: specsSchema.optional(),
  }),
  bindings: [
    bind(AssetCategoriesController, 'update'),
    bind(ApplicationCategoriesController, 'update'),
    bind(ConsumableCategoriesController, 'update'),
    bind(AssetCategoriesController, 'findAll'),
    bind(ApplicationCategoriesController, 'findAll'),
    bind(ConsumableCategoriesController, 'findAll'),
  ],
  async run(input, rt) {
    const { kind, category, ...body } = input;
    assertKindFields(kind, input);
    if (Object.values(body).every((v) => v === undefined)) {
      nothingToChange(`the ${KIND_LABEL[kind]}`);
    }
    const { id } = await resolveCategory(rt, kind, category, false);
    const updated = await updateCategory(rt, kind, id, body);
    return {
      data: categoryResult(kind, updated),
      summary: `Updated the ${KIND_LABEL[kind]} ${untrusted(str(updated.name))}.`,
      entityRefs: [categoryRef(updated, 'updated')],
    };
  },
  async preview(input, rt) {
    const { kind, category, ...fields } = input;
    assertKindFields(kind, input);
    const { row } = await resolveCategory(rt, kind, category, true);
    const current = row!;
    const changes = diff(current, CATEGORY_SCALARS, fields);
    if (input.name !== undefined && !sameText(current.name, input.name)) {
      const clash = (await listCategories(rt, kind)).find(
        (c) => c.id !== current.id && sameText(c.name, input.name!),
      );
      if (clash) {
        throw new ConflictException(
          `An ${KIND_LABEL[kind]} named "${input.name}" already exists (${String(clash.id)}).`,
        );
      }
    }
    if (input.specsSchema !== undefined) {
      const before = describeDictionary(current.specsSchema);
      const after = describeDictionary(input.specsSchema);
      if (before !== after) {
        changes.push({
          field: 'specsSchema',
          before,
          after,
          valueKind: 'text',
        });
      }
    }
    if (changes.length === 0) nothingToChange(String(current.name));
    const target = categoryRef(current, 'updated');
    return previewOf({
      target,
      changes,
      warnings: [],
      precondition: preconditionOf(target, current),
    });
  },
});

// ─── category_archive ────────────────────────────────────────────────────────────────────────────────

const categoryArchive = defineTool({
  name: 'category_archive',
  title: 'Archive a category',
  description:
    'Archive (soft-delete) an asset, application or consumable category by id or exact name. What is ' +
    'filed under it keeps existing but shows no live category; an administrator can restore it from ' +
    'the lazyit UI. The approval card shows how many models, assets, applications or consumables still ' +
    'use it — check with the person before archiving one in use.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z.strictObject({
    kind: categoryKind,
    category: referenceString('The category: its id or exact name.'),
  }),
  bindings: [
    bind(AssetCategoriesController, 'remove'),
    bind(ApplicationCategoriesController, 'remove'),
    bind(ConsumableCategoriesController, 'remove'),
    bind(AssetCategoriesController, 'findAll'),
    bind(ApplicationCategoriesController, 'findAll'),
    bind(ConsumableCategoriesController, 'findAll'),
    bind(AssetModelsController, 'findAll'),
    bind(AssetsController, 'findAll'),
    bind(ApplicationsController, 'findAll'),
    bind(ConsumablesController, 'findAll'),
  ],
  async run(input, rt) {
    const { id } = await resolveCategory(rt, input.kind, input.category, false);
    const archived = await removeCategory(rt, input.kind, id);
    return {
      data: categoryResult(input.kind, archived),
      summary: `Archived the ${KIND_LABEL[input.kind]} ${untrusted(str(archived.name))}.`,
      entityRefs: [categoryRef(archived, 'archived')],
    };
  },
  async preview(input, rt) {
    const { row } = await resolveCategory(rt, input.kind, input.category, true);
    const current = row!;
    const impact = await categoryImpact(rt, input.kind, String(current.id));
    const target = categoryRef(current, 'archived');
    return previewOf({
      target,
      changes: archiveChanges(impact),
      warnings: ['SOFT_DELETE'],
      impacted: impact.impacted,
      precondition: preconditionOf(target, current),
    });
  },
});

// ─── asset models: update / archive / restore ────────────────────────────────────────────────────────

const modelRef = (row: Row, op: AiEntityRef['op']): AiEntityRef => ({
  type: 'assetModel',
  id: String(row.id),
  op,
  label: modelLabel(row),
});

const MODEL_RESULT_FIELDS = [
  'id',
  'name',
  'manufacturer',
  'sku',
  'categoryId',
  'updatedAt',
  'deletedAt',
];

function modelResult(row: Row): Row {
  const out = pick(row, MODEL_RESULT_FIELDS);
  if (row.description !== undefined) {
    out.description = untrusted(str(row.description));
  }
  if (row.specs !== undefined) out.specs = untrustedJson(row.specs);
  return out;
}

/** Model-level default attributes: a `null` value removes the key. */
const modelSpecsPatch = z
  .record(
    z.string().trim().min(1).max(100),
    z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]),
  )
  .describe(
    'Default attributes to set on the model, merged over the current ones, e.g. { "ram": "16 GB" }; a ' +
      'null value removes that attribute.',
  );

function mergeSpecs(current: unknown, patch: Record<string, unknown>): Row {
  const merged: Row = {};
  const base = asRow(current);
  for (const key of Object.keys(base)) merged[key] = base[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

const MODEL_SCALARS = [
  { field: 'name' },
  { field: 'manufacturer' },
  { field: 'sku' },
  { field: 'description' },
];

const assetModelUpdate = defineTool({
  name: 'asset_model_update',
  title: 'Update an asset model',
  description:
    'Change an asset model (by id or exact name): rename it, correct its manufacturer or SKU, change ' +
    'its description, file it under another asset category (by id or exact name), or set / remove ' +
    'its default attributes (`specs`, merged). Every asset of the model sees the change.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z.strictObject({
    model: referenceString('The asset model: its id or exact name.'),
    name: z.string().trim().min(1).max(200).optional(),
    manufacturer: z.string().trim().min(1).max(200).optional(),
    sku: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    category: referenceString(
      'The asset category to file it under: its id or exact name.',
    ).optional(),
    specs: modelSpecsPatch.optional(),
  }),
  bindings: [
    bind(AssetModelsController, 'update'),
    bind(AssetModelsController, 'findOne'),
    bind(AssetModelsController, 'findAll'),
    bind(AssetCategoriesController, 'findAll'),
  ],
  async run(input, rt) {
    const { model, category, specs, ...fields } = input;
    const { id } = await resolveModel(rt, model, false);
    const body: Row = { ...fields };
    if (category) {
      body.categoryId = (await resolveAssetCategory(rt, category, false)).id;
    }
    if (specs) {
      // The route replaces `specs` whole: merge over the attributes read now.
      const current = asRow(
        await rt.call(AssetModelsController, 'findOne', { params: { id } }),
      );
      body.specs = mergeSpecs(current.specs, specs);
    }
    if (Object.keys(body).length === 0) nothingToChange('the model');
    const updated = asRow(
      await rt.call(AssetModelsController, 'update', {
        params: { id },
        body,
      }),
    );
    return {
      data: modelResult(updated),
      summary: `Updated the asset model ${untrusted(modelLabel(updated))}.`,
      entityRefs: [modelRef(updated, 'updated')],
    };
  },
  async preview(input, rt) {
    const { model, category, specs, ...fields } = input;
    const resolved = await resolveModel(rt, model, true);
    const current = asRow(
      await rt.call(AssetModelsController, 'findOne', {
        params: { id: resolved.id },
      }),
    );
    const changes = diff(current, MODEL_SCALARS, fields);
    if (category) {
      const after = await resolveAssetCategory(rt, category, true);
      if (after.id !== current.categoryId) {
        const before = current.categoryId
          ? ((await listCategories(rt, 'assetCategory'))
              .filter((c) => c.id === current.categoryId)
              .map((c) => ({
                type: 'category' as const,
                id: String(c.id),
                label: String(c.name),
              }))[0] ?? {
              type: 'category' as const,
              id: str(current.categoryId) ?? '',
            })
          : null;
        changes.push({
          field: 'category',
          before,
          after: entityValue(after),
          valueKind: 'entity',
        });
      }
    }
    const base = asRow(current.specs);
    for (const [key, after] of Object.entries(specs ?? {})) {
      const before = Object.hasOwn(base, key) ? (base[key] ?? null) : null;
      if (before === after) continue;
      changes.push({ field: `specs.${key}`, before, after, valueKind: 'text' });
    }
    if (changes.length === 0) nothingToChange(modelLabel(current));
    const target = modelRef(current, 'updated');
    return previewOf({
      target,
      changes,
      warnings: [],
      precondition: preconditionOf(target, current),
    });
  },
});

const assetModelArchive = defineTool({
  name: 'asset_model_archive',
  title: 'Archive an asset model',
  description:
    'Archive (soft-delete) an asset model by id or exact name. Its assets keep existing and keep ' +
    'pointing at it; the model leaves the model lists and can be restored with asset_model_restore. ' +
    'The approval card shows how many assets still use it — check with the person before archiving ' +
    'one in use.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z.strictObject({
    model: referenceString('The asset model: its id or exact name.'),
  }),
  bindings: [
    bind(AssetModelsController, 'remove'),
    bind(AssetModelsController, 'findOne'),
    bind(AssetModelsController, 'findAll'),
    bind(AssetsController, 'findAll'),
  ],
  async run(input, rt) {
    const { id } = await resolveModel(rt, input.model, false);
    const archived = asRow(
      await rt.call(AssetModelsController, 'remove', { params: { id } }),
    );
    return {
      data: modelResult(archived),
      summary: `Archived the asset model ${untrusted(modelLabel(archived))}.`,
      entityRefs: [modelRef(archived, 'archived')],
    };
  },
  async preview(input, rt) {
    const resolved = await resolveModel(rt, input.model, true);
    const current = asRow(
      await rt.call(AssetModelsController, 'findOne', {
        params: { id: resolved.id },
      }),
    );
    const impact: Impact = { impacted: [], unknown: [] };
    collect(
      impact,
      'assets',
      await counted(async () =>
        impactOf(
          'asset',
          await rt.call(AssetsController, 'findAll', {
            query: { modelId: resolved.id, limit: '5' },
          }),
          (a) => str(a.assetTag) ?? undefined,
        ),
      ),
    );
    const target = modelRef(current, 'archived');
    return previewOf({
      target,
      changes: archiveChanges(impact),
      warnings: ['SOFT_DELETE'],
      impacted: impact.impacted,
      precondition: preconditionOf(target, current),
    });
  },
});

/**
 * An ARCHIVED row by id or exact name, through a list's `deleted=only` slice (ADMIN only, ADR-0041). A
 * name is a `q` search whose partial page never decides; an id — the lists have no id filter — scans
 * at most five pages and, when more archived rows exist, is refused asking for the name.
 */
async function resolveArchived(
  rt: AiToolRuntime,
  type: 'assetModel' | 'location',
  reference: string,
  read: (
    query: Record<string, string>,
  ) => Promise<{ items: unknown; total?: unknown }>,
  label: (row: Row) => string,
): Promise<Row> {
  const rows = new Map<string, Row>();
  const remember = (row: Row) => {
    rows.set(String(row.id), row);
    return { id: String(row.id), label: label(row) };
  };
  const resolved = await rt.resolve({
    type,
    reference,
    lookup: async (ref) => {
      if (isCuidId(ref)) {
        for (let pageNo = 0; pageNo < SCAN_PAGES; pageNo++) {
          const offset = pageNo * Number(RESOLVE_PAGE);
          const page = await read({
            deleted: 'only',
            limit: RESOLVE_PAGE,
            offset: String(offset),
          });
          const shown = asRows(page.items);
          const hit = shown.find((r) => r.id === ref);
          if (hit) return [remember(hit)];
          const total = typeof page.total === 'number' ? page.total : 0;
          if (offset + shown.length >= total || shown.length === 0) return [];
        }
        throw new AiReferenceError(
          'AMBIGUOUS_REFERENCE',
          `Too many archived records to find ${ref} by id; give its exact name`,
        );
      }
      const page = await read({
        deleted: 'only',
        q: ref,
        limit: RESOLVE_PAGE,
      });
      return exactOnPage(
        page,
        (r) => sameText(r.name, ref),
        ref,
        'give its id',
      ).map(remember);
    },
  });
  return rows.get(resolved.id)!;
}

const archivedModel = (rt: AiToolRuntime, reference: string) =>
  resolveArchived(
    rt,
    'assetModel',
    reference,
    (query) => rt.call(AssetModelsController, 'findAll', { query }),
    modelLabel,
  );

const assetModelRestore = defineTool({
  name: 'asset_model_restore',
  title: 'Restore an archived asset model',
  description:
    'Bring an archived asset model back, by id or exact name. Only archived models can be restored. ' +
    'Administrators only.',
  domain: 'reference',
  class: 'write',
  idempotent: true,
  input: z.strictObject({
    model: referenceString('The archived asset model: its id or exact name.'),
  }),
  bindings: [
    bind(AssetModelsController, 'restore'),
    bind(AssetModelsController, 'findAll'),
  ],
  async run(input, rt) {
    const current = await archivedModel(rt, input.model);
    const restored = asRow(
      await rt.call(AssetModelsController, 'restore', {
        params: { id: String(current.id) },
      }),
    );
    return {
      data: modelResult(restored),
      summary: `Restored the asset model ${untrusted(modelLabel(restored))}.`,
      entityRefs: [modelRef(restored, 'restored')],
    };
  },
  async preview(input, rt) {
    const current = await archivedModel(rt, input.model);
    const target = modelRef(current, 'restored');
    return previewOf({
      target,
      changes: [
        { field: 'archived', before: true, after: false, valueKind: 'boolean' },
      ],
      warnings: [],
      precondition: preconditionOf(target, current),
    });
  },
});

// ─── locations: update / archive / restore ───────────────────────────────────────────────────────────

const locationRef = (row: Row, op: AiEntityRef['op']): AiEntityRef => ({
  type: 'location',
  id: String(row.id),
  op,
  label: String(row.name),
});

const LOCATION_RESULT_FIELDS = [
  'id',
  'name',
  'type',
  'parentId',
  'address',
  'floor',
  'updatedAt',
  'deletedAt',
];

function locationResult(row: Row): Row {
  const out = pick(row, LOCATION_RESULT_FIELDS);
  if (row.description !== undefined) {
    out.description = untrusted(str(row.description));
  }
  if (row.notes !== undefined) out.notes = untrusted(str(row.notes));
  return out;
}

const LOCATION_SCALARS = [
  { field: 'name' },
  { field: 'type' },
  { field: 'description' },
  { field: 'address' },
  { field: 'floor' },
  { field: 'notes' },
];

const TOP_LEVEL = 'None (top level)';

/** The parent a location detail names: the entry before itself in its root→self `path`. */
function parentOf(
  detail: Row,
): { type: 'location'; id: string; label: string } | null {
  const path = asRows(detail.path);
  const parent = path.length >= 2 ? path[path.length - 2] : undefined;
  if (parent) {
    return {
      type: 'location',
      id: String(parent.id),
      label: String(parent.name),
    };
  }
  const parentId = str(detail.parentId);
  return parentId ? { type: 'location', id: parentId, label: parentId } : null;
}

const locationUpdate = defineTool({
  name: 'location_update',
  title: 'Update a location',
  description:
    'Change a location (by id or exact name): rename it, change its type, description, address, floor ' +
    'or notes, or move it under another location (`parent`, by id or exact name; null makes it a ' +
    'top-level location). Its assets and child locations move with it.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z.strictObject({
    location: referenceString('The location: its id or exact name.'),
    name: z.string().trim().min(1).max(200).optional(),
    type: LocationTypeSchema.optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    floor: z.string().trim().min(1).max(50).optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
    parent: referenceString('The new parent location: its id or exact name.')
      .nullable()
      .optional()
      .describe(
        'The new parent location (id or exact name), or null to make it top-level.',
      ),
  }),
  bindings: [
    bind(LocationsController, 'update'),
    bind(LocationsController, 'findOne'),
    bind(LocationsController, 'findAll'),
  ],
  async run(input, rt) {
    const { location, parent, ...fields } = input;
    const { id } = await resolveLocation(rt, location, false);
    const body: Row = { ...fields };
    if (parent !== undefined) {
      body.parentId =
        parent === null ? null : (await resolveLocation(rt, parent, false)).id;
    }
    if (Object.values(body).every((v) => v === undefined)) {
      nothingToChange('the location');
    }
    const updated = asRow(
      await rt.call(LocationsController, 'update', {
        params: { id },
        body,
      }),
    );
    return {
      data: locationResult(updated),
      summary: `Updated the location ${untrusted(str(updated.name))}.`,
      entityRefs: [locationRef(updated, 'updated')],
    };
  },
  async preview(input, rt) {
    const { location, parent, ...fields } = input;
    const resolved = await resolveLocation(rt, location, true);
    const current = asRow(
      await rt.call(LocationsController, 'findOne', {
        params: { id: resolved.id },
      }),
    );
    const changes = diff(current, LOCATION_SCALARS, fields);
    if (parent !== undefined) {
      const before = parentOf(current);
      if (parent === null) {
        if (before) {
          changes.push({
            field: 'parent',
            before,
            after: TOP_LEVEL,
            valueKind: 'entity',
          });
        }
      } else {
        const after = await resolveLocation(rt, parent, true);
        // Never a card for a move the route refuses: under itself or one of its own descendants.
        const target = asRow(
          await rt.call(LocationsController, 'findOne', {
            params: { id: after.id },
          }),
        );
        if (asRows(target.path).some((p) => p.id === current.id)) {
          throw new BadRequestException(
            after.id === current.id
              ? 'A location cannot be its own parent.'
              : 'A location cannot be moved under one of its own descendants.',
          );
        }
        if (before?.id !== after.id) {
          changes.push({
            field: 'parent',
            before: before ?? TOP_LEVEL,
            after: entityValue(after),
            valueKind: 'entity',
          });
        }
      }
    }
    if (changes.length === 0) nothingToChange(String(current.name));
    const target = locationRef(current, 'updated');
    return previewOf({
      target,
      changes,
      warnings: [],
      precondition: preconditionOf(target, current),
    });
  },
});

const locationArchive = defineTool({
  name: 'location_archive',
  title: 'Archive a location',
  description:
    'Archive (soft-delete) a location by id or exact name. Its assets keep pointing at it and its child ' +
    'locations show as top-level until it is restored (location_restore). The approval card shows how ' +
    'many assets and child locations it still has — check with the person before archiving one in use.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z.strictObject({
    location: referenceString('The location: its id or exact name.'),
  }),
  bindings: [
    bind(LocationsController, 'remove'),
    bind(LocationsController, 'findOne'),
    bind(LocationsController, 'findAll'),
    bind(AssetsController, 'findAll'),
  ],
  async run(input, rt) {
    const { id } = await resolveLocation(rt, input.location, false);
    const archived = asRow(
      await rt.call(LocationsController, 'remove', { params: { id } }),
    );
    return {
      data: locationResult(archived),
      summary: `Archived the location ${untrusted(str(archived.name))}.`,
      entityRefs: [locationRef(archived, 'archived')],
    };
  },
  async preview(input, rt) {
    const resolved = await resolveLocation(rt, input.location, true);
    const current = asRow(
      await rt.call(LocationsController, 'findOne', {
        params: { id: resolved.id },
      }),
    );
    const id = String(current.id);
    const impact: Impact = { impacted: [], unknown: [] };
    collect(
      impact,
      'assets',
      await counted(async () =>
        impactOf(
          'asset',
          await rt.call(AssetsController, 'findAll', {
            query: { locationId: id, limit: '5' },
          }),
          (a) => str(a.assetTag) ?? undefined,
        ),
      ),
    );
    // The locations list has no parent filter: count the children by scanning it (bounded).
    const children = await scanCount(
      (offset) =>
        rt.call(LocationsController, 'findAll', {
          query: { limit: RESOLVE_PAGE, offset: String(offset) },
        }),
      (l) => l.parentId === id,
    );
    collect(
      impact,
      'child locations',
      children === null ? undefined : impactOf('location', children),
    );
    const target = locationRef(current, 'archived');
    return previewOf({
      target,
      changes: archiveChanges(impact),
      warnings: ['SOFT_DELETE'],
      impacted: impact.impacted,
      precondition: preconditionOf(target, current),
    });
  },
});

const archivedLocation = (rt: AiToolRuntime, reference: string) =>
  resolveArchived(
    rt,
    'location',
    reference,
    (query) => rt.call(LocationsController, 'findAll', { query }),
    (row) => String(row.name),
  );

const locationRestore = defineTool({
  name: 'location_restore',
  title: 'Restore an archived location',
  description:
    'Bring an archived location back, by id or exact name. Only archived locations can be restored. ' +
    'Administrators only.',
  domain: 'reference',
  class: 'write',
  idempotent: true,
  input: z.strictObject({
    location: referenceString('The archived location: its id or exact name.'),
  }),
  bindings: [
    bind(LocationsController, 'restore'),
    bind(LocationsController, 'findAll'),
  ],
  async run(input, rt) {
    const current = await archivedLocation(rt, input.location);
    const restored = asRow(
      await rt.call(LocationsController, 'restore', {
        params: { id: String(current.id) },
      }),
    );
    return {
      data: locationResult(restored),
      summary: `Restored the location ${untrusted(str(restored.name))}.`,
      entityRefs: [locationRef(restored, 'restored')],
    };
  },
  async preview(input, rt) {
    const current = await archivedLocation(rt, input.location);
    const target = locationRef(current, 'restored');
    return previewOf({
      target,
      changes: [
        { field: 'archived', before: true, after: false, valueKind: 'boolean' },
      ],
      warnings: [],
      precondition: preconditionOf(target, current),
    });
  },
});

export const taxonomyToolset: AiToolset = {
  domain: 'reference',
  tools: [
    categoryCreate,
    categoryUpdate,
    categoryArchive,
    assetModelUpdate,
    assetModelArchive,
    assetModelRestore,
    locationUpdate,
    locationArchive,
    locationRestore,
  ],
  unexposed: [],
};
