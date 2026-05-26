import { Module } from '@nestjs/common';
import { ConsumableCategoriesController } from './consumable-categories.controller';
import { ConsumableCategoriesService } from './consumable-categories.service';

@Module({
  controllers: [ConsumableCategoriesController],
  providers: [ConsumableCategoriesService],
  exports: [ConsumableCategoriesService],
})
export class ConsumableCategoriesModule {}
