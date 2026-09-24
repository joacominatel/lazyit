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
import type { AiToolRuntime, HttpShape } from '../core/tool-descriptor';
import { ALL_TOOLSETS } from '.';
import {
  buildInputForm,
  interactionToolset,
  looksLikeSecretRequest,
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
