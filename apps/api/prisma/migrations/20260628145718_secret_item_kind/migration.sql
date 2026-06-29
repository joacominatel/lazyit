-- CreateEnum
CREATE TYPE "SecretItemKind" AS ENUM ('GENERIC', 'SSH_KEY', 'TOTP', 'CERTIFICATE');

-- AlterTable
ALTER TABLE "secret_items" ADD COLUMN     "kind" "SecretItemKind" NOT NULL DEFAULT 'GENERIC';
