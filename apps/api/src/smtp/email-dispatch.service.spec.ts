import { EmailDispatchService } from './email-dispatch.service';
import {
  EMAIL_NOTIFICATION_TYPES,
  isEmailableNotificationType,
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

describe('email allowlist (curated, start-small)', () => {
  it('routes the operational nudges and NOT the login/audit ones', () => {
    expect(isEmailableNotificationType('low_stock')).toBe(true);
    expect(isEmailableNotificationType('workflow.run_failed')).toBe(true);
    expect(isEmailableNotificationType('critical_app_access')).toBe(true);
    // Bell-only in v1 (see ADR-0079 forks):
    expect(isEmailableNotificationType('secret.vault_setup')).toBe(false);
    expect(isEmailableNotificationType('permission_widened')).toBe(false);
    expect(isEmailableNotificationType('infra.agent_offline')).toBe(false);
  });
  it('the allowlist is the five clearly-operational types', () => {
    expect([...EMAIL_NOTIFICATION_TYPES].sort()).toEqual(
      [
        'admin_granted',
        'critical_app_access',
        'low_stock',
        'workflow.manual_task',
        'workflow.run_failed',
      ].sort(),
    );
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
        { email: 'admin1@example.com' },
        { email: 'admin2@example.com' },
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
      userFindFirst: { email: 'grantee@example.com' },
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
});
