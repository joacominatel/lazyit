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
  @ApiOperation({ summary: 'Create an application category' })
  @ApiCreatedResponse({ type: ApplicationCategoryDto })
  create(@Body() dto: CreateApplicationCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an application category' })
  @ApiOkResponse({ type: ApplicationCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateApplicationCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Soft-delete an application category (detaches its applications)',
  })
  @ApiOkResponse({ type: ApplicationCategoryDto })
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }
}
