// Only the tool's own logic runs here: the controllers are referenced, never instantiated.
jest.mock('../../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../../generated/prisma/enums',
  );
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
    construct: () => inert as object,
  });
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: inert };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import { ForbiddenException, type Type } from '@nestjs/common';
import { AiInputFormSchema } from '@lazyit/shared';
import { AssetCategoriesController } from '../../asset-categories/asset-categories.controller';
import { AssetModelsController } from '../../asset-models/asset-models.controller';
import { LocationsController } from '../../locations/locations.controller';
import { validateToolsets } from '../core/boot-validation';
import { AiToolExecutor } from '../core/tool-executor';
import type { AiToolRuntime, HttpShape } from '../core/tool-descriptor';
import { ALL_TOOLSETS } from '.';
import {
  buildInputForm,
  interactionToolset,
  looksLikeSecretRequest,
  normalizeRequestInput,
  requestInput,
  requestInputSchema,
} from './input-request.tools';

/** A runtime whose `call` answers per controller and records every dispatch. */
function fakeRt(
  answers: Map<Type<unknown>, (shape?: HttpShape) => unknown>,
): AiToolRuntime & { calls: Array<{ controller: string; shape?: HttpShape }> } {
  const calls: Array<{ controller: string; shape?: HttpShape }> = [];
  return {
    calls,
    ctx: {} as AiToolRuntime['ctx'],
    call: ((controller: Type<unknown>, _method: string, shape?: HttpShape) => {
      calls.push({ controller: controller.name, shape });
      const answer = answers.get(controller);
      if (!answer) return Promise.reject(new Error('unexpected call'));
      try {
        return Promise.resolve(answer(shape));
      } catch (err) {
        return Promise.reject(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }) as AiToolRuntime['call'],
    resolve: () => Promise.reject(new Error('unused')),
  };
}

const base = {
  title: 'New laptops',
  reason: 'I need the make and models to create them.',
};

function parse(input: unknown) {
  return requestInputSchema.safeParse(input);
}

describe('request_input — the registered tool', () => {
  const registered = validateToolsets(ALL_TOOLSETS).find(
    (tool) => tool.descriptor.name === 'request_input',
  )!;

  it('is chat-only, read-only for MCP hints, and open to every human with ai:use', () => {
    expect(registered.channels).toEqual(['CHAT']);
    expect(registered.descriptor.class).toBe('navigate');
    expect(registered.descriptor.awaitsInput).toBe(true);
    expect(registered.permissions).toEqual([]);
    expect(registered.principalKinds).toEqual({ human: true, service: false });
    expect(registered.annotations.readOnlyHint).toBe(true);
    expect(registered.inputSchema.type).toBe('object');
  });

  it('a non-navigate tool may not await input (boot validation)', () => {
    expect(() =>
      validateToolsets([
        {
          ...interactionToolset,
          tools: [{ ...requestInput, class: 'read', channels: undefined }],
        },
      ]),
    ).toThrow(/only a navigate \(chat-only\) tool may await input/);
  });
});

describe('request_input — the form schema', () => {
  it('accepts a form with fields, options and a repeat group', () => {
    const parsed = parse({
      ...base,
      fields: [
        {
          key: 'manufacturer',
          label: 'Manufacturer',
          kind: 'select',
          importance: 'required',
          optionsFrom: 'manufacturers',
        },
        {
          key: 'sameModel',
          label: 'All the same model?',
          kind: 'checkbox',
          importance: 'recommended',
        },
      ],
      groups: [
        {
          key: 'models',
          label: 'Models',
          maxRows: 10,
          fields: [
            {
              key: 'name',
              label: 'Model',
              kind: 'text',
              importance: 'required',
            },
            {
              key: 'count',
              label: 'How many',
              kind: 'number',
              importance: 'optional',
              min: 1,
              max: 500,
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['no field at all', { ...base }],
    [
      'a select without options',
      {
        ...base,
        fields: [
          { key: 'a', label: 'A', kind: 'select', importance: 'required' },
        ],
      },
    ],
    [
      'a select with both options and optionsFrom',
      {
        ...base,
        fields: [
          {
            key: 'a',
            label: 'A',
            kind: 'select',
            importance: 'required',
            options: ['x'],
            optionsFrom: 'locations',
          },
        ],
      },
    ],
    [
      'options on a text field',
      {
        ...base,
        fields: [
          {
            key: 'a',
            label: 'A',
            kind: 'text',
            importance: 'required',
            options: ['x'],
          },
        ],
      },
    ],
    [
      'min on a non-number',
      {
        ...base,
        fields: [
          {
            key: 'a',
            label: 'A',
            kind: 'text',
            importance: 'required',
            min: 1,
          },
        ],
      },
    ],
    [
      'duplicate keys',
      {
        ...base,
        fields: [
          { key: 'a', label: 'A', kind: 'text', importance: 'required' },
          { key: 'a', label: 'B', kind: 'text', importance: 'required' },
        ],
      },
    ],
    [
      'more than 20 fields',
      {
        ...base,
        fields: Array.from({ length: 21 }, (_, i) => ({
          key: `f${i}`,
          label: `F${i}`,
          kind: 'text',
          importance: 'optional',
        })),
      },
    ],
    [
      'more than 20 fields across groups',
      {
        ...base,
        fields: Array.from({ length: 15 }, (_, i) => ({
          key: `f${i}`,
          label: `F${i}`,
          kind: 'text',
          importance: 'optional',
        })),
        groups: [
          {
            key: 'g',
            label: 'G',
            maxRows: 2,
            fields: Array.from({ length: 6 }, (_, i) => ({
              key: `c${i}`,
              label: `C${i}`,
              kind: 'text',
              importance: 'optional',
            })),
          },
        ],
      },
    ],
    [
      'more than 50 rows',
      {
        ...base,
        groups: [
          {
            key: 'g',
            label: 'G',
            maxRows: 51,
            fields: [
              { key: 'a', label: 'A', kind: 'text', importance: 'optional' },
            ],
          },
        ],
      },
    ],
    [
      'minRows above maxRows',
      {
        ...base,
        groups: [
          {
            key: 'g',
            label: 'G',
            minRows: 3,
            maxRows: 2,
            fields: [
              { key: 'a', label: 'A', kind: 'text', importance: 'optional' },
            ],
          },
        ],
      },
    ],
    [
      'an unknown option source',
      {
        ...base,
        fields: [
          {
            key: 'a',
            label: 'A',
            kind: 'select',
            importance: 'required',
            optionsFrom: 'users',
          },
        ],
      },
    ],
    [
      'an over-long title',
      {
        ...base,
        title: 'x'.repeat(121),
        fields: [
          { key: 'a', label: 'A', kind: 'text', importance: 'optional' },
        ],
      },
    ],
  ])('refuses %s', (_name, input) => {
    expect(parse(input).success).toBe(false);
  });
});

describe('request_input — never a secret', () => {
  it.each([
    'Password',
    'Admin password',
    'API key',
    'Private key',
    'MFA code',
    'PIN',
    'Contraseña del equipo',
    'Clave de acceso',
    'Recovery code',
  ])('flags "%s"', (label) => {
    expect(looksLikeSecretRequest(label)).toBe(true);
  });

  it.each([
    'Secretary',
    'Passenger count',
    'Keyboard layout',
    'Model',
    'Serial number',
  ])('lets "%s" through', (label) => {
    expect(looksLikeSecretRequest(label)).toBe(false);
  });

  it.each([
    [{ key: 'adminPassword', label: 'Admin', kind: 'text' }],
    [{ key: 'account', label: 'Account password', kind: 'text' }],
    [
      {
        key: 'account',
        label: 'Account',
        kind: 'text',
        help: 'Paste the API key',
      },
    ],
    [{ key: 'apiToken', label: 'Integration', kind: 'textarea' }],
  ])(
    'refuses a form asking for one (%o), with a clear error for the model',
    async (field) => {
      const input = requestInputSchema.parse({
        ...base,
        fields: [{ ...field, importance: 'required' }],
      });
      const rt = fakeRt(new Map());
      await expect(buildInputForm(input, rt)).rejects.toThrow(
        /Never ask the user for secrets/,
      );
      expect(rt.calls).toHaveLength(0);
    },
  );

  it('refuses a secret asked in a repeat group', async () => {
    const input = requestInputSchema.parse({
      ...base,
      groups: [
        {
          key: 'hosts',
          label: 'Hosts',
          maxRows: 3,
          fields: [
            {
              key: 'name',
              label: 'Host',
              kind: 'text',
              importance: 'required',
            },
            {
              key: 'root',
              label: 'Root password',
              kind: 'text',
              importance: 'required',
            },
          ],
        },
      ],
    });
    await expect(buildInputForm(input, fakeRt(new Map()))).rejects.toThrow(
      /secret/,
    );
  });
});

describe('request_input — options from lazyit lists, read as the user', () => {
  const answers = new Map<Type<unknown>, (shape?: HttpShape) => unknown>([
    [
      AssetModelsController,
      () => ({
        items: [
          { id: 'm1', name: 'Latitude 5450', manufacturer: 'Dell' },
          { id: 'm2', name: 'ThinkPad T14', manufacturer: 'Lenovo' },
          { id: 'm3', name: 'Latitude 7450', manufacturer: 'dell' },
          { id: 'm4', name: 'Generic', manufacturer: null },
        ],
        total: 4,
      }),
    ],
    [
      AssetCategoriesController,
      () => [
        { id: 'c2', name: 'Laptops' },
        { id: 'c1', name: 'Desktops' },
      ],
    ],
    [
      LocationsController,
      () => ({ items: [{ id: 'l1', name: 'HQ' }], total: 1 }),
    ],
  ]);

  it('resolves each source into the stored, wire-valid form', async () => {
    const input = requestInputSchema.parse({
      ...base,
      fields: [
        {
          key: 'manufacturer',
          label: 'Manufacturer',
          kind: 'select',
          importance: 'required',
          optionsFrom: 'manufacturers',
        },
        {
          key: 'category',
          label: 'Category',
          kind: 'select',
          importance: 'recommended',
          optionsFrom: 'assetCategories',
        },
        {
          key: 'site',
          label: 'Site',
          kind: 'multiselect',
          importance: 'optional',
          optionsFrom: 'locations',
        },
        {
          key: 'model',
          label: 'Model',
          kind: 'select',
          importance: 'optional',
          optionsFrom: 'assetModels',
        },
        {
          key: 'color',
          label: 'Colour',
          kind: 'select',
          importance: 'optional',
          options: ['black', { value: 'silver', label: 'Silver' }, 'black'],
        },
      ],
    });
    const rt = fakeRt(answers);
    const { form } = await buildInputForm(input, rt);
    expect(AiInputFormSchema.safeParse(form).success).toBe(true);
    const byKey = Object.fromEntries(form.fields.map((f) => [f.key, f]));
    // Distinct manufacturer names, case-insensitive, sorted.
    expect(byKey.manufacturer.options).toEqual([
      { value: 'Dell', label: 'Dell' },
      { value: 'Lenovo', label: 'Lenovo' },
    ]);
    expect(byKey.manufacturer).toMatchObject({
      required: true,
      optionsFrom: 'manufacturers',
    });
    expect(byKey.category.options).toEqual([
      { value: 'c1', label: 'Desktops' },
      { value: 'c2', label: 'Laptops' },
    ]);
    expect(byKey.category.required).toBe(false);
    expect(byKey.site.options).toEqual([{ value: 'l1', label: 'HQ' }]);
    expect(byKey.model.options?.[0]).toEqual({
      value: 'm1',
      label: 'Latitude 5450 (Dell)',
    });
    // Model-supplied options: strings become { value, label }, duplicates dropped.
    expect(byKey.color.options).toEqual([
      { value: 'black', label: 'black' },
      { value: 'silver', label: 'Silver' },
    ]);
    expect(form.groups).toEqual([]);
    // Every list read went through the bound list route with a bounded page.
    expect(rt.calls.map((c) => c.controller).sort()).toEqual(
      [
        'AssetCategoriesController',
        'AssetModelsController',
        'AssetModelsController',
        'LocationsController',
      ].sort(),
    );
  });

  it('a list the user cannot read refuses the request (the route’s 403)', async () => {
    const input = requestInputSchema.parse({
      ...base,
      fields: [
        {
          key: 'site',
          label: 'Site',
          kind: 'select',
          importance: 'required',
          optionsFrom: 'locations',
        },
      ],
    });
    const rt = fakeRt(
      new Map([
        [
          LocationsController,
          () => {
            throw new ForbiddenException();
          },
        ],
      ]),
    );
    await expect(buildInputForm(input, rt)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('an empty list asks the model to use a text field', async () => {
    const input = requestInputSchema.parse({
      ...base,
      fields: [
        {
          key: 'site',
          label: 'Site',
          kind: 'select',
          importance: 'required',
          optionsFrom: 'locations',
        },
      ],
    });
    const rt = fakeRt(
      new Map([[LocationsController, () => ({ items: [], total: 0 })]]),
    );
    await expect(buildInputForm(input, rt)).rejects.toThrow(/text field/);
  });

  it('run() answers the built form for the runtime to store', async () => {
    const input = requestInputSchema.parse({
      ...base,
      fields: [
        {
          key: 'serial',
          label: 'Serial',
          kind: 'text',
          importance: 'required',
        },
      ],
      groups: [
        {
          key: 'models',
          label: 'Models',
          maxRows: 5,
          fields: [
            {
              key: 'name',
              label: 'Model',
              kind: 'text',
              importance: 'required',
            },
          ],
        },
      ],
    });
    const out = await requestInput.run(input, fakeRt(new Map()));
    expect(out.summary).toBe('Asked for 2 fields');
    expect(out.data.form.groups[0]).toMatchObject({ minRows: 1, maxRows: 5 });
  });
});

describe('request_input — tolerant of what providers actually send (#1403)', () => {
  const registered = validateToolsets(ALL_TOOLSETS).find(
    (tool) => tool.descriptor.name === 'request_input',
  )!;
  // `validate` is the executor's own gate (normalize, then parse); it never dispatches.
  const executor = new AiToolExecutor({} as never);
  const validate = (input: unknown) => executor.validate(registered, input);
  const errorOf = (input: unknown) => {
    const checked = validate(input);
    if (checked.ok || checked.result.ok) throw new Error('expected a refusal');
    return checked.result.error.message;
  };

  /**
   * The shape OpenAI's Responses API produced on the dev server (gpt-6-luna, strict tools by default):
   * every property of every field is filled — options, optionsFrom, min and max — whatever the kind.
   * It failed with exactly the CEO's error, six times in a row.
   */
  const materialized = {
    title: 'Datos de las laptops',
    reason: 'Necesito el fabricante, el modelo y la ubicación para crearlas.',
    fields: [
      {
        key: 'notes',
        label: 'Notas',
        kind: 'text',
        importance: 'optional',
        placeholder: 'Opcional',
        help: 'Cualquier detalle',
        options: ['N/A'],
        optionsFrom: 'manufacturers',
        min: 0,
        max: 0,
      },
      {
        key: 'manufacturer',
        label: 'Fabricante',
        kind: 'select',
        importance: 'required',
        placeholder: 'Elegí uno',
        help: 'Del catálogo',
        options: ['Apple', 'Dell'],
        optionsFrom: 'manufacturers',
        min: 0,
        max: 0,
      },
      {
        key: 'site',
        label: 'Ubicación',
        kind: 'select',
        importance: 'recommended',
        placeholder: 'Elegí una',
        help: 'Dónde quedan',
        options: ['HQ'],
        optionsFrom: 'locations',
        min: 0,
        max: 0,
      },
    ],
    groups: [],
  };

  it('the raw payload is what the screenshot showed (the strict schema alone refuses it)', () => {
    const parsed = parse(materialized);
    expect(parsed.success).toBe(false);
    const paths = parsed.error!.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining(['fields.0', 'fields.1', 'fields.2']),
    );
  });

  it('is accepted once normalized: what does not apply is dropped, lazyit lists win', () => {
    const checked = validate(materialized);
    expect(checked.ok).toBe(true);
    const input = (checked as { input: { fields: Record<string, unknown>[] } })
      .input;
    expect(input.fields[0]).toEqual({
      key: 'notes',
      label: 'Notas',
      kind: 'text',
      importance: 'optional',
      placeholder: 'Opcional',
      help: 'Cualquier detalle',
    });
    expect(input.fields[1]).toMatchObject({ optionsFrom: 'manufacturers' });
    expect(input.fields[1]).not.toHaveProperty('options');
    expect(input.fields[1]).not.toHaveProperty('min');
    expect(input.fields[2]).toMatchObject({ optionsFrom: 'locations' });
    expect(input.fields[2]).not.toHaveProperty('options');
  });

  it('null, blank strings and empty lists mean absent (OpenAI nullable / empty fill-ins)', () => {
    const checked = validate({
      ...base,
      fields: [
        {
          key: 'count',
          label: 'How many',
          kind: 'number',
          importance: 'required',
          placeholder: '',
          help: null,
          options: [],
          optionsFrom: null,
          min: 1,
          max: null,
        },
        {
          key: 'kind',
          label: 'Kind',
          kind: 'multiselect',
          importance: 'optional',
          options: ['Laptop', '', { value: '', label: '' }, 'Desktop'],
          optionsFrom: '',
          min: null,
          max: null,
        },
        {
          key: 'when',
          label: 'When',
          kind: 'date',
          importance: 'optional',
          options: [''],
          optionsFrom: '',
          placeholder: '   ',
        },
      ],
      groups: [
        {
          key: 'models',
          label: 'Models',
          help: '',
          minRows: null,
          maxRows: 5,
          fields: [
            {
              key: 'name',
              label: 'Model',
              kind: 'text',
              importance: 'required',
              options: null,
              min: 0,
            },
          ],
        },
      ],
    });
    expect(checked.ok).toBe(true);
    const input = (
      checked as {
        input: {
          fields: Record<string, unknown>[];
          groups: Record<string, unknown>[];
        };
      }
    ).input;
    expect(input.fields[0]).toEqual({
      key: 'count',
      label: 'How many',
      kind: 'number',
      importance: 'required',
      min: 1,
    });
    expect(input.fields[1].options).toEqual(['Laptop', 'Desktop']);
    expect(input.fields[2]).toEqual({
      key: 'when',
      label: 'When',
      kind: 'date',
      importance: 'optional',
    });
    expect(input.groups[0]).toEqual({
      key: 'models',
      label: 'Models',
      maxRows: 5,
      fields: [
        { key: 'name', label: 'Model', kind: 'text', importance: 'required' },
      ],
    });
  });

  it('keeps a number field’s bounds, and still refuses inverted ones with the fix', () => {
    expect(
      errorOf({
        ...base,
        fields: [
          {
            key: 'n',
            label: 'N',
            kind: 'number',
            importance: 'required',
            min: 10,
            max: 1,
          },
        ],
      }),
    ).toBe(
      'Invalid input: fields.0: (number) `min` (10) is above `max` (1): swap them or leave one out',
    );
  });

  it('a select left without choices still fails, and the error says how to fix the call', () => {
    const message = errorOf({
      ...base,
      fields: [
        { key: 'a', label: 'A', kind: 'text', importance: 'required' },
        {
          key: 'site',
          label: 'Site',
          kind: 'select',
          importance: 'required',
          options: [],
          optionsFrom: null,
          min: 0,
        },
      ],
    });
    expect(message).toBe(
      'Invalid input: fields.1: (select) needs its choices: add `options` (a list of strings) or ' +
        '`optionsFrom` (one of manufacturers, assetCategories, locations, assetModels) — or ask with ' +
        'kind "text" instead',
    );
  });

  it('never guesses from an unknown kind, and never fills a missing required property', () => {
    expect(
      errorOf({
        ...base,
        fields: [
          {
            key: 'a',
            label: 'A',
            kind: 'string',
            importance: 'required',
            options: ['x'],
          },
        ],
      }),
    ).toMatch(/^Invalid input: fields\.0\.kind: /);
    expect(
      errorOf({
        ...base,
        fields: [{ key: 'a', label: '', kind: 'text', importance: 'required' }],
      }),
    ).toMatch(/fields\.0\.label/);
    expect(errorOf({ ...base, fields: null, groups: [] })).toBe(
      'Invalid input: The form has no field: put at least one field in `fields` or in a group',
    );
  });

  it('a select with both sources keeps optionsFrom (documented rule), and the whole call still builds', async () => {
    const checked = validate({
      ...base,
      fields: [
        {
          key: 'site',
          label: 'Site',
          kind: 'select',
          importance: 'required',
          options: ['HQ'],
          optionsFrom: 'locations',
        },
      ],
    });
    expect(checked.ok).toBe(true);
    const rt = fakeRt(
      new Map<Type<unknown>, () => unknown>([
        [
          LocationsController,
          () => ({ items: [{ id: 'loc1', name: 'Main office' }], total: 1 }),
        ],
      ]),
    );
    const { form } = await buildInputForm(
      (checked as { input: Parameters<typeof buildInputForm>[0] }).input,
      rt,
    );
    expect(form.fields[0]).toMatchObject({
      optionsFrom: 'locations',
      options: [{ value: 'loc1', label: 'Main office' }],
    });
  });

  it('normalizes without throwing on anything, and leaves non-objects to validation', () => {
    for (const raw of [null, undefined, 'x', 3, [], { fields: 'x' }]) {
      expect(() => normalizeRequestInput(raw)).not.toThrow();
    }
    expect(normalizeRequestInput('x')).toBe('x');
  });

  it('the listed schema tells the model which properties belong to which kind', () => {
    const text = JSON.stringify(registered.inputSchema);
    expect(text).toContain('select / multiselect ONLY');
    expect(text).toContain('number ONLY');
    expect(registered.descriptor.description).toContain(
      'Give each field only the properties of its kind',
    );
  });
});
