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
import { CreateUserSchema, UpdateUserSchema, UserSchema } from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { ActorService } from '../common/actor.service';
import { UsersService } from './users.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { AssetAssignmentDto } from '../asset-assignments/asset-assignment.dto';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { AccessGrantDto } from '../access-grants/access-grant.dto';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe), TS types and the
// OpenAPI schema, all from one definition. See docs/03-decisions/0018-api-documentation-swagger.md.
class UserDto extends createZodDto(UserSchema) {}
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
  @ApiOperation({ summary: 'List all users (excludes soft-deleted)' })
  @ApiOkResponse({ type: [UserDto] })
  findAll() {
    return this.users.findAll();
  }

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

  @Get(':id')
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiOkResponse({ type: UserDto })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.findOne(id);
  }

  @Get(':id/assignments')
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

  @Get(':id/access-grants')
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
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Create a user — ADMIN only (can set the RBAC role)',
  })
  @ApiCreatedResponse({ type: UserDto })
  create(@Body() dto: CreateUserDto, @CurrentUser() actor?: User) {
    // Pass the actor so the service can attribute the IdP write-back audit line (ADR-0043 §3).
    return this.users.create(dto, this.actor.resolve(actor));
  }

  @Patch(':id')
  @Roles('ADMIN')
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
  @Roles('ADMIN')
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
  @Roles('ADMIN')
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
  @Roles('ADMIN')
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
