import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@lazyit/shared';

// Only decorator METADATA is read (see tool-coverage.spec for why these are stubbed).
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

import { ALL_TOOLSETS } from '../tools';
import { validateToolsets } from './boot-validation';

/**
 * CATALOG GOLDEN (security.md §10 test 1; mirrors `permission-parity.golden.spec.ts`). Every shipped tool,
 * the route it runs as, the permission DERIVED from that route's `@RequirePermission`, the default roles
 * that permission admits (per the seed), the principal kinds its guards admit, and its class and
 * channels. A tool added, re-bound, re-classed or silently
 * widened fails here until this table is updated in the same PR — so the change is visible in review.
 *
 * The behavioural half of the parity (a tool gets 403 exactly when its route would) is
 * `tool-route-parity.spec.ts`.
 */
const GOLDEN = {
  lazyit_search: {
    route: 'GET /search',
    permissions: ['search:read'],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  session_context: {
    route: 'GET /users/me',
    permissions: [],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: false,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  // ── assets + reference (W2-5) ──
  asset_archive: {
    route: 'DELETE /assets/:id',
    permissions: ['asset:delete'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  asset_check_in: {
    route: 'PATCH /asset-assignments/:id/release',
    permissions: ['asset:write'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  asset_check_out: {
    route: 'POST /asset-assignments',
    permissions: ['asset:write'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  asset_create: {
    route: 'POST /assets',
    permissions: ['asset:write'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  asset_get: {
    route: 'GET /assets/:id',
    permissions: ['asset:read'],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  asset_model_create: {
    route: 'POST /asset-models',
    permissions: ['assetModel:write'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  asset_restore: {
    route: 'POST /assets/:id/restore',
    permissions: ['asset:delete'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  asset_search: {
    route: 'GET /assets',
    permissions: ['asset:read'],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  asset_update: {
    route: 'PATCH /assets/:id',
    permissions: ['asset:write'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  location_create: {
    route: 'POST /locations',
    permissions: ['location:write'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  reference_lookup: {
    route: 'GET /asset-models',
    permissions: ['assetModel:read'],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  // ── users + activity (W2-9) ──
  user_search: {
    route: 'GET /users',
    permissions: ['user:read'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  user_get: {
    route: 'GET /users/:id',
    permissions: ['user:read'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  user_create: {
    route: 'POST /users',
    permissions: ['user:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  user_update: {
    route: 'PATCH /users/:id',
    permissions: ['user:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  user_offboard: {
    route: 'POST /users/:id/offboard',
    permissions: ['user:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  user_restore: {
    route: 'POST /users/:id/restore',
    permissions: ['user:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  dashboard_summary: {
    route: 'GET /dashboard/summary',
    permissions: ['dashboard:read'],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  activity_list: {
    route: 'GET /dashboard/activity',
    permissions: ['logs:read'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  // ── consumables (W2-7) ──
  consumable_search: {
    route: 'GET /consumables',
    permissions: ['consumable:read'],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  consumable_get: {
    route: 'GET /consumables/:id',
    permissions: ['consumable:read'],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  consumable_create: {
    route: 'POST /consumables',
    permissions: ['consumable:write'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  consumable_update: {
    route: 'PATCH /consumables/:id',
    permissions: ['consumable:write'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  consumable_record_movement: {
    route: 'POST /consumables/:id/movements',
    permissions: ['consumable:write'],
    roles: ['ADMIN', 'MEMBER'],
    humans: true,
    serviceAccounts: true,
    class: 'write',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  // ── infra (W2-10) ──
  infra_node_get: {
    route: 'GET /infra/nodes/:id',
    permissions: ['infra:read'],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  infra_node_search: {
    route: 'GET /infra/nodes/page',
    permissions: ['infra:read'],
    roles: ['ADMIN', 'MEMBER', 'VIEWER'],
    humans: true,
    serviceAccounts: true,
    class: 'read',
    channels: ['CHAT', 'MCP', 'HEADLESS'],
  },
  // ── workflow authoring (W2-14): chat only — a route admits an SA, the channel never does ──
  workflow_archive: {
    route: 'DELETE /workflows/:id',
    permissions: ['workflow:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT'],
  },
  workflow_author_version: {
    route: 'POST /workflows/:id/versions',
    permissions: ['workflow:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT'],
  },
  workflow_connection_archive: {
    route: 'DELETE /workflow-connections/:id',
    permissions: ['workflow:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT'],
  },
  workflow_connection_create: {
    route: 'POST /workflow-connections',
    permissions: ['workflow:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT'],
  },
  workflow_connection_test: {
    route: 'POST /workflow-connections/:id/test',
    permissions: ['workflow:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT'],
  },
  workflow_connection_update: {
    route: 'PATCH /workflow-connections/:id',
    permissions: ['workflow:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT'],
  },
  workflow_create: {
    route: 'POST /workflows',
    permissions: ['workflow:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT'],
  },
  workflow_set_enabled: {
    route: 'PATCH /workflows/:id',
    permissions: ['workflow:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT'],
  },
  workflow_update: {
    route: 'PATCH /workflows/:id',
    permissions: ['workflow:manage'],
    roles: ['ADMIN'],
    humans: true,
    serviceAccounts: true,
    class: 'elevated',
    channels: ['CHAT'],
  },
} as const;

/** Which roles the seed lets through the tool's route (AND semantics; ADMIN is the full catalog). */
function rolesAdmitted(permissions: readonly Permission[]): Role[] {
  return (['ADMIN', 'MEMBER', 'VIEWER'] as const).filter(
    (role) =>
      role === 'ADMIN' ||
      permissions.every((p) => DEFAULT_ROLE_PERMISSIONS[role].includes(p)),
  );
}

describe('AI tool catalog golden', () => {
  const registered = validateToolsets(ALL_TOOLSETS);

  it('ships exactly the golden tools, each derived from its route', () => {
    const actual = Object.fromEntries(
      registered.map((tool) => [
        tool.descriptor.name,
        {
          route: `${tool.route.method} ${tool.route.path}`,
          permissions: [...tool.permissions],
          roles: rolesAdmitted(tool.permissions),
          humans: tool.principalKinds.human,
          serviceAccounts: tool.principalKinds.service,
          class: tool.descriptor.class,
          channels: [...tool.channels],
        },
      ]),
    );
    expect(actual).toEqual(GOLDEN);
  });
});
