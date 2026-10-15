// Serializes "dedup onto a blob, then commit its row" against "no row references it, so unlink" (AUD-021).
const BLOB_LOCK_NAMESPACE = 'lazyit.attachment_blob';

export interface BlobLockClient {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<number>;
}

export interface BlobTryLockClient {
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<T>;
}

export async function lockBlob(
  tx: BlobLockClient,
  sha256: string,
): Promise<void> {
  // $executeRaw, not $queryRaw: the pg driver cannot deserialize the void pg_advisory_xact_lock returns.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BLOB_LOCK_NAMESPACE}), hashtext(${sha256}))`;
}

export async function tryLockBlob(
  tx: BlobTryLockClient,
  sha256: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<
    Array<{ locked: boolean }>
  >`SELECT pg_try_advisory_xact_lock(hashtext(${BLOB_LOCK_NAMESPACE}), hashtext(${sha256})) AS locked`;
  return rows[0]?.locked === true;
}
