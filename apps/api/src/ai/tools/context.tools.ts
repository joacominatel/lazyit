import { z } from 'zod';
import { SEARCH_ENTITIES, type SearchEntity } from '@lazyit/shared';
import { AccessGrantsController } from '../../access-grants/access-grants.controller';
import { AssetsController } from '../../assets/assets.controller';
import { ConfigController } from '../../config/config.controller';
import { InstanceController } from '../../instance/instance.controller';
import { SearchController } from '../../search/search.controller';
import { UsersController } from '../../users/users.controller';
import {
  AI_TOOL_LIST_DEFAULT_LIMIT,
  AI_TOOL_LIST_MAX_LIMIT,
} from '../ai.constants';
import { untrusted } from '../core/result-shaper';
import {
  bind,
  defineTool,
  unexposed,
  type AiToolset,
} from '../core/tool-descriptor';

/**
 * The CONTEXT toolset — the reference tools every channel starts from (tools-and-execution.md §7, rows 1
 * and 2). They show the pattern every domain toolset follows: a zod input, handlers bound by reference,
 * every read through `rt.call` (the route's own guards, pipes and controller logic, as the principal),
 * and a concise, named projection of the result.
 */

type Row = Record<string, unknown>;

/** Keep only the named fields of a row (a concise projection; unknown rows become `{}`). */
function pick(row: unknown, fields: readonly string[]): Row {
  const source =
    typeof row === 'object' && row !== null ? (row as Row) : ({} as Row);
  const out: Row = {};
  for (const field of fields) {
    if (field in source) out[field] = source[field];
  }
  return out;
}

const sessionContext = defineTool({
  name: 'session_context',
  title: 'Session context',
  description:
    'Who is acting and what they may do: the current user (name, email, role), their effective ' +
    'permissions, the lazyit version, and the assets and application access currently assigned to them. ' +
    'Call it first to learn what you can do on their behalf.',
  domain: 'context',
  class: 'read',
  idempotent: true,
  input: z.strictObject({}),
  bindings: [
    bind(UsersController, 'me'),
    bind(ConfigController, 'myPermissions'),
    bind(InstanceController, 'getVersion'),
    bind(AssetsController, 'findMine'),
    bind(AccessGrantsController, 'findMine'),
  ],
  async run(_input, rt) {
    const limit = String(AI_TOOL_LIST_DEFAULT_LIMIT);
    const me = await rt.call(UsersController, 'me');
    const permissions = await rt.call(ConfigController, 'myPermissions');
    const version = await rt.call(InstanceController, 'getVersion');
    const assets = await rt.call(AssetsController, 'findMine', {
      query: { limit },
    });
    const grants = await rt.call(AccessGrantsController, 'findMine', {
      query: { activeOnly: 'true', limit },
    });
    return {
      data: {
        user: pick(me, ['id', 'firstName', 'lastName', 'email', 'role']),
        permissions: permissions.permissions,
        version: version.current,
        assignedAssets: {
          total: assets.total,
          items: assets.items.map((a) =>
            pick(a, ['id', 'name', 'assetTag', 'serial', 'status']),
          ),
        },
        activeAccess: {
          total: grants.total,
          items: grants.items.map((g) =>
            pick(g, ['id', 'applicationId', 'grantedAt', 'expiresAt']),
          ),
        },
      },
    };
  },
});

/** Per-entity projection of a search hit; free text other people wrote is wrapped as untrusted. */
const HIT_FIELDS: Record<SearchEntity, readonly string[]> = {
  assets: ['id', 'name', 'assetTag', 'serial', 'status'],
  articles: ['id', 'slug', 'title', 'status'],
  users: ['id', 'firstName', 'lastName', 'email'],
  locations: ['id', 'name', 'type'],
  applications: ['id', 'name', 'vendor'],
  infra: ['id', 'label', 'kind', 'status', 'ipAddress', 'assetName'],
  consumables: ['id', 'name', 'sku', 'currentStock', 'unit'],
};
const HIT_UNTRUSTED_TEXT: Partial<Record<SearchEntity, string>> = {
  assets: 'notes',
  articles: 'excerpt',
  applications: 'description',
  consumables: 'description',
};

const lazyitSearch = defineTool({
  name: 'lazyit_search',
  title: 'Search lazyit',
  description:
    'Full-text search across assets, knowledge-base articles, users, locations, applications, ' +
    'infrastructure nodes and consumables. Returns, per entity, the total and the best hits with their ' +
    'ids. Use it to find an entity before reading or changing it; never guess an id.',
  domain: 'context',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    query: z.string().trim().min(1).max(200).describe('What to search for.'),
    entities: z
      .array(z.enum(SEARCH_ENTITIES))
      .min(1)
      .optional()
      .describe('Restrict the search to these entities. Omit to search all.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(AI_TOOL_LIST_MAX_LIMIT)
      .optional()
      .describe(
        `Hits per entity (default ${AI_TOOL_LIST_DEFAULT_LIMIT}, max ${AI_TOOL_LIST_MAX_LIMIT}).`,
      ),
  }),
  bindings: [bind(SearchController, 'find')],
  async run(input, rt) {
    const results = await rt.call(SearchController, 'find', {
      query: {
        q: input.query,
        entities: input.entities?.join(','),
        limit: String(input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT),
      },
    });
    const data: Row = {};
    if ((results as Row).degraded === true) {
      data.degraded = true;
    }
    for (const entity of SEARCH_ENTITIES) {
      const block = (results as Partial<Record<SearchEntity, unknown>>)[
        entity
      ] as { hits?: unknown[]; total?: number } | undefined;
      if (!block) continue;
      const textField = HIT_UNTRUSTED_TEXT[entity];
      data[entity] = {
        total: block.total ?? 0,
        hits: (block.hits ?? []).map((hit) => {
          const projected = pick(hit, HIT_FIELDS[entity]);
          if (textField) {
            const text = (hit as Row)[textField];
            projected[textField] = untrusted(
              typeof text === 'string' ? text : null,
            );
          }
          return projected;
        }),
      };
    }
    return { data };
  },
});

export const contextToolset: AiToolset = {
  domain: 'context',
  tools: [sessionContext, lazyitSearch],
  unexposed: [
    unexposed(
      ConfigController,
      ['status', 'csrfToken', 'setup'],
      'Public first-run setup surface: no principal to act as.',
    ),
    unexposed(
      ConfigController,
      ['getPermissions', 'updatePermissions'],
      'The permission matrix: elevated configuration, after v1 (tools-and-execution.md §3).',
    ),
  ],
};
