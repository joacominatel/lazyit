import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  CreateUserSchema,
  UpdateUserSchema,
  UserListPageSchema,
  UserSchema,
} from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorService } from '../common/actor.service';
import { UsersService, USER_SORT_ALLOWLIST } from './users.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parsePageQuery } from '../common/parse-page-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { AssetAssignmentDto } from '../asset-assignments/asset-assignment.dto';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { AccessGrantDto } from '../access-grants/access-grant.dto';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe), TS types and the
// OpenAPI schema, all from one definition. See docs/03-decisions/0018-api-documentation-swagger.md.
class UserDto extends createZodDto(UserSchema) {}
class UserListPageDto extends createZodDto(UserListPageSchema) {}
class CreateUserDto extends createZodDto(CreateUserSchema) {}
class UpdateUserDto extends createZodDto(UpdateUserSchema) {}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly assignments: AssetAssignmentsService,
    private readonly grants: AccessGrantsService,
    private readonly actor: ActorService,
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
  @ApiOkResponse({ type: UserListPageDto })
  findAll(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
    @Query('deleted') deleted?: string,
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
    return this.users.findPage({ q }, pageQuery);
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
  me(@CurrentUser() user?: User): User {
    // The route is non-@Public, so the JwtAuthGuard guarantees a user in OIDC mode. In shim mode an
    // anonymous caller would have no user — surface that as 401 rather than a confusing empty body.
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }
    return user;
  }

  // A cross-user DIRECTORY read (identity of another user) — gated on `user:read` (ADR-0046
  // pre-tightened: VIEWER 403). `/users/me` above stays open for the self-read.
  @Get(':id')
  @RequirePermission('user:read')
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiOkResponse({ type: UserDto })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.findOne(id);
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

  @Patch(':id')
  @RequirePermission('user:manage')
  @ApiOperation({
    summary: 'Update a user — ADMIN only (can change the RBAC role)',
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
      },
    },
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor?: User,
  ): ReturnType<UsersService['remove']> {
    return this.users.remove(id, this.actor.resolve(actor));
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
      },
    },
  })
  offboard(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor?: User,
  ): ReturnType<UsersService['remove']> {
    return this.users.remove(id, this.actor.resolve(actor));
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
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.restore(id);
  }
}
