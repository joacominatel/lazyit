/**
 * reset-admin-password.ts — local-auth admin password recovery CLI (ADR-0086 §5, F1d / #994).
 *
 * WHEN TO USE: the LAST resort when every ADMIN of a local-auth (AUTH_MODE=local) instance is
 * locked out of their password and there is no SMTP-based reset flow — a gap ADR-0086 explicitly
 * accepts rather than building a mail server dependency. ONLY applies to local-auth instances: an
 * OIDC-linked account has no `passwordHash` at all (login is the IdP's job, ADR-0016/0043), so
 * resetting one here would do nothing for it.
 *
 * It bypasses the app entirely and writes directly to Postgres via `DATABASE_URL` — standalone
 * `bun` script, own PrismaClient, NOT wired into Nest — exactly like the existing `set-role.ts`
 * escape hatch. It refuses to touch anyone but a LIVE ADMIN (this is a login-recovery tool, not a
 * general password-set tool: use the Users section, or `set-role`, to promote someone to ADMIN
 * first). The actual reset (lookup, ADMIN check, hash, write, sessionEpoch bump) lives in
 * `../src/auth/local/reset-admin-password.ts` — reused here, unit-tested there.
 *
 * The new password hashes with the app's EXACT argon2id params (`LocalCredentialService` —
 * `ARGON2ID_PARAMS`, `@lazyit/shared`), so the result is byte-for-byte interchangeable with a
 * hash the app would set itself, and BUMPS `sessionEpoch` — every existing session for the
 * account is revoked immediately (ADR-0086 §3): a token minted before the reset never survives it.
 *
 * Usage (from apps/api):
 *   bun run reset-admin-password <email-or-username>
 *   # then type the new password when prompted — it is masked and NEVER becomes a CLI argument,
 *   # so it never lands in shell history or a `ps`/process-list snapshot.
 *
 * Non-interactive (scripting/CI, no TTY): pipe the password on stdin instead, e.g.
 *   printf '%s' 'N3wPassw0rd!' | bun run reset-admin-password admin@lazyit.local
 *
 * Exits non-zero on: missing identifier, no LIVE user found, user not ADMIN, empty password.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { LocalCredentialService } from '../src/auth/local/local-credential.service';
import { resetAdminPassword } from '../src/auth/local/reset-admin-password';

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  console.error(
    '  Usage: bun run reset-admin-password <email-or-username>\n' +
      '  You will then be prompted to type the new password (masked, not a CLI arg).\n',
  );
  process.exit(1);
}

/**
 * Read the new password without it ever becoming a CLI argument. Interactive TTY: a masked prompt
 * (raw mode, no echo). Non-interactive (piped/redirected stdin): read the whole stream and take its
 * first line — lets `printf '%s' pw | bun run reset-admin-password <id>` work in scripts/CI while
 * still keeping the password out of argv/`ps`.
 */
async function promptPassword(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8').split('\n')[0].trimEnd();
  }

  return new Promise<string>((resolve) => {
    process.stdout.write(label);
    stdin.resume();
    stdin.setRawMode(true);
    let input = '';
    const onData = (buf: Buffer): void => {
      const chunk = buf.toString('utf8');
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (char === '\u0003') {
          // Ctrl-C — abort like any other interactive prompt would.
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          input = input.slice(0, -1);
          continue;
        }
        input += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail('DATABASE_URL is not set (Bun auto-loads apps/api/.env).');
  }

  const [identifier] = process.argv.slice(2);
  if (!identifier) {
    fail('An <email-or-username> is required.');
  }

  const password = await promptPassword(`New password for ${identifier}: `);
  if (!password) {
    fail('The new password must not be empty.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  const credentials = new LocalCredentialService();

  try {
    const result = await resetAdminPassword(
      prisma,
      credentials,
      identifier,
      password,
    );
    console.log(
      `\n  ✓ Password reset for ADMIN ${result.email} (id ${result.id}).\n` +
        '  Every existing session for this account is now revoked — they must sign in again with the new password.\n',
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\n  ✗ reset-admin-password failed:', err, '\n');
  process.exit(1);
});
