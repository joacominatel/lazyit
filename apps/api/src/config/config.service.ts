import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { ConfigStatus, IntegrationMode, SetupAdmin } from '@lazyit/shared';
import { Role } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectUser } from '../search/search.documents';
import { LocalProvisioningService } from '../auth/local/local-provisioning.service';
import { resolveIntegrationMode } from './integration-mode';
import { SetupCsrfService } from './setup-csrf.service';

/** What `setup()` returns to the controller (mapped to {@link SetupResultSchema} there). */
export interface SetupOutcome {
  adminId: string;
  email: string;
  setupCompletedAt: Date;
}

/**
 * ConfigService — the brain behind the in-app first-run setup (ADR-0043 Phase 3 §5).
 *
 * NO migration, NO `config_settings` table: "configured" is DERIVED from whether any ADMIN exists
 * (decision in the task + §5a), and `integrationMode` / `devMode` are read from env. This keeps
 * first-run a pure read of existing state, so the wizard self-locks the instant an ADMIN is created.
 *
 * `setup()` bootstraps the FIRST ADMIN, idempotently: 409 once ANY ADMIN exists (§6 #3). Local mode sets
 * the admin's password; OIDC mode creates the row only, with no password and no IdP call (ADR-0102).
 * Every admin creation is audited (structured Pino: op, email, ip).
 */
@Injectable()
export class ConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly csrf: SetupCsrfService,
    private readonly provisioning: LocalProvisioningService,
    @InjectPinoLogger(ConfigService.name)
    private readonly logger: PinoLogger,
  ) {}

  /** `local` under AUTH_MODE=local, else `generic-oidc`. */
  integrationMode(): IntegrationMode {
    return resolveIntegrationMode(process.env.AUTH_MODE);
  }

  /** True when the instance runs first-party local auth (AUTH_MODE=local, ADR-0086). */
  private isLocalMode(): boolean {
    return this.integrationMode() === 'local';
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
      // Only local mode owns a credential; under OIDC the operator's IdP does (ADR-0102).
      requiresAdminPassword: isLocal,
      // Always false since ADR-0102; still emitted because older web builds read it.
      canProvisionAccounts: false,
      // Whether an ADMIN can locally ONBOARD a directory person — mint a one-time temp password so an
      // imported, login-less person can sign in (ADR-0086 §5, issue #1072). True ONLY in local mode
      // (lazyit owns the credential); the Users page reads it to offer the temp-password action in place
      // of the impossible "Create OIDC account" one. Spread only when local so the OIDC status is
      // byte-identical to before (matching the authMode pattern below).
      ...(isLocal ? { canProvisionLocalAccounts: true } : {}),
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
   * DB write and the audit.
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
    // No IdP mirror, `externalId` stays null.
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
      this.auditSetup('setup', admin.id, admin.email, ip, { mode: 'local' });
      return {
        adminId: admin.id,
        email: admin.email,
        setupCompletedAt: admin.createdAt,
      };
    }

    // OIDC: the operator's IdP owns the credential and JIT links the admin on first sign-in (ADR-0102).
    const admin = await this.prisma.user.create({
      data: {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        role: Role.ADMIN,
      },
    });
    // Immutability enforcement WRITE side (ADR-0086 §1): persist the 'oidc' mode marker at first setup.
    await this.persistAuthModeMarker();
    this.search.upsert('users', projectUser(admin));
    this.auditSetup('setup', admin.id, admin.email, ip, {});
    return {
      adminId: admin.id,
      email: admin.email,
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
   * yet). Captures the operation, the new admin's email, the requester IP and the auth mode, so the
   * one-time bootstrap is attributable in the logs.
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
