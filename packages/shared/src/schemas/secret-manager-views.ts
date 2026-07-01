import { z } from "zod";
import {
  SecretEnvelopeSchema,
  SecretItemKindSchema,
  SecretItemSchema,
} from "./secret-item";
import { CreateSecretVaultSchema, SecretVaultSchema } from "./secret-vault";
import { KdfParamsSchema } from "./user-keypair";
import { VaultMembershipSchema, WrappedDekSchema } from "./vault-membership";

/**
 * Secret Manager — COMPOSITE request bodies and READ/response shapes shared by api and web (and the
 * slice-4 KB chip). These are the wire shapes that the per-entity schemas (secret-vault, secret-item,
 * vault-membership, user-keypair) don't cover on their own: a controller-composed create body, a couple
 * of metadata read shapes, and the chip-resolution composite. One definition so api and web never drift
 * (issue #430).
 *
 * PURE zod — this file MUST NOT import `@lazyit/shared/crypto` or `@noble/*` (apps/api's CommonJS Jest
 * cannot load ESM `@noble`; apps/api is only a ciphertext custodian). It composes ONLY the pure-zod
 * sibling schemas, all of which are base64 string blobs + metadata, never crypto operations.
 */

/** Generous cap on a base64 public-key field — bounded, never the value. Matches the sibling schemas. */
const BLOB_MAX = 4096;

/**
 * Create a vault (`POST /secret-vaults`) — the non-secret `name` + the creator's OWN first wrapped-DEK
 * membership (the DEK is client-generated, posted wrapped; ADR-0061 §3/§4). The vault DEK never transits
 * the server: `membership` is a {@link WrappedDek} self-wrap produced CLIENT-SIDE. Composed from the two
 * sibling schemas so api (the `POST` DTO + service input) and web (the create body) stay one contract.
 */
export const CreateSecretVaultWithMembershipSchema = z.strictObject({
  name: CreateSecretVaultSchema.shape.name,
  membership: WrappedDekSchema,
});
export type CreateSecretVaultWithMembership = z.infer<
  typeof CreateSecretVaultWithMembershipSchema
>;

/**
 * The public-key lookup response (`GET /secret-manager/users/:userId/public-key`) — the ONLY keypair
 * field a non-owner may read, used by a granter to wrap a DEK to a target member (ADR-0061 §4). Public
 * material only (`publicKey` base64), never any wrapped private-key blob. Left of the §9 line.
 */
export const UserPublicKeySchema = z.object({
  userId: z.uuid(),
  publicKey: z.base64().min(1).max(BLOB_MAX),
});
export type UserPublicKey = z.infer<typeof UserPublicKeySchema>;

/**
 * A vault member's NON-secret display metadata — the shape of `GET /secret-vaults/:id/members` and the
 * embedded `members` on the vault detail (below). NEVER a wrapped-DEK blob (those are per-caller, on
 * `membership/me`); `memberSince` is the membership `createdAt` (ISO-8601). Server-visible metadata (§9).
 */
export const VaultMemberMetaSchema = z.object({
  userId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  memberSince: z.iso.datetime(),
});
export type VaultMemberMeta = z.infer<typeof VaultMemberMetaSchema>;

/**
 * A vault with its embedded member list — the shape of `GET /secret-vaults/:id` (the detail endpoint
 * inlines `members`, unlike the standalone `/members` list). Metadata only — never a DEK.
 */
export const SecretVaultDetailSchema = SecretVaultSchema.extend({
  members: z.array(VaultMemberMetaSchema),
});
export type SecretVaultDetail = z.infer<typeof SecretVaultDetailSchema>;

/**
 * A handle autocomplete suggestion (`GET /secret-manager/items/handles?q=`) — server-visible metadata
 * ONLY (handle/label/vaultId), never a value (ADR-0061 §8). Member-scoped to the caller's vaults.
 */
export const HandleSuggestionSchema = z.object({
  handle: z.string(),
  label: z.string(),
  vaultId: z.cuid(),
});
export type HandleSuggestion = z.infer<typeof HandleSuggestionSchema>;

/**
 * The chip-resolution response (`GET /secret-manager/items/by-handle/:handle`): the referenced item
 * (ciphertext envelope) plus the caller's OWN wrapped-DEK membership for its vault, so the browser can
 * unwrap → decrypt in place (ADR-0061 §8/§6). 403 if the caller is not a live member of the item's vault;
 * 404 if no live handle. The plaintext value never round-trips through the server (INV-10). Consumed by
 * the slice-4 chip render plugin.
 */
export const ResolvedHandleSchema = z.object({
  item: SecretItemSchema,
  membership: VaultMembershipSchema,
});
export type ResolvedHandle = z.infer<typeof ResolvedHandleSchema>;

// ── Programmatic secret retrieval via a service account (ADR-0080) ───────────────

/**
 * A single item in a headless fetch response — server-visible METADATA (`handle`/`label`/`kind`) plus the
 * at-rest AES-256-GCM envelope (ciphertext only). NEVER the plaintext value: the `lazyit-fetch` CLI
 * decrypts it locally under the unwrapped vault DEK. A subset of {@link SecretItemSchema} (no id /
 * timestamps — the CLI only needs the key name + the ciphertext to emit a `.env`).
 */
export const ServiceAccountFetchItemSchema = z.object({
  handle: z.string(),
  label: z.string(),
  kind: SecretItemKindSchema,
  ...SecretEnvelopeSchema.shape,
});
export type ServiceAccountFetchItem = z.infer<
  typeof ServiceAccountFetchItemSchema
>;

/**
 * The headless fetch response (`GET /secret-fetch/:vaultId`, ADR-0080) — everything a STATELESS caller (the
 * `lazyit-fetch` CLI, holding ONLY the SA token) needs to decrypt a vault CLIENT-SIDE, in one round-trip:
 *
 *   1. `keypair`     — the SA's wrapped private key + its Argon2id inputs. The CLI re-derives the KEK from
 *                      the token (Argon2id over `privateKeySalt`) and unwraps the private key locally.
 *   2. `membership`  — the vault DEK wrapped to the SA's public key. The CLI unwraps it with the private
 *                      key from step 1.
 *   3. `items`       — the ciphertext envelopes. The CLI decrypts each under the DEK from step 2.
 *
 * EVERYTHING here is CIPHERTEXT or public material (left of the ADR-0061 §9 line). The server produces NO
 * plaintext — it never holds the token-derived KEK, never unwraps the private key or the DEK, and never
 * decrypts a value (INV-10). The `keypair.publicKey` is deliberately OMITTED (the CLI does not need it to
 * unwrap). Every call to this endpoint is audited (ITEMS_FETCHED — which SA, which vault, when).
 */
export const ServiceAccountVaultFetchSchema = z.object({
  vaultId: z.cuid(),
  keypair: z.object({
    privateKeyEnc: z.base64().min(1).max(4096),
    privateKeySalt: z.base64().min(1).max(4096),
    privateKeyIv: z.base64().min(1).max(4096),
    kdfParams: KdfParamsSchema,
  }),
  membership: WrappedDekSchema,
  items: z.array(ServiceAccountFetchItemSchema),
});
export type ServiceAccountVaultFetch = z.infer<
  typeof ServiceAccountVaultFetchSchema
>;
