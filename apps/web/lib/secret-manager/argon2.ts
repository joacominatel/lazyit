/**
 * Argon2id — the passphrase → private-key-wrapping-key KDF (ADR-0061 §3, crypto-design §1/§4 Copy A).
 *
 * This is lazyit's ONLY memory-hard KDF and the single weakest link in the zero-knowledge envelope: a
 * member's vault passphrase is human-chosen (low entropy), so the at-rest `privateKeyEncByPassphrase`
 * blob must be guarded by a memory-hard KDF to make offline brute-force of a stolen blob ruinously
 * expensive. WebCrypto's only password-KDF is PBKDF2 (NOT memory-hard, GPU/ASIC-cheap), so Argon2id
 * comes from `hash-wasm` — hand-tuned WebAssembly that runs in the browser, in Bun, and in Node, with
 * the `.wasm` base64-inlined (no separate asset, validated by the #366 spike).
 *
 * The FROZEN parameters (`ARGON2ID_PARAMS` — m=64 MiB, t=3, p=1, 16-byte salt, 32-byte out) live in
 * `@lazyit/shared/crypto` so the client and any future re-derivation agree byte-for-byte; a mismatch
 * would make a stored blob undecryptable. This wrapper reads them from that single source of truth and
 * never re-states them.
 *
 * OFF THE MAIN THREAD (#503): hash-wasm runs the whole memory-hard pass SYNCHRONOUSLY inside the WASM
 * module on the calling thread — the `await` only yields AFTER the blocking work finishes. Run inline on
 * the main thread it freezes the UI for hundreds of ms to ~1s during every unlock/bootstrap/reset (the
 * "unlocking" spinner cannot even animate). So in the browser we drive `argon2.worker.ts` instead, keeping
 * the main thread responsive; the derivation itself (params, inputs, output) is byte-identical. Outside a
 * browser (the `bun test` crypto suite, SSR) `Worker` is unavailable, so we fall back to running the SAME
 * derivation inline — same single source of truth, only WHERE it runs differs.
 *
 * INV-10 discipline: the passphrase and the derived wrapping key are EPHEMERAL — present only in this
 * browser call (and, in the worker, an in-process `postMessage` that never touches the network), never
 * persisted, never logged, never sent to the server. Callers drop the derived key after the one AES-GCM
 * wrap/unwrap that consumes it (see `crypto.ts`).
 */

import { ARGON2ID_PARAMS } from "@lazyit/shared/crypto";
import { argon2id } from "hash-wasm";
import type {
  Argon2WorkerRequest,
  Argon2WorkerResponse,
} from "./argon2.worker";

/** True only in a real browser with module Web Worker support (false under `bun test` and SSR). */
function workerSupported(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined";
}

// ---------------------------------------------------------------------------
// Browser path — a single long-lived worker, shared across unlocks. Requests
// are correlated by a monotonic id so concurrent derivations cannot cross.
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<
  number,
  { resolve: (key: Uint8Array) => void; reject: (err: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./argon2.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.addEventListener(
    "message",
    (event: MessageEvent<Argon2WorkerResponse>) => {
      const { id } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if ("error" in event.data) entry.reject(new Error(event.data.error));
      else entry.resolve(event.data.key);
    },
  );
  worker.addEventListener("error", (event) => {
    // A worker-level failure invalidates every in-flight request; reject them and reset so the next
    // derivation spins up a fresh worker.
    const failed = new Error(event.message || "Argon2id worker error.");
    for (const entry of pending.values()) entry.reject(failed);
    pending.clear();
    worker = null;
  });
  return worker;
}

function deriveInWorker(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const id = nextRequestId++;
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: Argon2WorkerRequest = { id, password: passphrase, salt };
    getWorker().postMessage(request);
  });
}

// ---------------------------------------------------------------------------
// Fallback path (non-browser: `bun test`, SSR) — run the SAME derivation inline.
// ---------------------------------------------------------------------------

async function deriveInline(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const key = await argon2id({
    password: passphrase,
    salt,
    iterations: ARGON2ID_PARAMS.iterations,
    parallelism: ARGON2ID_PARAMS.parallelism,
    memorySize: ARGON2ID_PARAMS.memorySize,
    hashLength: ARGON2ID_PARAMS.hashLength,
    // Raw 32-byte derived key (a wrapping key), NOT a PHC-encoded verifier string.
    outputType: "binary",
  });
  // `outputType: "binary"` guarantees a Uint8Array; the union return type is narrowed here.
  return key as Uint8Array;
}

/**
 * Derive the 32-byte AES-256 wrapping key from a vault passphrase and its (clear, per-keypair) salt,
 * using Argon2id with the FROZEN `ARGON2ID_PARAMS`. Returns RAW key bytes (`outputType: "binary"`),
 * never a PHC-encoded verifier string — this derives a *wrapping key*, it does not *verify a password*.
 *
 * In the browser the derivation runs in `argon2.worker.ts` so the main thread stays responsive (#503);
 * outside a browser it runs inline. The async signature and return type are identical either way, so
 * callers (`crypto.ts`, `use-vault-dek.ts`, `unlock-gate.tsx`) need no change.
 *
 * @param passphrase the user's vault passphrase (UTF-8 string; never persisted, never logged).
 * @param salt       the 16-byte CSPRNG salt stored in clear on the `UserKeypair` (`passphraseSalt`).
 * @returns          a 32-byte (256-bit) AES key, in browser memory only — drop it after use.
 */
export async function deriveKeyArgon2id(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  if (salt.length !== ARGON2ID_PARAMS.saltLength) {
    throw new Error(
      `Argon2id salt must be ${ARGON2ID_PARAMS.saltLength} bytes.`,
    );
  }
  return workerSupported()
    ? deriveInWorker(passphrase, salt)
    : deriveInline(passphrase, salt);
}
