import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { KeypairController } from './keypair.controller';
import { SecretFetchController } from './secret-fetch.controller';
import { SecretManagerService } from './secret-manager.service';
import { ServiceAccountKeypairController } from './service-account-keypair.controller';
import { VaultsController } from './vaults.controller';

/**
 * Secret Manager module (ADR-0061, #366 slice 2b) — the ciphertext-custodian backend for the
 * zero-knowledge human Secret Manager. The server stores/serves wrapped blobs + ciphertext and enforces
 * the TWO authorization layers (RBAC `secret:read`/`secret:manage` + per-vault crypto membership); it can
 * NEVER decrypt a value (INV-10). NO crypto here — no cipher, no KDF, no env key.
 *
 * The HUMAN-ONLY guard (a service account never enters) is applied at each human controller; auth +
 * permission enforcement is the global JwtAuthGuard + RolesGuard. PrismaService is global.
 *
 * Programmatic secret retrieval (ADR-0080) adds two surfaces: the human-only `ServiceAccountKeypairController`
 * (an ADMIN bootstraps an SA's crypto identity) and the SERVICE-ONLY `SecretFetchController` (the headless
 * ciphertext read). The fetch surface is the ONLY secret route a service account may reach; it returns
 * ciphertext + wrapped keys only — still NO crypto here (INV-10).
 */
@Module({
  controllers: [
    KeypairController,
    VaultsController,
    ItemsController,
    ServiceAccountKeypairController,
    SecretFetchController,
  ],
  providers: [SecretManagerService],
  // Exported so other modules (e.g. InfraModule, ADR-0073) can reuse the METADATA-ONLY soft-ref
  // resolution + attach-authz helpers. Only the service is shared — never crypto, never values.
  exports: [SecretManagerService],
})
export class SecretManagerModule {}
