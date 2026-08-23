# Fashion Marketplace Addendum Spec

**Status:** Draft for review
**Scope:** Extends `specs/schema.prisma` and future Vendor/Commerce modules to support a fashion marketplace layer (small brands & boutiques) alongside the original bazaar/discovery model.
**Depends on:** Existing `User`, `RefreshToken` models (implemented). `Vendor`, `Organizer`, `Bazaar`, `Booth*` models (drafted in specs, not yet implemented).

---

## 1. Decisions Locked (Confirmed by Ibrahim)

- **Cart model: multi-vendor — CONFIRMED.** A single cart can hold items from multiple vendors. At checkout, the cart splits into one `Order` per vendor (sub-orders), sharing an `OrderGroup` for grouping in the UI and for a single Paymob payment intent.
- **Categories: managed taxonomy table — CONFIRMED.** `Product.category` is a relation to a `Category` model, not a free string. See Section 2b.
- **Approval-gated visibility applies to Products**, consistent with existing Booth/Listing pattern — a `Product` is only visible to Shoppers once `approvalStatus = APPROVED`.
- **No multi-role accounts** — a Vendor account with `vendorType` including `MARKETPLACE` still just has one `User` row with `role = VENDOR`.

---

## 2. Vendor Entity Extension

Extend the existing (drafted, not yet implemented) `Vendor` model:

```prisma
enum VendorType {
  BAZAAR_ONLY
  MARKETPLACE
  BOTH
}

model Vendor {
  // ...existing fields (userId, businessName, approvalStatus, etc.)
  vendorType      VendorType @default(BAZAAR_ONLY)

  // Storefront metadata (only relevant when vendorType includes MARKETPLACE)
  brandStory      String?
  logoUrl         String?
  bannerUrl       String?
  returnPolicy    String?
  shippingPolicy  String?

  products        Product[]
  orders          Order[]
}
```

## 2b. Category Taxonomy

```prisma
model Category {
  id          String     @id @default(uuid())
  name        String
  slug        String     @unique
  parentId    String?
  parent      Category?  @relation("CategoryHierarchy", fields: [parentId], references: [id])
  children    Category[] @relation("CategoryHierarchy")

  products    Product[]

  @@map("categories")
}
```

- Self-referencing hierarchy (e.g. `Women > Dresses > Maxi Dresses`) supports faceted browsing/search later without a schema change.
- Seed with an initial flat or lightly-nested set (v1) — no need to build a full admin taxonomy editor yet; Admin can manage via direct DB/seed script until an admin UI exists.
- `slug` used for URL/search-friendly filtering.

## 3. Product & Variant Models

```prisma
enum ApprovalStatus {
  PENDING
  APPROVED
  REJECTED
}

model Product {
  id              String   @id @default(uuid())
  vendorId        String
  vendor          Vendor   @relation(fields: [vendorId], references: [id])

  title           String
  description     String
  categoryId      String
  category        Category @relation(fields: [categoryId], references: [id])
  basePrice       Decimal  @db.Money
  images          String[]

  approvalStatus  ApprovalStatus @default(PENDING)
  isActive        Boolean  @default(true)

  variants        ProductVariant[]
  cartItems       CartItem[]
  orderItems      OrderItem[]

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@map("products")
}

model ProductVariant {
  id              String   @id @default(uuid())
  productId       String
  product         Product  @relation(fields: [productId], references: [id])

  sku             String   @unique
  size            String?
  color           String?
  priceOverride   Decimal? @db.Money   // null = use Product.basePrice
  stockQuantity   Int      @default(0)

  cartItems       CartItem[]
  orderItems      OrderItem[]

  @@map("product_variants")
}
```

**Note:** Stock decrement happens at order creation (checkout), not at add-to-cart, to avoid holding stock hostage in abandoned carts. Consider a short reservation TTL (e.g. 10 min) in a later iteration if overselling becomes an issue — out of scope for v1.

## 4. Cart, Checkout & Orders

```prisma
model Cart {
  id          String     @id @default(uuid())
  userId      String     @unique
  user        User       @relation(fields: [userId], references: [id])
  items       CartItem[]
  updatedAt   DateTime   @updatedAt

  @@map("carts")
}

model CartItem {
  id          String   @id @default(uuid())
  cartId      String
  cart        Cart     @relation(fields: [cartId], references: [id])
  productId   String
  product     Product  @relation(fields: [productId], references: [id])
  variantId   String
  variant     ProductVariant @relation(fields: [variantId], references: [id])
  quantity    Int      @default(1)

  @@unique([cartId, variantId])
  @@map("cart_items")
}

enum OrderStatus {
  PENDING
  PAID
  FULFILLED
  SHIPPED
  DELIVERED
  CANCELLED
}

// Groups sub-orders created from a single checkout action (multi-vendor cart)
model OrderGroup {
  id              String   @id @default(uuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id])
  orders          Order[]
  paymobIntentId  String?
  createdAt       DateTime @default(now())

  @@map("order_groups")
}

// One Order per vendor per checkout
model Order {
  id              String   @id @default(uuid())
  orderGroupId    String
  orderGroup      OrderGroup @relation(fields: [orderGroupId], references: [id])
  vendorId        String
  vendor          Vendor   @relation(fields: [vendorId], references: [id])
  userId          String
  user            User     @relation(fields: [userId], references: [id])

  status          OrderStatus @default(PENDING)
  subtotal        Decimal  @db.Money
  items           OrderItem[]

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@map("orders")
}

model OrderItem {
  id              String   @id @default(uuid())
  orderId         String
  order           Order    @relation(fields: [orderId], references: [id])
  productId       String
  product         Product  @relation(fields: [productId], references: [id])
  variantId       String
  variant         ProductVariant @relation(fields: [variantId], references: [id])

  // Snapshot at purchase time — never read from Product/Variant after order creation
  titleSnapshot   String
  priceSnapshot   Decimal  @db.Money
  quantity        Int

  @@map("order_items")
}
```

**Price/variant snapshotting is mandatory**: `OrderItem` stores its own `titleSnapshot`/`priceSnapshot` so historical orders remain accurate even if the vendor later edits or deletes the product.

## 5. Order Status Lifecycle

```
PENDING → PAID → FULFILLED → SHIPPED → DELIVERED
              ↘ CANCELLED (from PENDING or PAID only)
```

- `PENDING → PAID`: triggered by Paymob webhook confirmation.
- `PAID → FULFILLED`: Vendor marks items packed/ready.
- `FULFILLED → SHIPPED`: Vendor marks shipped (tracking number optional field, future).
- `SHIPPED → DELIVERED`: Vendor or Shopper confirms (TBD which — flag for implementation discussion).
- `CANCELLED`: only allowed pre-fulfillment, initiated by Shopper (before PAID) or Vendor/Admin (PAID, pre-fulfillment, requires refund handling — out of scope for v1 spec, needs a follow-up Payments spec).

## 6. API Surface (high-level, for module planning)

- `GET /products` — public, approved only, filterable by vendor/category
- `POST /products` — Vendor only, creates in PENDING
- `PATCH /products/:id/approve` — Admin only
- `GET/POST/PATCH/DELETE /cart` — Shopper only, own cart
- `POST /checkout` — Shopper only, creates OrderGroup + Orders from cart, initiates Paymob intent
- `GET /orders` — Shopper: own orders. Vendor: own-vendor orders. Admin: all.
- `PATCH /orders/:id/status` — Vendor (own orders) or Admin

## 7. Open Items For Discussion Before Implementation

1. Who confirms `SHIPPED → DELIVERED` — Vendor, Shopper, or auto-timeout?
2. Refund/cancellation-after-payment flow — needs its own Payments spec addendum.
3. Stock reservation strategy for high-demand items (deferred to v2).
4. Initial category seed list — needs Ibrahim's input on actual categories/subcategories for Egyptian fashion market (e.g. Women/Men/Kids top-level, then subcategories).
