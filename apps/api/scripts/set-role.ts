/**
 * Set a user's RBAC role by email (ADR-0040). The admin-bootstrap escape hatch: the `rbac_user_role`
 * migration backfilled every PRE-EXISTING user to MEMBER, and first-user-ADMIN only fires on a truly
 * empty database — so on a real (non-empty) DB the only ADMIN is the seeded `admin@lazyit.local`, and
 * an operator who signs in via OIDC is stuck as MEMBER with no UI to self-promote. This script lets
 * the operator designate the first ADMIN (or fix any role) directly against the DB.
 *
 * Standalone bun script — NOT wired into Nest — so it carries its own PrismaClient (Postgres adapter
 * + DATABASE_URL). It bypasses the Nest soft-delete extension, so it targets LIVE rows explicitly
 * (`deletedAt: null`): you set the role of an active account, not a tombstoned one.
 *
 * Usage (from apps/api):
 *   bun run set-role <email> <ADMIN|MEMBER|VIEWER>
 *   # examples
 *   bun run set-role operator@yourco.com ADMIN
 *   bun run set-role old.admin@yourco.com MEMBER
 *
 * Bun auto-loads `.env` (DATABASE_URL). Exits non-zero on any error (bad role, unknown email, …) so
 * it is safe to use in scripts. Email is matched case-insensitively (the column is citext, ADR-0041);
 * the argument is normalized (trim + lowercase) to match.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '../generated/prisma/client';

const VALID_ROLES = Object.values(Role); // ['ADMIN', 'MEMBER', 'VIEWER'] — mirrors the Prisma enum.

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  console.error(
    `  Usage: bun run set-role <email> <${VALID_ROLES.join('|')}>\n` +
      `  Example: bun run set-role operator@yourco.com ADMIN\n`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail('DATABASE_URL is not set (Bun auto-loads apps/api/.env).');
  }

  const [rawEmail, rawRole] = process.argv.slice(2);
  if (!rawEmail || !rawRole) {
    fail('Both <email> and <role> are required.');
  }

  // Validate the role against the live Prisma enum (case-sensitive — roles are UPPERCASE).
  if (!(VALID_ROLES as string[]).includes(rawRole)) {
    fail(
      `Invalid role "${rawRole}". Must be one of: ${VALID_ROLES.join(', ')}.`,
    );
  }
  const role = rawRole as Role;

  // Match the citext column (ADR-0041): normalize the input to its canonical lowercase form.
  const email = rawEmail.trim().toLowerCase();

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const user = await prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });
    if (!user) {
      fail(`No LIVE user found with email "${email}".`);
    }

    if (user.role === role) {
      console.log(
        `\n  ✓ ${user.firstName} ${user.lastName} <${user.email}> is already ${role} — nothing to do.\n`,
      );
      return;
    }

    const previous = user.role;
    await prisma.user.update({ where: { id: user.id }, data: { role } });

    console.log(
      `\n  ✓ Role updated for ${user.firstName} ${user.lastName} <${user.email}>:\n` +
        `      ${previous}  →  ${role}\n`,
    );
    if (role === Role.ADMIN) {
      console.log(
        '  This user can now administer lazyit from the Users section.\n',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\n  ✗ set-role failed:', err, '\n');
  process.exit(1);
});
