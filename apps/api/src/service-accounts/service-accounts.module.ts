import { Module } from '@nestjs/common';
import { ServiceAccountsController } from './service-accounts.controller';
import { ServiceAccountsService } from './service-accounts.service';

/**
 * Service Accounts management module (ADR-0048). Hosts the ADMIN-gated `/service-accounts` CRUD + token
 * lifecycle. The AUTHENTICATION side (the JwtAuthGuard SA branch) lives in the auth module and needs no
 * provider from here — it imports the pure token/permission helpers directly. PrismaService is global.
 */
@Module({
  controllers: [ServiceAccountsController],
  providers: [ServiceAccountsService],
  exports: [ServiceAccountsService],
})
export class ServiceAccountsModule {}
