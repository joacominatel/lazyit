import { EmailDispatchService } from './email-dispatch.service';
import {
  EMAIL_NOTIFICATION_TYPES,
  SECURITY_NOTICE_NOTIFICATION_TYPES,
  isEmailableNotificationType,
  isSecurityNoticeType,
  type NotificationEmailJob,
} from './email.constants';
import * as mailer from './email.mailer';
import type { PrismaService } from '../prisma/prisma.service';
import type { PermissionResolverService } from '../auth/permission-resolver.service';
import type { SmtpService } from './smtp.service';

// Stub the generated Prisma client so ts-jest never resolves its ESM-style `.js` imports (the api
// CommonJS-Jest convention — mirrors asset-tag-scheme.service.spec). Prisma is mocked per-test anyway.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

// The email channel routing (ADR-0079): the allowlist, and the worker-side recipient resolution that
// mirrors the bell audience (broadcast → notification:read holders; targeted → that one user).

/** Typed accessor for the first sendMail arg (avoids unsafe `any` member access on mock.calls). */
function mailArg(sendMail: jest.Mock): {
  to?: unknown;
  bcc?: unknown;
  subject?: unknown;
} {
  const args = sendMail.mock.calls[0] as unknown[];
  return args[0] as { to?: unknown; bcc?: unknown; subject?: unknown };
}

describe('email allowlist (curated)', () => {
  it('routes the operational nudges AND the sensitive-audit alerts (CEO opt-in 2026-06-30)', () => {
    expect(isEmailableNotificationType('low_stock')).toBe(true);
    expect(isEmailableNotificationType('workflow.run_failed')).toBe(true);
    expect(isEmailableNotificationType('critical_app_access')).toBe(true);
    // Sensitive-audit alerts (#852) — now INCLUDED (ADR-0079 fork #1):
    expect(isEmailableNotificationType('permission_widened')).toBe(true);
    expect(isEmailableNotificationType('infra.agent_offline')).toBe(true);
    // The weekly update nudge (ADR-0084 §2) — emailed (the whole point is an admin inbox):
    expect(isEmailableNotificationType('update.available')).toBe(true);
    // The targeted requester decision nudge (#1071) — emailed (opt-out-able):
    expect(isEmailableNotificationType('access_request.decided')).toBe(true);
    // The proactive expiry nudges (#1070) — emailed (act before the deadline, opt-out-able):
    expect(isEmailableNotificationType('warranty_expiring')).toBe(true);
    expect(isEmailableNotificationType('access_grant_expiring')).toBe(true);
    // The targeted check-out acknowledgement nudge (ADR-0089 Part B, #1029) — emailed (opt-out-able):
    expect(isEmailableNotificationType('asset_assignment.acknowledged')).toBe(
      true,
    );
    // The new-AI-agent-connection security notice (ADR-0097, security §6.3) — emailed:
    expect(isEmailableNotificationType('mcp.client_connected')).toBe(true);
    // Still bell-only — the per-user login nudge is not inbox-worthy:
    expect(isEmailableNotificationType('secret.vault_setup')).toBe(false);
  });
  it('the allowlist is the thirteen emailed types', () => {
    expect([...EMAIL_NOTIFICATION_TYPES].sort()).toEqual(
      [
        'access_grant_expiring',
        'access_request.decided',
        'admin_granted',
        'asset_assignment.acknowledged',
        'critical_app_access',
        'infra.agent_offline',
        'low_stock',
        'mcp.client_connected',
        'permission_widened',
        'update.available',
        'warranty_expiring',
        'workflow.manual_task',
        'workflow.run_failed',
      ].sort(),
    );
  });
});

describe('security notices (#1699)', () => {
  it('mcp.client_connected is the only security notice, and it is emailable', () => {
    expect([...SECURITY_NOTICE_NOTIFICATION_TYPES]).toEqual([
      'mcp.client_connected',
    ]);
    for (const type of SECURITY_NOTICE_NOTIFICATION_TYPES) {
      expect(isEmailableNotificationType(type)).toBe(true);
    }
    expect(isSecurityNoticeType('low_stock')).toBe(false);
    expect(isSecurityNoticeType('access_request.decided')).toBe(false);
  });
});

describe('EmailDispatchService.dispatch', () => {
  const config = {
    host: 'smtp.example.com',
    port: 587,
    security: 'starttls' as const,
    username: 'mailer',
    password: 'pw',
    fromAddress: 'it@example.com',
    fromName: 'lazyit',
    rejectUnauthorized: true,
  };

  function setup(overrides?: {
    resolveConfig?: unknown;
    userFindFirst?: unknown;
    userFindMany?: unknown[];
    hasAll?: (role: string) => boolean;
  }) {
    const sendMail = jest.fn().mockResolvedValue({});
    jest.spyOn(mailer, 'buildTransport').mockReturnValue({ sendMail } as never);

    const prisma = {
      user: {
        findFirst: jest
          .fn()
          .mockResolvedValue(overrides?.userFindFirst ?? null),
        findMany: jest.fn().mockResolvedValue(overrides?.userFindMany ?? []),
      },
    } as unknown as PrismaService;

    const permissions = {
      hasAll: jest.fn((role: string) =>
        Promise.resolve(
          overrides?.hasAll ? overrides.hasAll(role) : role === 'ADMIN',
        ),
      ),
    } as unknown as PermissionResolverService;

    const smtp = {
      resolveConfig: jest
        .fn()
        .mockResolvedValue(
          overrides && 'resolveConfig' in overrides
            ? overrides.resolveConfig
            : config,
        ),
    } as unknown as SmtpService;

    return {
      service: new EmailDispatchService(prisma, permissions, smtp),
      sendMail,
      prisma,
      permissions,
    };
  }

  const baseJob: NotificationEmailJob = {
    notificationId: 'n1',
    type: 'low_stock',
    severity: 'warning',
    title: 'Low stock: USB-C cables',
    summary: '3 remaining (min 10)',
    entityType: 'consumable',
    entityId: 'c1',
    recipientUserId: null,
  };

  afterEach(() => jest.restoreAllMocks());

  it('does nothing when email is off / config unresolved (no send)', async () => {
    const { service, sendMail } = setup({ resolveConfig: null });
    await service.dispatch(baseJob);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('BROADCAST: emails notification:read roles via bcc (addresses not cross-disclosed)', async () => {
    const { service, sendMail } = setup({
      userFindMany: [
        { email: 'admin1@example.com', notificationEmailOptOutTypes: [] },
        { email: 'admin2@example.com', notificationEmailOptOutTypes: [] },
      ],
    });
    await service.dispatch(baseJob);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const msg = mailArg(sendMail);
    expect(msg.bcc).toEqual(['admin1@example.com', 'admin2@example.com']);
    expect(msg.to).toBe(config.fromAddress); // broadcast: `to` is the sender, recipients hidden in bcc
    expect(msg.subject).toBe(baseJob.title);
  });

  it('TARGETED: emails the single user with `to` (no bcc)', async () => {
    const { service, sendMail } = setup({
      userFindFirst: {
        email: 'grantee@example.com',
        notificationEmailOptOutTypes: [],
      },
    });
    await service.dispatch({ ...baseJob, recipientUserId: 'u-123' });
    const msg = mailArg(sendMail);
    expect(msg.to).toBe('grantee@example.com');
    expect(msg.bcc).toBeUndefined();
  });

  it('no recipients (no admin has an email) → no send', async () => {
    const { service, sendMail } = setup({ userFindMany: [] });
    await service.dispatch(baseJob);
    expect(sendMail).not.toHaveBeenCalled();
  });

  // Per-user, per-type EMAIL opt-out (issue #879): a user who listed job.type in their
  // notificationEmailOptOutTypes is dropped from the email audience — both paths.
  it('BROADCAST: drops a user who opted OUT of this type, keeps one who did not', async () => {
    const { service, sendMail } = setup({
      userFindMany: [
        { email: 'in@example.com', notificationEmailOptOutTypes: [] },
        {
          email: 'out@example.com',
          notificationEmailOptOutTypes: ['low_stock'], // opted out of baseJob.type
        },
        {
          email: 'other@example.com',
          notificationEmailOptOutTypes: ['admin_granted'], // opted out of a DIFFERENT type
        },
      ],
    });
    await service.dispatch(baseJob); // type = 'low_stock'
    expect(sendMail).toHaveBeenCalledTimes(1);
    const msg = mailArg(sendMail);
    expect(msg.bcc).toEqual(['in@example.com', 'other@example.com']);
  });

  it('TARGETED: a user who opted OUT of this type gets NO email', async () => {
    const { service, sendMail } = setup({
      userFindFirst: {
        email: 'grantee@example.com',
        notificationEmailOptOutTypes: ['low_stock'],
      },
    });
    await service.dispatch({ ...baseJob, recipientUserId: 'u-123' }); // type = 'low_stock'
    expect(sendMail).not.toHaveBeenCalled();
  });

  // A security notice ignores the opt-out (#1699): a stored opt-out entry for it is ignored on read.
  const mcpNotice: NotificationEmailJob = {
    ...baseJob,
    type: 'mcp.client_connected',
    severity: 'warning',
    title: 'New AI agent connected: Claude',
    summary: null,
    entityType: null,
    entityId: null,
    recipientUserId: 'u-123',
  };

  it('TARGETED security notice: emailed even though the user opted OUT of it', async () => {
    const { service, sendMail } = setup({
      userFindFirst: {
        email: 'owner@example.com',
        notificationEmailOptOutTypes: ['mcp.client_connected'],
      },
    });
    await service.dispatch(mcpNotice);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(mailArg(sendMail).to).toBe('owner@example.com');
  });

  it('BROADCAST security notice: no opted-out recipient is dropped', async () => {
    const { service, sendMail } = setup({
      userFindMany: [
        {
          email: 'a@example.com',
          notificationEmailOptOutTypes: ['mcp.client_connected'],
        },
        { email: 'b@example.com', notificationEmailOptOutTypes: [] },
      ],
    });
    await service.dispatch({ ...mcpNotice, recipientUserId: null });
    expect(mailArg(sendMail).bcc).toEqual(['a@example.com', 'b@example.com']);
  });

  it('a security notice carries the "cannot be turned off" footer, not the preferences link', async () => {
    const render = jest.spyOn(mailer, 'renderNotificationEmail');
    const { service } = setup({
      userFindFirst: {
        email: 'owner@example.com',
        notificationEmailOptOutTypes: [],
      },
    });
    await service.dispatch(mcpNotice);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'security-notice' }),
    );
    await service.dispatch({ ...baseJob, recipientUserId: 'u-123' });
    expect(render).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'notification' }),
    );
  });

  it('a security notice still sends nothing while email is off', async () => {
    const { service, sendMail } = setup({ resolveConfig: null });
    await service.dispatch(mcpNotice);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('TARGETED: a user opted out of a DIFFERENT type still receives this one', async () => {
    const { service, sendMail } = setup({
      userFindFirst: {
        email: 'grantee@example.com',
        notificationEmailOptOutTypes: ['admin_granted'],
      },
    });
    await service.dispatch({ ...baseJob, recipientUserId: 'u-123' }); // type = 'low_stock'
    const msg = mailArg(sendMail);
    expect(msg.to).toBe('grantee@example.com');
  });
});
