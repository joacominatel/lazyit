/**
 * Argon2id Web Worker — runs the memory-hard passphrase KDF OFF the main thread (#503).
 *
 * `deriveKeyArgon2id` (in `argon2.ts`) is lazyit's ONLY memory-hard KDF and, run inline, hash-wasm
 * executes the whole Argon2id pass (m=64 MiB, t=3, p=1) SYNCHRONOUSLY inside the WASM module on the
 * calling thread — so on the main thread the UI freezes for hundreds of ms to ~1s during every vault
 * unlock/bootstrap/reset (the "unlocking" spinner cannot even animate). This module hosts that exact
 * derivation in a dedicated worker thread; the wrapper drives it via `postMessage` and the main thread
 * stays responsive.
 *
 * SINGLE SOURCE OF TRUTH: the FROZEN `ARGON2ID_PARAMS` (m/t/p/salt/hash) come from `@lazyit/shared/crypto`
 * — the SAME constant the inline path read. WHERE the derivation runs changes; WHAT is derived does not.
 *
 * INV-10 (zero-knowledge): this worker runs IN THE BROWSER. The passphrase arrives over an in-process
 * `postMessage` (never the network) and the derived key is posted straight back to the page. Nothing here
 * touches the server, storage, or a log — the ephemeral discipline of the inline path is preserved.
 */

import { ARGON2ID_PARAMS } from "@lazyit/shared/crypto";
import { argon2id } from "hash-wasm";

/** Request posted INTO the worker: a correlation id, the passphrase, and the clear per-keypair salt. */
export interface Argon2WorkerRequest {
  id: number;
  password: string;
  salt: Uint8Array;
}

/** Response posted BACK from the worker: the same id plus either the raw key bytes or an error message. */
export type Argon2WorkerResponse =
  | { id: number; key: Uint8Array }
  | { id: number; error: string };

const ctx = self as unknown as Worker;

ctx.addEventListener("message", async (event: MessageEvent<Argon2WorkerRequest>) => {
  const { id, password, salt } = event.data;
  try {
    const key = (await argon2id({
      password,
      salt,
      iterations: ARGON2ID_PARAMS.iterations,
      parallelism: ARGON2ID_PARAMS.parallelism,
      memorySize: ARGON2ID_PARAMS.memorySize,
      hashLength: ARGON2ID_PARAMS.hashLength,
      // Raw 32-byte derived key (a wrapping key), NOT a PHC-encoded verifier string.
      outputType: "binary",
    })) as Uint8Array;
    const response: Argon2WorkerResponse = { id, key };
    // Transfer the key's buffer so it is moved (not copied) back to the page.
    ctx.postMessage(response, [key.buffer]);
  } catch (err) {
    const response: Argon2WorkerResponse = {
      id,
      error: err instanceof Error ? err.message : "Argon2id derivation failed.",
    };
    ctx.postMessage(response);
  }
});
