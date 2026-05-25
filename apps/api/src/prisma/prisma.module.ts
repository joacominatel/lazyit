import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global module: every feature module can inject PrismaService without
 * importing PrismaModule. See docs/03-decisions/0002-nestjs-backend.md.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
