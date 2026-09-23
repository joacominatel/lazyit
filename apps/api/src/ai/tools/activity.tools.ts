import { AuditController } from '../../audit/audit.controller';
import { DashboardController } from '../../dashboard/dashboard.controller';
import { NotificationsController } from '../../notifications/notifications.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

const PENDING = 'Pending: the activity toolset (W2-9) binds or excludes it.';

/**
 * The ACTIVITY toolset (W2-9): the dashboard summary and the activity feed. Pre-created by the AI core
 * unit; its unit fills `tools` and replaces the pending entries with a decision per handler. The coverage
 * test fails on any handler left undecided.
 */
export const activityToolset: AiToolset = {
  domain: 'activity',
  tools: [],
  unexposed: [
    unexposed(
      DashboardController,
      ['summary', 'activityFilters', 'activity'],
      PENDING,
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
