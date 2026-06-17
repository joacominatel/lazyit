-- AlterTable
ALTER TABLE "import_sessions" ADD COLUMN     "detected" JSONB,
ADD COLUMN     "error" JSONB;
