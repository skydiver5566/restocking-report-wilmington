-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockySkuReceipt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "firstReceivedAt" TIMESTAMP(3),
    "lastReceivedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockySkuReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockySyncState" (
    "shop" TEXT NOT NULL,
    "fullOffset" INTEGER NOT NULL DEFAULT 0,
    "fullDone" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockySyncState_pkey" PRIMARY KEY ("shop")
);

-- CreateIndex
CREATE INDEX "StockySkuReceipt_shop_idx" ON "StockySkuReceipt"("shop");

-- CreateIndex
CREATE INDEX "StockySkuReceipt_shop_sku_idx" ON "StockySkuReceipt"("shop", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "StockySkuReceipt_shop_sku_key" ON "StockySkuReceipt"("shop", "sku");
