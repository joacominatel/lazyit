import { z } from 'zod';
import {
  ActivityEntityTypeSchema,
  RecentActivityActionSchema,
} from '@lazyit/shared';
import { AuditController } from '../../audit/audit.controller';
import { DashboardController } from '../../dashboard/dashboard.controller';
import { NotificationsController } from '../../notifications/notifications.controller';
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
import { searchText } from './search-text';

/**
 * The ACTIVITY toolset (W2-9; tools-and-execution.md §7 rows 5–6): the dashboard summary and the unified
 * activity feed, READ ONLY. Both go through `rt.call` — the route's own `@RequirePermission`
 * (`dashboard:read`, `logs:read`), pipes and query validation, as the principal.
 *
 * Untrusted text: an activity row's `subjectName` is the affected entity's name (an asset an agent may
 * have auto-created from a reported hostname, an application, a consumable), and a summary row's history
 * `payload` carries operator-written values — both are wrapped with `untrusted()`. The feed's `summary`
 * is a fixed server-generated phrase and the actor/target names are directory display names.
 */

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return typeof value === 'object' && value !== null ? (value as Row) : {};
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow) : [];
}

function pick(row: unknown, fields: readonly string[]): Row {
  const source = asRow(row);
  const out: Row = {};
  for (const field of fields) {
    if (field in source) out[field] = source[field];
  }
  return out;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

const dashboardSummary = defineTool({
  name: 'dashboard_summary',
  title: 'Dashboard summary',
  description:
    'A point-in-time overview of the estate: assets by status (and how many are assigned, how many ' +
    'warranties expire soon), active application access grants (expiring soon, on critical apps), ' +
    'consumables at or below their reorder point, and published vs draft articles. detail "full" adds ' +
    'the latest asset history events. Use it for "how are we doing" questions; use activity_list for ' +
    'who did what.',
  domain: 'activity',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    expiringWithinDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Look-ahead window for "expiring soon" grants (default 30).'),
    detail: z
      .enum(['concise', 'full'])
      .default('concise')
      .describe('"full" adds the latest asset history events.'),
  }),
  bindings: [bind(DashboardController, 'summary')],
  async run(input, rt) {
    const summary = asRow(
      await rt.call(DashboardController, 'summary', {
        query: {
          expiringWithinDays:
            input.expiringWithinDays === undefined
              ? undefined
              : String(input.expiringWithinDays),
        },
      }),
    );
    const data: Row = {
      ...pick(summary, ['assets', 'access', 'consumables', 'articles']),
      generatedAt: iso(summary.generatedAt),
    };
    if (input.detail === 'full') {
      data.recentAssetHistory = asRows(summary.recentActivity).map((e) => ({
        ...pick(e, ['id', 'assetId', 'eventType', 'performedById']),
        createdAt: iso(e.createdAt),
        payload:
          e.payload && typeof e.payload === 'object'
            ? untrusted(JSON.stringify(e.payload))
            : null,
      }));
    }
    return { data };
  },
});

const activityList = defineTool({
  name: 'activity_list',
  title: 'List recent activity',
  description:
    'The unified activity feed, newest first: asset changes, check-outs and check-ins, access granted ' +
    'and revoked, stock movements and user lifecycle events (created, role changed, offboarded…). ' +
    'Filter by entity type and id, by actor (a user id or "me"), by action, by a time window ' +
    '[from, to) or by text matched against the summary and the actor name (omit `query` to list by the ' +
    'other filters alone). Returns a page and the ' +
    'total. Requires the logs:read permission (administrators by default).',
  domain: 'activity',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    entityType: ActivityEntityTypeSchema.optional(),
    entityId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Only rows about this entity id.'),
    actor: z
      .union([z.uuid(), z.literal('me')])
      .optional()
      .describe('Only rows by this user id, or "me" (the person you act for).'),
    action: RecentActivityActionSchema.optional(),
    from: z.iso
      .datetime()
      .optional()
      .describe('Inclusive lower bound (ISO-8601).'),
    to: z.iso
      .datetime()
      .optional()
      .describe('Exclusive upper bound (ISO-8601).'),
    query: searchText('Text matched against the summary and the actor name.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(AI_TOOL_LIST_MAX_LIMIT)
      .optional()
      .describe(
        `Page size (default ${AI_TOOL_LIST_DEFAULT_LIMIT}, max ${AI_TOOL_LIST_MAX_LIMIT}).`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Rows to skip (default 0).'),
  }),
  bindings: [bind(DashboardController, 'activity')],
  async run(input, rt) {
    const limit = input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const page = asRow(
      await rt.call(DashboardController, 'activity', {
        query: {
          limit: String(limit),
          offset: String(offset),
          entityType: input.entityType,
          entityId: input.entityId,
          actorId: input.actor,
          action: input.action,
          from: input.from,
          to: input.to,
          q: input.query,
        },
      }),
    );
    const items = asRows(page.items).map((row) => ({
      occurredAt: iso(row.occurredAt),
      ...pick(row, [
        'action',
        'entityType',
        'entityId',
        'summary',
        'actorId',
        'actorName',
        'targetUserId',
        'targetUserName',
      ]),
      subjectName: untrusted(
        typeof row.subjectName === 'string' ? row.subjectName : null,
      ),
    }));
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

export const activityToolset: AiToolset = {
  domain: 'activity',
  tools: [dashboardSummary, activityList],
  unexposed: [
    unexposed(
      DashboardController,
      ['activityFilters'],
      "The Reports page's select menus; activity_list filters by actor and action directly.",
    ),
    unexposed(
      DashboardController,
      ['activityExport'],
      'A bulk CSV file export (@Res stream); use the activity tool instead.',
    ),
    unexposed(
      AuditController,
      ['filters', 'logs'],
      'Deferred: the security audit logs are v1.1 (tools-and-execution.md §3).',
    ),
    unexposed(
      AuditController,
      ['export'],
      'A bulk CSV file export (@Res stream).',
    ),
    unexposed(
      NotificationsController,
      [
        'findAll',
        'unreadCount',
        'markRead',
        'markAllRead',
        'dismissAll',
        'dismiss',
      ],
      'Deferred: notifications are v1.1 (tools-and-execution.md §3).',
    ),
  ],
};
