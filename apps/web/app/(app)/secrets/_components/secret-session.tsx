"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/**
 * SecretManagerProvider — the zero-knowledge in-memory SESSION (ADR-0061, INV-10 on the client).
 *
 * THE SECURITY LINE. The two pieces of long-lived secret material the UI holds — the caller's unlocked
 * X25519 PRIVATE KEY and the per-vault unwrapped DEKs — live ONLY here, in React state / a ref, in
 * browser memory. They are NEVER written to localStorage / sessionStorage / cookies, NEVER put in a
 * TanStack Query cache (no query key, no query data), NEVER logged, NEVER placed in a URL. They are
 * cleared on {@link SecretSession.lock} (an explicit "Lock" action) and whenever this provider unmounts
 * (route change out of the app, logout — the provider is mounted inside the `(app)` group only).
 *
 * The private key gates the whole read chain (crypto-design §6): unlock private key → unwrap a vault DEK
 * from your membership → open an item. We cache the unwrapped DEK per vault so a member doesn't re-run
 * the (cheap) unwrap on every reveal; the (expensive) Argon2id passphrase unlock runs once per session.
 *
 * NOTE on `Uint8Array` in React state: we keep the private key in a ref (it is identity-stable and we
 * never want it to drive renders), and expose only a boolean `isUnlocked` to the tree. The DEK cache is
 * a plain `Map` in a ref for the same reason — callers read/write it through the methods below, and a
 * `version` counter bumps a render only when membership of the cache changes (so a vault page can react
 * to "this vault is now unwrapped").
 */
export interface SecretSession {
  /** True once the caller's private key is unlocked and held in memory. */
  isUnlocked: boolean;
  /**
   * Store the freshly-unlocked private key in memory (called right after `unlockWithPassphrase` /
   * `unlockWithRecoveryKey`). Replaces any previous key. The bytes never leave this module.
   */
  setPrivateKey: (privateKey: Uint8Array) => void;
  /** The unlocked private key, or `undefined` if locked. Held in browser memory only — never persist it. */
  getPrivateKey: () => Uint8Array | undefined;
  /** Cache the unwrapped DEK for a vault (after `unwrapDekFromMembership`). Browser memory only. */
  cacheDek: (vaultId: string, dek: Uint8Array) => void;
  /** The cached unwrapped DEK for a vault, or `undefined` if this vault hasn't been unwrapped this session. */
  getDek: (vaultId: string) => Uint8Array | undefined;
  /** True if this vault's DEK is already unwrapped in memory (no unlock gate needed to reveal). */
  hasDek: (vaultId: string) => boolean;
  /**
   * LOCK: drop the private key AND every cached DEK from memory. Wired to an explicit "Lock" action and
   * implicitly enforced by unmount. After this, any reveal needs a fresh passphrase unlock.
   */
  lock: () => void;
  /** Bumps when the unlock state or the DEK cache membership changes — lets a page re-derive gates. */
  version: number;
}

const SecretSessionContext = createContext<SecretSession | undefined>(undefined);

export function SecretManagerProvider({ children }: { children: React.ReactNode }) {
  // The private key + DEK cache live in refs (identity-stable, never a render dependency). A boolean +
  // a version counter are the ONLY things that drive renders — never the secret bytes themselves.
  const privateKeyRef = useRef<Uint8Array | undefined>(undefined);
  const dekCacheRef = useRef<Map<string, Uint8Array>>(new Map());
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [version, setVersion] = useState(0);

  const setPrivateKey = useCallback((privateKey: Uint8Array) => {
    privateKeyRef.current = privateKey;
    setIsUnlocked(true);
    setVersion((v) => v + 1);
  }, []);

  const getPrivateKey = useCallback(() => privateKeyRef.current, []);

  const cacheDek = useCallback((vaultId: string, dek: Uint8Array) => {
    dekCacheRef.current.set(vaultId, dek);
    setVersion((v) => v + 1);
  }, []);

  const getDek = useCallback((vaultId: string) => dekCacheRef.current.get(vaultId), []);

  const hasDek = useCallback((vaultId: string) => dekCacheRef.current.has(vaultId), []);

  const lock = useCallback(() => {
    // Drop every reference to secret material. We do not attempt to zero the bytes (JS gives no
    // guarantee), but we drop all handles so they become collectible — the security boundary is "no
    // persistence", and a locked session can no longer reach any of it.
    privateKeyRef.current = undefined;
    dekCacheRef.current = new Map();
    setIsUnlocked(false);
    setVersion((v) => v + 1);
  }, []);

  const value = useMemo<SecretSession>(
    () => ({
      isUnlocked,
      setPrivateKey,
      getPrivateKey,
      cacheDek,
      getDek,
      hasDek,
      lock,
      version,
    }),
    [isUnlocked, setPrivateKey, getPrivateKey, cacheDek, getDek, hasDek, lock, version],
  );

  return (
    <SecretSessionContext.Provider value={value}>{children}</SecretSessionContext.Provider>
  );
}

/** Read the in-memory secret session. Throws if used outside {@link SecretManagerProvider}. */
export function useSecretSession(): SecretSession {
  const ctx = useContext(SecretSessionContext);
  if (!ctx) {
    throw new Error("useSecretSession must be used within a SecretManagerProvider");
  }
  return ctx;
}
