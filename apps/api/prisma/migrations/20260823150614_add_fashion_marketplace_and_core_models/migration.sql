/*
  Warnings:

  - A unique constraint covering the columns `[phone]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."ScheduleType" AS ENUM ('ONE_OFF', 'RECURRING');

-- CreateEnum
CREATE TYPE "public"."BazaarStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."ApplicationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."EventType" AS ENUM ('TALK', 'MEETUP', 'SCREENING', 'MARKET');

-- CreateEnum
CREATE TYPE "public"."FollowableType" AS ENUM ('VENDOR', 'BAZAAR');

-- CreateEnum
CREATE TYPE "public"."FavorableType" AS ENUM ('VENDOR', 'BAZAAR', 'EVENT');

-- CreateEnum
CREATE TYPE "public"."RatingTargetType" AS ENUM ('VENDOR', 'BAZAAR', 'EVENT');

-- CreateEnum
CREATE TYPE "public"."NotificationType" AS ENUM ('BAZAAR_NEARBY', 'FOLLOWED_VENDOR_NEW_BAZAAR', 'EVENT_REMINDER');

-- CreateEnum
CREATE TYPE "public"."SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "public"."PayerType" AS ENUM ('VENDOR', 'ORGANIZER');

-- CreateEnum
CREATE TYPE "public"."PaymentPurpose" AS ENUM ('SUBSCRIPTION', 'BAZAAR_FEE');

-- CreateEnum
CREATE TYPE "public"."PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "public"."VendorType" AS ENUM ('BAZAAR_ONLY', 'MARKETPLACE', 'BOTH');

-- CreateEnum
CREATE TYPE "public"."ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."OrderStatus" AS ENUM ('PENDING', 'PAID', 'FULFILLED', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "location" geography(Point, 4326),
ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "public"."vendors" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "logo" TEXT,
    "coverMedia" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hasFixedLocation" BOOLEAN NOT NULL DEFAULT false,
    "homeLocation" geography(Point, 4326),
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionStatus" "public"."SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "vendorType" "public"."VendorType" NOT NULL DEFAULT 'BAZAAR_ONLY',
    "brandStory" TEXT,
    "logoUrl" TEXT,
    "bannerUrl" TEXT,
    "returnPolicy" TEXT,
    "shippingPolicy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."products" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "basePrice" MONEY NOT NULL,
    "images" TEXT[],
    "approvalStatus" "public"."ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."product_variants" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "size" TEXT,
    "color" TEXT,
    "priceOverride" MONEY,
    "stockQuantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."organizers" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "organizers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."bazaars" (
    "id" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "coverMedia" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "location" geography(Point, 4326) NOT NULL,
    "scheduleType" "public"."ScheduleType" NOT NULL,
    "recurrenceRule" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "public"."BazaarStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "bazaars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."booth_layouts" (
    "id" TEXT NOT NULL,
    "bazaarId" TEXT NOT NULL,
    "gridConfig" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booth_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."booths" (
    "id" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "positionX" INTEGER NOT NULL,
    "positionY" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "boothListingId" TEXT,

    CONSTRAINT "booths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."booth_listings" (
    "id" TEXT NOT NULL,
    "bazaarId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "applicationStatus" "public"."ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "booth_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."events" (
    "id" TEXT NOT NULL,
    "bazaarId" TEXT,
    "organizerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "public"."EventType" NOT NULL,
    "location" geography(Point, 4326) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "coverMedia" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."follows" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "followableType" "public"."FollowableType" NOT NULL,
    "followableId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."favorites" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "favorableType" "public"."FavorableType" NOT NULL,
    "favorableId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ratings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetType" "public"."RatingTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "public"."NotificationType" NOT NULL,
    "idempotencyKey" TEXT,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."subscriptions" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" "public"."SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "paymobRef" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payments" (
    "id" TEXT NOT NULL,
    "payerType" "public"."PayerType" NOT NULL,
    "payerId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "purpose" "public"."PaymentPurpose" NOT NULL,
    "paymobRef" TEXT,
    "status" "public"."PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."carts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."cart_items" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."order_groups" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paymobIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."orders" (
    "id" TEXT NOT NULL,
    "orderGroupId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "public"."OrderStatus" NOT NULL DEFAULT 'PENDING',
    "subtotal" MONEY NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "titleSnapshot" TEXT NOT NULL,
    "priceSnapshot" MONEY NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendors_ownerId_key" ON "public"."vendors"("ownerId");

-- CreateIndex
CREATE INDEX "vendors_category_idx" ON "public"."vendors"("category");

-- CreateIndex
CREATE INDEX "vendors_verified_idx" ON "public"."vendors"("verified");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "public"."categories"("slug");

-- CreateIndex
CREATE INDEX "products_vendorId_idx" ON "public"."products"("vendorId");

-- CreateIndex
CREATE INDEX "products_categoryId_idx" ON "public"."products"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_sku_key" ON "public"."product_variants"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "organizers_ownerId_key" ON "public"."organizers"("ownerId");

-- CreateIndex
CREATE INDEX "bazaars_status_idx" ON "public"."bazaars"("status");

-- CreateIndex
CREATE INDEX "bazaars_organizerId_idx" ON "public"."bazaars"("organizerId");

-- CreateIndex
CREATE UNIQUE INDEX "booth_layouts_bazaarId_key" ON "public"."booth_layouts"("bazaarId");

-- CreateIndex
CREATE UNIQUE INDEX "booths_boothListingId_key" ON "public"."booths"("boothListingId");

-- CreateIndex
CREATE INDEX "booths_layoutId_idx" ON "public"."booths"("layoutId");

-- CreateIndex
CREATE UNIQUE INDEX "booths_layoutId_label_key" ON "public"."booths"("layoutId", "label");

-- CreateIndex
CREATE INDEX "booth_listings_bazaarId_applicationStatus_idx" ON "public"."booth_listings"("bazaarId", "applicationStatus");

-- CreateIndex
CREATE INDEX "booth_listings_vendorId_idx" ON "public"."booth_listings"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "booth_listings_bazaarId_vendorId_key" ON "public"."booth_listings"("bazaarId", "vendorId");

-- CreateIndex
CREATE INDEX "events_organizerId_idx" ON "public"."events"("organizerId");

-- CreateIndex
CREATE INDEX "events_bazaarId_idx" ON "public"."events"("bazaarId");

-- CreateIndex
CREATE INDEX "events_startsAt_idx" ON "public"."events"("startsAt");

-- CreateIndex
CREATE INDEX "follows_followableType_followableId_idx" ON "public"."follows"("followableType", "followableId");

-- CreateIndex
CREATE UNIQUE INDEX "follows_userId_followableType_followableId_key" ON "public"."follows"("userId", "followableType", "followableId");

-- CreateIndex
CREATE INDEX "favorites_favorableType_favorableId_idx" ON "public"."favorites"("favorableType", "favorableId");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_userId_favorableType_favorableId_key" ON "public"."favorites"("userId", "favorableType", "favorableId");

-- CreateIndex
CREATE INDEX "ratings_targetType_targetId_idx" ON "public"."ratings"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "ratings_userId_targetType_targetId_key" ON "public"."ratings"("userId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_idempotencyKey_key" ON "public"."notifications"("idempotencyKey");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "public"."notifications"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_vendorId_key" ON "public"."subscriptions"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_paymobRef_key" ON "public"."payments"("paymobRef");

-- CreateIndex
CREATE INDEX "payments_payerType_payerId_idx" ON "public"."payments"("payerType", "payerId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "public"."payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "carts_userId_key" ON "public"."carts"("userId");

-- CreateIndex
CREATE INDEX "cart_items_cartId_idx" ON "public"."cart_items"("cartId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_cartId_variantId_key" ON "public"."cart_items"("cartId", "variantId");

-- CreateIndex
CREATE INDEX "orders_userId_idx" ON "public"."orders"("userId");

-- CreateIndex
CREATE INDEX "orders_vendorId_status_idx" ON "public"."orders"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "public"."users"("phone");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "public"."users"("role");

-- AddForeignKey
ALTER TABLE "public"."vendors" ADD CONSTRAINT "vendors_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."organizers" ADD CONSTRAINT "organizers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bazaars" ADD CONSTRAINT "bazaars_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "public"."organizers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."booth_layouts" ADD CONSTRAINT "booth_layouts_bazaarId_fkey" FOREIGN KEY ("bazaarId") REFERENCES "public"."bazaars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."booths" ADD CONSTRAINT "booths_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "public"."booth_layouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."booths" ADD CONSTRAINT "booths_boothListingId_fkey" FOREIGN KEY ("boothListingId") REFERENCES "public"."booth_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."booth_listings" ADD CONSTRAINT "booth_listings_bazaarId_fkey" FOREIGN KEY ("bazaarId") REFERENCES "public"."bazaars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."booth_listings" ADD CONSTRAINT "booth_listings_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."events" ADD CONSTRAINT "events_bazaarId_fkey" FOREIGN KEY ("bazaarId") REFERENCES "public"."bazaars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."events" ADD CONSTRAINT "events_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "public"."organizers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."follows" ADD CONSTRAINT "follows_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."favorites" ADD CONSTRAINT "favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ratings" ADD CONSTRAINT "ratings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."subscriptions" ADD CONSTRAINT "subscriptions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."carts" ADD CONSTRAINT "carts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cart_items" ADD CONSTRAINT "cart_items_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "public"."carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cart_items" ADD CONSTRAINT "cart_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cart_items" ADD CONSTRAINT "cart_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "public"."product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."order_groups" ADD CONSTRAINT "order_groups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_orderGroupId_fkey" FOREIGN KEY ("orderGroupId") REFERENCES "public"."order_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."order_items" ADD CONSTRAINT "order_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "public"."product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
