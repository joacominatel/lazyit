import { ConflictException } from '@nestjs/common';
import { z } from 'zod';
import {
  ConsumableMovementTypeSchema,
  CreateConsumableSchema,
  UpdateConsumableSchema,
  INT4_MAX,
  int4,
  type AiEntityRef,
} from '@lazyit/shared';
import { ConsumablesController } from '../../consumables/consumables.controller';
import { CONSUMABLE_SORT_ALLOWLIST } from '../../consumables/consumables.service';
import {
  AI_TOOL_LIST_DEFAULT_LIMIT,
  AI_TOOL_LIST_MAX_LIMIT,
} from '../ai.constants';
import {
  AiReferenceError,
  type AiResolvedReference,
} from '../core/reference-resolver';
import { untrusted } from '../core/result-shaper';
import { phrase, summaryPhrase, yesNo } from '../core/sentences';
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
 * The CONSUMABLES toolset (W2-7; tools-and-execution.md §7 rows 27–31): consumables and their stock
 * ledger. Every read and write goes through `rt.call` — the route's own guards, pipes and controller
 * logic, as the principal — so a tool can never do what `/consumables` would refuse.
 *
 * Stock is never edited: it moves only through the append-only movement ledger (ADR-0034), so the only
 * stock-changing tool is `consumable_record_movement`. Its preview shows the stock before → after and
 * refuses, like the route, a movement that would take stock below zero or past int4; its precondition is
 * the consumable's `updatedAt`, which every movement bumps, so a stock change between the card and the
 * approval is `STALE`.
 *
 * A consumable reference is its id, its SKU or its exact name (case-insensitive), resolved through the
 * bound list route (`rt.resolve`). Other-authored free text — a consumable's description and notes, a
 * movement's reason and notes — is wrapped as untrusted content in results.
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

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** A timestamp as the ISO string the preview contract needs (the service answers `Date`s in-process). */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new Error('Consumable row has no updatedAt');
}

/** At or below its reorder threshold — the same rule as the list's `lowStock` filter. */
function isLow(row: Row): boolean {
  const stock = num(row.currentStock);
  const min = num(row.minStock);
  return stock !== null && min !== null && stock <= min;
}

/** "Toner HP 26A (TN-26A)" — the label a person recognizes. */
function labelOf(row: Row): string {
  const name = str(row.name) ?? String(row.id);
  const sku = str(row.sku);
  return sku ? `${name} (${sku})` : name;
}

/** The consumable summary every tool shares: identifiers and stock, never free text. */
function consumableSummary(row: Row): Row {
  return {
    ...pick(row, [
      'id',
      'name',
      'sku',
      'categoryId',
      'unit',
      'currentStock',
      'minStock',
    ]),
    lowStock: isLow(row),
  };
}

/** The full consumable: the summary plus its other-authored text (untrusted) and timestamps. */
function consumableDetail(row: Row): Row {
  return {
    ...consumableSummary(row),
    ...pick(row, ['createdAt', 'updatedAt']),
    description: untrusted(str(row.description)),
    notes: untrusted(str(row.notes)),
  };
}

/** One ledger row. The actor is an id pair (human XOR Service Account, ADR-0048). */
function movementRow(row: Row, full: boolean): Row {
  const out: Row = {
    ...pick(row, [
      'id',
      'type',
      'quantity',
      'createdAt',
      'performedById',
      'serviceAccountId',
    ]),
    reason: untrusted(str(row.reason)),
  };
  if (full) out.notes = untrusted(str(row.notes));
  return out;
}

function consumableRef(
  id: string,
  op: AiEntityRef['op'],
  label?: string,
): AiEntityRef {
  return { type: 'consumable', id, op, ...(label ? { label } : {}) };
}

/** A Prisma `cuid()` (v1: `c` + 24 lower-case alphanumerics) — passed straight through as an id. */
const CUID = /^c[a-z0-9]{24}$/;

/** The rows one reference lookup reads: the list route's page maximum (ADR-0030). */
const RESOLVE_PAGE = 200;

/**
 * Resolve a consumable reference (id | SKU | exact name) through the bound, guarded list route. The
 * route's `q` is a substring search; only exact (case-insensitive) SKU or name matches count, and more
 * than one is `AMBIGUOUS_REFERENCE`. The read is bounded by the route's page maximum.
 *
 * A PARTIAL page never decides: when more rows match the substring than one page holds, an exact match
 * may sit past it (a second consumable with the same name, or the one meant), so the reference is
 * refused as `AMBIGUOUS_REFERENCE` instead of resolved. That matters for MCP and headless writes, which
 * run without a preview card a person could catch a wrong target on.
 */
function resolveConsumable(
  rt: AiToolRuntime,
  reference: string,
): Promise<AiResolvedReference> {
  return rt.resolve({
    type: 'consumable',
    reference,
    isId: (r) => CUID.test(r),
    lookup: async (r) => {
      const page = await rt.call(ConsumablesController, 'findAll', {
        query: { q: r, limit: String(RESOLVE_PAGE) },
      });
      const shown = asRows(page.items);
      if (typeof page.total !== 'number' || page.total > shown.length) {
        throw new AiReferenceError(
          'AMBIGUOUS_REFERENCE',
          `"${r}" matches more than ${RESOLVE_PAGE} consumables; use the consumable's id (from consumable_search)`,
        );
      }
      const needle = r.toLowerCase();
      return shown
        .filter(
          (row) =>
            str(row.sku)?.toLowerCase() === needle ||
            str(row.name)?.toLowerCase() === needle,
        )
        .map((row) => ({ id: String(row.id), label: labelOf(row) }));
    },
  });
}

/** Read the live consumable a write targets (404 when missing or archived, 403 as the route answers). */
async function readConsumable(rt: AiToolRuntime, id: string): Promise<Row> {
  return asRow(
    await rt.call(ConsumablesController, 'findOne', { params: { id } }),
  );
}

const reference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    'The consumable: its id, its SKU or its exact name (case-insensitive). Use consumable_search when unsure.',
  );

const pageSize = z
  .number()
  .int()
  .min(1)
  .max(AI_TOOL_LIST_MAX_LIMIT)
  .optional()
  .describe(
    `Page size (default ${AI_TOOL_LIST_DEFAULT_LIMIT}, max ${AI_TOOL_LIST_MAX_LIMIT}).`,
  );

const SORT_FIELDS = Object.keys(CONSUMABLE_SORT_ALLOWLIST) as [
  keyof typeof CONSUMABLE_SORT_ALLOWLIST,
  ...(keyof typeof CONSUMABLE_SORT_ALLOWLIST)[],
];

// ─── Reads ─────────────────────────────────────────────────────────────────────────────────────────

const consumableSearch = defineTool({
  name: 'consumable_search',
  title: 'Search consumables',
  description:
    'Search or list the stock-counted supplies (cables, adapters, toner…). `query` matches the name, ' +
    'SKU and description (omit it to list by the other filters alone); `lowStock` keeps only items at or below their reorder threshold; `categoryId` restricts ' +
    'to one consumable category (find it with reference_lookup). Returns a page of consumables with their ' +
    'ids, current stock and threshold, and the total; detail "full" adds the description and notes. ' +
    'Archived consumables are not listed.',
  domain: 'consumables',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    query: searchText('Case-insensitive text to look for.'),
    lowStock: z
      .boolean()
      .optional()
      .describe('Only items at or below their minimum stock.'),
    categoryId: z.cuid().optional().describe('A consumable category id.'),
    sort: z.enum(SORT_FIELDS).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    detail: z
      .enum(['concise', 'full'])
      .default('concise')
      .describe('"full" adds the description, notes and timestamps.'),
    limit: pageSize,
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Rows to skip (default 0).'),
  }),
  bindings: [bind(ConsumablesController, 'findAll')],
  async run(input, rt) {
    const limit = input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const page = await rt.call(ConsumablesController, 'findAll', {
      query: {
        q: input.query,
        lowStock:
          input.lowStock === undefined ? undefined : String(input.lowStock),
        category: input.categoryId,
        sort: input.sort,
        dir: input.dir,
        limit: String(limit),
        offset: String(offset),
      },
    });
    const items = asRows(page.items).map(
      input.detail === 'full' ? consumableDetail : consumableSummary,
    );
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

const consumableGet = defineTool({
  name: 'consumable_get',
  title: 'Get a consumable',
  description:
    'One consumable by id, SKU or exact name: its stock, reorder threshold, unit, description and notes, ' +
    'and its most recent stock movements (newest first) — the append-only ledger of IN (added), OUT ' +
    '(removed) and ADJUSTMENT (recounted to an absolute value). Filter the movements by type or by a ' +
    'createdAt range. detail "full" adds each movement\'s notes.',
  domain: 'consumables',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    consumable: reference,
    detail: z
      .enum(['concise', 'full'])
      .default('concise')
      .describe('"full" adds the movement notes.'),
    movementType: ConsumableMovementTypeSchema.optional().describe(
      'Only movements of this type.',
    ),
    from: z.iso
      .datetime()
      .optional()
      .describe('Only movements at or after this ISO datetime.'),
    to: z.iso
      .datetime()
      .optional()
      .describe('Only movements at or before this ISO datetime.'),
    movementLimit: z
      .number()
      .int()
      .min(0)
      .max(AI_TOOL_LIST_MAX_LIMIT)
      .optional()
      .describe(
        `Movements to include (default ${AI_TOOL_LIST_DEFAULT_LIMIT}, max ${AI_TOOL_LIST_MAX_LIMIT}; 0 = none).`,
      ),
  }),
  bindings: [
    bind(ConsumablesController, 'findOne'),
    bind(ConsumablesController, 'findMovements'),
    bind(ConsumablesController, 'findAll'),
  ],
  async run(input, rt) {
    const { id } = await resolveConsumable(rt, input.consumable);
    const consumable = await readConsumable(rt, id);
    const data: Row = { consumable: consumableDetail(consumable) };
    const limit = input.movementLimit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    if (limit > 0) {
      const movements = asRows(
        await rt.call(ConsumablesController, 'findMovements', {
          params: { id },
          query: { type: input.movementType, from: input.from, to: input.to },
        }),
      );
      data.movements = {
        total: movements.length,
        items: movements
          .slice(0, limit)
          .map((m) => movementRow(m, input.detail === 'full')),
      };
    }
    return { data };
  },
});

// ─── Writes ────────────────────────────────────────────────────────────────────────────────────────

const createFields = CreateConsumableSchema.shape;

const consumableCreate = defineTool({
  name: 'consumable_create',
  title: 'Create a consumable',
  description:
    'Create a stock-counted supply item. Its stock starts at 0: to put units on the shelf, record an IN ' +
    'movement with consumable_record_movement afterwards. `sku` must be unique among live consumables; ' +
    '`minStock` is the reorder threshold that raises a low-stock alert; `categoryId` comes from ' +
    'reference_lookup.',
  domain: 'consumables',
  class: 'write',
  input: z.strictObject({
    name: createFields.name.describe('Display name.'),
    sku: createFields.sku.describe('Stock-keeping unit, unique when present.'),
    categoryId: createFields.categoryId.describe('A consumable category id.'),
    description: createFields.description,
    minStock: createFields.minStock.describe(
      'Reorder threshold: at or below it the item is low on stock.',
    ),
    unit: createFields.unit.describe(
      'Unit of measure, free text (default "units").',
    ),
    notes: createFields.notes,
  }),
  bindings: [bind(ConsumablesController, 'create')],
  async run(input, rt) {
    const created = asRow(
      await rt.call(ConsumablesController, 'create', { body: input }),
    );
    const id = String(created.id);
    return {
      data: consumableDetail(created),
      ...summaryPhrase(
        phrase('consumable_create.summary', {
          consumable: labelOf(created),
          hasUnit: yesNo(str(created.unit) !== null),
          unit: str(created.unit) ?? '',
        }),
      ),
      entityRefs: [consumableRef(id, 'created', labelOf(created))],
    };
  },
  preview(input) {
    const changes: AiToolPreview['changes'] = [];
    for (const [field, value] of Object.entries(input)) {
      if (value === undefined) continue;
      changes.push({
        field,
        after: value,
        ...(field === 'minStock' ? { valueKind: 'number' as const } : {}),
      });
    }
    changes.push({ field: 'currentStock', after: 0, valueKind: 'number' });
    return Promise.resolve({
      changes,
      warnings: [],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
    });
  },
});

/**
 * The editable fields, taken from the route's own body schema (`UpdateConsumableSchema`, already
 * partial) so the tool cannot drift from what `PATCH /consumables/:id` accepts — minus the fields the AI
 * surface deliberately does not offer yet.
 *
 * `returnable` (ADR-0098, #1364) is NOT offered: the consumable-deliveries change kept the AI surface
 * unchanged, and extending the consumables tools (returnable, delivery targets, returns) is a recorded
 * follow-up of ADR-0098.
 */
const AI_DEFERRED_UPDATE_FIELDS = ['returnable'] as const;
const UPDATE_FIELDS = UpdateConsumableSchema.shape;
type UpdateField = Exclude<
  keyof typeof UPDATE_FIELDS,
  (typeof AI_DEFERRED_UPDATE_FIELDS)[number]
>;
const UPDATE_FIELD_NAMES = (
  Object.keys(UPDATE_FIELDS) as (keyof typeof UPDATE_FIELDS)[]
).filter(
  (field): field is UpdateField =>
    !(AI_DEFERRED_UPDATE_FIELDS as readonly string[]).includes(field),
);

const consumableUpdate = defineTool({
  name: 'consumable_update',
  title: 'Update a consumable',
  description:
    "Change a consumable's name, SKU, category, description, reorder threshold (minStock), unit or " +
    'notes. It cannot change the stock: stock moves only through consumable_record_movement. Send only ' +
    'the fields to change.',
  domain: 'consumables',
  class: 'write',
  destructive: true,
  idempotent: true,
  input: z
    .strictObject({
      consumable: reference,
      name: UPDATE_FIELDS.name,
      sku: UPDATE_FIELDS.sku,
      categoryId: UPDATE_FIELDS.categoryId.describe(
        'A consumable category id.',
      ),
      description: UPDATE_FIELDS.description,
      minStock: UPDATE_FIELDS.minStock.describe('Reorder threshold.'),
      unit: UPDATE_FIELDS.unit,
      notes: UPDATE_FIELDS.notes,
    })
    .refine((v) => UPDATE_FIELD_NAMES.some((f) => v[f] !== undefined), {
      error: 'At least one field must be provided to update',
    }),
  bindings: [
    bind(ConsumablesController, 'update'),
    bind(ConsumablesController, 'findOne'),
    bind(ConsumablesController, 'findAll'),
  ],
  async run(input, rt) {
    const { id } = await resolveConsumable(rt, input.consumable);
    const body: Row = {};
    for (const field of UPDATE_FIELD_NAMES) {
      if (input[field] !== undefined) body[field] = input[field];
    }
    const updated = asRow(
      await rt.call(ConsumablesController, 'update', { params: { id }, body }),
    );
    return {
      data: consumableDetail(updated),
      ...summaryPhrase(
        phrase('consumable_update.summary', { consumable: labelOf(updated) }),
      ),
      entityRefs: [consumableRef(id, 'updated', labelOf(updated))],
    };
  },
  async preview(input, rt) {
    const { id } = await resolveConsumable(rt, input.consumable);
    const current = await readConsumable(rt, id);
    const target = consumableRef(id, 'updated', labelOf(current));
    const changes: AiToolPreview['changes'] = [];
    for (const field of UPDATE_FIELD_NAMES) {
      if (input[field] === undefined) continue;
      changes.push({
        field,
        before: current[field] ?? null,
        after: input[field],
        ...(field === 'minStock' ? { valueKind: 'number' as const } : {}),
      });
    }
    return {
      target,
      changes,
      warnings: [],
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
      precondition: { entity: target, updatedAt: iso(current.updatedAt) },
    };
  },
});

const consumableRecordMovement = defineTool({
  name: 'consumable_record_movement',
  title: 'Record a stock movement',
  description:
    "Change a consumable's stock by appending a movement to its ledger: IN adds `quantity`, OUT removes " +
    'it (refused if the stock would go below zero), ADJUSTMENT sets the stock to `quantity` (a physical ' +
    'recount). `quantity` is always positive. A movement is permanent — it is never edited or deleted; ' +
    'correct a mistake with another movement. Not idempotent: every call records a new movement.',
  domain: 'consumables',
  class: 'write',
  idempotent: false,
  input: z.strictObject({
    consumable: reference,
    type: ConsumableMovementTypeSchema.describe(
      'IN adds, OUT removes, ADJUSTMENT sets the absolute count.',
    ),
    quantity: int4({ min: 1 }).describe(
      'A positive whole number: the units moved, or the counted total for ADJUSTMENT.',
    ),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe('Why (e.g. "Issued to Ana for the new desk").'),
    notes: z.string().trim().min(1).max(2000).optional(),
  }),
  bindings: [
    bind(ConsumablesController, 'createMovement'),
    bind(ConsumablesController, 'findOne'),
    bind(ConsumablesController, 'findAll'),
  ],
  async run(input, rt) {
    const resolved = await resolveConsumable(rt, input.consumable);
    const id = resolved.id;
    const movement = asRow(
      await rt.call(ConsumablesController, 'createMovement', {
        params: { id },
        body: {
          type: input.type,
          quantity: input.quantity,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      }),
    );
    // The route answers the ledger row; read the new stock back. Best-effort: a caller holding
    // consumable:write without consumable:read (a Service Account) still records the movement.
    let after: Row | null = null;
    try {
      after = await readConsumable(rt, id);
    } catch {
      after = null;
    }
    const label = after ? labelOf(after) : resolved.label;
    const data: Row = { movement: movementRow(movement, true) };
    if (after) data.consumable = consumableSummary(after);
    return {
      data,
      ...summaryPhrase(
        phrase('consumable_record_movement.summary', {
          type: input.type,
          quantity: input.quantity,
          consumable: label ?? id,
          hasStock: yesNo(after !== null),
          stock: after ? String(after.currentStock) : '',
        }),
      ),
      entityRefs: [
        consumableRef(id, 'updated', label),
        {
          type: 'consumableMovement',
          id: String(movement.id),
          op: 'created',
          parent: { type: 'consumable', id },
        },
      ],
    };
  },
  async preview(input, rt) {
    const { id } = await resolveConsumable(rt, input.consumable);
    const current = await readConsumable(rt, id);
    const before = num(current.currentStock) ?? 0;
    const minStock = num(current.minStock);
    let after: number;
    // The route's own refusals, decided before a card is shown (the route re-checks atomically).
    if (input.type === 'IN') {
      after = before + input.quantity;
      if (after > INT4_MAX) {
        throw new ConflictException(
          `Stock would exceed the maximum of ${INT4_MAX}`,
        );
      }
    } else if (input.type === 'OUT') {
      if (before < input.quantity) {
        throw new ConflictException(
          `Insufficient stock: have ${before}, cannot remove ${input.quantity}`,
        );
      }
      after = before - input.quantity;
    } else {
      after = input.quantity;
    }
    const target = consumableRef(id, 'updated', labelOf(current));
    const changes: AiToolPreview['changes'] = [
      { field: 'currentStock', before, after, valueKind: 'number' },
      { field: 'type', after: input.type },
      { field: 'quantity', after: input.quantity, valueKind: 'number' },
    ];
    if (input.reason !== undefined) {
      changes.push({ field: 'reason', after: input.reason });
    }
    if (input.notes !== undefined) {
      changes.push({ field: 'notes', after: input.notes });
    }
    // Append-only: the movement stays in the ledger. A downward crossing of the reorder threshold rings
    // the low-stock bell (ADR-0056 §3).
    const warnings = ['LEDGER_APPEND'];
    if (minStock !== null && before > minStock && after <= minStock) {
      warnings.push('NOTIFIES_USERS');
    }
    return {
      target,
      changes,
      warnings,
      impacted: [],
      untrustedSources: [],
      elevated: false,
      stepUpRequired: false,
      precondition: { entity: target, updatedAt: iso(current.updatedAt) },
    };
  },
});

export const consumablesToolset: AiToolset = {
  domain: 'consumables',
  tools: [
    consumableSearch,
    consumableGet,
    consumableCreate,
    consumableUpdate,
    consumableRecordMovement,
  ],
  unexposed: [
    unexposed(
      ConsumablesController,
      ['remove', 'restore'],
      'Deferred to v1.1: consumable archive and restore (tools-and-execution.md §3, §7).',
    ),
    unexposed(
      ConsumablesController,
      ['findDeliveries'],
      'Deferred: the consumable deliveries read (ADR-0098, #1364) — the AI consumables surface was kept unchanged; extending it with delivery targets, returns and this list is a recorded ADR-0098 follow-up.',
    ),
  ],
};
