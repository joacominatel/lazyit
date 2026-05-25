import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CreateUserSchema, UpdateUserSchema, UserSchema } from '@lazyit/shared';
import { UsersService } from './users.service';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe), TS types and the
// OpenAPI schema, all from one definition. See docs/03-decisions/0018-api-documentation-swagger.md.
class UserDto extends createZodDto(UserSchema) {}
class CreateUserDto extends createZodDto(CreateUserSchema) {}
class UpdateUserDto extends createZodDto(UpdateUserSchema) {}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List all users (excludes soft-deleted)' })
  @ApiOkResponse({ type: [UserDto] })
  findAll() {
    return this.users.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiOkResponse({ type: UserDto })
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
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
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a user' })
  @ApiOkResponse({ type: UserDto })
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }
}
