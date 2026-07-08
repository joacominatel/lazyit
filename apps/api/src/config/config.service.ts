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
import { LocalProvisioningService } from '../auth/local/local-provisioning.service';
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
    private readonly provisioning: LocalProvisioningService,
    @InjectPinoLogger(ConfigService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * The IdP posture (zitadel | generic-oidc | local). `AUTH_MODE=local` yields `'local'` regardless of
   * IDENTITY_PROVIDER_TYPE (ADR-0086 §5), matching the LocalIdentityProvider the AuthModule builds.
   */
  integrationMode(): IntegrationMode {
    return resolveIntegrationMode(
      process.env.IDENTITY_PROVIDER_TYPE,
      process.env.AUTH_MODE,
    );
  }

  /** True when the instance runs first-party local auth (AUTH_MODE=local, ADR-0086). */
  private isLocalMode(): boolean {
    return this.idp.kind === 'local';
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
    const isLocal = this.isLocalMode();
    return {
      isConfigured: adminCount > 0,
      adminCount,
      integrationMode: this.integrationMode(),
      devMode: this.devMode(),
      csrfToken: this.csrf.issue(),
      // requiresAdminPassword is DECOUPLED from supportsManagement (ADR-0086 §5): in LOCAL mode the wizard
      // MUST collect a password (lazyit stores it as the first admin's passwordHash — otherwise the first
      // ADMIN would be un-loggable and the instance bricks). In OIDC mode it stays exactly as before —
      // true only for bundled Zitadel with a Management credential (issue #335), false for BYOI.
      requiresAdminPassword: isLocal ? true : this.idp.supportsManagement,
      // Whether the manual "Create OIDC account" promotion (ADR-0069) can actually succeed — true ONLY
      // for the bundled Zitadel. In LOCAL / BYOI there is no management write-back, so the Users page
      // reads this to hide the impossible action instead of offering a request that always 400s (#1048).
      canProvisionAccounts: this.idp.supportsManagement,
      // The UI-facing auth mode (ADR-0086 §6). Populated ONLY in local mode here so the OIDC
      // /config/status response stays byte-identical to today; F2 adds the explicit 'oidc' value when it
      // branches the /login screen. `shim` never reaches a browser, so it is not part of this union.
      ...(isLocal ? { authMode: 'local' as const } : {}),
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

    // LOCAL mode (ADR-0086 §5): lazyit OWNS the credential — there is no IdP. `/setup` is the ONLY path to
    // the first ADMIN and it MUST set a password (else an un-loggable first admin bricks the instance). We
    // hash it via the LocalCredentialService (through the provisioning primitive) and store it on the new
    // ADMIN's `passwordHash` — the admin chooses their OWN real password, so mustChangePassword stays false.
    // No IdP mirror, `externalId` stays null. We branch BEFORE the supportsManagement checks below because
    // LocalIdentityProvider is `supportsManagement:false` (which those checks read).
    if (this.isLocalMode()) {
      if (!input.password) {
        throw new BadRequestException(
          'An initial password is required to create the first administrator in local authentication mode.',
        );
      }
      const credential = await this.provisioning.credentialFields(
        input.password,
        { mustChangePassword: false },
      );
      const admin = await this.prisma.user.create({
        data: {
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          role: Role.ADMIN,
          ...credential,
        },
      });
      // Immutability enforcement WRITE side (ADR-0086 §1): persist the mode marker at first setup so every
      // subsequent boot refuses to start if AUTH_MODE is flipped on this now-populated instance.
      await this.persistAuthModeMarker();
      this.search.upsert('users', projectUser(admin));
      this.auditSetup('setup', admin.id, admin.email, ip, {
        mirrored: false,
        mode: 'local',
      });
      return {
        adminId: admin.id,
        email: admin.email,
        mirrored: false,
        setupCompletedAt: admin.createdAt,
      };
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
        // Immutability enforcement WRITE side (ADR-0086 §1): persist the 'oidc' mode marker at first setup.
        await this.persistAuthModeMarker();
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
    // Immutability enforcement WRITE side (ADR-0086 §1): persist the 'oidc' mode marker at first setup.
    await this.persistAuthModeMarker();
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
   * Persist the immutable auth-mode marker at first successful setup (ADR-0086 §1). Upserts the single
   * `instance_config` row (fixed id 'singleton') with the boot-validated `AUTH_MODE`. Every subsequent boot
   * compares this against `env.AUTH_MODE` (auth/mode-marker.ts) and REFUSES to start on a mismatch — the
   * write side of the "mode is chosen once and is immutable" enforcement. Setup is one-time (409 after the
   * first ADMIN), so this effectively writes exactly once; the upsert is idempotent regardless.
   *
   * `AUTH_MODE` is guaranteed present + one of shim|local|oidc here (boot-config asserts it before the app
   * boots). The fallback to 'oidc' is defensive dead-code for the type — it is never taken at runtime.
   */
  private async persistAuthModeMarker(): Promise<void> {
    const authMode = process.env.AUTH_MODE ?? 'oidc';
    await this.prisma.instanceConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', authMode },
      update: { authMode },
    });
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
