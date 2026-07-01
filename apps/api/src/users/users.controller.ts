import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotImplementedException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  CloneUserResultSchema,
  CloneUserSchema,
  CreateUserSchema,
  RoleCountsSchema,
  RoleSchema,
  UpdateUserSchema,
  UserListPageSchema,
  UserSchema,
} from '@lazyit/shared';
import type { Role } from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorService } from '../common/actor.service';
import { UsersService, USER_SORT_ALLOWLIST } from './users.service';
import { PasswordResetUnsupportedError } from '../auth/identity/identity-provider.interface';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parsePageQuery } from '../common/parse-page-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { AssetAssignmentDto } from '../asset-assignments/asset-assignment.dto';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { AccessGrantDto } from '../access-grants/access-grant.dto';
import { VaultSetupNudgeService } from '../notifications/vault-setup-nudge.service';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe), TS types and the
// OpenAPI schema, all from one definition. See docs/03-decisions/0018-api-documentation-swagger.md.
class UserDto extends createZodDto(UserSchema) {}
class UserListPageDto extends createZodDto(UserListPageSchema) {}
class RoleCountsDto extends createZodDto(RoleCountsSchema) {}
class CreateUserDto extends createZodDto(CreateUserSchema) {}
class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
class CloneUserDto extends createZodDto(CloneUserSchema) {}
class CloneUserResultDto extends createZodDto(CloneUserResultSchema) {}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly assignments: AssetAssignmentsService,
    private readonly grants: AccessGrantsService,
    private readonly actor: ActorService,
    private readonly vaultSetupNudge: VaultSetupNudgeService,
  ) {}

  @Get()
  @RequirePermission('user:read')
  @ApiOperation({
    summary:
      'List users (paginated; active by default). Server-side q search + sort. deleted=only lists offboarded (archived) users (ADMIN).',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Case-insensitive substring match on firstName, lastName and email',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size. Default 50, max 200 (ADR-0030).',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Zero-based offset. Mutually redundant with page.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-based page number (alternative to offset).',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(USER_SORT_ALLOWLIST),
    description:
      'Server-side sort field. Unknown field → 400. Default: createdAt desc.',
  })
  @ApiQuery({
    name: 'dir',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort direction (default asc when sort is set).',
  })
  @ApiQuery({
    name: 'deleted',
    required: false,
    enum: ['active', 'only'],
    description:
      'Soft-delete slice. active (default) = live users; only = offboarded (soft-deleted) users — ADMIN only (403 otherwise). (ADR-0041)',
  })
  @ApiQuery({
    name: 'directoryOnly',
    required: false,
    type: Boolean,
    description:
      'Directory-person filter (ADR-0069 §0 #2). true = only directory persons (no login); false = only login-backed accounts; absent = all (default).',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: RoleSchema.options,
    description:
      'RBAC role filter (issue #693). Scope the list to one role (ADMIN | MEMBER | VIEWER). Unknown value → 400. Absent = all roles (default). Backs the Settings → Roles "View N members" deep-link.',
  })
  @ApiOkResponse({ type: UserListPageDto })
  findAll(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
    @Query('deleted') deleted?: string,
    @Query('directoryOnly') directoryOnly?: string,
    @Query('role') role?: string,
    @CurrentUser() user?: User,
  ) {
    const pageQuery = parsePageQuery({
      limit,
      offset,
      page,
      sort,
      dir,
      deleted,
    });
    // The list route carries no @Roles (any authenticated user may list ACTIVE users), so gate the
    // privileged archived slice here: deleted=only is ADMIN-only (403 otherwise). (ADR-0041)
    assertCanListDeleted(pageQuery.deleted, user);
    // directoryOnly is tri-state: absent → undefined (no filter); present → parsed boolean.
    const directoryOnlyFilter =
      directoryOnly !== undefined
        ? parseBooleanQuery(directoryOnly, true)
        : undefined;
    // role is optional (issue #693): absent → no filter; present → validated by RoleSchema (the global
    // ZodValidationPipe only validates @Body, so a raw @Query is otherwise unchecked → 400 on a bad value).
    const roleFilter =
      role !== undefined ? this.parseRoleQuery(role) : undefined;
    return this.users.findPage(
      { q, directoryOnly: directoryOnlyFilter, role: roleFilter },
      pageQuery,
    );
  }

  /** Validate a raw `?role=` query value against the RBAC allowlist; an unknown value is a clean 400. */
  private parseRoleQuery(raw: string): Role {
    const result = RoleSchema.safeParse(raw);
    if (!result.success) {
      throw new BadRequestException(
        `Invalid role filter: must be one of ${RoleSchema.options.join(', ')}`,
      );
    }
    return result.data;
  }

  // The Settings → Roles cards' real per-role counts (issue #693): one lightweight server-side
  // `groupBy` over the live directory, returned as `{ ADMIN, MEMBER, VIEWER }`. Gated on `user:read`
  // (the same directory-read gate as the list); a VIEWER 403s, consistent with ADR-0046 P3.
  @Get('role-counts')
  @RequirePermission('user:read')
  @ApiOperation({
    summary:
      'Per-role LIVE user counts { ADMIN, MEMBER, VIEWER } — the Settings → Roles card counts (issue #693)',
    description:
      'A single server-side groupBy over the active (not soft-deleted) directory. Correct at any team ' +
      'size (the old client-side count truncated past the list window). The cards deep-link into the ' +
      'Users list (/users?role=…) for the actual membership browser.',
  })
  @ApiOkResponse({ type: RoleCountsDto })
  roleCounts() {
    return this.users.roleCounts();
  }

  // INTENTIONALLY NOT gated with `user:read` (ADR-0046 P3): a VIEWER must read its OWN record + role
  // here — the frontend reads it to decide which admin-only controls to show. It only ever returns the
  // caller (never another user), so it is a self-read, not a directory read. Gating it would break the
  // admin-UI gate for VIEWER. Only the cross-user DIRECTORY reads below carry `user:read`.
  @Get('me')
  @ApiOperation({
    summary: 'The current authenticated user (including their RBAC role)',
    description:
      'Returns the caller as resolved by the auth guard (@CurrentUser). The OIDC token does NOT ' +
      'carry the lazyit role, so the frontend reads it here to decide which admin-only controls to ' +
      'show. Any authenticated user may call it; it only ever returns the caller, never another user.',
  })
  @ApiOkResponse({ type: UserDto })
  async me(@CurrentUser() user?: User) {
    // The route is non-@Public, so the JwtAuthGuard guarantees a user in OIDC mode. In shim mode an
    // anonymous caller would have no user — surface that as 401 rather than a confusing empty body.
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }
    // POST-LOGIN SEAM (ADR-0056 amendment, #453): /me is the app-load self-read every session makes, so
    // it is the natural place to fire the one-time vault-setup nudge for a `secret:read` holder with no
    // keypair. The call is IDEMPOTENT (one notification per user, ever — the dedupeKey) and FAIL-SOFT
    // (it never throws), so a notification problem can never block the /me response or login.
    await this.vaultSetupNudge.notifyIfVaultSetupNeeded(user);
    // Resolve the manager descriptor (ADR-0058) so /me matches the full UserSchema the web consumes.
    return this.users.serializeUser(user);
  }

  // A cross-user DIRECTORY read (identity of another user) — gated on `user:read` (ADR-0046
  // pre-tightened: VIEWER 403). `/users/me` above stays open for the self-read.
  @Get(':id')
  @RequirePermission('user:read')
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiOkResponse({ type: UserDto })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    // The serialized read resolves the manager FK to a redaction-safe descriptor (ADR-0058).
    return this.users.findOneSerialized(id);
  }

  // A cross-user DIRECTORY-relational read (which assets a NAMED user holds — enumeration keyed by a
  // user id). Gated on `user:read`, NOT `asset:read`: a VIEWER holds `asset:read`, so gating on the
  // asset domain would leave the cross-user enumeration open. `user:read` makes the VIEWER lose it,
  // consistent with the directory finding (ADR-0046 P3).
  @Get(':id/assignments')
  @RequirePermission('user:read')
  @ApiOperation({
    summary: "List a user's asset assignments (active-only by default)",
  })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description: 'Default true. Pass false to include released assignments.',
  })
  @ApiOkResponse({ type: [AssetAssignmentDto] })
  async findAssignments(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    await this.users.findOne(id); // 404 if the user is missing or soft-deleted
    return this.assignments.findAll({
      userId: id,
      activeOnly: parseBooleanQuery(activeOnly, true),
    });
  }

  // A cross-user access-MAP read (which apps a NAMED user can reach) — access-grant data, gated on
  // `accessGrant:read` (ADR-0046 pre-tightened: VIEWER 403), matching the access-grant ledger.
  @Get(':id/access-grants')
  @RequirePermission('accessGrant:read')
  @ApiOperation({
    summary: "List a user's access grants (active-only by default)",
  })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description: 'Default true. Pass false to include revoked grants.',
  })
  @ApiQuery({
    name: 'includeExpired',
    required: false,
    type: Boolean,
    description:
      'Default true. Pass false to hide active grants already past their expiresAt.',
  })
  @ApiOkResponse({ type: [AccessGrantDto] })
  async findAccessGrants(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('activeOnly') activeOnly?: string,
    @Query('includeExpired') includeExpired?: string,
  ) {
    await this.users.findOne(id); // 404 if the user is missing or soft-deleted
    return this.grants.findAll({
      userId: id,
      activeOnly: parseBooleanQuery(activeOnly, true),
      includeExpired: parseBooleanQuery(includeExpired, true),
    });
  }

  @Post()
  @RequirePermission('user:manage')
  @ApiOperation({
    summary: 'Create a user — ADMIN only (can set the RBAC role)',
  })
  @ApiCreatedResponse({ type: UserDto })
  create(@Body() dto: CreateUserDto, @CurrentUser() actor?: User) {
    // Pass the actor so the service can attribute the IdP write-back audit line (ADR-0043 §3).
    return this.users.create(dto, this.actor.resolve(actor));
  }

  @Post(':id/clone')
  @RequirePermission('user:manage')
  @ApiOperation({
    summary:
      'Clone a user with chosen actions — ADMIN only (ADR-0058). Mints a NEW user and mirrors the SOURCE’s selected active assignments + grants.',
    description:
      'A clone is a CREATE with extras: `:id` is the SOURCE (must be live). The body’s `profile` is a ' +
      'normal CreateUser payload (the new identity); the clone NEVER copies the source email/legajo/' +
      'username or externalId (SEC-006). `cloneAssetAssignments` / `cloneAccessGrants` opt INTO mirroring ' +
      'the source’s ACTIVE assignments/grants as NEW append-only rows for the new user (actor = the ' +
      'cloning admin); a soft-deleted asset / a not-active id is skipped and reported. ' +
      '`fireWorkflowsOnClonedGrants` (default FALSE) is the engine toggle: false = grants recorded ' +
      'bookkeeping-only (the ACCESS_GRANTED workflow is SUPPRESSED); true = each cloned grant fires the ' +
      'standard after-commit workflow run (provisioning externally). The choice is audited in the ' +
      'clone’s CREATED UserHistory. Returns the per-item result `{ created, skipped: [{ id, reason }] }`.',
  })
  @ApiCreatedResponse({ type: CloneUserResultDto })
  clone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloneUserDto,
    @CurrentUser() actor?: User,
  ) {
    // The cloning admin is the actor on every cloned assignment/grant + the trigger cause of any run.
    return this.users.clone(id, dto, this.actor.resolve(actor));
  }

  @Patch(':id')
  @RequirePermission('user:manage')
  @ApiOperation({
    summary:
      'Update a user — ADMIN only. Can change first/last name, email and the RBAC role.',
    description:
      'Name/email/role edits are mirrored back to the IdP (Zitadel) inside a no-split-brain ' +
      'transaction: if the Zitadel write fails the local change is reverted and the request is 503 ' +
      '(issue #149). The email is the account-linking key and is written pre-verified, so it never ' +
      'forces re-verification. externalId can never be set here (SEC-006).',
  })
  @ApiOkResponse({ type: UserDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor?: User,
  ) {
    // Pass the actor so the service can enforce the RBAC self-role-change guard (no self-escalation/
    // demotion → 403) and the last-admin guard (refuse to demote the final ADMIN → 409). ADR-0040.
    return this.users.update(id, dto, this.actor.resolve(actor));
  }

  @Post(':id/reset-password')
  @RequirePermission('user:manage')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Trigger a password reset for a user — ADMIN only (issue #149)',
    description:
      'Asks the identity provider to send the user a password-reset link. lazyit NEVER stores, sets ' +
      'or sends a password (ADR-0016/0037): Zitadel emails the link via ZITADEL’s own SMTP (which the ' +
      'operator must have configured for delivery). 422 if the user is inactive; 501 ("managed by ' +
      'your identity provider") under BYOI / generic OIDC or for a user not linked to the IdP; 503 if ' +
      'the Zitadel Management call fails. Returns 204 No Content on success.',
  })
  @ApiNoContentResponse({
    description: 'Reset notification triggered (Zitadel will email the link).',
  })
  async resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor?: User,
  ): Promise<void> {
    try {
      await this.users.requestPasswordReset(id, this.actor.resolve(actor));
    } catch (err) {
      // BYOI (or a user with no IdP link) cannot trigger a reset: surface that HONESTLY as a 501 rather
      // than a misleading 2xx (INV-4). Every other error (404/422/503) propagates unchanged.
      if (err instanceof PasswordResetUnsupportedError) {
        throw new NotImplementedException(err.message);
      }
      throw err;
    }
  }

  @Delete(':id')
  @RequirePermission('user:manage')
  @ApiOperation({
    summary: 'Offboard (soft-delete) a user — ADMIN only',
    description:
      'Soft-deletes the user and, in one transaction, revokes all their active access grants and ' +
      'releases all their active asset assignments (with RELEASED history). Returns the offboarding ' +
      'summary (released assignments + revoked-grant count).',
  })
  @ApiOkResponse({
    schema: {
      example: {
        userId: '00000000-0000-0000-0000-000000000000',
        releasedAssignments: [{ id: 'clx…', assetId: 'cla…' }],
        revokedGrants: 2,
        revokedVaultMemberships: 1,
        rotationVaults: [{ vaultId: 'clv…', name: 'Prod DB', itemCount: 3 }],
      },
    },
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal?: Principal,
  ): ReturnType<UsersService['remove']> {
    // Resolve to the unified attribution so the offboarding's FK writes (revokedById / releasedById or
    // their *SaId counterparts) name the right actor — an SA holding user:manage attributes to itself.
    return this.users.remove(id, this.actor.resolveActor(principal));
  }

  @Post(':id/offboard')
  @RequirePermission('user:manage')
  @ApiOperation({
    summary:
      'Offboard a user (explicit alias of DELETE /users/:id) — ADMIN only',
    description:
      'Same effect as DELETE /users/:id: soft-delete + revoke grants + release assignments, all in ' +
      'one transaction. Provided as an intention-revealing verb for the offboarding flow.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        userId: '00000000-0000-0000-0000-000000000000',
        releasedAssignments: [{ id: 'clx…', assetId: 'cla…' }],
        revokedGrants: 2,
        revokedVaultMemberships: 1,
        rotationVaults: [{ vaultId: 'clv…', name: 'Prod DB', itemCount: 3 }],
      },
    },
  })
  offboard(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal?: Principal,
  ): ReturnType<UsersService['remove']> {
    return this.users.remove(id, this.actor.resolveActor(principal));
  }

  @Post(':id/restore')
  @RequirePermission('user:manage')
  @ApiOperation({
    summary: 'Restore (re-onboard) a soft-deleted user — ADMIN only (ADR-0041)',
    description:
      'Clears deletedAt so the account exists and can log in again. Does NOT re-grant the access or ' +
      're-assign the assets that offboarding revoked/released — those are separate, intentional acts.',
  })
  @ApiOkResponse({ type: UserDto })
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    // Resolve the principal so the RESTORED history row (DEBT-2, issue #185) names the right actor —
    // a human → performedById, an SA holding user:manage → serviceAccountId (CHECK-safe; ADR-0048).
    return this.users.restore(id, this.actor.resolveActor(principal));
  }

  // The manual "Crear cuenta OIDC" promotion (ADR-0069 §0 #3): take an existing DIRECTORY
  // person (no login) and provision its IdP account NOW — the explicit counterpart to the auto-claim by
  // verified-email login (ADR-0038). ADMIN-only (same `user:manage` gate as every other user mutation).
  @Post(':id/provision-account')
  @RequirePermission('user:manage')
  @ApiOperation({
    summary:
      'Provision an OIDC account for a directory person — ADMIN only (ADR-0069)',
    description:
      'Promotes a directory-only person (created by the bulk import, no login) into a real account: ' +
      'creates the user in the bundled identity provider (Zitadel), sets externalId and flips ' +
      'directoryOnly to false, all without a split-brain (IdP first, then the local update + audit in ' +
      'one transaction). 400 if the target is not a directory person, already has an account, or has no ' +
      'email (Zitadel requires one); 503 if the IdP create fails. Only the bundled-management IdP can ' +
      'provision here.',
  })
  @ApiCreatedResponse({ type: UserDto })
  provisionAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor?: User,
  ) {
    // Pass the actor so the service attributes the audited UPDATED history row + the IdP write-back line.
    return this.users.provisionAccount(id, this.actor.resolve(actor));
  }
}
