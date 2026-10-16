import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ASSET_STATUS_LABEL_DESCRIPTION_MAX,
  ASSET_STATUS_LABEL_NAME_MAX,
  ASSET_STATUS_LABEL_ORDER_MAX,
  AssetSpecsDictionarySchema,
  AssetStatusLabelColorSchema,
  AssetStatusSchema,
  LocationTypeSchema,
  type AiActionPreview,
  type AiEntityRef,
  type AiEntityType,
} from '@lazyit/shared';
import { ApplicationCategoriesController } from '../../application-categories/application-categories.controller';
import { AssetCategoriesController } from '../../asset-categories/asset-categories.controller';
import { AssetModelsController } from '../../asset-models/asset-models.controller';
import { AssetStatusLabelsController } from '../../asset-status-labels/asset-status-labels.controller';
import { AssetsController } from '../../assets/assets.controller';
import { ConsumableCategoriesController } from '../../consumable-categories/consumable-categories.controller';
import { LocationsController } from '../../locations/locations.controller';
import { AiReferenceError } from '../core/reference-resolver';
import { untrusted } from '../core/result-shaper';
import { afterPhrase, phrase, summaryPhrase } from '../core/sentences';
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
  resolveStatusLabel,
  sameText,
  str,
  untrustedJson,
  type Row,
} from './reference.tools';

/**
 * The TAXONOMY toolset (#1390): managing the reference data assets, applications and consumables hang
 * off — the asset / application / consumable categories (one set of tools with a `kind`, since the three
 * share the `category:*` permissions), asset models, locations and the custom asset statuses (ADR-0101,
 * also under `category:*`). Creating a model or a location is in
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
  query: Record<string, string> = {},
): Promise<Row> {
  const shape = { params: { id }, query };
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
    case 'applicationCategory':
    case 'consumableCategory':
      break;
  }
  return impact;
}

/** The card rows an archive carries: archived false → true, plus what could not be counted. */
function archiveChanges(impact: Impact): Change[] {
  return [
    { field: 'archived', before: false, after: true, valueKind: 'boolean' },
    ...(impact.unknown.length > 0
      ? [
          {
            field: 'usedBy',
            ...afterPhrase(
              phrase('taxonomy.usedByUnknown', {
                kinds: impact.unknown.join(', '),
              }),
            ),
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
      ...summaryPhrase(
        phrase('category_create.summary', {
          kind: kind,
          name: String(untrusted(str(created.name))),
        }),
      ),
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
      {
        field: 'kind',
        ...afterPhrase(phrase('taxonomy.categoryKind', { kind })),
        valueKind: 'text',
      },
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
      ...summaryPhrase(
        phrase('category_update.summary', {
          kind: kind,
          name: String(untrusted(str(updated.name))),
        }),
      ),
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
    if (changes.length === 0) {
      nothingToChange(String(untrusted(str(current.name))));
    }
    const target = categoryRef(current, 'updated');
    return previewOf({
      target,
      changes,
      warnings: [],
      precondition: preconditionOf(target, current),
    });
  },
});

// ─── Delete resolution (AUD-024 / AUD-085): one choice for everything still filed under the row ───────

const deleteStrategy = z
  .enum(['detach', 'move'])
  .optional()
  .describe(
    'What happens to everything still filed under it, ONE choice for all of it: detach (they keep no ' +
      'reference) or move (they all go to `moveTo`). Required when anything is still there; ask the person.',
  );

const DETACHED = 'None (detached)';

const resolutionFields = {
  strategy: deleteStrategy,
  moveTo: referenceString(
    'With strategy move: where everything goes (id or exact name).',
  ).optional(),
};

const moveToGoesWithMove = (v: { strategy?: string; moveTo?: string }) =>
  (v.strategy === 'move') === (v.moveTo !== undefined);
const MOVE_TO_RULE = {
  message: 'moveTo goes with strategy move, and only with it',
  path: ['moveTo'],
};

/** The live dependents a delete-impact read counted, by kind; zero kinds dropped. */
function dependentsOf(impact: Row): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [kind, group] of Object.entries(impact)) {
    const total = (group as { total?: unknown } | null)?.total;
    if (typeof total === 'number' && total > 0) out[kind] = total;
  }
  return out;
}

/** The card's impact from a delete-impact read: exact counts, a sample only of what the caller may read. */
function impactFromDelete(
  response: Row,
  kinds: [string, AiEntityType, ((row: Row) => string | undefined)?][],
): Impact {
  const impacted = kinds
    .map(([key, type, label]) =>
      impactOf(
        type,
        (response[key] ?? { items: null }) as {
          items: unknown;
          total?: unknown;
        },
        label,
      ),
    )
    .filter((row): row is Impacted => row !== null);
  return { impacted, unknown: [] };
}

/** Never a card for a delete the route would refuse with 409: the model is told what still depends on it. */
function assertResolved(
  label: string,
  dependents: Record<string, number>,
  strategy: string | undefined,
): void {
  if (Object.keys(dependents).length === 0 || strategy !== undefined) return;
  const counts = Object.entries(dependents)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
  throw new ConflictException(
    `${label} is still in use (${counts}). Ask the person what happens to all of them, then propose ` +
      'again with strategy detach, or strategy move and moveTo.',
  );
}

// ─── category_archive ────────────────────────────────────────────────────────────────────────────────

const RESOLVABLE_KINDS: readonly CategoryKind[] = [
  'applicationCategory',
  'consumableCategory',
];

async function categoryDeleteImpact(
  rt: AiToolRuntime,
  kind: CategoryKind,
  id: string,
): Promise<Impact & { dependents: Record<string, number> }> {
  const shape = { params: { id } };
  let response: Row;
  switch (kind) {
    case 'applicationCategory':
      response = asRow(
        await rt.call(ApplicationCategoriesController, 'deleteImpact', shape),
      );
      return {
        ...impactFromDelete(response, [['applications', 'application']]),
        dependents: dependentsOf(response),
      };
    case 'consumableCategory':
      response = asRow(
        await rt.call(ConsumableCategoriesController, 'deleteImpact', shape),
      );
      return {
        ...impactFromDelete(response, [['consumables', 'consumable']]),
        dependents: dependentsOf(response),
      };
    case 'assetCategory':
      return { ...(await categoryImpact(rt, kind, id)), dependents: {} };
  }
}

function assertStrategyKind(kind: CategoryKind, strategy?: string): void {
  if (strategy !== undefined && !RESOLVABLE_KINDS.includes(kind)) {
    throw new BadRequestException(
      '`strategy` applies to application and consumable categories only.',
    );
  }
}

const categoryArchive = defineTool({
  name: 'category_archive',
  title: 'Archive a category',
  description:
    'Archive (soft-delete) an asset, application or consumable category by id or exact name; an ' +
    'administrator can restore it from the lazyit UI. An application or consumable category that still ' +
    'has live items needs ONE `strategy` for all of them: detach (they keep no category) or move (they go ' +
    'to `moveTo`, another category of the same kind). What sits under an asset category keeps existing ' +
    'but shows no live category. The approval card shows what still uses it — check with the person ' +
    'before archiving one in use.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z
    .strictObject({
      kind: categoryKind,
      category: referenceString('The category: its id or exact name.'),
      ...resolutionFields,
    })
    .refine(moveToGoesWithMove, MOVE_TO_RULE),
  bindings: [
    bind(AssetCategoriesController, 'remove'),
    bind(ApplicationCategoriesController, 'remove'),
    bind(ConsumableCategoriesController, 'remove'),
    bind(AssetCategoriesController, 'findAll'),
    bind(ApplicationCategoriesController, 'findAll'),
    bind(ConsumableCategoriesController, 'findAll'),
    bind(ApplicationCategoriesController, 'deleteImpact'),
    bind(ConsumableCategoriesController, 'deleteImpact'),
    bind(AssetModelsController, 'findAll'),
    bind(AssetsController, 'findAll'),
  ],
  async run(input, rt) {
    assertStrategyKind(input.kind, input.strategy);
    const { id } = await resolveCategory(rt, input.kind, input.category, false);
    const query: Record<string, string> = {};
    if (input.strategy !== undefined) query.strategy = input.strategy;
    if (input.moveTo !== undefined) {
      query.targetId = (
        await resolveCategory(rt, input.kind, input.moveTo, false)
      ).id;
    }
    const archived = await removeCategory(rt, input.kind, id, query);
    return {
      data: categoryResult(input.kind, archived),
      ...summaryPhrase(
        phrase('category_archive.summary', {
          kind: input.kind,
          name: String(untrusted(str(archived.name))),
        }),
      ),
      entityRefs: [categoryRef(archived, 'archived')],
    };
  },
  async preview(input, rt) {
    assertStrategyKind(input.kind, input.strategy);
    const { row } = await resolveCategory(rt, input.kind, input.category, true);
    const current = row!;
    const id = String(current.id);
    const impact = await categoryDeleteImpact(rt, input.kind, id);
    const dependents = impact.dependents;
    assertResolved(
      `The ${KIND_LABEL[input.kind]} "${String(untrusted(str(current.name)))}"`,
      dependents,
      input.strategy,
    );
    const changes = archiveChanges(impact);
    if (Object.keys(dependents).length > 0 && input.moveTo !== undefined) {
      const to = await resolveCategory(rt, input.kind, input.moveTo, true);
      if (to.id === id) {
        throw new BadRequestException(
          'moveTo must be another category, not the one being archived.',
        );
      }
      changes.push({
        field: 'destination',
        after: entityValue({
          type: 'category',
          id: to.id,
          label: String(to.row!.name),
        }),
        valueKind: 'entity',
      });
    } else if (Object.keys(dependents).length > 0) {
      changes.push({
        field: 'destination',
        after: DETACHED,
        valueKind: 'text',
      });
    }
    const target = categoryRef(current, 'archived');
    return previewOf({
      target,
      changes,
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

/** The `after` of a cleared model category, shown on the approval card (mirrors `TOP_LEVEL`). */
const NO_CATEGORY = 'None (no category)';

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
    'Change an asset model (by id or exact name): rename it, correct or clear its SKU (null clears ' +
    'it), correct its manufacturer, change or clear its description (null clears it), file it under ' +
    'another asset category (by id or exact name; null removes its category), or set / remove its ' +
    'default attributes (`specs`, merged). Every asset of the model sees the change.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z.strictObject({
    model: referenceString('The asset model: its id or exact name.'),
    name: z.string().trim().min(1).max(200).optional(),
    manufacturer: z.string().trim().min(1).max(200).optional(),
    sku: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .optional()
      .describe('The SKU, or null to clear it.'),
    description: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .nullable()
      .optional()
      .describe('The description, or null to clear it.'),
    category: referenceString(
      'The asset category to file it under: its id or exact name.',
    )
      .nullable()
      .optional()
      .describe(
        'The asset category to file it under (id or exact name), or null to remove its category.',
      ),
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
    if (category === null) {
      body.categoryId = null;
    } else if (category) {
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
      ...summaryPhrase(
        phrase('asset_model_update.summary', {
          model: String(untrusted(modelLabel(updated))),
        }),
      ),
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
    // A `null` SKU or description is a before → none row; clearing one the model does not have is
    // no change (`diff` skips null → null), so a lone one is a no-op.
    const changes = diff(current, MODEL_SCALARS, fields);
    const categoryBefore = async () =>
      current.categoryId
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
    if (category === null) {
      // Clearing a category the model does not have is not a change (a lone one is a no-op).
      if (current.categoryId) {
        changes.push({
          field: 'category',
          before: await categoryBefore(),
          after: NO_CATEGORY,
          valueKind: 'entity',
        });
      }
    } else if (category) {
      const after = await resolveAssetCategory(rt, category, true);
      if (after.id !== current.categoryId) {
        changes.push({
          field: 'category',
          before: await categoryBefore(),
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
      ...summaryPhrase(
        phrase('asset_model_archive.summary', {
          model: String(untrusted(modelLabel(archived))),
        }),
      ),
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
      ...summaryPhrase(
        phrase('asset_model_restore.summary', {
          model: String(untrusted(modelLabel(restored))),
        }),
      ),
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
      ...summaryPhrase(
        phrase('location_update.summary', {
          location: String(untrusted(str(updated.name))),
        }),
      ),
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
    'Archive (soft-delete) a location by id or exact name; it can be restored later (location_restore). ' +
    'While live assets, child locations or open purchases still point at it, give ONE `strategy` for all ' +
    'of them: detach (assets lose their location, child locations become top-level, purchases lose their ' +
    'delivery location) or move (all of them go to `moveTo`, a live location that is not inside this ' +
    'one). The approval card shows what it still has — ask the person which before archiving one in use.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z
    .strictObject({
      location: referenceString('The location: its id or exact name.'),
      ...resolutionFields,
    })
    .refine(moveToGoesWithMove, MOVE_TO_RULE),
  bindings: [
    bind(LocationsController, 'remove'),
    bind(LocationsController, 'deleteImpact'),
    bind(LocationsController, 'findOne'),
    bind(LocationsController, 'findAll'),
  ],
  async run(input, rt) {
    const { id } = await resolveLocation(rt, input.location, false);
    const query: Record<string, string> = {};
    if (input.strategy !== undefined) query.strategy = input.strategy;
    if (input.moveTo !== undefined) {
      query.targetId = (await resolveLocation(rt, input.moveTo, false)).id;
    }
    const archived = asRow(
      await rt.call(LocationsController, 'remove', { params: { id }, query }),
    );
    return {
      data: locationResult(archived),
      ...summaryPhrase(
        phrase('location_archive.summary', {
          location: String(untrusted(str(archived.name))),
        }),
      ),
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
    const response = asRow(
      await rt.call(LocationsController, 'deleteImpact', { params: { id } }),
    );
    const dependents = dependentsOf(response);
    assertResolved(
      `The location "${String(untrusted(str(current.name)))}"`,
      dependents,
      input.strategy,
    );
    const impact = impactFromDelete(response, [
      ['assets', 'asset', (a) => str(a.assetTag) ?? undefined],
      ['childLocations', 'location'],
      ['purchaseOrders', 'purchaseOrder', (p) => str(p.reference) ?? undefined],
    ]);
    const changes = archiveChanges(impact);
    if (Object.keys(dependents).length > 0 && input.moveTo !== undefined) {
      const to = await resolveLocation(rt, input.moveTo, true);
      // Catches a move onto itself or below it along the live path; the route also refuses one through an archived link.
      const toRow = asRow(
        await rt.call(LocationsController, 'findOne', {
          params: { id: to.id },
        }),
      );
      if (asRows(toRow.path).some((p) => p.id === id)) {
        throw new BadRequestException(
          'moveTo must be a location outside the one being archived.',
        );
      }
      changes.push({
        field: 'destination',
        after: entityValue(to),
        valueKind: 'entity',
      });
    } else if (Object.keys(dependents).length > 0) {
      changes.push({
        field: 'destination',
        after: DETACHED,
        valueKind: 'text',
      });
    }
    const target = locationRef(current, 'archived');
    return previewOf({
      target,
      changes,
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
      ...summaryPhrase(
        phrase('location_restore.summary', {
          location: String(untrusted(str(restored.name))),
        }),
      ),
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

// ─── custom asset statuses: create / update / archive / restore (ADR-0101) ──────────────────────────

/**
 * What a custom status IS, said once for every tool that manages one: the model reads it before it
 * proposes a custom status, so the four tools explain the concept the same way.
 */
const CUSTOM_STATUS_CONCEPT =
  'A custom asset status is a name the team defines (e.g. "In repair at vendor", "Loaner pool") mapped ' +
  'to exactly ONE built-in status — its kind: OPERATIONAL, IN_MAINTENANCE, IN_STORAGE, RETIRED, LOST or ' +
  'UNKNOWN. The built-in status drives every rule and report; the custom status only names it more ' +
  'precisely. Setting a custom status on an asset sets its built-in status to the kind. They are optional: ' +
  'an asset may keep a bare built-in status.';

const statusLabelReference = referenceString(
  'The custom status: its id or exact name (see reference_lookup kind "assetStatusLabel").',
);
const statusLabelName = z
  .string()
  .trim()
  .min(1)
  .max(ASSET_STATUS_LABEL_NAME_MAX)
  .describe('The custom status name, unique among live custom statuses.');
const statusLabelKind = AssetStatusSchema.describe(
  'The built-in status this custom status maps to (its kind).',
);
const statusLabelColor = AssetStatusLabelColorSchema.describe(
  'Badge colour as #RRGGBB, e.g. #F59E0B.',
);
const statusLabelDescription = z
  .string()
  .trim()
  .min(1)
  .max(ASSET_STATUS_LABEL_DESCRIPTION_MAX);
const statusLabelOrder = z
  .number()
  .int()
  .min(0)
  .max(ASSET_STATUS_LABEL_ORDER_MAX)
  .describe(
    'Sort position among the custom statuses of its kind, lower first.',
  );

const statusLabelRef = (row: Row, op: AiEntityRef['op']): AiEntityRef => ({
  type: 'assetStatusLabel',
  id: String(row.id),
  op,
  label: String(row.name),
});

const STATUS_LABEL_RESULT_FIELDS = [
  'id',
  'kind',
  'color',
  'order',
  'assetCount',
  'movedAssetCount',
  'createdAt',
  'updatedAt',
  'deletedAt',
];

/** A custom status as a tool returns it; the operator-written name and description are wrapped. */
function statusLabelResult(row: Row): Row {
  const out = pick(row, STATUS_LABEL_RESULT_FIELDS);
  out.name = untrusted(str(row.name));
  if (row.description !== undefined) {
    out.description = untrusted(str(row.description));
  }
  return out;
}

const liveStatusLabels = async (rt: AiToolRuntime): Promise<Row[]> =>
  asRows(await rt.call(AssetStatusLabelsController, 'findAll'));

/** 409 for a name a LIVE custom status (other than `exceptId`) already has — the route's own rule. */
async function assertStatusLabelNameFree(
  rt: AiToolRuntime,
  name: string,
  exceptId?: string,
): Promise<void> {
  const clash = (await liveStatusLabels(rt)).find(
    (l) => l.id !== exceptId && l.name === name,
  );
  if (clash) {
    throw new ConflictException(
      `A custom status named "${name}" already exists (${String(clash.id)}).`,
    );
  }
}

const assetStatusLabelCreate = defineTool({
  name: 'asset_status_label_create',
  title: 'Create a custom asset status',
  description:
    `${CUSTOM_STATUS_CONCEPT} Create one: a name and the built-in status (kind) it maps to, optionally a ` +
    'badge colour, a description and a sort order. Check with reference_lookup kind "assetStatusLabel" ' +
    'that it does not exist yet — a live custom status with the same name is refused.',
  domain: 'reference',
  class: 'write',
  input: z.strictObject({
    name: statusLabelName,
    kind: statusLabelKind,
    color: statusLabelColor.optional(),
    description: statusLabelDescription.optional(),
    order: statusLabelOrder.optional(),
  }),
  bindings: [
    bind(AssetStatusLabelsController, 'create'),
    bind(AssetStatusLabelsController, 'findAll'),
  ],
  async run(input, rt) {
    const created = asRow(
      await rt.call(AssetStatusLabelsController, 'create', { body: input }),
    );
    return {
      data: statusLabelResult(created),
      ...summaryPhrase(
        phrase('asset_status_label_create.summary', {
          name: String(untrusted(str(created.name))),
          kind: String(created.kind),
        }),
      ),
      entityRefs: [statusLabelRef(created, 'created')],
    };
  },
  async preview(input, rt) {
    // A card is never shown for a create the route would refuse.
    await assertStatusLabelNameFree(rt, input.name);
    const changes: Change[] = [
      { field: 'name', after: input.name, valueKind: 'text' },
      { field: 'kind', after: input.kind, valueKind: 'text' },
    ];
    for (const field of ['color', 'description'] as const) {
      if (input[field] !== undefined) {
        changes.push({ field, after: input[field], valueKind: 'text' });
      }
    }
    if (input.order !== undefined) {
      changes.push({ field: 'order', after: input.order, valueKind: 'number' });
    }
    return previewOf({ changes, warnings: [] });
  },
});

const STATUS_LABEL_SCALARS = [
  { field: 'name' },
  { field: 'kind' },
  { field: 'color' },
  { field: 'description' },
  { field: 'order', kind: 'number' as const },
];

const assetStatusLabelUpdate = defineTool({
  name: 'asset_status_label_update',
  title: 'Update a custom asset status',
  description:
    `${CUSTOM_STATUS_CONCEPT} Rename a custom status (by id or exact name), or change its colour, ` +
    'description or sort order (null clears those three). Its kind (the built-in status) can change only ' +
    'while NO asset carries it — otherwise the change is refused, because those assets would silently ' +
    'change status: move them to another status first (asset_update_batch), or create a new custom status.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z.strictObject({
    status: statusLabelReference,
    name: statusLabelName.optional().describe('The new name.'),
    kind: statusLabelKind.optional(),
    color: statusLabelColor.nullable().optional(),
    description: statusLabelDescription.nullable().optional(),
    order: statusLabelOrder.nullable().optional(),
  }),
  bindings: [
    bind(AssetStatusLabelsController, 'update'),
    bind(AssetStatusLabelsController, 'findAll'),
    bind(AssetsController, 'findAll'),
  ],
  async run(input, rt) {
    const { status, ...body } = input;
    if (Object.values(body).every((v) => v === undefined)) {
      nothingToChange('the custom status');
    }
    const { resolved } = await resolveStatusLabel(rt, status);
    const updated = asRow(
      await rt.call(AssetStatusLabelsController, 'update', {
        params: { id: resolved.id },
        body,
      }),
    );
    return {
      data: statusLabelResult(updated),
      ...summaryPhrase(
        phrase('asset_status_label_update.summary', {
          name: String(untrusted(str(updated.name))),
        }),
      ),
      entityRefs: [statusLabelRef(updated, 'updated')],
    };
  },
  async preview(input, rt) {
    const { status, ...fields } = input;
    const { row } = await resolveStatusLabel(rt, status);
    const changes = diff(row, STATUS_LABEL_SCALARS, fields);
    if (changes.length === 0) nothingToChange(String(untrusted(str(row.name))));
    if (input.name !== undefined && input.name !== row.name) {
      await assertStatusLabelNameFree(rt, input.name, String(row.id));
    }
    const kindChange = input.kind !== undefined && input.kind !== row.kind;
    const carriers = kindChange ? await statusLabelCarriers(rt, row) : 0;
    if (kindChange && carriers > 0) {
      throw new ConflictException(
        `${carriers} asset(s) carry the custom status "${String(untrusted(str(row.name)))}", so its built-in status cannot ` +
          `change from ${String(row.kind)} to ${input.kind}. Move them to another status first, or create ` +
          'a new custom status.',
      );
    }
    const target = statusLabelRef(row, 'updated');
    return previewOf({
      target,
      changes,
      warnings: [],
      precondition: preconditionOf(target, row),
    });
  },
});

/**
 * The assets carrying a custom status, archived ones included — what the route's kind guard and its
 * archive count (AUD-094); `assetCount` is live assets only. Archived assets are listed for an ADMIN only:
 * for anyone else the live count is all the card can know, and the route still decides.
 */
async function statusLabelCarriers(
  rt: AiToolRuntime,
  row: Row,
): Promise<number> {
  const live = typeof row.assetCount === 'number' ? row.assetCount : 0;
  const archived = await unlessForbidden(() =>
    rt.call(AssetsController, 'findAll', {
      query: { statusLabelId: String(row.id), deleted: 'only', limit: '1' },
    }),
  );
  return live + (typeof archived?.total === 'number' ? archived.total : 0);
}

/** Where an archive moves the assets of the custom status: another custom status, or a built-in one. */
async function archiveTarget(
  rt: AiToolRuntime,
  input: { moveTo?: string; moveToStatus?: string },
  archivedId: string,
): Promise<{
  query: Record<string, string>;
  card: Change['after'];
  label: string;
} | null> {
  if (input.moveTo !== undefined) {
    const { resolved, row } = await resolveStatusLabel(rt, input.moveTo);
    if (resolved.id === archivedId) {
      throw new BadRequestException(
        'moveTo must be another custom status, not the one being archived.',
      );
    }
    return {
      query: { reassignLabelId: resolved.id },
      card: entityValue(resolved),
      label: `${String(row.name)} (${String(row.kind)})`,
    };
  }
  if (input.moveToStatus !== undefined) {
    return {
      query: { reassignStatus: input.moveToStatus },
      card: input.moveToStatus,
      label: input.moveToStatus,
    };
  }
  return null;
}

const assetStatusLabelArchive = defineTool({
  name: 'asset_status_label_archive',
  title: 'Archive a custom asset status',
  description:
    `${CUSTOM_STATUS_CONCEPT} Archive (soft-delete) a custom status by id or exact name. When assets carry ` +
    'it, say where they go — exactly one of `moveTo` (another custom status) or `moveToStatus` (a bare ' +
    'built-in status): they move there, each with a status history entry, in the same step. The approval ' +
    'card shows how many assets move and where — ask the person where they should go when it is not clear. ' +
    'An administrator can restore it later (asset_status_label_restore); it comes back with no assets.',
  domain: 'reference',
  class: 'write',
  destructive: true,
  input: z
    .strictObject({
      status: statusLabelReference,
      moveTo: referenceString(
        'Move its assets to this OTHER custom status (id or exact name); their built-in status becomes its kind.',
      ).optional(),
      moveToStatus: AssetStatusSchema.optional().describe(
        'Move its assets to this bare built-in status (no custom status).',
      ),
    })
    .refine((v) => v.moveTo === undefined || v.moveToStatus === undefined, {
      message: 'Give moveTo or moveToStatus, not both',
      path: ['moveTo'],
    }),
  bindings: [
    bind(AssetStatusLabelsController, 'remove'),
    bind(AssetStatusLabelsController, 'findAll'),
    bind(AssetsController, 'findAll'),
  ],
  async run(input, rt) {
    const { resolved } = await resolveStatusLabel(rt, input.status);
    const target = await archiveTarget(rt, input, resolved.id);
    const archived = asRow(
      await rt.call(AssetStatusLabelsController, 'remove', {
        params: { id: resolved.id },
        query: target?.query ?? {},
      }),
    );
    const moved =
      typeof archived.movedAssetCount === 'number'
        ? archived.movedAssetCount
        : 0;
    return {
      data: statusLabelResult(archived),
      ...summaryPhrase(
        phrase('asset_status_label_archive.summary', {
          name: String(untrusted(str(archived.name))),
          moved,
          target: target ? String(untrusted(target.label)) : '',
        }),
      ),
      entityRefs: [statusLabelRef(archived, 'archived')],
    };
  },
  async preview(input, rt) {
    const { resolved, row } = await resolveStatusLabel(rt, input.status);
    const target = await archiveTarget(rt, input, resolved.id);
    const carriers = await statusLabelCarriers(rt, row);
    if (carriers > 0 && target === null) {
      throw new BadRequestException(
        `${carriers} asset(s) carry the custom status "${String(untrusted(str(row.name)))}": say where they go with moveTo ` +
          '(another custom status) or moveToStatus (a built-in status), then propose again.',
      );
    }
    const impact: Impact = { impacted: [], unknown: [] };
    collect(
      impact,
      'assets',
      await counted(async () =>
        impactOf(
          'asset',
          await rt.call(AssetsController, 'findAll', {
            query: { statusLabelId: resolved.id, limit: '5' },
          }),
          (a) => str(a.assetTag) ?? undefined,
        ),
      ),
    );
    const changes = archiveChanges(impact);
    if (target && carriers > 0) {
      changes.push({
        field: 'moveAssetsTo',
        after: target.card,
        valueKind:
          typeof target.card === 'object' && target.card !== null
            ? 'entity'
            : 'text',
      });
    }
    const ref = statusLabelRef(row, 'archived');
    return previewOf({
      target: ref,
      changes,
      warnings: ['SOFT_DELETE'],
      impacted: impact.impacted,
      precondition: preconditionOf(ref, row),
    });
  },
});

/** An ARCHIVED custom status by id or exact name, through the list's `deleted=only` slice (ADMIN only). */
async function archivedStatusLabel(
  rt: AiToolRuntime,
  reference: string,
): Promise<Row> {
  const rows = new Map<string, Row>();
  const resolved = await rt.resolve({
    type: 'assetStatusLabel',
    reference,
    lookup: async (ref) =>
      asRows(
        await rt.call(AssetStatusLabelsController, 'findAll', {
          query: { deleted: 'only' },
        }),
      )
        .filter((l) => l.id === ref || sameText(l.name, ref))
        .map((l) => {
          rows.set(String(l.id), l);
          return { id: String(l.id), label: String(l.name) };
        }),
  });
  return rows.get(resolved.id)!;
}

const assetStatusLabelRestore = defineTool({
  name: 'asset_status_label_restore',
  title: 'Restore an archived custom asset status',
  description:
    'Bring an archived custom asset status back, by id or exact name. It returns with no assets (archiving ' +
    'moved them off it). Refused when a live custom status took its name meanwhile. Administrators only.',
  domain: 'reference',
  class: 'write',
  idempotent: true,
  input: z.strictObject({
    status: referenceString(
      'The archived custom status: its id or exact name.',
    ),
  }),
  bindings: [
    bind(AssetStatusLabelsController, 'restore'),
    bind(AssetStatusLabelsController, 'findAll'),
  ],
  async run(input, rt) {
    const current = await archivedStatusLabel(rt, input.status);
    const restored = asRow(
      await rt.call(AssetStatusLabelsController, 'restore', {
        params: { id: String(current.id) },
      }),
    );
    return {
      data: statusLabelResult(restored),
      ...summaryPhrase(
        phrase('asset_status_label_restore.summary', {
          name: String(untrusted(str(restored.name))),
        }),
      ),
      entityRefs: [statusLabelRef(restored, 'restored')],
    };
  },
  async preview(input, rt) {
    const current = await archivedStatusLabel(rt, input.status);
    const target = statusLabelRef(current, 'restored');
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
    assetStatusLabelCreate,
    assetStatusLabelUpdate,
    assetStatusLabelArchive,
    assetStatusLabelRestore,
  ],
  unexposed: [],
};
