-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "costPerSeat" INTEGER,
ADD COLUMN     "renewalDate" TIMESTAMP(3),
ADD COLUMN     "seatsPurchased" INTEGER;
