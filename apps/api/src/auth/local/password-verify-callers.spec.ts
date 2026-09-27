import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * SEC-082 prevention: a password is checked by `LocalCredentialService.verify` only where a per-account
 * brute-force bound is known to wrap it. A new step-up surface goes through {@link PasswordStepUpVerifier}
 * (one shared backoff), never straight to the KDF. Adding a caller here is a security decision.
 */
const ALLOWED = new Set([
  // Sign-in: its own per-account backoff and per-IP limiter (ADR-0086 §3).
  'auth/local/login.service.ts',
  // Change password: the current password, behind the session and its own rate limit.
  'auth/local/password-lifecycle.service.ts',
  // THE step-up primitive (chat approvals and the OAuth consent).
  'auth/local/password-step-up.verifier.ts',
]);

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/(\.spec|harness-spec)\.ts$/.test(name)
      ? [path]
      : [];
  });
}

describe('LocalCredentialService.verify callers (SEC-082)', () => {
  it('only the login, the password change and the step-up primitive verify a password', () => {
    const callers = sourceFiles(SRC)
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        return (
          text.includes('LocalCredentialService') && /\.verify\(/.test(text)
        );
      })
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .sort();
    expect(callers).toEqual([...ALLOWED].sort());
  });
});
