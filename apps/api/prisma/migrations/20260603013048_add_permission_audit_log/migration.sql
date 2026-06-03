-- CreateEnum
CREATE TYPE "PermissionAuditAction" AS ENUM ('GRANT', 'REVOKE');

-- CreateTable
CREATE TABLE "permission_audit_log" (
    "id" SERIAL NOT NULL,
    "actorId" UUID,
    "role" "Role" NOT NULL,
    "permission" TEXT NOT NULL,
    "action" "PermissionAuditAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "permission_audit_log_role_id_idx" ON "permission_audit_log"("role", "id");

-- AddForeignKey
ALTER TABLE "permission_audit_log" ADD CONSTRAINT "permission_audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
