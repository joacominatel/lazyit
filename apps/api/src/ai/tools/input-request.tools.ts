import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  AI_INPUT_LIMITS,
  AiInputFieldKindSchema,
  AiInputFormSchema,
  AiInputImportanceSchema,
  AiInputKeySchema,
  AiInputOptionSourceSchema,
  MAX_PAGE_LIMIT,
  type AiInputField,
  type AiInputForm,
  type AiInputGroup,
  type AiInputOption,
  type AiInputOptionSource,
} from '@lazyit/shared';
import { AssetCategoriesController } from '../../asset-categories/asset-categories.controller';
import { AssetModelsController } from '../../asset-models/asset-models.controller';
import { LocationsController } from '../../locations/locations.controller';
import { UsersController } from '../../users/users.controller';
import { isSensitiveKey } from '../core/redaction';
import { AiRunsController } from '../runs/ai-runs.controller';
import {
  bind,
  defineTool,
  unexposed,
  type AiToolRuntime,
  type AiToolset,
} from '../core/tool-descriptor';

/**
 * `request_input` (#1388; ADR-0097 decision 3 as amended 2026-09-24) — the assistant asks the user for
 * data it is missing with a small form it builds. Chat only (`navigate` class: no domain write, no
 * approval card, never listed on MCP or headless). Executing it only validates the form and resolves
 * `optionsFrom` through the list routes as the user; the RUNTIME then stores the form, pauses the run
 * `AWAITING_INPUT` and answers the call with what the user submits (`AiInputService`).
 *
 * The form never collects a secret: a field, group, title or reason that looks like it asks for a
 * password, token, key or PIN refuses the whole call with a clear error for the model.
 */

/** The name the runtime keys its pause on. */
export const REQUEST_INPUT_TOOL = 'request_input';

const text = (max: number) => z.string().trim().min(1).max(max);

const optionInput = z.union([
  text(AI_INPUT_LIMITS.optionLength),
  z.strictObject({
    value: text(AI_INPUT_LIMITS.optionLength),
    label: text(AI_INPUT_LIMITS.optionLength),
  }),
]);

const fieldInput = z.strictObject({
  key: AiInputKeySchema.describe(
    'Identifier the answer is keyed by (e.g. `manufacturer`).',
  ),
  label: text(AI_INPUT_LIMITS.labelLength).describe(
    'What the user sees, in their language.',
  ),
  kind: AiInputFieldKindSchema,
  importance: AiInputImportanceSchema.describe(
    '`required`: you cannot continue without it. `recommended`: it would help. `optional`: nice to have.',
  ),
  placeholder: text(AI_INPUT_LIMITS.placeholderLength).optional(),
  help: text(AI_INPUT_LIMITS.helpLength).optional(),
  options: z
    .array(optionInput)
    .min(1)
    .max(AI_INPUT_LIMITS.options)
    .optional()
    .describe(
      'select / multiselect: the choices (a string, or { value, label }). Omit when using optionsFrom.',
    ),
  optionsFrom: AiInputOptionSourceSchema.optional().describe(
    'select / multiselect: take the choices from this lazyit list instead of `options` (values are ids, ' +
      'manufacturers are names).',
  ),
  min: z.number().finite().optional().describe('number only.'),
  max: z.number().finite().optional().describe('number only.'),
});
type FieldInput = z.infer<typeof fieldInput>;

const groupInput = z.strictObject({
  key: AiInputKeySchema,
  label: text(AI_INPUT_LIMITS.labelLength),
  help: text(AI_INPUT_LIMITS.helpLength).optional(),
  minRows: z.number().int().min(0).max(AI_INPUT_LIMITS.rows).optional(),
  maxRows: z.number().int().min(1).max(AI_INPUT_LIMITS.rows),
  fields: z.array(fieldInput).min(1).max(AI_INPUT_LIMITS.fields),
});
type GroupInput = z.infer<typeof groupInput>;

const SELECTS = new Set(['select', 'multiselect']);

export const requestInputSchema = z
  .strictObject({
    title: text(AI_INPUT_LIMITS.titleLength).describe(
      'A short heading for the form.',
    ),
    reason: text(AI_INPUT_LIMITS.reasonLength).describe(
      'Why you need this data, in one or two sentences.',
    ),
    fields: z
      .array(fieldInput)
      .max(AI_INPUT_LIMITS.fields)
      .optional()
      .describe('Single fields.'),
    groups: z
      .array(groupInput)
      .max(AI_INPUT_LIMITS.groups)
      .optional()
      .describe(
        'Repeat groups: rows of the same columns (one row per model, per site…), minRows..maxRows rows.',
      ),
  })
  .superRefine((form, ctx) => {
    const fields = form.fields ?? [];
    const groups = form.groups ?? [];
    const total =
      fields.length + groups.reduce((n, group) => n + group.fields.length, 0);
    if (total === 0) {
      ctx.addIssue({ code: 'custom', message: 'The form has no field' });
    }
    if (total > AI_INPUT_LIMITS.fields) {
      ctx.addIssue({
        code: 'custom',
        message: `At most ${AI_INPUT_LIMITS.fields} fields in total`,
      });
    }
    const topKeys = [...fields.map((f) => f.key), ...groups.map((g) => g.key)];
    if (new Set(topKeys).size !== topKeys.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Field and group keys must be unique',
      });
    }
    const check = (field: FieldInput, path: (string | number)[]) => {
      const select = SELECTS.has(field.kind);
      const sources =
        (field.options ? 1 : 0) + (field.optionsFrom !== undefined ? 1 : 0);
      if (select && sources !== 1) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: 'A select needs exactly one of options or optionsFrom',
        });
      }
      if (!select && sources > 0) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: 'Only a select or multiselect takes options',
        });
      }
      if (
        field.kind !== 'number' &&
        (field.min !== undefined || field.max !== undefined)
      ) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: 'Only a number takes min and max',
        });
      }
      if (
        field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max
      ) {
        ctx.addIssue({ code: 'custom', path, message: 'min is above max' });
      }
    };
    fields.forEach((field, i) => check(field, ['fields', i]));
    groups.forEach((group, g) => {
      const keys = group.fields.map((f) => f.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['groups', g],
          message: 'Field keys must be unique within a group',
        });
      }
      if ((group.minRows ?? 1) > group.maxRows) {
        ctx.addIssue({
          code: 'custom',
          path: ['groups', g],
          message: 'minRows is above maxRows',
        });
      }
      group.fields.forEach((field, i) =>
        check(field, ['groups', g, 'fields', i]),
      );
    });
  });
type RequestInput = z.infer<typeof requestInputSchema>;

// ─── Secrets are never collected ─────────────────────────────────────────────────────────────────

/** Words that mark a request for a credential, in English and Spanish. */
const SECRET_WORDS = new Set([
  'password',
  'passwords',
  'passwd',
  'passphrase',
  'pass',
  'pwd',
  'secret',
  'secrets',
  'token',
  'tokens',
  'credential',
  'credentials',
  'apikey',
  'otp',
  'totp',
  'mfa',
  '2fa',
  'pin',
  'cvv',
  'cvc',
  'contraseña',
  'contrasena',
  'contraseñas',
  'clave',
  'claves',
  'secreto',
  'credencial',
  'credenciales',
]);
/** Two-word phrases that name a credential ("api key", "private key", "clave privada"…). */
const SECRET_PAIRS = new Set([
  'api key',
  'private key',
  'secret key',
  'access key',
  'license key',
  'ssh key',
  'recovery code',
  'security code',
  'card number',
  'llave privada',
]);

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** Whether free text asks for a credential (word-based, so `secretary` or `passenger` pass). */
export function looksLikeSecretRequest(value: string | undefined): boolean {
  if (!value) return false;
  const list = words(value);
  for (let i = 0; i < list.length; i += 1) {
    if (SECRET_WORDS.has(list[i])) return true;
    if (i + 1 < list.length && SECRET_PAIRS.has(`${list[i]} ${list[i + 1]}`)) {
      return true;
    }
  }
  return false;
}

function secretProblem(form: RequestInput): string | null {
  if (
    looksLikeSecretRequest(form.title) ||
    looksLikeSecretRequest(form.reason)
  ) {
    return 'the title or reason';
  }
  const checkField = (field: FieldInput, where: string): string | null =>
    isSensitiveKey(field.key) ||
    looksLikeSecretRequest(field.label) ||
    looksLikeSecretRequest(field.placeholder) ||
    looksLikeSecretRequest(field.help)
      ? `${where} "${field.key}"`
      : null;
  for (const field of form.fields ?? []) {
    const problem = checkField(field, 'field');
    if (problem) return problem;
  }
  for (const group of form.groups ?? []) {
    if (
      isSensitiveKey(group.key) ||
      looksLikeSecretRequest(group.label) ||
      looksLikeSecretRequest(group.help)
    ) {
      return `group "${group.key}"`;
    }
    for (const field of group.fields) {
      const problem = checkField(field, `field "${group.key}."`);
      if (problem) return problem;
    }
  }
  return null;
}

// ─── Options from lazyit reference lists ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  const items =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { items?: unknown }).items
      : value;
  return Array.isArray(items)
    ? items.filter((r): r is Row => !!r && typeof r === 'object')
    : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function clip(value: string): string {
  return value.length > AI_INPUT_LIMITS.optionLength
    ? `${value.slice(0, AI_INPUT_LIMITS.optionLength - 1)}…`
    : value;
}

/** Pages read to collect the distinct manufacturers (models are paged; manufacturers are a model column). */
const MANUFACTURER_PAGES = 3;

/**
 * Read one reference list as the user, through its list route (a list they cannot read throws the
 * route's 403, refusing the whole request). At most {@link AI_INPUT_LIMITS.options} options.
 */
async function resolveOptions(
  rt: AiToolRuntime,
  source: AiInputOptionSource,
): Promise<{ options: AiInputOption[]; truncated: boolean }> {
  const cap = AI_INPUT_LIMITS.options;
  const page = (offset: number) => ({
    limit: String(MAX_PAGE_LIMIT),
    offset: String(offset),
    sort: 'name',
    dir: 'asc',
  });
  const out: AiInputOption[] = [];
  let more = false;
  switch (source) {
    case 'assetCategories': {
      for (const row of rows(
        await rt.call(AssetCategoriesController, 'findAll'),
      )) {
        const name = str(row.name);
        if (typeof row.id === 'string' && name) {
          out.push({ value: row.id, label: clip(name) });
        }
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      break;
    }
    case 'locations':
    case 'assetModels': {
      const result =
        source === 'locations'
          ? await rt.call(LocationsController, 'findAll', { query: page(0) })
          : await rt.call(AssetModelsController, 'findAll', { query: page(0) });
      const total = (result as { total?: unknown }).total;
      for (const row of rows(result)) {
        const name = str(row.name);
        if (typeof row.id !== 'string' || !name) continue;
        const maker = source === 'assetModels' ? str(row.manufacturer) : null;
        out.push({
          value: row.id,
          label: clip(maker ? `${name} (${maker})` : name),
        });
      }
      more = typeof total === 'number' && total > out.length;
      break;
    }
    case 'manufacturers': {
      const seen = new Map<string, string>();
      for (let n = 0; n < MANUFACTURER_PAGES; n += 1) {
        const result = await rt.call(AssetModelsController, 'findAll', {
          query: page(n * MAX_PAGE_LIMIT),
        });
        const batch = rows(result);
        for (const row of batch) {
          const maker = str(row.manufacturer);
          if (maker && !seen.has(maker.toLowerCase())) {
            seen.set(maker.toLowerCase(), clip(maker));
          }
        }
        const total = (result as { total?: unknown }).total;
        if (
          batch.length < MAX_PAGE_LIMIT ||
          typeof total !== 'number' ||
          total <= (n + 1) * MAX_PAGE_LIMIT
        ) {
          break;
        }
        more = n + 1 === MANUFACTURER_PAGES;
      }
      for (const maker of [...seen.values()].sort((a, b) =>
        a.localeCompare(b),
      )) {
        out.push({ value: maker, label: maker });
      }
      break;
    }
  }
  return { options: out.slice(0, cap), truncated: more || out.length > cap };
}

// ─── Building the stored form ────────────────────────────────────────────────────────────────────

function toOption(option: z.infer<typeof optionInput>): AiInputOption {
  return typeof option === 'string'
    ? { value: option, label: option }
    : { value: option.value, label: option.label };
}

async function buildField(
  field: FieldInput,
  rt: AiToolRuntime,
  truncated: Set<string>,
): Promise<AiInputField> {
  const out: AiInputField = {
    key: field.key,
    label: field.label,
    kind: field.kind,
    importance: field.importance,
    required: field.importance === 'required',
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.help ? { help: field.help } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
  };
  if (field.optionsFrom) {
    const resolved = await resolveOptions(rt, field.optionsFrom);
    if (resolved.truncated) truncated.add(field.key);
    if (resolved.options.length === 0) {
      throw new BadRequestException(
        `The lazyit list "${field.optionsFrom}" is empty: ask with a text field instead`,
      );
    }
    out.options = resolved.options;
    out.optionsFrom = field.optionsFrom;
  } else if (field.options) {
    const seen = new Set<string>();
    out.options = field.options.map(toOption).filter((option) => {
      if (seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
  }
  return out;
}

/** Validate and resolve the model's form into the stored `AiInputForm`. */
export async function buildInputForm(
  input: RequestInput,
  rt: AiToolRuntime,
): Promise<{ form: AiInputForm; truncated: string[] }> {
  const secret = secretProblem(input);
  if (secret) {
    throw new BadRequestException(
      `This form looks like it asks for a password, token, key, PIN or other secret (${secret}). ` +
        'Never ask the user for secrets or credentials: remove that field, or tell the user to enter it ' +
        'in the lazyit interface or their secret manager themselves.',
    );
  }
  const truncated = new Set<string>();
  const fields: AiInputField[] = [];
  for (const field of input.fields ?? []) {
    fields.push(await buildField(field, rt, truncated));
  }
  const groups: AiInputGroup[] = [];
  for (const group of input.groups ?? ([] as GroupInput[])) {
    const columns: AiInputField[] = [];
    for (const field of group.fields) {
      columns.push(await buildField(field, rt, truncated));
    }
    groups.push({
      key: group.key,
      label: group.label,
      ...(group.help ? { help: group.help } : {}),
      minRows: group.minRows ?? 1,
      maxRows: group.maxRows,
      fields: columns,
    });
  }
  // The stored form is the wire contract: never store one the web could not render.
  const form = AiInputFormSchema.parse({
    title: input.title,
    reason: input.reason,
    fields,
    groups,
  });
  return { form, truncated: [...truncated] };
}

export const requestInput = defineTool({
  name: REQUEST_INPUT_TOOL,
  title: 'Ask the user for missing data',
  description:
    'Ask the person for data you need and cannot find with a tool or safely infer, with a short form you ' +
    'design: a title, why you need it, and the fields — each marked required, recommended or optional. ' +
    'Use select options (or `optionsFrom` a lazyit list: manufacturers, assetCategories, locations, ' +
    'assetModels) when the answer is one of known values, and a repeat group when the same questions ' +
    'apply to several items (one row per model). Ask only for what is missing, in one form, before ' +
    'proposing changes; never for passwords, tokens, keys or other secrets. The run waits for the ' +
    'answer; the result is what the person submitted (or that they skipped or declined).',
  domain: 'interaction',
  class: 'navigate',
  awaitsInput: true,
  channels: ['CHAT'],
  input: requestInputSchema,
  // `[0]` is the permission-free self-read (no gate beyond `ai:use`); the lists resolve `optionsFrom`.
  bindings: [
    bind(UsersController, 'me'),
    bind(AssetModelsController, 'findAll'),
    bind(AssetCategoriesController, 'findAll'),
    bind(LocationsController, 'findAll'),
  ],
  async run(input, rt) {
    const { form, truncated } = await buildInputForm(input, rt);
    const count =
      form.fields.length +
      form.groups.reduce((n, group) => n + group.fields.length, 0);
    return {
      data: { form, ...(truncated.length > 0 ? { truncated } : {}) },
      summary: `Asked for ${count} field${count === 1 ? '' : 's'}`,
    };
  },
});

/** The INTERACTION toolset: chat-only tools that wait on the user (#1388). */
export const interactionToolset: AiToolset = {
  domain: 'interaction',
  tools: [requestInput],
  unexposed: [
    unexposed(
      AiRunsController,
      ['submitInput'],
      "The user's own answer to a form the assistant asked for: a human action, never an AI tool.",
    ),
  ],
};
