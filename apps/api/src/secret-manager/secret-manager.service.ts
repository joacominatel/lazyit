import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ChangeKeypairPassword,
  CreateSecretItem,
  CreateSecretVaultWithMembership,
  CreateServiceAccountKeypair,
  CreateServiceAccountVaultMembership,
  CreateUserKeypair,
  CreateVaultMembership,
  ExportSecretsAudit,
  HandleSuggestion,
  ResetUserKeypair,
  ResolvedHandle,
  SecretItem as SecretItemWire,
  SecretVault as SecretVaultWire,
  SecretVaultDetail,
  ServiceAccountKeypair as ServiceAccountKeypairWire,
  ServiceAccountPublicKey,
  ServiceAccountVaultFetch,
  ServiceAccountVaultMembership as ServiceAccountVaultMembershipWire,
  UpdateSecretItem,
  UpdateSecretVault,
  UserKeypair as UserKeypairWire,
  UserPublicKey,
  VaultMemberMeta,
  VaultMembership as VaultMembershipWire,
  VaultServiceAccountMemberMeta,
} from '@lazyit/shared';
import type {
  Prisma as PrismaTypes,
  SecretItem,
  SecretVault,
  ServiceAccount,
  ServiceAccountKeypair,
  ServiceAccountVaultMembership,
  UserKeypair,
  VaultMembership,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  type Principal,
  isHumanPrincipal,
  isServicePrincipal,
} from '../auth/principal';

/**
 * Secret Manager backend — the CIPHERTEXT CUSTODIAN (ADR-0061, crypto design note §6). The server stores
 * and serves wrapped blobs + ciphertext and enforces AUTHORIZATION; it is STRUCTURALLY INCAPABLE of
 * decrypting any value (INV-10). There is NO reveal()/decrypt()/unwrap(), NO `SECRET_MANAGER_KEY`, NO
 * cipher anywhere here — all crypto runs client-side.
 *
 * TWO ORTHOGONAL AUTHORIZATION LAYERS (ADR-0061 §7), enforced as:
 *   1. RBAC capability — `@RequirePermission('secret:read' | 'secret:manage')` on the controllers (the
 *      global RolesGuard); gates ENTERING the Secret Manager at all. (Human-only: the controllers also
 *      carry {@link HumanOnlyGuard}, so a service principal never reaches this service.)
 *   2. Crypto membership — a LIVE {@link VaultMembership} row for (vault, caller); gates which vault's
 *      blobs the caller may fetch/mutate. Re-checked SERVER-SIDE on every item/membership-scoped call
 *      ({@link assertLiveMembership}). The two layers are independent and may disagree (§7): holding
 *      `secret:read`/`secret:manage` grants NO plaintext and NO vault blobs without a membership.
 *
 * ADMIN carve-out (INV-8 vs INV-10): an ADMIN sees vault/member METADATA (list/detail/member list) even
 * without membership, but NEVER item envelopes, NEVER a wrapped DEK row, and there is no plaintext
 * endpoint at all. The ADMIN exception is over authorization/visibility, never cryptographic plaintext.
 *
 * NO-GRANT-WHAT-YOU-CANT-READ fence (§4): a GRANT requires the granter to ALREADY be a live member of the
 * vault (the authorization twin of the client-side crypto rule — the server cannot verify the wrap is
 * correct, but it CAN refuse a grant from a non-member). Enforced in {@link grantMembership}.
 *
 * AUDIT (§10): every mutation appends exactly one METADATA-ONLY {@link SecretAuditLog} row inside the
 * same transaction — never a value, key, or blob.
 */
@Injectable()
export class SecretManagerService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Keypair ──────────────────────────────────────────────────────────────────

  /**
   * The caller's own keypair (public key + both wrapped private-key copies). Self-only: the userId is the
   * authenticated caller, never a parameter. 404 if the caller has not bootstrapped a keypair yet.
   */
  async getMyKeypair(
    principal: Principal | undefined,
  ): Promise<UserKeypairWire> {
    const userId = this.requireHumanId(principal);
    const row = await this.prisma.userKeypair.findFirst({ where: { userId } });
    if (!row) {
      throw new NotFoundException('No keypair found for the current user');
    }
    return this.keypairToWire(row);
  }

  /**
   * Bootstrap the caller's keypair (1:1). 409 if one already exists (use PUT to reset). All material is
   * client-generated; the server stores public + wrapped blobs only — never the private key, passphrase,
   * or recovery key (INV-10). Audited KEYPAIR_CREATED.
   */
  async createMyKeypair(
    principal: Principal | undefined,
    dto: CreateUserKeypair,
  ): Promise<UserKeypairWire> {
    const userId = this.requireHumanId(principal);
    // findFirst respects the soft-delete read filter; a soft-deleted keypair is treated as absent (a
    // reset replaces in place, never mints a second — see resetMyKeypair). The @unique(userId) is the
    // race-safe backstop (P2002 → 409 via the global filter).
    const existing = await this.prisma.userKeypair.findFirst({
      where: { userId },
    });
    if (existing) {
      throw new ConflictException('A keypair already exists for this user');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.userKeypair.create({
        data: { userId, ...this.keypairData(dto) },
      });
      await this.writeAudit(tx, {
        action: 'KEYPAIR_CREATED',
        actorId: userId,
        targetUserId: userId,
      });
      return row;
    });
    return this.keypairToWire(created);
  }

  /**
   * Reset / replace the caller's keypair in place (peer-reset / passphrase change). Self-only. Upserts on
   * the 1:1 userId so a brand-new caller can also use PUT idempotently. Audited KEYPAIR_RESET. The old
   * wrapped blobs are overwritten; surviving vault members must re-wrap each DEK to the new public key
   * separately (a VaultMembership re-wrap, ADR-0061 §6) — out of this call's scope.
   */
  async resetMyKeypair(
    principal: Principal | undefined,
    dto: ResetUserKeypair,
  ): Promise<UserKeypairWire> {
    const userId = this.requireHumanId(principal);
    const data = this.keypairData(dto);
    const updated = await this.prisma.$transaction(async (tx) => {
      // upsert respects the 1:1 @unique(userId). Note: Prisma's upsert uses findUnique semantics, which
      // the soft-delete extension does NOT filter — so a previously soft-deleted keypair row is reused
      // (deletedAt cleared on update), which is the intended "replace in place".
      const row = await tx.userKeypair.upsert({
        where: { userId },
        create: { userId, ...data },
        update: { ...data, deletedAt: null },
      });
      await this.writeAudit(tx, {
        action: 'KEYPAIR_RESET',
        actorId: userId,
        targetUserId: userId,
      });
      return row;
    });
    return this.keypairToWire(updated);
  }

  /**
   * Change / reset ONLY the password wrap (Copy A) of the caller's EXISTING keypair (ADR-0066). Self-only,
   * human-only. The ASYMMETRIC model: the password is the daily ENTRY credential (mutable), the recovery
   * key is the ROOT that only RESETS the password. ONE method serves both:
   *   - CHANGE — the client unlocked the private key with the CURRENT password IN THE BROWSER, re-wrapped
   *     it under `Argon2id(new password)`.
   *   - RESET — the client unlocked the private key with the RECOVERY KEY IN THE BROWSER, re-wrapped it
   *     under `Argon2id(new password)`.
   * The server cannot tell (and need not know) which credential the client used — it only ever receives
   * the new Copy A blob. This is NOT bootstrap and NOT a keypair reset — it requires a LIVE keypair (404 if
   * none) and overwrites EXACTLY `privateKeyEncByPassphrase`/`passphraseSalt`/`passphraseIv`/`kdfParams`
   * (+ the @updatedAt bump). It NEVER touches `publicKey`, `privateKeyEncByRecovery`, `recoverySalt`, or
   * `recoveryIv` — Copy B keeps working — so there is no DEK re-wrap and no membership churn (ADR-0066 §2).
   * The server stores ciphertext only and never sees the private key, either password, or the recovery key
   * (INV-10). Audited PASSWORD_CHANGED (metadata only).
   */
  async changePassword(
    principal: Principal | undefined,
    dto: ChangeKeypairPassword,
  ): Promise<UserKeypairWire> {
    const userId = this.requireHumanId(principal);
    // Must already have a LIVE keypair — this re-wraps an existing password copy, it does NOT bootstrap.
    // findFirst respects the soft-delete read filter, so a soft-deleted keypair reads as absent (→ 404).
    const existing = await this.prisma.userKeypair.findFirst({
      where: { userId },
    });
    if (!existing) {
      throw new NotFoundException('No keypair found for the current user');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.userKeypair.update({
        where: { id: existing.id },
        // ONLY the password wrap (Copy A). publicKey / privateKeyEncByRecovery / recoverySalt / recoveryIv
        // are deliberately omitted — they MUST stay untouched (ADR-0066 §2). `updatedAt` bumps via
        // @updatedAt automatically.
        data: {
          privateKeyEncByPassphrase: dto.privateKeyEncByPassphrase,
          passphraseSalt: dto.passphraseSalt,
          passphraseIv: dto.passphraseIv,
          kdfParams: dto.kdfParams,
        },
      });
      await this.writeAudit(tx, {
        action: 'PASSWORD_CHANGED',
        actorId: userId,
        targetUserId: userId,
      });
      return row;
    });
    return this.keypairToWire(updated);
  }

  /**
   * A user's PUBLIC key — the material needed to wrap a DEK to them when granting (ADR-0061 §4). Public
   * by design (left of the §9 line). 404 if that user has no keypair yet (they must bootstrap one before
   * they can be granted). Returns ONLY the public key + identity, never any wrapped private-key blob.
   */
  async getUserPublicKey(targetUserId: string): Promise<UserPublicKey> {
    const row = await this.prisma.userKeypair.findFirst({
      where: { userId: targetUserId },
      select: { userId: true, publicKey: true },
    });
    if (!row) {
      throw new NotFoundException('No keypair found for that user');
    }
    return { userId: row.userId, publicKey: row.publicKey };
  }

  // ── Vaults ───────────────────────────────────────────────────────────────────

  /**
   * List vaults (metadata only). ADMIN sees ALL live vaults (INV-8 visibility); everyone else sees ONLY
   * the vaults they are a LIVE crypto member of. Membership ≠ plaintext: this is the metadata list, never
   * a value.
   */
  async listVaults(
    principal: Principal | undefined,
  ): Promise<SecretVaultWire[]> {
    const userId = this.requireHumanId(principal);
    if (this.isAdmin(principal)) {
      const rows = await this.prisma.secretVault.findMany({
        orderBy: { name: 'asc' },
      });
      return rows.map((r) => this.vaultToWire(r));
    }
    // Member-scoped: vaults with a membership for this caller. memberships have no soft-delete, so any
    // row is a live membership; the vault itself must be live (the join filters soft-deleted vaults out
    // via the relation's read filter is NOT automatic on nested reads, so filter explicitly).
    const rows = await this.prisma.secretVault.findMany({
      where: { memberships: { some: { userId } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.vaultToWire(r));
  }

  /**
   * Vault detail (name + member list, metadata). ADMIN or a live member. 404 if the vault is missing or
   * soft-deleted (never leak existence to a non-member, but ADMIN sees all so a real 404 only means gone).
   */
  async getVault(
    principal: Principal | undefined,
    vaultId: string,
  ): Promise<SecretVaultDetail> {
    const userId = this.requireHumanId(principal);
    const vault = await this.getLiveVaultOr404(vaultId);
    await this.assertVaultMetadataVisible(principal, userId, vaultId);
    const members = await this.loadMembers(vaultId);
    return { ...this.vaultToWire(vault), members };
  }

  /**
   * Create a vault + the creator's first wrapped-DEK membership in ONE transaction (ADR-0061 §3/§4). The
   * DEK is client-generated and never transits the server; the creator posts their own wrapped-DEK blob
   * alongside the name. 409 on a live name collision. Audited VAULT_CREATED + MEMBERSHIP_GRANTED.
   */
  async createVault(
    principal: Principal | undefined,
    dto: CreateSecretVaultWithMembership,
  ): Promise<SecretVaultWire> {
    const userId = this.requireHumanId(principal);
    // Pre-check the live-name collision for a clean 409 message; the partial-unique index is the
    // race-safe backstop (P2002 → 409 via the global PrismaExceptionFilter).
    const clash = await this.prisma.secretVault.findFirst({
      where: { name: dto.name },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException('A vault with this name already exists');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const vault = await tx.secretVault.create({ data: { name: dto.name } });
      await tx.vaultMembership.create({
        data: {
          vaultId: vault.id,
          userId,
          ephemeralPublicKey: dto.membership.ephemeralPublicKey,
          wrapNonce: dto.membership.wrapNonce,
          wrappedDek: dto.membership.wrappedDek,
          wrapVersion: dto.membership.wrapVersion,
        },
      });
      await this.writeAudit(tx, {
        action: 'VAULT_CREATED',
        actorId: userId,
        vaultId: vault.id,
      });
      await this.writeAudit(tx, {
        action: 'MEMBERSHIP_GRANTED',
        actorId: userId,
        vaultId: vault.id,
        targetUserId: userId,
      });
      return vault;
    });
    return this.vaultToWire(created);
  }

  /**
   * Rename a vault. Requires `secret:manage` (the controller). 409 on a live name collision. Audited via
   * VAULT_CREATED is wrong — a rename is a metadata edit; we do NOT add a new audit action for it in v1
   * (the catalog has no VAULT_UPDATED), so a rename is intentionally not audited beyond the row's
   * updatedAt. (Reported as out-of-scope: a VAULT_RENAMED audit action would need a schema enum bump.)
   */
  async renameVault(
    principal: Principal | undefined,
    vaultId: string,
    dto: UpdateSecretVault,
  ): Promise<SecretVaultWire> {
    this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    const clash = await this.prisma.secretVault.findFirst({
      where: { name: dto.name, id: { not: vaultId } },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException('A vault with this name already exists');
    }
    const updated = await this.prisma.secretVault.update({
      where: { id: vaultId },
      data: { name: dto.name },
    });
    return this.vaultToWire(updated);
  }

  /**
   * Soft-delete a vault + soft-delete its live items + HARD-DROP its memberships, in ONE transaction
   * (ADR-0061 §2/§5). Soft delete frees the vault name and item handles for reuse (live-only partial
   * unique). Memberships hard-drop (no soft-delete column). Audited VAULT_DELETED. Requires
   * `secret:manage`.
   */
  async deleteVault(
    principal: Principal | undefined,
    vaultId: string,
  ): Promise<SecretVaultWire> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    const now = new Date();
    const deleted = await this.prisma.$transaction(async (tx) => {
      // Soft-delete the live items (the extension's update is NOT auto-filtered, so scope to live rows).
      await tx.secretItem.updateMany({
        where: { vaultId, deletedAt: null },
        data: { deletedAt: now },
      });
      // Hard-drop the wrapped-DEK copies (a membership is a current-state join, no soft delete).
      await tx.vaultMembership.deleteMany({ where: { vaultId } });
      const vault = await tx.secretVault.update({
        where: { id: vaultId },
        data: { deletedAt: now },
      });
      await this.writeAudit(tx, {
        action: 'VAULT_DELETED',
        actorId: userId,
        vaultId,
      });
      return vault;
    });
    return this.vaultToWire(deleted);
  }

  // ── Items ────────────────────────────────────────────────────────────────────

  /** List a vault's live items (metadata + envelope blobs). Requires LIVE membership (else 403/404). */
  async listItems(
    principal: Principal | undefined,
    vaultId: string,
  ): Promise<SecretItemWire[]> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    await this.assertLiveMembership(userId, vaultId);
    const rows = await this.prisma.secretItem.findMany({
      where: { vaultId },
      orderBy: { label: 'asc' },
    });
    return rows.map((r) => this.itemToWire(r));
  }

  /**
   * Add an item (client-encrypted envelope) to a vault. Requires LIVE membership. 409 on a live handle
   * collision (global). Audited ITEM_CREATED. The server stores ciphertext only — never the value.
   */
  async createItem(
    principal: Principal | undefined,
    vaultId: string,
    dto: CreateSecretItem,
  ): Promise<SecretItemWire> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    await this.assertLiveMembership(userId, vaultId);
    const clash = await this.prisma.secretItem.findFirst({
      where: { handle: dto.handle },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException('A secret with this handle already exists');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      // Close the deleteVault↔createItem TOCTOU (#425): the liveness + membership pre-checks above ran
      // OUTSIDE this transaction, so a concurrent deleteVault could soft-delete the vault and hard-drop
      // our membership between them and this insert (Read Committed), orphaning a live item under a dead
      // vault (its handle would stay occupied in the live-only partial-unique index). Re-read liveness +
      // re-assert membership INSIDE the tx, before the create — if the vault is no longer live, abort
      // with the same not-found error and nothing is written.
      await this.assertLiveVaultMembershipTx(tx, userId, vaultId);
      const item = await tx.secretItem.create({
        data: {
          vaultId,
          handle: dto.handle,
          label: dto.label,
          ciphertext: dto.ciphertext,
          iv: dto.iv,
          authTag: dto.authTag,
          keyVersion: dto.keyVersion,
          // Server-visible METADATA only (ADR-0075); GENERIC when omitted (back-compat default).
          kind: dto.kind ?? 'GENERIC',
        },
      });
      await this.writeAudit(tx, {
        action: 'ITEM_CREATED',
        actorId: userId,
        vaultId,
        itemId: item.id,
      });
      return item;
    });
    return this.itemToWire(created);
  }

  /**
   * Update an item: a metadata edit (label/handle) and/or a re-encrypted envelope. Requires LIVE
   * membership. The envelope is ALL-OR-NONE: if any of ciphertext/iv/authTag/keyVersion is present, all
   * four must be (a partial envelope is a 400). 409 on a handle collision. Audited ITEM_UPDATED.
   */
  async updateItem(
    principal: Principal | undefined,
    vaultId: string,
    itemId: string,
    dto: UpdateSecretItem,
  ): Promise<SecretItemWire> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    await this.assertLiveMembership(userId, vaultId);
    const item = await this.getLiveItemOr404(vaultId, itemId);

    const envelopeFields = [
      dto.ciphertext,
      dto.iv,
      dto.authTag,
      dto.keyVersion,
    ];
    const envelopePresent = envelopeFields.filter(
      (f) => f !== undefined,
    ).length;
    if (envelopePresent !== 0 && envelopePresent !== 4) {
      throw new BadRequestException(
        'The envelope (ciphertext, iv, authTag, keyVersion) must be sent all-or-none',
      );
    }
    const data: PrismaTypes.SecretItemUpdateInput = {};
    if (dto.handle !== undefined) data.handle = dto.handle;
    if (dto.label !== undefined) data.label = dto.label;
    // Re-typing is a metadata-only edit (ADR-0075) — never touches the envelope.
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (envelopePresent === 4) {
      data.ciphertext = dto.ciphertext;
      data.iv = dto.iv;
      data.authTag = dto.authTag;
      data.keyVersion = dto.keyVersion;
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nothing to update');
    }
    if (dto.handle !== undefined && dto.handle !== item.handle) {
      const clash = await this.prisma.secretItem.findFirst({
        where: { handle: dto.handle, id: { not: itemId } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException('A secret with this handle already exists');
      }
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      // Close the deleteVault↔updateItem TOCTOU (#425): re-read liveness + re-assert membership INSIDE
      // the tx, before the update, so a concurrent deleteVault that committed after the pre-checks above
      // cannot resurrect a soft-deleted item under a dead vault. Same not-found error if the vault is gone.
      await this.assertLiveVaultMembershipTx(tx, userId, vaultId);
      const row = await tx.secretItem.update({
        where: { id: itemId },
        data,
      });
      await this.writeAudit(tx, {
        action: 'ITEM_UPDATED',
        actorId: userId,
        vaultId,
        itemId,
      });
      return row;
    });
    return this.itemToWire(updated);
  }

  /** Soft-delete an item (frees its handle). Requires LIVE membership. Audited ITEM_DELETED. */
  async deleteItem(
    principal: Principal | undefined,
    vaultId: string,
    itemId: string,
  ): Promise<SecretItemWire> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    await this.assertLiveMembership(userId, vaultId);
    await this.getLiveItemOr404(vaultId, itemId);
    const deleted = await this.prisma.$transaction(async (tx) => {
      const row = await tx.secretItem.update({
        where: { id: itemId },
        data: { deletedAt: new Date() },
      });
      await this.writeAudit(tx, {
        action: 'ITEM_DELETED',
        actorId: userId,
        vaultId,
        itemId,
      });
      return row;
    });
    return this.itemToWire(deleted);
  }

  /**
   * Record a vault secret EXPORT (#612). The export itself — DECRYPTING the values and building the
   * `.env`/JSON file — happens ENTIRELY CLIENT-SIDE after the member unlocks the vault; the server is
   * structurally incapable of producing a plaintext export (INV-10 / ADR-0061). This method takes NO
   * secret material (the `ExportSecretsAudit` body is a strictObject with at most an optional non-secret
   * `itemCount`) and only appends ONE metadata-only {@link SecretAuditLog} row (ITEMS_EXPORTED): WHO
   * exported WHICH vault, when. Requires LIVE membership — exporting decryptable values is a member-only
   * action (an ADMIN without a membership has nothing to decrypt, INV-10), mirroring the item reads. The
   * strict `ExportSecretsAudit` body is the GUARANTEE that no secret material is smuggled in: it permits
   * ONLY an optional non-secret `itemCount`, and any unknown key is rejected (400) at the DTO edge. The
   * SecretAuditLog row schema has no count column, so the count is not persisted — the row stays identical
   * to every other audit row (no blob, no value); the count is echoed back in the ack for the client.
   */
  async recordExport(
    principal: Principal | undefined,
    vaultId: string,
    audit?: ExportSecretsAudit,
  ): Promise<{ ok: true; itemCount: number | null }> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    await this.assertLiveMembership(userId, vaultId);
    await this.prisma.$transaction(async (tx) => {
      await this.writeAudit(tx, {
        action: 'ITEMS_EXPORTED',
        actorId: userId,
        vaultId,
      });
    });
    return { ok: true, itemCount: audit?.itemCount ?? null };
  }

  /**
   * Record a single-item REVEAL (#870). The decrypt itself happens ENTIRELY CLIENT-SIDE after the member
   * unlocks the vault (INV-10 / ADR-0061: the server never sees plaintext); this method takes NO secret
   * material (only the path-param `vaultId`/`itemId`) and appends ONE metadata-only {@link SecretAuditLog}
   * row (ITEM_REVEALED): WHO revealed WHICH item, in WHICH vault, when. NEVER a value, key, or blob.
   * Requires LIVE membership — only a member holds a decryptable value, mirroring the item reads / export
   * (an ADMIN without a membership has nothing to reveal, INV-10). Distinct from ITEMS_FETCHED, which is
   * the machine/whole-vault programmatic read (ADR-0080, no itemId). The web caller fires this
   * fire-and-forget: a failed audit write must never block a member from seeing their own secret.
   */
  async recordReveal(
    principal: Principal | undefined,
    vaultId: string,
    itemId: string,
  ): Promise<void> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    await this.assertLiveMembership(userId, vaultId);
    // IDOR / audit-trail integrity: itemId MUST be a live item OF this vault (else 404), mirroring the
    // updateItem/deleteItem sibling gate. Without this a member of vault V could beacon a bogus or FOREIGN
    // itemId (an item in another vault), salting the very audit trail #870 exists to make trustworthy.
    // On the fire-and-forget client path a 404 is harmless (the reveal itself already happened locally).
    await this.getLiveItemOr404(vaultId, itemId);
    await this.prisma.$transaction(async (tx) => {
      await this.writeAudit(tx, {
        action: 'ITEM_REVEALED',
        actorId: userId,
        vaultId,
        itemId,
      });
    });
  }

  // ── Members ──────────────────────────────────────────────────────────────────

  /** Member list of a vault (userId + display metadata). ADMIN or a live member. */
  async listMembers(
    principal: Principal | undefined,
    vaultId: string,
  ): Promise<VaultMemberMeta[]> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    await this.assertVaultMetadataVisible(principal, userId, vaultId);
    return this.loadMembers(vaultId);
  }

  /**
   * The vault's SERVICE-ACCOUNT members (ADR-0080) — the machine members a human members list omits.
   * Same visibility contract as {@link listMembers}: an ADMIN or a live human member (`secret:read` at the
   * controller). Returns non-secret display metadata only (id + name + tokenPrefix + isActive) — NEVER a
   * wrapped DEK or the token. Without this read the members UI could not show (or revoke) a granted SA.
   */
  async listServiceAccountMembers(
    principal: Principal | undefined,
    vaultId: string,
  ): Promise<VaultServiceAccountMemberMeta[]> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    await this.assertVaultMetadataVisible(principal, userId, vaultId);
    return this.loadServiceAccountMembers(vaultId);
  }

  /**
   * The caller's OWN wrapped-DEK row for this vault (the blob their browser unwraps). Requires LIVE
   * membership — 404 if the caller is not a member (the row genuinely does not exist for them; this is
   * NOT an ADMIN-visible metadata surface — it returns a wrapped DEK, right of the metadata line).
   */
  async getMyMembership(
    principal: Principal | undefined,
    vaultId: string,
  ): Promise<VaultMembershipWire> {
    const userId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    const row = await this.prisma.vaultMembership.findUnique({
      where: { vaultId_userId: { vaultId, userId } },
    });
    if (!row) {
      throw new NotFoundException('You are not a member of this vault');
    }
    return this.membershipToWire(row);
  }

  /**
   * GRANT a member: store the DEK already wrapped to the target's public key (client-produced). Requires
   * `secret:manage` (controller) AND — the NO-GRANT-WHAT-YOU-CANT-READ fence (ADR-0061 §4) — the GRANTER
   * must be a LIVE member of the vault (else 403). The server cannot verify the wrap is cryptographically
   * correct (zero-knowledge); it enforces the AUTHORIZATION fence and stores the blob. 409 if the target
   * is already a member. Audited MEMBERSHIP_GRANTED.
   */
  async grantMembership(
    principal: Principal | undefined,
    vaultId: string,
    dto: CreateVaultMembership,
  ): Promise<VaultMembershipWire> {
    const granterId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    // §4 fence: the granter must already be able to read the vault — server-side, that means being a live
    // member. An ADMIN who is NOT a member CANNOT grant (they hold no DEK to wrap; INV-8 does not extend
    // to crypto). This is the authorization twin of the client-side crypto rule.
    await this.assertLiveMembership(
      granterId,
      vaultId,
      'You must be a member of this vault to grant access',
    );
    const existing = await this.prisma.vaultMembership.findUnique({
      where: { vaultId_userId: { vaultId, userId: dto.userId } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'That user is already a member of this vault',
      );
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.vaultMembership.create({
        data: {
          vaultId,
          userId: dto.userId,
          ephemeralPublicKey: dto.ephemeralPublicKey,
          wrapNonce: dto.wrapNonce,
          wrappedDek: dto.wrappedDek,
          wrapVersion: dto.wrapVersion,
        },
      });
      await this.writeAudit(tx, {
        action: 'MEMBERSHIP_GRANTED',
        actorId: granterId,
        vaultId,
        targetUserId: dto.userId,
      });
      return row;
    });
    return this.membershipToWire(created);
  }

  /**
   * REVOKE a member: HARD-DROP the wrapped-DEK row (ADR-0061 §5 soft revoke = the row ceases to exist).
   * Requires `secret:manage` (controller). 404 if no such membership. Audited MEMBERSHIP_REVOKED. NOTE
   * (per ADR §7): dropping the row stops NEW server reads but does not crypto-revoke a cached DEK — hard
   * revoke (DEK rotation) is deferred Phase-2.
   */
  async revokeMembership(
    principal: Principal | undefined,
    vaultId: string,
    targetUserId: string,
  ): Promise<{ revoked: true }> {
    const actorId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    const existing = await this.prisma.vaultMembership.findUnique({
      where: { vaultId_userId: { vaultId, userId: targetUserId } },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('That user is not a member of this vault');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.vaultMembership.delete({
        where: { vaultId_userId: { vaultId, userId: targetUserId } },
      });
      await this.writeAudit(tx, {
        action: 'MEMBERSHIP_REVOKED',
        actorId,
        vaultId,
        targetUserId,
      });
    });
    return { revoked: true };
  }

  // ── Service accounts — programmatic secret retrieval (ADR-0080) ────────────────
  //
  // INV-10 is PRESERVED end-to-end here, exactly as for humans: this service NEVER decrypts. It stores +
  // serves the SA's PUBLIC key, its token-WRAPPED private key, the DEK WRAPPED to the SA, and item
  // CIPHERTEXT. The token-derived KEK is computed CLIENT-SIDE (the `lazyit-fetch` CLI); the server holds
  // only the SHA-256 token hash (for auth, in ServiceAccount.tokenHash) — never the token plaintext, never
  // a key that decrypts a value. The read endpoint returns ciphertext only; the CLI does every unwrap.

  /**
   * Create OR REPLACE a SERVICE ACCOUNT's keypair (`POST /secret-manager/service-accounts/:saId/keypair`),
   * ADR-0080 (auto-gen on create + regenerate on token rotation, issue #883). Performed by a HUMAN with
   * `secret:manage` (the controller) — the SA cannot act for itself. All material is CLIENT-GENERATED (the
   * browser wrapped the private key under the token-derived KEK); the server stores public + wrapped blobs
   * only, never the token, the private key, or the KEK (INV-10).
   *
   * Two call sites:
   *   - SA CREATE — the browser generates the keypair while the one-time creation token is in memory and
   *     uploads it for EVERY new SA (no row yet → create).
   *   - TOKEN ROTATION — the browser re-generates the keypair under the NEW token (the old wrap is dead the
   *     moment the token rotates) and re-uploads it; the 1:1 row (@unique serviceAccountId) is REPLACED in
   *     place. This is also the retrofit path for a pre-#883 keyless SA (no row → create its first keypair).
   *
   * A regenerated keypair carries a NEW public key, so every DEK previously wrapped to the OLD public key
   * (the SA's `ServiceAccountVaultMembership` rows) is now undecryptable. Those memberships are HARD-DROPPED
   * in the SAME transaction, so the SA cleanly loses its grants and must be re-granted (ADR-0080: rotation =
   * re-issue keypair + re-grant) — leaving them would only make the fetch-CLI decrypt fail confusingly. An
   * idempotent re-upload of the SAME public key keeps the memberships. 404 if the SA is missing/revoked.
   * Audited SA_KEYPAIR_CREATED (metadata only) whether the keypair was created or replaced.
   */
  async setServiceAccountKeypair(
    principal: Principal | undefined,
    serviceAccountId: string,
    dto: CreateServiceAccountKeypair,
  ): Promise<ServiceAccountKeypairWire> {
    const actorId = this.requireHumanId(principal);
    await this.getLiveServiceAccountOr404(serviceAccountId);
    const existing = await this.prisma.serviceAccountKeypair.findFirst({
      where: { serviceAccountId },
    });
    const row = await this.prisma.$transaction(async (tx) => {
      let saved: ServiceAccountKeypair;
      if (existing) {
        // A fresh keypair (changed public key) orphans every DEK wrapped to the old key — drop those
        // memberships so the SA cleanly loses its grants (re-grant required). A same-key re-submit keeps them.
        if (existing.publicKey !== dto.publicKey) {
          await tx.serviceAccountVaultMembership.deleteMany({
            where: { serviceAccountId },
          });
        }
        saved = await tx.serviceAccountKeypair.update({
          where: { serviceAccountId },
          data: this.saKeypairData(dto),
        });
      } else {
        saved = await tx.serviceAccountKeypair.create({
          data: { serviceAccountId, ...this.saKeypairData(dto) },
        });
      }
      await this.writeAudit(tx, {
        action: 'SA_KEYPAIR_CREATED',
        actorId,
        targetServiceAccountId: serviceAccountId,
      });
      return saved;
    });
    return this.saKeypairToWire(row);
  }

  /**
   * A service account's PUBLIC key (`GET /secret-manager/service-accounts/:saId/public-key`) — the material
   * a granter wraps the vault DEK to (ADR-0080). Public by design; returns ONLY the public key + identity,
   * never a wrapped private-key blob. 404 if the SA has no keypair yet (it must be bootstrapped first).
   */
  async getServiceAccountPublicKey(
    serviceAccountId: string,
  ): Promise<ServiceAccountPublicKey> {
    const row = await this.prisma.serviceAccountKeypair.findFirst({
      where: { serviceAccountId },
      select: { serviceAccountId: true, publicKey: true },
    });
    if (!row) {
      throw new NotFoundException('No keypair found for that service account');
    }
    return { serviceAccountId: row.serviceAccountId, publicKey: row.publicKey };
  }

  /**
   * GRANT a SERVICE ACCOUNT as a crypto member of a vault (`POST /secret-vaults/:vaultId/service-account-
   * members`). Requires `secret:manage` (controller) AND — the NO-GRANT-WHAT-YOU-CANT-READ fence
   * (ADR-0061 §4) — the HUMAN granter must be a LIVE member of the vault (else 403): they unwrapped the DEK
   * with their own key and re-wrapped it to the SA's public key CLIENT-SIDE, and the server enforces the
   * authorization fence + stores the wrapped blob (it cannot verify the wrap; zero-knowledge). The target SA
   * must exist (404) and not already be a member (409). Audited MEMBERSHIP_GRANTED (targetServiceAccountId).
   */
  async grantServiceAccountMembership(
    principal: Principal | undefined,
    vaultId: string,
    dto: CreateServiceAccountVaultMembership,
  ): Promise<ServiceAccountVaultMembershipWire> {
    const granterId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    // §4 fence: the human granter must already be able to read the vault (a live member). An ADMIN who is
    // NOT a member cannot grant (they hold no DEK to wrap; INV-8 does not extend to crypto).
    await this.assertLiveMembership(
      granterId,
      vaultId,
      'You must be a member of this vault to grant access',
    );
    await this.getLiveServiceAccountOr404(dto.serviceAccountId);
    const existing = await this.prisma.serviceAccountVaultMembership.findUnique(
      {
        where: {
          vaultId_serviceAccountId: {
            vaultId,
            serviceAccountId: dto.serviceAccountId,
          },
        },
        select: { id: true },
      },
    );
    if (existing) {
      throw new ConflictException(
        'That service account is already a member of this vault',
      );
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.serviceAccountVaultMembership.create({
        data: {
          vaultId,
          serviceAccountId: dto.serviceAccountId,
          ephemeralPublicKey: dto.ephemeralPublicKey,
          wrapNonce: dto.wrapNonce,
          wrappedDek: dto.wrappedDek,
          wrapVersion: dto.wrapVersion,
        },
      });
      await this.writeAudit(tx, {
        action: 'MEMBERSHIP_GRANTED',
        actorId: granterId,
        vaultId,
        targetServiceAccountId: dto.serviceAccountId,
      });
      return row;
    });
    return this.saMembershipToWire(created);
  }

  /**
   * REVOKE a service account's membership (`DELETE /secret-vaults/:vaultId/service-account-members/:saId`).
   * Requires `secret:manage` (controller). HARD-DROP of the wrapped-DEK row (ADR-0061 §5 soft revoke = the
   * row ceases to exist), so the SA can no longer fetch the wrapped DEK. 404 if no such membership. Audited
   * MEMBERSHIP_REVOKED (targetServiceAccountId). NOTE: like the human case, this stops NEW server reads but
   * does not crypto-revoke a DEK the SA already cached — remediation for a compromise is rotating the token
   * + re-issuing the keypair (a documented follow-up).
   */
  async revokeServiceAccountMembership(
    principal: Principal | undefined,
    vaultId: string,
    serviceAccountId: string,
  ): Promise<{ revoked: true }> {
    const actorId = this.requireHumanId(principal);
    await this.getLiveVaultOr404(vaultId);
    const existing = await this.prisma.serviceAccountVaultMembership.findUnique(
      {
        where: { vaultId_serviceAccountId: { vaultId, serviceAccountId } },
        select: { id: true },
      },
    );
    if (!existing) {
      throw new NotFoundException(
        'That service account is not a member of this vault',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceAccountVaultMembership.delete({
        where: { vaultId_serviceAccountId: { vaultId, serviceAccountId } },
      });
      await this.writeAudit(tx, {
        action: 'MEMBERSHIP_REVOKED',
        actorId,
        vaultId,
        targetServiceAccountId: serviceAccountId,
      });
    });
    return { revoked: true };
  }

  /**
   * List the vaults a SERVICE ACCOUNT may fetch (`GET /secret-fetch`) — metadata only (id + name), so the
   * headless caller can discover which `vaultId` to pass. SERVICE principal only. NEVER a value, envelope,
   * or wrapped key. Member-scoped: only vaults the SA holds a wrapped-DEK row for.
   */
  async listFetchableVaults(
    principal: Principal | undefined,
  ): Promise<SecretVaultWire[]> {
    const serviceAccountId = this.requireServiceAccountId(principal);
    const rows = await this.prisma.secretVault.findMany({
      where: { serviceAccountMemberships: { some: { serviceAccountId } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.vaultToWire(r));
  }

  /**
   * The HEADLESS FETCH (`GET /secret-fetch/:vaultId`) — the SERVICE-account programmatic read (ADR-0080).
   * Returns EVERYTHING a stateless caller (the `lazyit-fetch` CLI, holding ONLY the SA token) needs to
   * decrypt the vault CLIENT-SIDE, in one round-trip: the SA's token-wrapped private key, the vault DEK
   * wrapped to the SA, and every live item's ciphertext envelope. ALL of it is CIPHERTEXT or public
   * material — the server produces NO plaintext (INV-10): it never derives the token-derived KEK, never
   * unwraps the private key or the DEK, never decrypts a value.
   *
   * Authz (two orthogonal layers, mirroring the human model): `secret:fetch` (the controller RBAC gate,
   * SERVICE-only) AND a LIVE {@link ServiceAccountVaultMembership} for (vault, SA) — else 403. The SA must
   * also have a keypair (it does if it was ever granted). EVERY call is AUDITED (ITEMS_FETCHED — which SA,
   * which vault, when) BEFORE the response is returned, so there is no unaudited programmatic read.
   */
  async fetchVaultForServiceAccount(
    principal: Principal | undefined,
    vaultId: string,
  ): Promise<ServiceAccountVaultFetch> {
    const serviceAccountId = this.requireServiceAccountId(principal);
    await this.getLiveVaultOr404(vaultId);
    const membership =
      await this.prisma.serviceAccountVaultMembership.findUnique({
        where: { vaultId_serviceAccountId: { vaultId, serviceAccountId } },
      });
    if (!membership) {
      throw new ForbiddenException(
        'This service account is not a member of this vault',
      );
    }
    const keypair = await this.prisma.serviceAccountKeypair.findFirst({
      where: { serviceAccountId },
    });
    if (!keypair) {
      // Defensive: a granted SA always has a keypair (the grant wraps to its public key). Guard anyway.
      throw new NotFoundException('This service account has no keypair');
    }
    const items = await this.prisma.secretItem.findMany({
      where: { vaultId },
      orderBy: { handle: 'asc' },
    });
    // GUARANTEE the audit trail: write it (awaited) BEFORE returning — a programmatic read is never
    // unaudited. If the audit insert fails, the whole request fails and no ciphertext is served.
    await this.prisma.$transaction(async (tx) => {
      await this.writeAudit(tx, {
        action: 'ITEMS_FETCHED',
        serviceAccountId,
        vaultId,
      });
    });
    return {
      vaultId,
      keypair: {
        privateKeyEnc: keypair.privateKeyEnc,
        privateKeySalt: keypair.privateKeySalt,
        privateKeyIv: keypair.privateKeyIv,
        kdfParams: keypair.kdfParams as ServiceAccountKeypairWire['kdfParams'],
      },
      membership: {
        ephemeralPublicKey: membership.ephemeralPublicKey,
        wrapNonce: membership.wrapNonce,
        wrappedDek: membership.wrappedDek,
        wrapVersion: membership.wrapVersion,
      },
      items: items.map((r) => ({
        handle: r.handle,
        label: r.label,
        kind: r.kind,
        ciphertext: r.ciphertext,
        iv: r.iv,
        authTag: r.authTag,
        keyVersion: r.keyVersion,
      })),
    };
  }

  // ── Chip resolution (slice-4 contract) ───────────────────────────────────────

  /**
   * Resolve a KB chip ({@code lazyit_secret.HANDLE}) to a live item's envelope + the caller's OWN
   * wrapped-DEK row for that item's vault (ADR-0061 §8). Requires LIVE membership of the item's vault
   * (else 403). 404 if no live item has that handle. Returns ciphertext + the caller's wrapped DEK so the
   * browser can run the §6 decrypt chain in place — never plaintext.
   */
  async resolveByHandle(
    principal: Principal | undefined,
    handle: string,
  ): Promise<ResolvedHandle> {
    const userId = this.requireHumanId(principal);
    const item = await this.prisma.secretItem.findFirst({ where: { handle } });
    if (!item) {
      throw new NotFoundException('No secret found for that handle');
    }
    // The vault must be live too (a soft-deleted vault's live items shouldn't be reachable; deleteVault
    // soft-deletes items, but guard against drift).
    const vault = await this.prisma.secretVault.findFirst({
      where: { id: item.vaultId },
      select: { id: true },
    });
    if (!vault) {
      throw new NotFoundException('No secret found for that handle');
    }
    const membership = await this.prisma.vaultMembership.findUnique({
      where: { vaultId_userId: { vaultId: item.vaultId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException(
        'You are not a member of the vault that holds this secret',
      );
    }
    return {
      item: this.itemToWire(item),
      membership: this.membershipToWire(membership),
    };
  }

  /**
   * Chip autocomplete: live item handles (metadata) from vaults the caller is a member of (ADR-0061 §8).
   * NEVER values. Member-scoped: only handles from the caller's vaults are offered. `q` filters by a
   * case-insensitive handle/label substring; capped to a small page.
   */
  async searchHandles(
    principal: Principal | undefined,
    q: string | undefined,
  ): Promise<HandleSuggestion[]> {
    const userId = this.requireHumanId(principal);
    const query = (q ?? '').trim();
    const rows = await this.prisma.secretItem.findMany({
      where: {
        vault: { memberships: { some: { userId } } },
        ...(query.length > 0
          ? {
              OR: [
                { handle: { contains: query, mode: 'insensitive' } },
                { label: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { handle: true, label: true, vaultId: true },
      orderBy: { handle: 'asc' },
      take: 20,
    });
    return rows.map((r) => ({
      handle: r.handle,
      label: r.label,
      vaultId: r.vaultId,
    }));
  }

  // ── Soft-ref resolution for non-secret surfaces (ADR-0073, #801) ────────────────

  /**
   * Resolve a batch of `(handle, vaultId)` soft refs to LIVE SecretItem METADATA — handle, label,
   * vaultId ONLY, NEVER a value, envelope, or wrapped key (INV-10). For surfaces that store soft
   * handle-refs (the Infra topology node→secret linkage, mirroring KB chips): a ref whose secret is
   * no longer live (soft-deleted, or its editable handle was renamed away) simply DOES NOT match and
   * is DROPPED — never a dangling chip. MEMBER-BLIND on purpose: handle + label are metadata shown to
   * any node viewer (the same posture as a KB chip), so this does NOT gate on the caller's vault
   * membership — the value side stays unreachable regardless. Returns stable-sorted (label, then
   * handle). The `findMany` honours the soft-delete read filter, so only live items match.
   */
  async resolveHandlesMetadata(
    refs: { handle: string; vaultId: string }[],
  ): Promise<{ handle: string; label: string; vaultId: string }[]> {
    if (refs.length === 0) return [];
    const rows = await this.prisma.secretItem.findMany({
      where: {
        OR: refs.map((r) => ({ vaultId: r.vaultId, handle: r.handle })),
      },
      // METADATA ONLY — never ciphertext/iv/authTag (INV-10). The custodian cannot decrypt anyway.
      select: { handle: true, label: true, vaultId: true },
    });
    return rows
      .map((r) => ({ handle: r.handle, label: r.label, vaultId: r.vaultId }))
      .sort(
        (a, b) =>
          a.label.localeCompare(b.label) || a.handle.localeCompare(b.handle),
      );
  }

  /**
   * Authorize ATTACHING a handle to a non-secret surface (ADR-0073, #801): the caller must hold a
   * LIVE membership of `vaultId` (else 403) AND a live SecretItem with that `handle` must exist IN
   * that vault (else 404). Membership is checked FIRST so a non-member can never probe whether a
   * handle exists in a vault they cannot see (no information leak). METADATA ONLY — confirms
   * existence by selecting `id`; it NEVER reads or returns an envelope (INV-10). Throws; returns void.
   */
  async assertHandleAttachable(
    principal: Principal | undefined,
    vaultId: string,
    handle: string,
  ): Promise<void> {
    const userId = this.requireHumanId(principal);
    await this.assertLiveMembership(
      userId,
      vaultId,
      'You are not a member of the vault that holds this secret',
    );
    const item = await this.prisma.secretItem.findFirst({
      where: { vaultId, handle },
      select: { id: true },
    });
    if (!item) {
      throw new NotFoundException(
        'No secret found for that handle in this vault',
      );
    }
  }

  // ── helpers: authz ────────────────────────────────────────────────────────────

  /** The authenticated human's User.id, or a 403 if anonymous/non-human (the controller guard also blocks SAs). */
  private requireHumanId(principal: Principal | undefined): string {
    if (!isHumanPrincipal(principal)) {
      throw new ForbiddenException('A human user is required');
    }
    return principal.user.id;
  }

  /**
   * The authenticated SERVICE ACCOUNT's id, or a 403 if anonymous/human (ADR-0080). The service-only gate
   * for the headless fetch surface — the inverse of {@link requireHumanId}. Even an ADMIN human (who holds
   * `secret:fetch` via the full catalog) is refused here: the fetch path is machine-only. The controller
   * also carries {@link ServiceOnlyGuard} as the edge fence; this is the belt-and-suspenders backstop.
   */
  private requireServiceAccountId(principal: Principal | undefined): string {
    if (!isServicePrincipal(principal)) {
      throw new ForbiddenException('A service account is required');
    }
    return principal.serviceAccount.id;
  }

  /** Is the principal an ADMIN human? (INV-8 visibility — metadata only, never plaintext.) */
  private isAdmin(principal: Principal | undefined): boolean {
    return isHumanPrincipal(principal) && principal.user.role === 'ADMIN';
  }

  /**
   * Assert the caller may see a vault's METADATA (detail / member list): ADMIN (any vault) OR a live
   * member. 403 otherwise — NOT a 404, because the vault's existence has already been confirmed live to
   * the caller's level (an ADMIN always passes; a member passes; everyone else is forbidden the metadata).
   */
  private async assertVaultMetadataVisible(
    principal: Principal | undefined,
    userId: string,
    vaultId: string,
  ): Promise<void> {
    if (this.isAdmin(principal)) return;
    const member = await this.prisma.vaultMembership.findUnique({
      where: { vaultId_userId: { vaultId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException('You do not have access to this vault');
    }
  }

  /**
   * Assert the caller holds a LIVE membership of the vault (the crypto-membership gate for item/wrapped-
   * DEK reads). 403 otherwise. ADMIN does NOT bypass this — there is no plaintext/wrapped-DEK an ADMIN
   * may read without a membership (INV-10).
   */
  private async assertLiveMembership(
    userId: string,
    vaultId: string,
    message = 'You are not a member of this vault',
  ): Promise<void> {
    const member = await this.prisma.vaultMembership.findUnique({
      where: { vaultId_userId: { vaultId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException(message);
    }
  }

  /**
   * IN-TRANSACTION re-assertion of vault liveness + caller membership (the #425 TOCTOU fence). Run as the
   * FIRST statement of an item create/update transaction so the guard and the write share one snapshot:
   * if a concurrent {@link deleteVault} soft-deleted the vault (and hard-dropped this membership) after the
   * out-of-tx pre-checks, the re-read sees the vault gone and aborts — no live item is left under a dead
   * vault. Throws the same NotFound/Forbidden the pre-checks would (no information leak vs. the happy path).
   */
  private async assertLiveVaultMembershipTx(
    tx: PrismaTypes.TransactionClient,
    userId: string,
    vaultId: string,
  ): Promise<void> {
    // The soft-delete read filter applies to tx reads too, so a soft-deleted vault reads as absent.
    const vault = await tx.secretVault.findFirst({
      where: { id: vaultId },
      select: { id: true },
    });
    if (!vault) {
      throw new NotFoundException('Vault not found');
    }
    const member = await tx.vaultMembership.findUnique({
      where: { vaultId_userId: { vaultId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException('You are not a member of this vault');
    }
  }

  // ── helpers: lookups ───────────────────────────────────────────────────────────

  /** Fetch a LIVE vault or 404 (the read filter excludes soft-deleted vaults). */
  private async getLiveVaultOr404(vaultId: string): Promise<SecretVault> {
    const vault = await this.prisma.secretVault.findFirst({
      where: { id: vaultId },
    });
    if (!vault) {
      throw new NotFoundException('Vault not found');
    }
    return vault;
  }

  /** Fetch a LIVE item scoped to its vault or 404 (IDOR: the item must belong to this vault). */
  private async getLiveItemOr404(
    vaultId: string,
    itemId: string,
  ): Promise<SecretItem> {
    const item = await this.prisma.secretItem.findFirst({
      where: { id: itemId, vaultId },
    });
    if (!item) {
      throw new NotFoundException('Secret not found');
    }
    return item;
  }

  /**
   * Fetch a LIVE service account or 404 (ADR-0080). The soft-delete read filter excludes a revoked
   * (deletedAt) account, so a revoked SA reads as absent — you cannot bootstrap a keypair for it or grant
   * it a vault. (A disabled `isActive=false` account can still be granted but cannot authenticate to fetch.)
   */
  private async getLiveServiceAccountOr404(
    serviceAccountId: string,
  ): Promise<ServiceAccount> {
    const account = await this.prisma.serviceAccount.findFirst({
      where: { id: serviceAccountId },
    });
    if (!account) {
      throw new NotFoundException('Service account not found');
    }
    return account;
  }

  /** Load the (live-membership) member list for a vault as display metadata (userId + name/email). */
  private async loadMembers(vaultId: string): Promise<VaultMemberMeta[]> {
    const rows = await this.prisma.vaultMembership.findMany({
      where: { vaultId },
      select: {
        userId: true,
        createdAt: true,
        user: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      userId: r.userId,
      firstName: r.user.firstName,
      lastName: r.user.lastName,
      email: r.user.email,
      memberSince: r.createdAt.toISOString(),
    }));
  }

  /**
   * Load a vault's SERVICE-ACCOUNT members as display metadata (ADR-0080). Only LIVE memberships exist here
   * — a revoked (soft-deleted) SA has its wrapped-DEK row hard-dropped — so no soft-delete filter is needed.
   * `isActive` is surfaced so the UI can flag a member whose token is currently disabled (a paused SA is
   * still a crypto member, but its token will not authenticate). Never a wrapped DEK or the token (INV-10).
   */
  private async loadServiceAccountMembers(
    vaultId: string,
  ): Promise<VaultServiceAccountMemberMeta[]> {
    const rows = await this.prisma.serviceAccountVaultMembership.findMany({
      where: { vaultId },
      select: {
        serviceAccountId: true,
        createdAt: true,
        serviceAccount: {
          select: {
            name: true,
            description: true,
            tokenPrefix: true,
            isActive: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      serviceAccountId: r.serviceAccountId,
      name: r.serviceAccount.name,
      description: r.serviceAccount.description,
      tokenPrefix: r.serviceAccount.tokenPrefix,
      isActive: r.serviceAccount.isActive,
      memberSince: r.createdAt.toISOString(),
    }));
  }

  // ── helpers: audit ─────────────────────────────────────────────────────────────

  /**
   * Append a METADATA-ONLY audit row (ADR-0061 §10). Records WHO acted on WHICH vault/item/target —
   * NEVER a value, key, or blob. Always called inside the mutation's transaction.
   */
  private async writeAudit(
    tx: PrismaTypes.TransactionClient,
    entry: {
      action: PrismaTypes.SecretAuditLogCreateInput['action'];
      // Exactly ONE actor is set (DB CHECK: human XOR service account). Human actions set `actorId`; a
      // programmatic SA read (ITEMS_FETCHED) sets `serviceAccountId` and leaves `actorId` unset.
      actorId?: string;
      serviceAccountId?: string;
      vaultId?: string;
      itemId?: string;
      targetUserId?: string;
      // The SA TARGET (ADR-0080): SA_KEYPAIR_CREATED + an SA-subject MEMBERSHIP_GRANTED/REVOKED.
      targetServiceAccountId?: string;
    },
  ): Promise<void> {
    await tx.secretAuditLog.create({
      data: {
        action: entry.action,
        actorId: entry.actorId ?? null,
        serviceAccountId: entry.serviceAccountId ?? null,
        vaultId: entry.vaultId ?? null,
        itemId: entry.itemId ?? null,
        targetUserId: entry.targetUserId ?? null,
        targetServiceAccountId: entry.targetServiceAccountId ?? null,
      },
    });
  }

  // ── helpers: wire projection ─────────────────────────────────────────────────────

  /** Build the keypair write payload from the client-supplied DTO (kdfParams as Prisma jsonb). */
  private keypairData(
    dto: CreateUserKeypair,
  ): Omit<PrismaTypes.UserKeypairCreateInput, 'user' | 'userId'> {
    return {
      publicKey: dto.publicKey,
      privateKeyEncByPassphrase: dto.privateKeyEncByPassphrase,
      passphraseSalt: dto.passphraseSalt,
      passphraseIv: dto.passphraseIv,
      kdfParams: dto.kdfParams,
      privateKeyEncByRecovery: dto.privateKeyEncByRecovery,
      recoverySalt: dto.recoverySalt,
      recoveryIv: dto.recoveryIv,
    };
  }

  private keypairToWire(row: UserKeypair): UserKeypairWire {
    return {
      id: row.id,
      userId: row.userId,
      publicKey: row.publicKey,
      privateKeyEncByPassphrase: row.privateKeyEncByPassphrase,
      passphraseSalt: row.passphraseSalt,
      passphraseIv: row.passphraseIv,
      kdfParams: row.kdfParams as UserKeypairWire['kdfParams'],
      privateKeyEncByRecovery: row.privateKeyEncByRecovery,
      recoverySalt: row.recoverySalt,
      recoveryIv: row.recoveryIv,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    };
  }

  private vaultToWire(row: SecretVault): SecretVaultWire {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    };
  }

  private itemToWire(row: SecretItem): SecretItemWire {
    return {
      id: row.id,
      vaultId: row.vaultId,
      handle: row.handle,
      label: row.label,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
      kind: row.kind,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    };
  }

  private membershipToWire(row: VaultMembership): VaultMembershipWire {
    return {
      id: row.id,
      vaultId: row.vaultId,
      userId: row.userId,
      ephemeralPublicKey: row.ephemeralPublicKey,
      wrapNonce: row.wrapNonce,
      wrappedDek: row.wrappedDek,
      wrapVersion: row.wrapVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Build the SA-keypair write payload from the client DTO (kdfParams as Prisma jsonb). ADR-0080. */
  private saKeypairData(
    dto: CreateServiceAccountKeypair,
  ): Omit<
    PrismaTypes.ServiceAccountKeypairCreateInput,
    'serviceAccount' | 'serviceAccountId'
  > {
    return {
      publicKey: dto.publicKey,
      privateKeyEnc: dto.privateKeyEnc,
      privateKeySalt: dto.privateKeySalt,
      privateKeyIv: dto.privateKeyIv,
      kdfParams: dto.kdfParams,
    };
  }

  private saKeypairToWire(
    row: ServiceAccountKeypair,
  ): ServiceAccountKeypairWire {
    return {
      id: row.id,
      serviceAccountId: row.serviceAccountId,
      publicKey: row.publicKey,
      privateKeyEnc: row.privateKeyEnc,
      privateKeySalt: row.privateKeySalt,
      privateKeyIv: row.privateKeyIv,
      kdfParams: row.kdfParams as ServiceAccountKeypairWire['kdfParams'],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    };
  }

  private saMembershipToWire(
    row: ServiceAccountVaultMembership,
  ): ServiceAccountVaultMembershipWire {
    return {
      id: row.id,
      vaultId: row.vaultId,
      serviceAccountId: row.serviceAccountId,
      ephemeralPublicKey: row.ephemeralPublicKey,
      wrapNonce: row.wrapNonce,
      wrappedDek: row.wrappedDek,
      wrapVersion: row.wrapVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
