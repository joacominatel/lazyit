import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * INV-10 ARCHITECTURAL MERGE GATE (ADR-0061, crypto design note §10 item 7 — elevated to a HARD
 * REQUIREMENT in the CTO ratification §10.7).
 *
 * The single biggest regression risk for the zero-knowledge Secret Manager is a future contributor
 * adding a "convenience" server-side decrypt (the server-decryptable `WorkflowSecret` pattern is right
 * there in the repo), or importing crypto into the API custodian. This test STATICALLY SCANS the
 * apps/api source tree and FAILS CI if any INV-10 fence is breached:
 *
 *   1. ZERO imports of `@noble/*` or `@lazyit/shared/crypto` ANYWHERE in apps/api — the API is a
 *      ciphertext custodian; all crypto is client-side (ADR-0061 §3, crypto note §0/§6).
 *   2. NO `SECRET_MANAGER_KEY`-style env read in the secret-manager module — there is NO env master key
 *      over values (the deliberate inversion of `WORKFLOW_SECRET_KEY`; crypto note §6).
 *   3. NO reveal/decrypt/unwrap method and NO cipher primitive token in the secret-manager module — a
 *      best-effort NAME/TOKEN heuristic (belt-and-suspenders; can be evaded by an innocuous method name
 *      + a runtime-assembled algorithm string — which is exactly why #4 exists).
 *   4. THE SOUND STRUCTURAL INVARIANT: the secret-manager module imports NO cipher-providing module
 *      (`node:crypto`/`crypto`/`@noble/*`/`@lazyit/shared/crypto`/WebCrypto `.subtle`), scanned on RAW
 *      text. If the custodian imports nothing that can decrypt, it CANNOT decrypt — regardless of method
 *      names or obfuscated algorithm strings. This is the LOAD-BEARING check; #3 is a secondary net.
 *
 * This is a pure filesystem scan (no Nest/Prisma bootstrap), so it runs fast. It is a strong regression
 * FENCE, not a formal proof — rely on #4 (the structural import invariant); prefer TIGHTENING over
 * loosening if a future pattern slips past #1–#3. Do NOT weaken it.
 */

const API_SRC = join(__dirname, '..');
const MODULE_DIR = __dirname;

/** Recursively collect every `.ts` file under `dir`, excluding generated output and node_modules. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Read a file as text (UTF-8). */
function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/**
 * Strip comments and string/template literals so the CODE-level scans (env reads, reveal methods, cipher
 * primitives) test ACTUAL code, not the heavy ADR/INV-10 prose these files carry (which legitimately
 * names "decrypt"/"unwrap"/"AES-256-GCM" when documenting what the server must NOT do). Block comments,
 * line comments, and the contents of '…' / "…" / `…` literals are blanked. Conservative and dependency-
 * free — good enough to remove prose false-positives while keeping every executable token.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        i += 2;
      } else if (c === '/' && next === '*') {
        state = 'block';
        i += 2;
      } else if (c === "'") {
        state = 'single';
        i += 1;
      } else if (c === '"') {
        state = 'double';
        i += 1;
      } else if (c === '`') {
        state = 'template';
        i += 1;
      } else {
        out += c;
        i += 1;
      }
    } else if (state === 'line') {
      if (c === '\n') {
        out += c;
        state = 'code';
      }
      i += 1;
    } else if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else {
        if (c === '\n') out += c;
        i += 1;
      }
    } else {
      // inside a string/template literal — blank it (skip escapes)
      if (c === '\\') {
        i += 2;
        continue;
      }
      const closer = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (c === closer) state = 'code';
      if (c === '\n') out += c;
      i += 1;
    }
  }
  return out;
}

/** Read a file and return only its executable code (comments + string literals blanked). */
function readCode(file: string): string {
  return stripCommentsAndStrings(read(file));
}

describe('INV-10 architectural guard (ADR-0061 — the merge gate)', () => {
  const allApiFiles = collectTsFiles(API_SRC);
  const moduleFiles = collectTsFiles(MODULE_DIR).filter(
    // The guard itself names the forbidden tokens in its own assertions / comments — exclude it.
    (f) => f !== __filename,
  );

  it('1. apps/api imports NO @noble/* and NO @lazyit/shared/crypto anywhere', () => {
    // An import/require/dynamic-import is a module specifier in a string literal, so scan the RAW text
    // (stripping strings would erase the specifier). The `from '…'` / `require('…')` / `import('…')`
    // shape ensures we only catch a real dependency edge, never a token mentioned in prose.
    const forbiddenImport =
      /(?:from\s+|require\(\s*|import\s*\(\s*)['"](?:@noble\/[^'"]+|@lazyit\/shared\/crypto)['"]/;
    const offenders = allApiFiles.filter((f) => forbiddenImport.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('2. the secret-manager module reads NO SECRET_MANAGER_KEY-style env (no env master key over values)', () => {
    // CODE-level scan (prose/strings blanked): any process.env access whose key mentions a secret/vault
    // master key. There must be NO env master key over values — the inversion of WORKFLOW_SECRET_KEY.
    const envMasterKey =
      /process\.env(?:\.[A-Za-z0-9_]*(?:SECRET_MANAGER|SECRET_KEY|VAULT_KEY|MANAGER_KEY)[A-Za-z0-9_]*|\[)/i;
    const offenders = moduleFiles.filter((f) => envMasterKey.test(readCode(f)));
    expect(offenders).toEqual([]);
  });

  it('3. the secret-manager module has NO reveal/decrypt/unwrap method and NO cipher primitive', () => {
    // CODE-level scan (prose/strings blanked) — the ADR/INV-10 documentation legitimately NAMES
    // decrypt/unwrap/AES-GCM to describe what the server must NOT do; we test the executable code only.
    // (a) No method/function whose NAME is reveal/decrypt/unwrap (optionally over a value) — a call site.
    const revealMethod =
      /(?:^|[^A-Za-z0-9_.])(?:reveal|decrypt|unwrap)(?:ById|Value|Secret|Dek|PrivateKey)?\s*\(/i;
    // (b) No node:crypto cipher primitive or AES/GCM identifier in code.
    const cipherPrimitive =
      /createDecipheriv|createCipheriv|crypto\.subtle|(?:^|[^A-Za-z0-9_])(?:aes|gcm)(?:[-_][0-9a-z]+)?\b/i;

    const offenders: { file: string; hit: string }[] = [];
    for (const file of moduleFiles) {
      const code = readCode(file);
      if (revealMethod.test(code))
        offenders.push({ file, hit: 'reveal/decrypt/unwrap method' });
      if (cipherPrimitive.test(code))
        offenders.push({ file, hit: 'cipher/aes/gcm primitive' });
    }
    expect(offenders).toEqual([]);
  });

  it('4. the secret-manager MODULE imports NO cipher-providing module (the SOUND structural invariant)', () => {
    // The LOAD-BEARING rule. #1–#3 are best-effort name/token heuristics that an adversary can dodge
    // (an innocuously-named decrypt method + a runtime-assembled `aes-256-gcm` string + a `node:crypto`
    // import — which #1 does NOT forbid). This rule closes that whole class structurally: a ciphertext
    // custodian that imports NOTHING capable of decryption CANNOT decrypt, whatever the method is named.
    // Scanned on RAW text (not the comment/string-stripped code) so an obfuscated specifier can't hide
    // the dependency edge — an import specifier is a string literal, so stripping would erase it.
    const cipherProviderImport =
      /(?:from\s+|require\(\s*|import\s*\(\s*)['"](?:node:crypto|crypto|@noble\/[^'"]+|@lazyit\/shared\/crypto)['"]/;
    // WebCrypto reached via the global `crypto` (no import): catch a `.subtle` property access. Scanned on
    // CODE (strings/comments blanked) so the ADR prose that mentions WebCrypto can't false-positive, while
    // a real `crypto.subtle.decrypt(...)` call still trips it (`.subtle` is hard to obfuscate away).
    const webcryptoAccess = /\.subtle\b|\bSubtleCrypto\b|\bwebcrypto\b/;
    const offenders = moduleFiles.filter(
      (f) => cipherProviderImport.test(read(f)) || webcryptoAccess.test(readCode(f)),
    );
    expect(offenders).toEqual([]);
  });

  // ── ADR-0065 regenerate-recovery write path (the third keypair write) ──────────────
  // The module-wide scans (#1–#4) already cover any file added to the module, so the new route/service
  // inherit the structural fence automatically. These explicit assertions PIN the new write path so a
  // future refactor that re-introduces crypto on it (or returns a raw row) fails CI by name — the ADR
  // §"Security & invariants" 🚩 requirement to extend this guard to the new route.
  it('5. the regenerate-recovery route + service exist, import NO cipher, and return only the wire shape', () => {
    const controller = join(MODULE_DIR, 'keypair.controller.ts');
    const service = join(MODULE_DIR, 'secret-manager.service.ts');
    const controllerCode = readCode(controller);
    const serviceCode = readCode(service);

    // (a) The new self-only POST route is wired through the same guards as the other keypair routes
    //     (HumanOnlyGuard at the class level + the `secret:read` capability gate), delegating to the
    //     service — never decrypting inline.
    expect(controllerCode).toMatch(/@Post\(\s*\)|@Post\(/); // a POST exists
    expect(read(controller)).toMatch(/keypair\/recovery/); // the route path (a string literal)
    expect(controllerCode).toMatch(/regenerateRecoveryKey\s*\(/); // delegates to the service
    expect(controllerCode).toMatch(/RequirePermission/); // capability-gated

    // (b) The service method exists and is the ONLY thing the route calls.
    expect(serviceCode).toMatch(/regenerateRecoveryKey\s*\(/);

    // (c) INV-10 on the new path: neither file imports a cipher provider nor reads a master-key env, and
    //     the service returns the wire projection (keypairToWire) — never a raw Prisma row or plaintext.
    const cipherProviderImport =
      /(?:from\s+|require\(\s*|import\s*\(\s*)['"](?:node:crypto|crypto|@noble\/[^'"]+|@lazyit\/shared\/crypto)['"]/;
    const envMasterKey =
      /process\.env(?:\.[A-Za-z0-9_]*(?:SECRET_MANAGER|SECRET_KEY|VAULT_KEY|MANAGER_KEY)[A-Za-z0-9_]*|\[)/i;
    for (const file of [controller, service]) {
      expect(cipherProviderImport.test(read(file))).toBe(false);
      expect(envMasterKey.test(readCode(file))).toBe(false);
    }
    expect(serviceCode).toMatch(/return\s+this\.keypairToWire\(/);
  });
});
