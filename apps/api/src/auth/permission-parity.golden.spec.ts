import { Reflector } from '@nestjs/core';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@lazyit/shared';

// The controllers transitively import their services → PrismaService → the generated Prisma client
// (ESM `.js` re-exports jest can't transform) and, for some, the ESM `meilisearch` package. We only
// introspect decorator METADATA here (no instances, no DB), so stub those modules so importing the
// controller classes never loads the real ones.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
  // Some privileged controllers (#555) transitively pull the `Role` enum at module load
  // (config → permissions-config.service). Provide it so importing the class for metadata works.
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { PERMISSION_KEY } from './require-permission.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AssetsController } from '../assets/assets.controller';
import { AssetAssignmentsController } from '../asset-assignments/asset-assignments.controller';
import { ApplicationsController } from '../applications/applications.controller';
import { ConsumablesController } from '../consumables/consumables.controller';
import { ArticlesController } from '../articles/articles.controller';
import { LocationsController } from '../locations/locations.controller';
import { AssetModelsController } from '../asset-models/asset-models.controller';
import { AssetCategoriesController } from '../asset-categories/asset-categories.controller';
import { ConsumableCategoriesController } from '../consumable-categories/consumable-categories.controller';
import { ArticleCategoriesController } from '../article-categories/article-categories.controller';
import { ApplicationCategoriesController } from '../application-categories/application-categories.controller';
import { AccessGrantsController } from '../access-grants/access-grants.controller';
import { UsersController } from '../users/users.controller';
// Privileged surfaces added to the parity net (#555): every @RequirePermission route on these must
// resolve to ADMIN-only — a MEMBER/VIEWER must never reach the Secret Manager, SA management, the
// permission matrix, or the workflow engine.
import { VaultsController } from '../secret-manager/vaults.controller';
import { ItemsController } from '../secret-manager/items.controller';
import { KeypairController } from '../secret-manager/keypair.controller';
import { ServiceAccountsController } from '../service-accounts/service-accounts.controller';
import { ConfigController } from '../config/config.controller';
import { WorkflowsController } from '../workflow-engine/definitions/workflows.controller';
import { WorkflowConnectionsController } from '../workflow-engine/definitions/workflow-connections.controller';
import { WorkflowSecretsController } from '../workflow-engine/definitions/workflow-secrets.controller';
import { WorkflowRunsController } from '../workflow-engine/runs/workflow-runs.controller';
import { ManualTasksController } from '../workflow-engine/tasks/manual-tasks.controller';
import { WorkflowDryRunController } from '../workflow-engine/dry-run/workflow-dry-run.controller';

/**
 * GOLDEN PARITY TEST (ADR-0046 P4) — the safety net for the mechanical @Roles → @RequirePermission
 * sweep. It is BEHAVIOR-PRESERVING by construction:
 *
 *   For every migrated controller route, the set of roles allowed by its `@RequirePermission`
 *   (computed from the seed: which of ADMIN/MEMBER/VIEWER hold ALL the required permissions) MUST
 *   EXACTLY equal the set of roles that route allowed BEFORE this PR (the old `@Roles` set).
 *
 * The pre-migration role-set is the documented SOURCE OF TRUTH below ({@link PRE_MIGRATION}), derived
 * 1:1 from the old `@Roles(...)` gates on each handler (verified against git history of this PR). The
 * post-migration role-set is computed live from the REAL decorator metadata on the controller classes
 * resolved against the REAL seed (`DEFAULT_ROLE_PERMISSIONS`). A mismatch — e.g. someone wiring an
 * AccessGrant mutation to `accessGrant:write` (which MEMBER holds) instead of `accessGrant:grant`
 * (ADMIN-only) — FAILS CI. This is what makes the sweep safe and keeps it safe.
 *
 * Scope note: this asserts the DECORATOR gate per route. A few list GETs additionally narrow a
 * privileged query slice (`deleted=only`) to ADMIN via an in-handler `assertCanListDeleted` check
 * (ADR-0041); that runtime gate is unchanged by this PR and is covered by its own specs, so it is out
 * of scope for this decorator-level parity table.
 */

const ROLES: readonly Role[] = ['ADMIN', 'MEMBER', 'VIEWER'];

/** Which roles hold EVERY one of the given permissions, per the seed (AND semantics; ADMIN is full). */
function rolesHolding(perms: readonly Permission[]): Set<Role> {
  const held = (role: Role) => new Set(DEFAULT_ROLE_PERMISSIONS[role]);
  return new Set(
    ROLES.filter((role) => {
      const set = held(role);
      return perms.every((p) => set.has(p));
    }),
  );
}

const eqRoles = (a: Set<Role>, b: Set<Role>) =>
  a.size === b.size && [...a].every((r) => b.has(r));
const fmt = (s: Set<Role>) => [...s].sort().join('+') || '(none)';

/**
 * The DOCUMENTED pre-migration role-set for every WRITE/lifecycle route this PR migrated, keyed by
 * `Controller#method`. Each value is the EXACT role-set the old `@Roles(...)` gate allowed:
 *   - `@Roles('ADMIN','MEMBER')` → ['ADMIN','MEMBER']   (ordinary writes)
 *   - `@Roles('ADMIN')`          → ['ADMIN']            (deletes, restores, access-grant + user admin)
 */
const PRE_MIGRATION: Record<string, Role[]> = {
  // assets — create/update = ADMIN+MEMBER; batch ops, delete, restore = ADMIN
  'AssetsController#create': ['ADMIN', 'MEMBER'],
  'AssetsController#update': ['ADMIN', 'MEMBER'],
  'AssetsController#batchRemove': ['ADMIN'],
  'AssetsController#batchRestore': ['ADMIN'],
  'AssetsController#batchSetStatus': ['ADMIN'],
  'AssetsController#remove': ['ADMIN'],
  'AssetsController#restore': ['ADMIN'],
  // asset-assignments — all ADMIN+MEMBER (live under the asset domain)
  'AssetAssignmentsController#create': ['ADMIN', 'MEMBER'],
  'AssetAssignmentsController#release': ['ADMIN', 'MEMBER'],
  'AssetAssignmentsController#updateNotes': ['ADMIN', 'MEMBER'],
  // applications
  'ApplicationsController#create': ['ADMIN', 'MEMBER'],
  'ApplicationsController#update': ['ADMIN', 'MEMBER'],
  'ApplicationsController#remove': ['ADMIN'],
  'ApplicationsController#restore': ['ADMIN'],
  // consumables — create/update/movements = ADMIN+MEMBER; delete/restore = ADMIN
  'ConsumablesController#create': ['ADMIN', 'MEMBER'],
  'ConsumablesController#update': ['ADMIN', 'MEMBER'],
  'ConsumablesController#createMovement': ['ADMIN', 'MEMBER'],
  'ConsumablesController#remove': ['ADMIN'],
  'ConsumablesController#restore': ['ADMIN'],
  // articles — authoring ops = ADMIN+MEMBER; delete/restore = ADMIN
  'ArticlesController#create': ['ADMIN', 'MEMBER'],
  'ArticlesController#importArticle': ['ADMIN', 'MEMBER'],
  'ArticlesController#update': ['ADMIN', 'MEMBER'],
  'ArticlesController#addLink': ['ADMIN', 'MEMBER'],
  'ArticlesController#removeLink': ['ADMIN', 'MEMBER'],
  'ArticlesController#publish': ['ADMIN', 'MEMBER'],
  'ArticlesController#unpublish': ['ADMIN', 'MEMBER'],
  'ArticlesController#remove': ['ADMIN'],
  'ArticlesController#restore': ['ADMIN'],
  // locations
  'LocationsController#create': ['ADMIN', 'MEMBER'],
  'LocationsController#update': ['ADMIN', 'MEMBER'],
  'LocationsController#remove': ['ADMIN'],
  'LocationsController#restore': ['ADMIN'],
  // asset-models
  'AssetModelsController#create': ['ADMIN', 'MEMBER'],
  'AssetModelsController#update': ['ADMIN', 'MEMBER'],
  'AssetModelsController#remove': ['ADMIN'],
  'AssetModelsController#restore': ['ADMIN'],
  // asset categories
  'AssetCategoriesController#create': ['ADMIN', 'MEMBER'],
  'AssetCategoriesController#update': ['ADMIN', 'MEMBER'],
  'AssetCategoriesController#remove': ['ADMIN'],
  'AssetCategoriesController#restore': ['ADMIN'],
  // consumable categories
  'ConsumableCategoriesController#create': ['ADMIN', 'MEMBER'],
  'ConsumableCategoriesController#update': ['ADMIN', 'MEMBER'],
  'ConsumableCategoriesController#remove': ['ADMIN'],
  'ConsumableCategoriesController#restore': ['ADMIN'],
  // article categories
  'ArticleCategoriesController#create': ['ADMIN', 'MEMBER'],
  'ArticleCategoriesController#update': ['ADMIN', 'MEMBER'],
  'ArticleCategoriesController#remove': ['ADMIN'],
  'ArticleCategoriesController#restore': ['ADMIN'],
  // application categories
  'ApplicationCategoriesController#create': ['ADMIN', 'MEMBER'],
  'ApplicationCategoriesController#update': ['ADMIN', 'MEMBER'],
  'ApplicationCategoriesController#remove': ['ADMIN'],
  'ApplicationCategoriesController#restore': ['ADMIN'],
  // access-grants — ALL ADMIN-only (must resolve to accessGrant:grant, NOT :write)
  'AccessGrantsController#batchRevoke': ['ADMIN'],
  'AccessGrantsController#create': ['ADMIN'],
  'AccessGrantsController#revoke': ['ADMIN'],
  'AccessGrantsController#updateNotes': ['ADMIN'],
  'AccessGrantsController#updateExpiry': ['ADMIN'],
  // users administration — ALL ADMIN-only (must resolve to user:manage, NOT user:write)
  'UsersController#create': ['ADMIN'],
  'UsersController#update': ['ADMIN'],
  'UsersController#remove': ['ADMIN'],
  'UsersController#offboard': ['ADMIN'],
  'UsersController#restore': ['ADMIN'],
  // issue #149 — admin-triggered password reset; same user:manage gate as the rest of user admin.
  'UsersController#resetPassword': ['ADMIN'],
};

// The controller classes whose write routes were migrated. Read routes (already on @RequirePermission
// from Ola 2a) are intentionally NOT in PRE_MIGRATION — only the routes this PR touched are asserted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTROLLERS: Array<[string, any]> = [
  ['AssetsController', AssetsController],
  ['AssetAssignmentsController', AssetAssignmentsController],
  ['ApplicationsController', ApplicationsController],
  ['ConsumablesController', ConsumablesController],
  ['ArticlesController', ArticlesController],
  ['LocationsController', LocationsController],
  ['AssetModelsController', AssetModelsController],
  ['AssetCategoriesController', AssetCategoriesController],
  ['ConsumableCategoriesController', ConsumableCategoriesController],
  ['ArticleCategoriesController', ArticleCategoriesController],
  ['ApplicationCategoriesController', ApplicationCategoriesController],
  ['AccessGrantsController', AccessGrantsController],
  ['UsersController', UsersController],
];

describe('@RequirePermission parity with the retired @Roles gates (ADR-0046 P4)', () => {
  const reflector = new Reflector();

  // For every migrated route: the roles allowed by its @RequirePermission (resolved against the seed)
  // EXACTLY equal the roles its old @Roles gate allowed. This is the core behavior-preservation proof.
  for (const [name, ctrl] of CONTROLLERS) {
    const proto = ctrl.prototype as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (m) => m !== 'constructor' && typeof proto[m] === 'function',
    );

    for (const method of methods) {
      const key = `${name}#${method}`;
      const expected = PRE_MIGRATION[key];
      if (!expected) {
        continue; // a read or non-gated route — not part of this PR's write migration.
      }

      it(`${key}: effective role-set unchanged (was ${expected.slice().sort().join('+')})`, () => {
        const perms = reflector.get<Permission[] | undefined>(
          PERMISSION_KEY,
          proto[method] as () => unknown,
        );
        // Every migrated write route MUST now carry @RequirePermission (no @Roles, no open gate).
        expect(perms).toBeDefined();
        expect((perms ?? []).length).toBeGreaterThan(0);

        const after = rolesHolding(perms as Permission[]);
        const before = new Set<Role>(expected);
        expect(eqRoles(after, before)).toBe(true);
        // A readable failure if the sets differ:
        expect(`${key} → ${fmt(after)}`).toBe(`${key} → ${fmt(before)}`);
      });
    }
  }

  // Coverage guard: every documented pre-migration route was actually found + asserted on a controller
  // (catches a renamed/removed handler that would silently drop a gate from the parity check).
  it('covers every documented pre-migration write route (no orphan table entries)', () => {
    const found = new Set<string>();
    for (const [name, ctrl] of CONTROLLERS) {
      const proto = ctrl.prototype as unknown as Record<string, unknown>;
      for (const m of Object.getOwnPropertyNames(proto)) {
        if (m !== 'constructor' && typeof proto[m] === 'function') {
          found.add(`${name}#${m}`);
        }
      }
    }
    const missing = Object.keys(PRE_MIGRATION).filter((k) => !found.has(k));
    expect(missing).toEqual([]);
  });

  // Anti-orphan guard for the AccessGrant trap: the AccessGrant mutations must NOT resolve to a set
  // that includes MEMBER. If they were (mis)gated on accessGrant:write, MEMBER would slip in here.
  it('AccessGrant mutations never admit MEMBER (accessGrant:grant, never :write)', () => {
    const proto = AccessGrantsController.prototype as unknown as Record<
      string,
      unknown
    >;
    const grantMethods = [
      'create',
      'batchRevoke',
      'revoke',
      'updateNotes',
      'updateExpiry',
    ];
    for (const method of grantMethods) {
      const perms = reflector.get<Permission[] | undefined>(
        PERMISSION_KEY,
        proto[method] as () => unknown,
      );
      const after = rolesHolding(perms ?? []);
      expect(after.has('MEMBER')).toBe(false);
      expect(after.has('VIEWER')).toBe(false);
      expect(after.has('ADMIN')).toBe(true);
    }
  });
});

/**
 * ADMIN-ONLY PARITY for the privileged surfaces (#555 — generalising the ADR-0046 P4 net beyond the 13
 * classic CRUD controllers). The Secret Manager, Service-Accounts management, the permission matrix, and
 * the workflow engine are all ADMIN-tier by design: `secret:*`, `settings:manage`, and the `workflow:*`
 * verbs are ADMIN-only in the seed. These controllers had no `@Roles` baseline (they were born on
 * `@RequirePermission`), so instead of a pre/post diff we assert the security INVARIANT directly: every
 * `@RequirePermission(perm)` route resolves to EXACTLY `{ADMIN}` — a MEMBER/VIEWER must never reach them.
 *
 * Routes intentionally excluded: `@Public()` first-run/setup routes (no auth at all) and the deliberate
 * `@RequirePermission()` with NO args (e.g. `GET /config/my-permissions` — any authenticated caller).
 * A future mis-wire of one of these routes to a MEMBER-held verb (`asset:read`, a `:write`, …) FAILS CI.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ADMIN_ONLY_CONTROLLERS: Array<[string, any]> = [
  ['VaultsController', VaultsController],
  ['ItemsController', ItemsController],
  ['KeypairController', KeypairController],
  ['ServiceAccountsController', ServiceAccountsController],
  ['ConfigController', ConfigController],
  ['WorkflowsController', WorkflowsController],
  ['WorkflowConnectionsController', WorkflowConnectionsController],
  ['WorkflowSecretsController', WorkflowSecretsController],
  ['WorkflowRunsController', WorkflowRunsController],
  ['ManualTasksController', ManualTasksController],
  ['WorkflowDryRunController', WorkflowDryRunController],
];

describe('@RequirePermission ADMIN-only parity for privileged surfaces (#555)', () => {
  const reflector = new Reflector();

  for (const [name, ctrl] of ADMIN_ONLY_CONTROLLERS) {
    const proto = ctrl.prototype as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (m) => m !== 'constructor' && typeof proto[m] === 'function',
    );

    for (const method of methods) {
      const handler = proto[method] as () => unknown;
      const isPublic = reflector.get<boolean | undefined>(
        IS_PUBLIC_KEY,
        handler,
      );
      if (isPublic) {
        continue; // @Public() — first-run/setup; not permission-gated by design.
      }
      const perms = reflector.get<Permission[] | undefined>(
        PERMISSION_KEY,
        handler,
      );
      // A handler with no @RequirePermission metadata at all, or an EMPTY require (any authenticated),
      // is not an ADMIN-only route — skip (the empty-require case is e.g. config#myPermissions).
      if (!perms || perms.length === 0) {
        continue;
      }

      it(`${name}#${method}: resolves to ADMIN-only (no MEMBER/VIEWER)`, () => {
        const after = rolesHolding(perms);
        expect(after.has('VIEWER')).toBe(false);
        expect(after.has('MEMBER')).toBe(false);
        expect(after.has('ADMIN')).toBe(true);
        // Readable failure if the set ever drifts:
        expect(`${name}#${method} → ${fmt(after)}`).toBe(
          `${name}#${method} → ADMIN`,
        );
      });
    }
  }

  // Coverage guard: each privileged controller actually contributed at least one asserted ADMIN-only
  // route — catches a controller that silently lost ALL its @RequirePermission gates (or an import typo
  // resolving to an empty class), which would make the block vacuously pass.
  it('every privileged controller contributes at least one ADMIN-only route', () => {
    for (const [name, ctrl] of ADMIN_ONLY_CONTROLLERS) {
      const proto = ctrl.prototype as unknown as Record<string, unknown>;
      const gated = Object.getOwnPropertyNames(proto)
        .filter((m) => m !== 'constructor' && typeof proto[m] === 'function')
        .filter((m) => {
          const handler = proto[m] as () => unknown;
          if (reflector.get<boolean>(IS_PUBLIC_KEY, handler)) return false;
          const perms = reflector.get<Permission[] | undefined>(
            PERMISSION_KEY,
            handler,
          );
          return !!perms && perms.length > 0;
        });
      expect(`${name}: ${gated.length} gated`).not.toBe(`${name}: 0 gated`);
    }
  });
});
