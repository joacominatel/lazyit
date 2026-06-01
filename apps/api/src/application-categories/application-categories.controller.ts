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
import {
  ApplicationCategorySchema,
  CreateApplicationCategorySchema,
  UpdateApplicationCategorySchema,
} from '@lazyit/shared';
import { ApplicationCategoriesService } from './application-categories.service';
import { Roles } from '../auth/roles.decorator';

class ApplicationCategoryDto extends createZodDto(ApplicationCategorySchema) {}
class CreateApplicationCategoryDto extends createZodDto(
  CreateApplicationCategorySchema,
) {}
class UpdateApplicationCategoryDto extends createZodDto(
  UpdateApplicationCategorySchema,
) {}

@ApiTags('application-categories')
@Controller('application-categories')
export class ApplicationCategoriesController {
  constructor(private readonly categories: ApplicationCategoriesService) {}

  @Get()
  @ApiOperation({
    summary: 'List all application categories (excludes soft-deleted)',
  })
  @ApiOkResponse({ type: [ApplicationCategoryDto] })
  findAll() {
    return this.categories.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an application category by id' })
  @ApiOkResponse({ type: ApplicationCategoryDto })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Post()
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Create an application category (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: ApplicationCategoryDto })
  create(@Body() dto: CreateApplicationCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Update an application category (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: ApplicationCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateApplicationCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Soft-delete an application category (detaches its applications) — ADMIN only',
  })
  @ApiOkResponse({ type: ApplicationCategoryDto })
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }
}
