# Vendor Module Spec

**Status:** Draft for review
**Scope:** Direct vendor registration, vendor profile/storefront management, and product catalog management (CRUD for Products + ProductVariants) — modeled on how Talabat/Instashop bundle store setup and catalog management into one vendor-facing surface.
**Depends on:** `User`, `Vendor`, `Product`, `ProductVariant`, `Category` models (already migrated). Auth module (JWT, guards, password hashing patterns).
**Out of scope (this pass):** Booth/Bazaar-specific vendor flows (separate module), Cart/Checkout/Orders (separate module), Subscription/billing enforcement (flagged as open item), image upload for product photos (same S3 blocker as avatar upload — deferred).

---

## 1. Vendor Registration (Direct)

Unlike Shopper registration (email/password only), Vendor registration creates a `User` (role=VENDOR) AND a `Vendor` profile in a single transaction — no separate "apply to become a vendor" step, matching the direct-signup decision.

**Endpoint:** `POST /auth/register/vendor` (separate from existing `POST /auth/register`, which stays Shopper-only — keeps the "no multi-role accounts" rule enforced structurally: you pick your path at signup, not after)

**Request body:**
```
{
  email, password, ownerName,        // → User fields (name = ownerName)
  businessName, category,            // → Vendor required fields
  vendorType,                        // BAZAAR_ONLY | MARKETPLACE | BOTH
  description?                       // optional at signup, editable later
}
```

**Behavior:**
- Wrapped in a Prisma `$transaction`: create `User` (role=VENDOR, bcrypt-hashed password, same pattern as existing Auth registration) + create `Vendor` (ownerId = new user's id, verified=false, subscriptionStatus=TRIALING per schema default). If either insert fails, both roll back — no orphaned User-without-Vendor or vice versa.
- Reuses the existing enumeration-proof error pattern from Auth for the email-already-exists case (same generic error message as Shopper registration, don't leak whether the collision is email-only or full account).
- New vendor is NOT auto-verified (`verified: false`). Whether unverified vendors can immediately list products is an open item — see Section 5.
- Returns the same token pair shape as regular login (access + refresh), since after registering, the vendor should be logged in immediately — matches typical Talabat/Instashop vendor onboarding (register → land in dashboard, not register → wait → separately log in).

## 2. Vendor Profile Management

**Endpoints:**
- `GET /vendors/me` — own vendor profile (requires `@Roles(Role.VENDOR)`)
- `PATCH /vendors/me` — update `businessName`, `category`, `description`, `logo`, `coverMedia`, storefront fields (`brandStory`, `logoUrl`, `bannerUrl`, `returnPolicy`, `shippingPolicy`), `hasFixedLocation`/`homeLocation` (same lat/lng → PostGIS pattern as Users module's location endpoint — reuse that raw SQL approach, don't reinvent it)
- `GET /vendors/:id` — PUBLIC endpoint, shopper-facing storefront view. Only returns vendors where `verified: true` and `deletedAt: null` — unverified/deleted vendors 404 for public viewers (don't leak existence).

**Guardrails:**
- `verified`, `subscriptionStatus`, `ownerId` are never editable via `PATCH /vendors/me` — admin-only fields, rejected via the same `forbidNonWhitelisted` pattern used in the Users module (don't decorate them in the DTO, the global pipe rejects them automatically).
- `vendorType` change (e.g. BAZAAR_ONLY → BOTH) is allowed via this endpoint — no approval gate on this specific field, since it doesn't affect trust/safety, just what section of the app they appear in.

## 3. Product Catalog Management

Vendor-scoped — a vendor can only manage their own products (`vendorId` derived from the authenticated vendor's user, never trusted from the request body).

**Endpoints:**
- `GET /vendors/me/products` — paginated list of own products, all statuses (PENDING/APPROVED/REJECTED, including inactive) — this is the vendor's own dashboard view, unfiltered.
- `POST /vendors/me/products` — create product. Starts `approvalStatus: PENDING` always — vendor cannot self-approve (enforced by not exposing `approvalStatus` as a settable DTO field, same forbidNonWhitelisted pattern). **Requires `vendor.verified === true`** — reject with 403 if the calling vendor is not yet verified. This blocks catalog-building entirely until admin verification, per decision.
- `GET /vendors/me/products/:id` — single product detail (own only — 404 if `vendorId` doesn't match caller, not 403, to avoid confirming the ID exists).
- `PATCH /vendors/me/products/:id` — update `title`, `description`, `categoryId`, `basePrice`, `images`, `isActive`. **Any edit resets `approvalStatus` to `PENDING`** (and clears `rejectionReason` if previously rejected) — an approved product that gets edited must go back through admin review before it's publicly visible again. This applies even to trivial edits (e.g. toggling `isActive`) — implement uniformly, don't special-case which fields trigger re-review, to keep the rule simple and predictable for vendors.
- `DELETE /vendors/me/products/:id` — soft-delete (`deletedAt`), not hard delete (matches schema, preserves order history integrity per the fashion marketplace addendum's snapshot design).
- `POST /vendors/me/products/:id/variants` — add a variant (sku, size, color, priceOverride, stockQuantity)
- `PATCH /vendors/me/products/:id/variants/:variantId` — update a variant (e.g. restock — bump `stockQuantity`)
- `DELETE /vendors/me/products/:id/variants/:variantId` — remove a variant

**Public product browsing** (Shopper-facing, separate from vendor dashboard):
- `GET /products` — public, filterable by `categoryId`/`vendorId`, only returns `approvalStatus: APPROVED`, `isActive: true`, `deletedAt: null`, and — critically — only products belonging to a `verified: true` vendor (join filter). An approved product from an unverified vendor should not be publicly browsable — flagged as a deliberate compounding of the two approval gates, confirm this is the intended behavior (see Section 5).
- `GET /products/:id` — public single product detail, same visibility filters.

## 4. Admin Product Approval

Not building a full admin dashboard in this pass, but the minimum needed to unblock the above:

- `PATCH /admin/products/:id/approve` — `@Roles(Role.ADMIN)`, sets `approvalStatus: APPROVED`
- `PATCH /admin/products/:id/reject` — `@Roles(Role.ADMIN)`, sets `approvalStatus: REJECTED`, requires `reason` string in body, persisted to `Product.rejectionReason` (new field — see Section 6, schema addition required before implementation).

Admin vendor verification (`PATCH /admin/vendors/:id/verify`) is also needed here since Section 3's public product visibility depends on it — including it in this pass rather than leaving vendors permanently unable to go public.

## 5. Open Items For Discussion Before Implementation

1. **Subscription/billing gate** — schema has `subscriptionStatus` (TRIALING/ACTIVE/PAST_DUE/CANCELED) but this spec doesn't enforce anything based on it (e.g. blocking product creation if `PAST_DUE`). Out of scope until Payments module exists — flagging so it's not forgotten, not silently decided either way.

## 6. Required Schema Addition (Before Implementation)

`Product.rejectionReason String?` — needs a small Prisma migration, following the same pattern as the Users module's `phone`/`deletedAt` additions. This should be done as its own small scoped step before the main module implementation, same as prior schema-change steps in this project.
