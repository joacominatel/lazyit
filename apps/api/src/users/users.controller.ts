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
import { UsersService } from './users.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { parseActiveOnly } from '../asset-assignments/active-only';
import { AssetAssignmentDto } from '../asset-assignments/asset-assignment.dto';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import {
  parseActiveOnly as parseGrantActiveOnly,
  parseIncludeExpired,
} from '../access-grants/query-params';
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
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all users (excludes soft-deleted)' })
  @ApiOkResponse({ type: [UserDto] })
  findAll() {
    return this.users.findAll();
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
      activeOnly: parseActiveOnly(activeOnly),
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
      activeOnly: parseGrantActiveOnly(activeOnly),
      includeExpired: parseIncludeExpired(includeExpired),
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a user' })
  @ApiCreatedResponse({ type: UserDto })
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user' })
  @ApiOkResponse({ type: UserDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a user' })
  @ApiOkResponse({ type: UserDto })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.remove(id);
  }
}
