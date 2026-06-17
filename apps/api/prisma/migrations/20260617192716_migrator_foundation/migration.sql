-- CreateEnum
CREATE TYPE "ImportEntity" AS ENUM ('ASSET');

-- CreateEnum
CREATE TYPE "ImportSessionStatus" AS ENUM ('PENDING', 'PARSING', 'PARSED', 'MAPPED', 'DRY_RUN', 'COMMITTING', 'COMMITTED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'COERCED', 'VALID', 'INVALID', 'COMMITTED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "import_sessions" (
    "id" TEXT NOT NULL,
    "entity" "ImportEntity" NOT NULL,
    "status" "ImportSessionStatus" NOT NULL DEFAULT 'PENDING',
    "ownerId" UUID NOT NULL,
    "mapping" JSONB,
    "resolutionPlan" JSONB,
    "fileHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "raw" JSONB NOT NULL,
    "coerced" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_runs" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "entity" "ImportEntity" NOT NULL,
    "actorId" UUID,
    "counts" JSONB NOT NULL,
    "conflictSummary" JSONB,
    "fileHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_sessions_ownerId_idx" ON "import_sessions"("ownerId");

-- CreateIndex
CREATE INDEX "import_sessions_expiresAt_idx" ON "import_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "import_rows_sessionId_rowIndex_idx" ON "import_rows"("sessionId", "rowIndex");

-- CreateIndex
CREATE INDEX "import_rows_sessionId_status_idx" ON "import_rows"("sessionId", "status");

-- CreateIndex
CREATE INDEX "import_runs_sessionId_id_idx" ON "import_runs"("sessionId", "id");

-- CreateIndex
CREATE INDEX "import_runs_actorId_idx" ON "import_runs"("actorId");

-- AddForeignKey
ALTER TABLE "import_sessions" ADD CONSTRAINT "import_sessions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "import_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "import_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
