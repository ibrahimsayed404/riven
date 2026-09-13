/*
  Warnings:

  - Added the required column `orderId` to the `ratings` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "public"."FavorableType" ADD VALUE 'PRODUCT';

-- AlterEnum
ALTER TYPE "public"."RatingTargetType" ADD VALUE 'PRODUCT';

-- AlterTable
ALTER TABLE "public"."ratings" ADD COLUMN     "orderId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "ratings_orderId_idx" ON "public"."ratings"("orderId");

-- AddForeignKey
ALTER TABLE "public"."ratings" ADD CONSTRAINT "ratings_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
