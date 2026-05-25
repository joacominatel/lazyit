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
  CreateLocationSchema,
  UpdateLocationSchema,
  type CreateLocation,
  type UpdateLocation,
} from '@lazyit/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LocationsService } from './locations.service';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  findAll() {
    return this.locations.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.locations.findOne(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(CreateLocationSchema)) dto: CreateLocation) {
    return this.locations.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateLocationSchema)) dto: UpdateLocation,
  ) {
    return this.locations.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.locations.remove(id);
  }
}
