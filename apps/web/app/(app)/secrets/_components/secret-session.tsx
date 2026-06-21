"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Idle / inactivity auto-lock window (#605). After this many ms with NO user activity (pointer, key,
 * scroll, touch) the session auto-locks — the private key and every cached DEK are dropped, exactly as
 * an explicit Lock. A password-manager-grade default; not yet a user/instance preference (deferred).
 */
const IDLE_LOCK_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Grace period after the tab is HIDDEN (`visibilitychange`) before auto-locking (#605). A brief hide
 * (alt-tab to copy a value, switch to a password field) should not nuke the session; a walk-away should.
 */
const HIDDEN_LOCK_MS = 60 * 1000; // 1 minute

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
 * a plain `Map` in a ref for the same reason — callers read/write it through the methods below.
 *
 * SPLIT CONTEXT (SM-FE-006). The session is exposed through TWO separate contexts so DEK churn doesn't
 * ripple through unlock-state-only consumers:
 *   - {@link useSecretSession} — the STABLE slice: `isUnlocked` + `lock` + the (identity-stable) key
 *     accessors. It re-renders ONLY when the unlock state flips (unlock / lock). App-wide consumers that
 *     just need "is the session unlocked?" (the user menu, every KB secret chip) subscribe here and are
 *     no longer woken by `cacheDek`.
 *   - {@link useSecretDek} — the narrowly-subscribed DEK slice: `cacheDek` / `getDek` / `hasDek` + a
 *     `version` counter that bumps when the DEK-cache membership changes. Only the vault-read chain
 *     (`use-vault-dek`) and the create-vault flow subscribe here, so per-vault DEK caching re-renders
 *     just those, never the whole tree.
 * `lock` lives in the stable slice but clears BOTH (drops the key → flips `isUnlocked`; drops every DEK →
 * bumps the DEK `version`), so a Lock still tears the entire session down.
 */

/** The STABLE slice — flips only on unlock/lock. */
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
  /**
   * LOCK: drop the private key AND every cached DEK from memory. Wired to an explicit "Lock" action and
   * implicitly enforced by unmount. After this, any reveal needs a fresh passphrase unlock.
   */
  lock: () => void;
}

/** The DEK slice — bumps `version` when the per-vault DEK cache membership changes. */
export interface SecretDek {
  /** Cache the unwrapped DEK for a vault (after `unwrapDekFromMembership`). Browser memory only. */
  cacheDek: (vaultId: string, dek: Uint8Array) => void;
  /** The cached unwrapped DEK for a vault, or `undefined` if this vault hasn't been unwrapped this session. */
  getDek: (vaultId: string) => Uint8Array | undefined;
  /** True if this vault's DEK is already unwrapped in memory (no unlock gate needed to reveal). */
  hasDek: (vaultId: string) => boolean;
  /** Bumps when the DEK cache membership changes — lets a vault page re-derive its reveal gate. */
  version: number;
}

const SecretSessionContext = createContext<SecretSession | undefined>(undefined);
const SecretDekContext = createContext<SecretDek | undefined>(undefined);

export function SecretManagerProvider({ children }: { children: React.ReactNode }) {
  // The private key + DEK cache live in refs (identity-stable, never a render dependency). A boolean +
  // a version counter are the ONLY things that drive renders — never the secret bytes themselves.
  const privateKeyRef = useRef<Uint8Array | undefined>(undefined);
  const dekCacheRef = useRef<Map<string, Uint8Array>>(new Map());
  const [isUnlocked, setIsUnlocked] = useState(false);
  // DEK-cache membership version — drives ONLY the DEK context, so caching a vault DEK never re-renders
  // unlock-state-only consumers (SM-FE-006).
  const [dekVersion, setDekVersion] = useState(0);

  const setPrivateKey = useCallback((privateKey: Uint8Array) => {
    privateKeyRef.current = privateKey;
    setIsUnlocked(true);
  }, []);

  const getPrivateKey = useCallback(() => privateKeyRef.current, []);

  const cacheDek = useCallback((vaultId: string, dek: Uint8Array) => {
    dekCacheRef.current.set(vaultId, dek);
    setDekVersion((v) => v + 1);
  }, []);

  const getDek = useCallback((vaultId: string) => dekCacheRef.current.get(vaultId), []);

  const hasDek = useCallback((vaultId: string) => dekCacheRef.current.has(vaultId), []);

  const lock = useCallback(() => {
    // Drop every reference to secret material. We do not attempt to zero the bytes (JS gives no
    // guarantee), but we drop all handles so they become collectible — the security boundary is "no
    // persistence", and a locked session can no longer reach any of it. Lock spans BOTH slices: it
    // flips `isUnlocked` (stable) and bumps the DEK `version` (DEK), so the whole session tears down.
    privateKeyRef.current = undefined;
    dekCacheRef.current = new Map();
    setIsUnlocked(false);
    setDekVersion((v) => v + 1);
  }, []);

  // ── Idle / inactivity auto-lock (#605) ───────────────────────────────────────────────────────────
  // While the session is unlocked, an inactivity timer drops the private key + every DEK after
  // IDLE_LOCK_MS of no user input — the dominant real-world threat for a password manager is a walked-
  // away, still-unlocked screen. Any pointer/keyboard/scroll/touch activity resets the timer. A hidden
  // tab arms a shorter HIDDEN_LOCK_MS timer. Pure client-side teardown via `lock()` — INV-10 intact
  // (no plaintext/DEK leaves the browser; the timer only DROPS in-memory material).
  useEffect(() => {
    if (!isUnlocked) return; // only run the timer while there is material to protect
    if (typeof window === "undefined") return;

    let idleTimer: ReturnType<typeof setTimeout>;

    const armIdle = (ms: number) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => lock(), ms);
    };

    const onActivity = () => {
      // Only meaningful while visible; a hidden tab uses its own (shorter) timer.
      if (document.visibilityState === "visible") armIdle(IDLE_LOCK_MS);
    };

    const onVisibility = () => {
      armIdle(document.visibilityState === "hidden" ? HIDDEN_LOCK_MS : IDLE_LOCK_MS);
    };

    // `passive` — these listeners never call preventDefault, so they stay off the scroll/input hot path.
    const activityEvents = [
      "pointerdown",
      "keydown",
      "scroll",
      "touchstart",
      "mousemove",
    ] as const;
    for (const ev of activityEvents) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);

    // Arm immediately on unlock (respecting current visibility).
    onVisibility();

    return () => {
      clearTimeout(idleTimer);
      for (const ev of activityEvents) {
        window.removeEventListener(ev, onActivity);
      }
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isUnlocked, lock]);

  const session = useMemo<SecretSession>(
    () => ({ isUnlocked, setPrivateKey, getPrivateKey, lock }),
    [isUnlocked, setPrivateKey, getPrivateKey, lock],
  );

  const dek = useMemo<SecretDek>(
    () => ({ cacheDek, getDek, hasDek, version: dekVersion }),
    [cacheDek, getDek, hasDek, dekVersion],
  );

  return (
    <SecretSessionContext.Provider value={session}>
      <SecretDekContext.Provider value={dek}>{children}</SecretDekContext.Provider>
    </SecretSessionContext.Provider>
  );
}

/**
 * Read the STABLE session slice (`isUnlocked` / `lock` / key accessors). Re-renders ONLY on unlock/lock —
 * NOT on DEK caching. Throws if used outside {@link SecretManagerProvider}.
 */
export function useSecretSession(): SecretSession {
  const ctx = useContext(SecretSessionContext);
  if (!ctx) {
    throw new Error("useSecretSession must be used within a SecretManagerProvider");
  }
  return ctx;
}

/**
 * Read the DEK slice (`cacheDek` / `getDek` / `hasDek` / `version`). Re-renders when the per-vault DEK
 * cache membership changes — subscribe here ONLY where the vault read-chain needs it. Throws if used
 * outside {@link SecretManagerProvider}.
 */
export function useSecretDek(): SecretDek {
  const ctx = useContext(SecretDekContext);
  if (!ctx) {
    throw new Error("useSecretDek must be used within a SecretManagerProvider");
  }
  return ctx;
}
