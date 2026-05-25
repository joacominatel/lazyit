import { Module } from '@nestjs/common';
import { ApplicationCategoriesController } from './application-categories.controller';
import { ApplicationCategoriesService } from './application-categories.service';

@Module({
  controllers: [ApplicationCategoriesController],
  providers: [ApplicationCategoriesService],
  exports: [ApplicationCategoriesService],
})
export class ApplicationCategoriesModule {}
