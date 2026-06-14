import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateSecretItem,
  CreateSecretVault,
  CreateUserKeypair,
  CreateVaultMembership,
  ResetUserKeypair,
  SecretItem as SecretItemWire,
  SecretVault as SecretVaultWire,
  UpdateSecretItem,
  UpdateSecretVault,
  UserKeypair as UserKeypairWire,
  VaultMembership as VaultMembershipWire,
} from '@lazyit/shared';
import type {
  Prisma as PrismaTypes,
  SecretItem,
  SecretVault,
  UserKeypair,
  VaultMembership,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { type Principal, isHumanPrincipal } from '../auth/principal';

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
   * A user's PUBLIC key — the material needed to wrap a DEK to them when granting (ADR-0061 §4). Public
   * by design (left of the §9 line). 404 if that user has no keypair yet (they must bootstrap one before
   * they can be granted). Returns ONLY the public key + identity, never any wrapped private-key blob.
   */
  async getUserPublicKey(
    targetUserId: string,
  ): Promise<{ userId: string; publicKey: string }> {
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
  ): Promise<SecretVaultWire & { members: VaultMemberMeta[] }> {
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
    dto: CreateVaultInput,
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
  ): Promise<{ item: SecretItemWire; membership: VaultMembershipWire }> {
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

  // ── helpers: authz ────────────────────────────────────────────────────────────

  /** The authenticated human's User.id, or a 403 if anonymous/non-human (the controller guard also blocks SAs). */
  private requireHumanId(principal: Principal | undefined): string {
    if (!isHumanPrincipal(principal)) {
      throw new ForbiddenException('A human user is required');
    }
    return principal.user.id;
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

  // ── helpers: audit ─────────────────────────────────────────────────────────────

  /**
   * Append a METADATA-ONLY audit row (ADR-0061 §10). Records WHO acted on WHICH vault/item/target —
   * NEVER a value, key, or blob. Always called inside the mutation's transaction.
   */
  private async writeAudit(
    tx: PrismaTypes.TransactionClient,
    entry: {
      action: PrismaTypes.SecretAuditLogCreateInput['action'];
      actorId: string;
      vaultId?: string;
      itemId?: string;
      targetUserId?: string;
    },
  ): Promise<void> {
    await tx.secretAuditLog.create({
      data: {
        action: entry.action,
        actorId: entry.actorId,
        vaultId: entry.vaultId ?? null,
        itemId: entry.itemId ?? null,
        targetUserId: entry.targetUserId ?? null,
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
}

/** Member display metadata (userId + name/email + memberSince) — NEVER a wrapped DEK or any blob. */
export interface VaultMemberMeta {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  memberSince: string;
}

/** Chip autocomplete suggestion — handles + labels (metadata) from the caller's vaults. NEVER values. */
export interface HandleSuggestion {
  handle: string;
  label: string;
  vaultId: string;
}

/**
 * Vault-create input: the non-secret name + the creator's own first wrapped-DEK membership (the DEK is
 * client-generated and posted wrapped). Composed by the controller from the two shared DTOs so the
 * service receives one cohesive object.
 */
export interface CreateVaultInput {
  name: CreateSecretVault['name'];
  membership: {
    ephemeralPublicKey: CreateVaultMembership['ephemeralPublicKey'];
    wrapNonce: CreateVaultMembership['wrapNonce'];
    wrappedDek: CreateVaultMembership['wrappedDek'];
    wrapVersion: CreateVaultMembership['wrapVersion'];
  };
}
