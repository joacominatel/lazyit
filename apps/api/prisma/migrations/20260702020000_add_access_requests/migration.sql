-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateTable
CREATE TABLE "access_requests" (
    "id" TEXT NOT NULL,
    "requesterId" UUID NOT NULL,
    "applicationId" TEXT NOT NULL,
    "accessLevel" TEXT,
    "justification" TEXT,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "deniedReason" TEXT,
    "grantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_requests_grantId_key" ON "access_requests"("grantId");

-- CreateIndex
CREATE INDEX "access_requests_applicationId_idx" ON "access_requests"("applicationId");

-- CreateIndex
CREATE INDEX "access_requests_requesterId_idx" ON "access_requests"("requesterId");

-- CreateIndex
CREATE INDEX "access_requests_status_idx" ON "access_requests"("status");

-- CreateIndex
-- Partial UNIQUE index: at most ONE OPEN (PENDING) request per (requester, application). Prisma PSL
-- can't express a partial unique index, so it lives here as raw SQL (the same pattern as
-- asset_assignments' active-key — ADR-0019/0041). A DECIDED request (APPROVED/DENIED) is exempt, so the
-- same pair can be requested again after a decision; it also races safely (the DB rejects a concurrent
-- second PENDING with a unique violation the service maps to 409). The enum value is cast to its type in
-- the WHERE clause. See docs/03-decisions/0085-access-request-flow.md and docs/05-runbooks/prisma-migrations.md.
CREATE UNIQUE INDEX "access_requests_requester_application_pending_key"
    ON "access_requests"("requesterId", "applicationId")
    WHERE "status" = 'PENDING'::"AccessRequestStatus";

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "access_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
