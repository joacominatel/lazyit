import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { ConfigStatus, IntegrationMode, SetupAdmin } from '@lazyit/shared';
import { Role } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectUser } from '../search/search.documents';
import {
  IDENTITY_PROVIDER,
  type IdentityProvider,
} from '../auth/identity/identity-provider.interface';
import { resolveIntegrationMode } from './integration-mode';
import { SetupCsrfService } from './setup-csrf.service';

/** What `setup()` returns to the controller (mapped to {@link SetupResultSchema} there). */
export interface SetupOutcome {
  adminId: string;
  email: string;
  /** True when the new ADMIN was also mirrored into the IdP; false when created local-only. */
  mirrored: boolean;
  setupCompletedAt: Date;
}

/**
 * ConfigService — the brain behind the in-app first-run setup (ADR-0043 Phase 3 §5).
 *
 * NO migration, NO `config_settings` table: "configured" is DERIVED from whether any ADMIN exists
 * (decision in the task + §5a), and `integrationMode` / `devMode` are read from env. This keeps
 * first-run a pure read of existing state, so the wizard self-locks the instant an ADMIN is created.
 *
 * `setup()` bootstraps the FIRST ADMIN. It is idempotent: 409 once ANY ADMIN exists (the one-time
 * gate, §6 #3). It reuses the same DB-first + IdP-mirror shape as UsersService.create, branching on
 * whether the IdP MANAGES users (issue #335):
 *   - BUNDLED Zitadel (`supportsManagement`): the wizard supplies an initial PASSWORD (a 400 here if
 *     it is missing). lazyit sets it on the freshly-created Zitadel user so the operator can log in
 *     immediately (no SMTP/e-mail-code path). If the mirror fails we COMPENSATE — hard-delete the
 *     just-created local row and surface a 503 to retry — because a local-only ADMIN with no loggable
 *     Zitadel user would silently break "setup → ready". NO degrade-to-local-only here.
 *   - BYOI / generic-OIDC (no management): created LOCAL-ONLY (mirrored=false), no password. The
 *     ADR-0043 §6 #4 degrade-not-block stance applies only to THIS path now — providers we cannot
 *     manage never mirror anyway, so there is nothing to fail-and-block on.
 * Every admin creation is audited (structured Pino: op, email, ip).
 */
@Injectable()
export class ConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    @Inject(IDENTITY_PROVIDER)
    private readonly idp: IdentityProvider,
    private readonly csrf: SetupCsrfService,
    @InjectPinoLogger(ConfigService.name)
    private readonly logger: PinoLogger,
  ) {}

  /** The IdP posture, derived from IDENTITY_PROVIDER_TYPE (zitadel | generic-oidc). */
  integrationMode(): IntegrationMode {
    return resolveIntegrationMode(process.env.IDENTITY_PROVIDER_TYPE);
  }

  /**
   * Dev posture (§7): true when AUTH_MODE=shim (auth disabled) OR NODE_ENV is not "production". Drives
   * the amber "Dev Mode" topbar banner vs. the blue "Production" one — so an operator can never ship a
   * dev posture by accident without it being obvious.
   */
  devMode(): boolean {
    return (
      process.env.AUTH_MODE === 'shim' || process.env.NODE_ENV !== 'production'
    );
  }

  /**
   * First-run status (`GET /config/status`, @Public). `isConfigured = adminCount > 0`. Counts LIVE
   * ADMINs only — the soft-delete read filter already excludes offboarded users, so an offboarded
   * admin does not keep the instance "configured". Issues a fresh CSRF token the wizard echoes on
   * `POST /config/setup`. No secrets in the payload.
   */
  async getStatus(): Promise<ConfigStatus> {
    const adminCount = await this.prisma.user.count({
      where: { role: Role.ADMIN },
    });
    return {
      isConfigured: adminCount > 0,
      adminCount,
      integrationMode: this.integrationMode(),
      devMode: this.devMode(),
      csrfToken: this.csrf.issue(),
      // The wizard collects an initial password only when lazyit can SET it on the IdP (bundled Zitadel
      // with management); BYOI / generic-OIDC own the credential themselves (issue #335).
      requiresAdminPassword: this.idp.supportsManagement,
    };
  }

  /** Issue a standalone CSRF token (`GET /config/csrf`) without the full status payload. */
  issueCsrfToken(): string {
    return this.csrf.issue();
  }

  /**
   * Create the FIRST ADMIN (`POST /config/setup`). The CSRF token + rate limit are enforced in the
   * controller layer (guard + explicit check) before this runs; here we own the idempotent gate, the
   * DB write, the (best-effort) IdP mirror and the audit.
   *
   * @param input  validated SetupAdmin payload (email + names; role is locked to ADMIN).
   * @param ip     the requester IP, for the structured audit line (never used to authorize).
   */
  async setup(
    input: SetupAdmin,
    ip: string | undefined,
  ): Promise<SetupOutcome> {
    // One-time gate (§6 #3): 409 the instant ANY live ADMIN already exists. The check-then-create
    // window is acceptable for first-run (a fresh, single-instance deploy); the worst case is two
    // genuinely-concurrent setups both succeeding, which only ever yields two ADMINs — strictly safer
    // than locking everyone out, mirroring the first-user-ADMIN race already accepted in ADR-0040.
    const existingAdmins = await this.prisma.user.count({
      where: { role: Role.ADMIN },
    });
    if (existingAdmins > 0) {
      throw new ConflictException(
        'This instance is already configured (an administrator exists).',
      );
    }

    // Bundled Zitadel REQUIRES an initial password (issue #335): the freshly-created Zitadel user has
    // no credential and there is no SMTP/e-mail-code path, so without a password the operator would be
    // locked out. Re-check the posture server-side (the schema makes `password` optional on the wire,
    // required only here) and 400 BEFORE creating any local row. BYOI never reaches this — it owns the
    // credential and the wizard sends no password.
    if (this.idp.supportsManagement && !input.password) {
      throw new BadRequestException(
        'An initial password is required to create the first administrator for the bundled identity provider.',
      );
    }

    // DB-first: create the local ADMIN row. This is the authoritative record regardless of the IdP
    // outcome (lazyit is DB-first for authorization — ADR-0043 #1).
    const admin = await this.prisma.user.create({
      data: {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        role: Role.ADMIN,
      },
    });

    // Mirror into the IdP when management is supported (bundled Zitadel). BLOCK-AND-COMPENSATE (issue
    // #335): unlike the old degrade-to-local-only, a mirror failure here MUST roll the local row back
    // and surface a 503 to retry — a local-only ADMIN with no loggable Zitadel user silently breaks
    // "setup → ready" (the operator could never sign in). We thread the wizard-chosen password through
    // so Zitadel creates the user active (changeRequired:false).
    if (this.idp.supportsManagement) {
      try {
        const ref = await this.idp.createUser({
          email: admin.email,
          firstName: admin.firstName,
          lastName: admin.lastName,
          role: Role.ADMIN,
          password: input.password,
        });
        const linked = await this.prisma.user.update({
          where: { id: admin.id },
          data: { externalId: ref.externalId },
        });
        this.search.upsert('users', projectUser(linked));
        this.auditSetup('setup', admin.id, admin.email, ip, { mirrored: true });
        return {
          adminId: linked.id,
          email: linked.email,
          mirrored: true,
          setupCompletedAt: linked.updatedAt,
        };
      } catch (err) {
        // Compensate: hard-delete the just-created local row so nothing is left behind (best-effort,
        // same pattern as UsersService.compensateLocalCreate — a delete failure only logs, the 503
        // still wins), then surface a retry-able 503. We do NOT keep a local-only ADMIN on this path.
        try {
          await this.prisma.user.delete({ where: { id: admin.id } });
        } catch (delErr) {
          this.logger.error(
            { op: 'setup', subjectUserId: admin.id, ip: ip ?? 'unknown' },
            `failed to roll back local ADMIN after IdP provisioning failure (${delErr instanceof Error ? delErr.message : String(delErr)})`,
          );
        }
        this.logger.error(
          {
            op: 'setup',
            email: admin.email,
            ip: ip ?? 'unknown',
            subjectUserId: admin.id,
          },
          `first-run IdP provisioning failed; rolled back the local ADMIN (nothing created) (${err instanceof Error ? err.message : String(err)})`,
        );
        throw new ServiceUnavailableException(
          "Couldn't provision the administrator in the identity provider; nothing was created — please retry.",
        );
      }
    }

    // Local-only path: providers we cannot manage (BYOI / generic-OIDC). No password, no mirror — the
    // operator's own IdP owns the credential. This is the only path the ADR-0043 §6 #4 degrade-not-
    // block stance still covers (there is no mirror to fail on).
    this.search.upsert('users', projectUser(admin));
    this.auditSetup('setup', admin.id, admin.email, ip, { mirrored: false });
    return {
      adminId: admin.id,
      email: admin.email,
      mirrored: false,
      setupCompletedAt: admin.createdAt,
    };
  }

  /**
   * Structured audit line for the privileged first-run admin creation (§6 #3 — no DB audit table
   * yet). Captures the operation, the new admin's email, the requester IP and whether the IdP mirror
   * landed, so the one-time bootstrap is attributable in the logs.
   */
  private auditSetup(
    op: string,
    subjectUserId: string,
    email: string,
    ip: string | undefined,
    extra: Record<string, unknown>,
  ): void {
    this.logger.info(
      { op, subjectUserId, email, ip: ip ?? 'unknown', ...extra },
      `first-run setup: created first ADMIN ${email}`,
    );
  }
}
