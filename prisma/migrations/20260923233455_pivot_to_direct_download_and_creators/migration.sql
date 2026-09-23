-- DropForeignKey
ALTER TABLE "entitlements" DROP CONSTRAINT "entitlements_accountId_fkey";

-- DropForeignKey
ALTER TABLE "entitlements" DROP CONSTRAINT "entitlements_productId_fkey";

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_accountId_fkey";

-- DropForeignKey
ALTER TABLE "reading_progress" DROP CONSTRAINT "reading_progress_accountId_fkey";

-- DropForeignKey
ALTER TABLE "reading_progress" DROP CONSTRAINT "reading_progress_productId_fkey";

-- DropForeignKey
ALTER TABLE "rendered_pages" DROP CONSTRAINT "rendered_pages_productId_fkey";

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "accountId",
DROP COLUMN "name",
ADD COLUMN     "creatorEarning" DECIMAL(10,2),
ADD COLUMN     "downloadToken" TEXT,
ADD COLUMN     "storeEarning" DECIMAL(10,2),
ADD COLUMN     "watermarkedPdfKey" TEXT;

-- AlterTable
ALTER TABLE "products" DROP COLUMN "pageCount",
DROP COLUMN "renderStatus",
ADD COLUMN     "creatorId" TEXT,
ADD COLUMN     "creatorSplitPct" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "accounts";

-- DropTable
DROP TABLE "entitlements";

-- DropTable
DROP TABLE "reading_progress";

-- DropTable
DROP TABLE "rendered_pages";

-- DropEnum
DROP TYPE "RenderStatus";

-- CreateTable
CREATE TABLE "creators" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creators_username_key" ON "creators"("username");

-- CreateIndex
CREATE UNIQUE INDEX "orders_downloadToken_key" ON "orders"("downloadToken");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE SET NULL ON UPDATE CASCADE;
