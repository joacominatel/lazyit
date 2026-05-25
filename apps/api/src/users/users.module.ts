import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AssetAssignmentsModule } from '../asset-assignments/asset-assignments.module';

@Module({
  imports: [AssetAssignmentsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
