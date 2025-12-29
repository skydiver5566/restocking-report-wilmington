-- CreateTable
CREATE TABLE "ReportRunState" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "periodQtySoldLTE" INTEGER NOT NULL,
    "lookBackDays" INTEGER NOT NULL,
    "sinceISO" TEXT NOT NULL,
    "cursor" TEXT,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "processedOrders" INTEGER NOT NULL DEFAULT 0,
    "salesByVariant" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,

    CONSTRAINT "ReportRunState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportRunState_shop_createdAt_idx" ON "ReportRunState"("shop", "createdAt");
