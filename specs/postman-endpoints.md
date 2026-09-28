# Riven API — Postman endpoint reference

Generated from the controllers and DTOs in `apps/api/src` on 2026-09-19; re-checked route by route against the code on 2026-09-25 (all 120 routes). Paste each block into the request's **Description** in Postman.

**Base URL:** `http://localhost:3000` (no prefix). In the Postman workspace "Riven" (15 collections, environment "Riven") it is `{{URL}}` **with a trailing slash** — requests look like `{{URL}}auth/login` — and the Login request's test script saves the access token to `{{token}}`.

**Conventions that apply everywhere**
- Auth: `Authorization: Bearer <accessToken>` (15 min). Refresh with `POST /auth/refresh`.
- Bodies are JSON. Unknown fields are rejected (`400 VALIDATION_ERROR`).
- Errors are flat: `{ "code": "...", "message": "...", "details"?: {...} }`. For `VALIDATION_ERROR` the `message` is an array of strings. Codes that can come from any route: 400 `VALIDATION_ERROR` · 401 `INVALID_ACCESS_TOKEN` · 429 `RATE_LIMITED` · 409 `UNIQUE_VIOLATION` / 400 `INVALID_REFERENCE` / 404 `NOT_FOUND` (database constraint hits) · `HTTP_ERROR` (older routes without a specific code) · 500 `INTERNAL_SERVER_ERROR`. `TARGET_TYPE_UNSUPPORTED` (social) and 500 `INVALID_AMOUNT` (payment setup) are internal guards that validation normally prevents.
- Lists: `?page=` (>=1) and `?limit=` (1–100) → `{ data: [...], meta: { total, page, limit, totalPages } }`. Social/discovery lists use `?cursor=` instead → `{ data, nextCursor }`.
- Rate limits: 300 req/min per user or IP; 10/min on register/login; 30/min on refresh; 1/min on location updates → `429 RATE_LIMITED` + `Retry-After`.
- Money (EGP) comes back as a **decimal string without fixed places**: `"420"`, `"449.5"` (Prisma Decimal). Search hits carry prices as numbers. Send numbers with at most 2 decimals (`"basePrice": 450`). `paidAmountCents` (admin order detail) is integer piastres.
- Visibility rule: vendors and organizers are invisible to shoppers until an admin approves them. Products have no approval gate — a product is visible as soon as it's created, subject only to `isActive` and its vendor being verified and not deleted (product decision, 2026-09-27). A bazaar is public only while its organizer is verified and not deleted (spec3 B8b).

Enums used below
- `Role`: SHOPPER · VENDOR · ORGANIZER · ADMIN
- `VendorCategory`: FASHION · FOOD · HOME_CRAFTS · BEAUTY · ACCESSORIES · KIDS · ART · OTHER
- `VendorType`: BAZAAR_ONLY · MARKETPLACE · BOTH
- `OrderStatus`: PENDING · PAID · FULFILLED · SHIPPED · DELIVERED · CANCELLED
- `ScheduleType`: ONE_OFF · RECURRING — `BazaarStatus`: DRAFT · PUBLISHED · CANCELLED · COMPLETED
- `ApplicationStatus`: PENDING · ACCEPTED · REJECTED
- `FavorableType`: VENDOR · BAZAAR · PRODUCT · EVENT (not available) — `FollowableType`: VENDOR · BAZAAR — `RatingTargetType`: VENDOR · BAZAAR · PRODUCT · EVENT (not available)

---

## 1. Auth (`/auth`)

### POST /auth/register
Creates a **SHOPPER** account. Vendors and organizers use their own routes; `role` may be omitted or `"SHOPPER"` — anything else is rejected.
Auth: none. Limit 10/min.
Body: `{ "email", "password" (>=8 chars, at least 1 digit), "name" }`
201 → `{ id, email, name, role: "SHOPPER", createdAt }` — no tokens; log in next.
Errors: 400 VALIDATION_ERROR (a `role` other than SHOPPER: "only SHOPPER accounts can be created here") · 409 EMAIL_ALREADY_EXISTS (case-insensitive). The service also refuses other roles with 400 ROLE_NOT_SELF_ASSIGNABLE, as a second guard behind validation.

### POST /auth/register/vendor
Creates a VENDOR user **and** its vendor profile in one transaction. Profile starts unverified (hidden from shoppers) until an admin verifies it.
Auth: none. Limit 10/min.
Body: `{ "email", "password", "name" (person), "businessName" (<=120), "category": VendorCategory, "vendorType": VendorType, "description"? (<=2000) }`
201 → `{ accessToken, refreshToken, user: { id, email, name, role: "VENDOR" } }`
Errors: 400 VALIDATION_ERROR · 409 EMAIL_ALREADY_EXISTS.

### POST /auth/register/organizer
Creates an ORGANIZER user and its organizer profile. Starts unverified.
Auth: none. Limit 10/min.
Body: `{ "email", "password" (>=8), "name", "organizationName" }`
201 → `{ accessToken, refreshToken, user }`
Errors: 400 · 409 EMAIL_ALREADY_EXISTS.

### POST /auth/login
Exchanges credentials for a token pair. Same error for wrong email and wrong password (no user enumeration). A deleted account looks like it never existed; an admin-deactivated one gets a clear 403 — but only when the password is right.
Auth: none. Limit 10/min.
Body: `{ "email", "password" }`
201 → `{ accessToken (15m), refreshToken (30d), user: { id, email, name, role } }`
Errors: 401 INVALID_CREDENTIALS · 403 ACCOUNT_DEACTIVATED (correct password, account suspended by admin) · 429 RATE_LIMITED.

### POST /auth/refresh
Rotates the refresh token: the one you send is revoked and a new pair is issued. **Reusing an already-rotated token is treated as theft and revokes every session of that user.**
Auth: none. Limit 30/min.
Body: `{ "refreshToken" }`
201 → `{ accessToken, refreshToken, user }`
Errors: 401 INVALID_REFRESH_TOKEN (revoked, expired, unknown) · 403 ACCOUNT_DEACTIVATED.

### POST /auth/logout
Revokes one refresh token. Idempotent: returns 204 even if the token was already revoked or unknown. The access token stays valid until it expires (stateless JWT).
Auth: none (the token in the body identifies the session).
Body: `{ "refreshToken" }`
204 → empty.

### GET /auth/me
Returns the identity inside the access token. Use `GET /users/me` for the full profile.
Auth: any role.
200 → `{ id, email, name, role }`
Errors: 401 INVALID_ACCESS_TOKEN (also once the account is deactivated or deleted — the user is re-read on every request).

---

## 2. Users (`/users`, `/admin/users`)

### GET /users/me
Full profile of the logged-in user, including location if set.
Auth: any role.
200 → `{ id, name, email, phone, role, interests[], isActive, location: { lat, lng } | null, createdAt, updatedAt }`

### PATCH /users/me
Partial profile update. `phone` must be a valid Egyptian mobile number.
Auth: any role.
Body (all optional): `{ "name", "phone", "interests": string[] (<=20) }`
200 → updated profile. Errors: 400 · 409 UNIQUE_VIOLATION (phone already used).

### PATCH /users/me/location
Stores the user's current GPS position (PostGIS point) for discovery. **Limit 1/min.**
Auth: any role.
Body: `{ "lat": -90..90, "lng": -180..180 }`
204 → empty. Errors: 400 · 429.

### DELETE /users/me
Soft-deletes the account after re-checking the password. Revokes all sessions. If the user is a vendor/organizer, their vendor/organizer profile is soft-deleted too (products drop out of search).
Auth: any role.
Body: `{ "password" }`
204 → empty. Errors: 401 INVALID_PASSWORD.

### GET /admin/users
Paginated user list for moderation.
Auth: ADMIN.
Query: `role?`, `search?` (name/email), `includeDeleted?=true`, `page`, `limit`.
200 → `{ data: [{ id, name, email, phone, role, interests, isActive, location: null, createdAt, updatedAt }], meta }` (location only in the detail view; `isActive:false` = suspended by admin)

### GET /admin/users/:id
One user with profile details and location.
Auth: ADMIN. 200 → user. Errors: 404 USER_NOT_FOUND.

### PATCH /admin/users/:id/deactivate
Suspends the account: `isActive=false`, every session revoked; login answers 403 ACCOUNT_DEACTIVATED until reactivated. Already-suspended → 204 no-op (no audit row). Writes audit action USER_DEACTIVATED.
Auth: ADMIN. 204. Errors: 404 USER_NOT_FOUND · 400 CANNOT_DEACTIVATE_SELF · 400 USER_DELETED (owner-deleted accounts can't be moderated).

### PATCH /admin/users/:id/reactivate
Lifts the suspension: `isActive=true`. Already active → 204 no-op. Audit USER_REACTIVATED. Cannot resurrect an account its owner deleted.
Auth: ADMIN. 204. Errors: 404 USER_NOT_FOUND · 400 USER_DELETED.

---

## 3. Vendors (`/vendors`, `/admin/vendors`)

### GET /vendors/me
The logged-in vendor's own profile, including moderation fields (`verified`, `rejectionReason`, `subscriptionStatus`).
Auth: VENDOR. 200 → vendor. Errors: 404 VENDOR_PROFILE_NOT_FOUND.

### PATCH /vendors/me
Update storefront info. Does **not** reset verification. A `businessName` change also re-indexes the vendor's products (their search documents carry `vendorName`), like the admin edit.
Auth: VENDOR.
Body (all optional): `{ "businessName" (<=120), "category": VendorCategory, "description" (<=2000), "logo" (URL), "coverMedia": URL[] (<=10), "brandStory" (<=5000), "logoUrl", "bannerUrl", "returnPolicy" (<=5000), "shippingPolicy" (<=5000), "vendorType": VendorType, "hasFixedLocation": boolean }`
200 → vendor. Errors: 400 (enums are uppercase: `"category": "FASHION"`, not `"fashion"`) · 404 VENDOR_PROFILE_NOT_FOUND.

### PATCH /vendors/me/location
Sets the vendor's fixed home location. Limit 1/min.
Auth: VENDOR. Body: `{ "lat" (-90..90), "lng" (-180..180) }`. 204. Errors: 400 · 404 VENDOR_PROFILE_NOT_FOUND · 429.

### GET /vendors/:id
Public storefront. Only verified, non-deleted vendors are returned; internal fields (ownerId, subscriptionStatus, rejectionReason, isActive, deletedAt) are stripped.
Auth: none. 200 → public vendor. Errors: 404 VENDOR_NOT_FOUND.

### GET /vendors/me/products
The vendor's own catalog, soft-deleted ones excluded.
Auth: VENDOR. Query: `page`, `limit`. 200 → `{ data, meta }`.

### POST /vendors/me/products
Creates a product. It's immediately public — no approval gate — subject to `isActive` and the vendor being verified. Prices are EGP with <=2 decimals. `images` must be URLs (use `/media/upload-url` first). **Requires the vendor to be verified**, else 403 `VENDOR_NOT_VERIFIED`.
Auth: VENDOR.
Body: `{ "title", "description", "categoryId" (UUID from GET /categories), "basePrice", "images": URL[], "isActive"?: boolean }`
201 → product. Errors: 400 · 400 INVALID_REFERENCE (bad categoryId).

### GET /vendors/me/products/:id
One of the vendor's products with its live variants.
Auth: VENDOR. 200 → product. Errors: 404 PRODUCT_NOT_FOUND.

### PATCH /vendors/me/products/:id
Partial update. Only the given fields change — no approval state to reset.
Auth: VENDOR. Body: any subset of the create body. 200 → product. Errors: 404.

### DELETE /vendors/me/products/:id
Soft-delete (kept for order history). Removed from search.
Auth: VENDOR. 200 → the soft-deleted product row. Errors: 404 PRODUCT_NOT_FOUND.

### POST /vendors/me/products/:id/variants
Adds a sellable variant. Stock lives on the variant, not the product.
Auth: VENDOR.
Body: `{ "sku" (<=64, unique per vendor), "size"?, "color"?, "priceOverride"? (replaces basePrice), "stockQuantity"? (int >=0) }`
201 → variant. Errors: 404 PRODUCT_NOT_FOUND · 409 SKU_TAKEN.

### PATCH /vendors/me/products/:id/variants/:variantId
Partial variant update (e.g. restock).
Auth: VENDOR. Body: subset of the create body. 200 → variant. Errors: 404.

### DELETE /vendors/me/products/:id/variants/:variantId
Soft-deletes the variant; it disappears from carts and public reads.
Auth: VENDOR. 200 → the variant row. Errors: 404 PRODUCT_NOT_FOUND · 404 VARIANT_NOT_FOUND.

### GET /admin/vendors
Moderation queue.
Auth: ADMIN. Query: `status?` = pending | verified | rejected, `search?`, `page`, `limit`.
200 → `{ data: [vendor incl. owner email, verified, rejectionReason], meta }`

### GET /admin/vendors/:id
Full vendor detail in **any** state (pending, rejected, soft-deleted); the public `GET /vendors/:id` 404s on those.
Auth: ADMIN. 200 → vendor profile + `rejectionReason`, `deletedAt`, `owner: { id, name, email, isActive }`, `location: {lat,lng} | null`, `productCount: number` (non-deleted products of this vendor). Errors: 404 VENDOR_NOT_FOUND (also for a malformed id).

### PATCH /admin/vendors/:id/verify
Marks the vendor verified → storefront and its products become public and searchable. Clears `rejectionReason`. Idempotent. Audit VENDOR_VERIFIED.
Auth: ADMIN. 200 → vendor. Errors: 404.

### PATCH /admin/vendors/:id/reject
Rejects (or revokes a verified vendor). Products vanish from public reads.
Auth: ADMIN. Body: `{ "reason" (1–1000) }`. 200 → vendor. Errors: 400 · 404.
**This is also how admin suspends a vendor** (specs/admin-module-spec3.md B1): rejecting a verified vendor hides the shop and its products, removes them from search, and checkout refuses them; `verify` lifts it.

### PATCH /admin/vendors/:id
Admin edit of **text and images only** (spec3 B2). Verification is never touched — a verified vendor stays verified. Only changed fields are written; an unchanged body is a 200 no-op with no audit. A name change also re-indexes the vendor's products (their documents carry the vendor name). Audit VENDOR_EDITED.
Auth: ADMIN. Body (all optional): `{ "businessName" (1–120), "description" (<=2000), "brandStory" (<=5000), "returnPolicy" (<=5000), "shippingPolicy" (<=5000), "logo" (URL), "logoUrl", "bannerUrl", "coverMedia": URL[] (<=10) }`. Any other field (category, vendorType, verified, …) → 400.
200 → the admin vendor detail. Errors: 400 · 404 VENDOR_NOT_FOUND (also soft-deleted).

---

## 4. Products — public & admin (`/products`, `/admin/products`)

Products have no approval gate (product decision, 2026-09-27 — `specs/vendor-module-spec2.md`): a product is public as soon as it's created, subject only to `isActive`, `deletedAt`, and its vendor being verified and not deleted.

### GET /products
Public catalog: only active, non-deleted products of verified vendors.
Auth: none. Query: `categoryId?`, `vendorId?`, `search?` (<=200, case-insensitive match on title or description), `page`, `limit`.
200 → `{ data: [public product + variants], meta }`

### GET /products/:id
Public product detail with live variants and public vendor summary.
Auth: none. 200. Errors: 404 PRODUCT_NOT_FOUND (also when inactive/deleted/vendor unverified).

### GET /admin/products
Lists every non-deleted product.
Auth: ADMIN. Query: `vendorId?`, `page`, `limit`. 200 → `{ data, meta }`.

### GET /admin/products/:id
Full product detail regardless of state (inactive, soft-deleted); the public `GET /products/:id` 404s on those.
Auth: ADMIN. 200 → product + `deletedAt`, `vendor: { id, name, verified }`, `category: { id, name, slug }`, `variants[]` (all of them; removed ones have `deletedAt` set). Errors: 404 PRODUCT_NOT_FOUND.

### PATCH /admin/products/:id
Admin edit of **title, description and images only** (spec3 B2). Only changed fields are written; unchanged = 200 no-op, no audit. Re-indexes the product. Audit PRODUCT_EDITED.
Auth: ADMIN. Body (all optional): `{ "title" (1–200), "description" (<=5000), "images": URL[] (<=10) }`. Price, category, isActive → 400.
200 → the admin product detail. Errors: 400 · 404 PRODUCT_NOT_FOUND (also soft-deleted).

### DELETE /admin/products/:id
**Soft delete** (spec3 B3a): the row stays for order history; the product disappears from public reads and search. Cart lines are **not** removed — checkout refuses them as `PRODUCT_UNAVAILABLE`. Deleting an already-deleted product is a 204 no-op. Audit PRODUCT_DELETED.
Auth: ADMIN. 204. Errors: 404 PRODUCT_NOT_FOUND.

---

## 5. Categories

### GET /categories
Full category tree (roots with nested `children`). Use the `id` as `categoryId` when creating products.
Auth: none. 200 → `[{ id, name, slug, children: [...] }]`

### GET /admin/categories
Flat list (not paginated; the taxonomy is small), alphabetical, with usage counts.
Auth: ADMIN. 200 → `[{ id, name, slug, parentId, productCount, childCount }]` (`productCount` excludes soft-deleted products).

### POST /admin/categories
Creates a category. Audit CATEGORY_CREATED.
Auth: ADMIN. Body: `{ "name" (1–60, trimmed), "slug" (lowercase words joined by single hyphens, e.g. "maxi-dresses", <=60), "parentId"? (uuid; omit for a root) }`
201 → category `{ id, name, slug, parentId }`. Errors: 400 (validation, unknown field) · 404 CATEGORY_PARENT_NOT_FOUND · 409 CATEGORY_SLUG_TAKEN.

### PATCH /admin/categories/:id
Rename, re-slug and/or move. `parentId: null` moves it to the root; omitting a field leaves it unchanged. Audit CATEGORY_UPDATED — an identical PATCH is a 200 no-op with no audit row.
A slug change or a move re-indexes the search documents of every product in the category and its sub-categories (their `categorySlug`/`categoryPath` change); a rename alone doesn't need to.
Auth: ADMIN. Body: `{ "name"?, "slug"?, "parentId"?: uuid | null }` (at least one).
200 → category. Errors: 400 CATEGORY_UPDATE_EMPTY · 400 CATEGORY_CYCLE (under itself or a descendant) · 404 CATEGORY_NOT_FOUND · 404 CATEGORY_PARENT_NOT_FOUND · 409 CATEGORY_SLUG_TAKEN.

### DELETE /admin/categories/:id
Only an **unused** category (spec3 B3b): no products reference it — **soft-deleted products count** — and it has no sub-categories. Nothing is moved or cascaded; move them first. Audit CATEGORY_DELETED.
Auth: ADMIN. 204. Errors: 404 CATEGORY_NOT_FOUND · 409 CATEGORY_IN_USE with `details: { productCount, childCount }`.
Note: `GET /admin/categories` shows `productCount` *without* soft-deleted products, so a category listed with 0 can still be in use.

---

## 6. Cart (`/cart`) — SHOPPER only

### GET /cart
The shopper's cart. Lines carry public product/variant fields only. Reading doesn't create a cart: until the first `POST /cart/items` there is none, and the response is an empty placeholder with `id: ""`. The first Add Item creates the real cart (a uuid); Clear Cart empties it but keeps it.
Auth: SHOPPER. 200 → `{ id, userId, updatedAt, items: [{ id, productId, variantId, quantity, product, variant }] }`

### POST /cart/items
Adds a variant or increases its quantity. Product must be publicly visible; stock is checked.
Auth: SHOPPER. Body: `{ "productId", "variantId", "quantity" (>=1) }`
201 → cart item. Errors: 404 PRODUCT_UNAVAILABLE (unknown, hidden or removed product/variant) · 400 INSUFFICIENT_STOCK (`details.inStock`) · 400 INVALID_QUANTITY.

### PATCH /cart/items/:itemId
Sets the exact quantity; `0` removes the line. Stock is re-checked.
Auth: SHOPPER. Body: `{ "quantity" (>=0) }`. 200. Errors: 404 CART_ITEM_NOT_FOUND · 400 INSUFFICIENT_STOCK.

### DELETE /cart/items/:itemId
Removes one line. Auth: SHOPPER. 200. Errors: 404 CART_ITEM_NOT_FOUND.

### DELETE /cart
Empties the cart (the cart itself and its id stay). Auth: SHOPPER. 200.

---

## 7. Checkout (`/checkout`) — SHOPPER only

### POST /checkout
Turns the cart into one **OrderGroup** with one **Order per vendor**, reserves stock, empties the cart, and asks Paymob for a payment intention. If Paymob is not configured (local dev) the orders are still created and `paymentSetupFailed: true` is returned — call retry-payment later.
Auth: SHOPPER. Body: none.
201 → the OrderGroup (`id` = orderGroupId, `orders: [{ id, vendorId, status: "PENDING", subtotal, items }]`, …) plus `paymobIntentId`, `clientUrl` and `paymentSetupFailed: false` — or the OrderGroup with only `paymentSetupFailed: true` when Paymob isn't configured.
Errors: 400 CART_EMPTY · 400 CHECKOUT_ITEM_UNAVAILABLE (`details.items` lists the bad lines, each with `reason` PRODUCT_UNAVAILABLE or OUT_OF_STOCK) · 500 CHECKOUT_CONTENDED (too busy to reserve stock; retry) · 500 CHECKOUT_FAILED.
Note: a PENDING group that is never paid is auto-cancelled after 60 min and its stock released.

### POST /checkout/:orderGroupId/retry-payment
Requests a fresh Paymob intention for a still-PENDING group (e.g. after `paymentSetupFailed`).
Auth: SHOPPER (owner). 201 → payment fields. Errors: 404 ORDER_GROUP_NOT_FOUND · 403 ORDER_GROUP_FORBIDDEN (another shopper's checkout) · 400 PAYMENT_ALREADY_SET_UP (an intention already exists) · 400 ORDER_GROUP_NOT_PENDING · 503 PAYMENTS_NOT_CONFIGURED.

---

## 8. Orders — shopper (`/orders`) and vendor (`/vendors/me/orders`)

Status flow: PENDING → PAID (webhook) → FULFILLED → SHIPPED (vendor) → DELIVERED (shopper). PENDING or PAID → CANCELLED.

### GET /orders
The shopper's orders (one per vendor), newest first.
Auth: SHOPPER. Query: `status?`, `page`, `limit`. 200 → `{ data, meta }`.

### GET /orders/:id
One order with items and vendor summary.
Auth: SHOPPER (owner). 200. Errors: 404 ORDER_NOT_FOUND.

### PATCH /orders/:id/cancel
Cancels **the whole checkout group** this order belongs to (every PENDING order in it) and restores stock — Paymob intentions are per group, so cancel is per group. Only while PENDING.
Auth: SHOPPER (owner). Body: none.
200 → `{ cancelledOrderIds: [...] }`. Errors: 404 · 400 ORDER_NOT_CANCELLABLE · 409 ORDER_STATE_CHANGED.

### PATCH /orders/:id/confirm-delivery
Shopper confirms receipt: SHIPPED → DELIVERED. Unlocks rating the vendor/products of this order.
Auth: SHOPPER (owner). 200 → order. Errors: 404 · 400 ORDER_NOT_SHIPPED · 409 ORDER_STATE_CHANGED.

### GET /vendors/me/orders
The vendor's sub-orders with shopper contact (`user: { name, email, phone }`) — no `items` in the list.
Auth: VENDOR. Query: `status?`, `page`, `limit`. 200 → `{ data, meta }`.

### GET /vendors/me/orders/:id
One sub-order with items and shopper contact.
Auth: VENDOR (owner). 200. Errors: 404 ORDER_NOT_FOUND.

### PATCH /vendors/me/orders/:id/status
Vendor progresses fulfilment. Allowed: PAID → FULFILLED, FULFILLED → SHIPPED only.
Auth: VENDOR (owner). Body: `{ "status": "FULFILLED" | "SHIPPED" }`
200 → order. Errors: 400 VENDOR_TRANSITION_NOT_ALLOWED (any value other than FULFILLED/SHIPPED) · 400 INVALID_ORDER_TRANSITION (wrong current state; message lists allowed next states) · 409 ORDER_STATE_CHANGED.

### GET /admin/orders
Every order of every shopper and vendor, newest first.
Auth: ADMIN. Query: `status?` (OrderStatus), `vendorId?`, `userId?`, `orderGroupId?` (uuids), `page`, `limit`.
200 → `{ data: [order + vendor { id, name } + user { id, name, email }], meta }` — no items in list rows. Errors: 400 (bad enum/uuid, unknown query field).

### GET /admin/orders/:id
Any order, plus its `items` and the group's payment record: `orderGroup { id, createdAt, paidAt, paidAmountCents, paymobOrderId, paymobIntentId, paymobTransactionId }` — the Paymob ids appear on this admin route only, for payment support.
Auth: ADMIN. 200. Errors: 404 ORDER_NOT_FOUND.

### PATCH /admin/orders/:id/cancel
Cancels an **unpaid** order (spec3 B6) — the same rule as the shopper's cancel. It is **group-level**: every PENDING order of that checkout is cancelled (one payment covers the group) and their stock is restored. Already CANCELLED = 200 no-op. Audit ORDER_CANCELLED, one row per cancelled order. **No refunds**: a PAID order is refused.
Auth: ADMIN. 200 → `{ ...order, cancelledOrderIds: [...] }`. Errors: 400 ORDER_NOT_CANCELLABLE (PAID or later) · 404 ORDER_NOT_FOUND · 409 ORDER_STATE_CHANGED (paid while in flight).

---

## 9. Bazaars — public (`/bazaars`), organizer (`/organizers/me`), vendor applications, admin organizers

### GET /bazaars
Published bazaars, optionally near a point.
**Visibility rule** (same on detail, discovery, search, apply and ratings): a bazaar is public only if it is PUBLISHED, not deleted, **and its organizer is verified and not deleted** (spec3 B8b). Rejecting an organizer hides their bazaars; re-verifying brings them back — the bazaar's status is never changed.
Auth: none. Query: `lat?` (-90..90), `lng?` (-180..180), `radiusKm?` (0.1–150; all three together for proximity), `scheduleType?`, `page` (>=1), `limit` (1–100, default 20).
200 → `{ data: [bazaar + location {lat,lng}], meta }`

### GET /bazaars/:id
Published bazaar detail with `acceptedVendors` (verified vendors only).
Auth: none. 200. Errors: 404 BAZAAR_NOT_FOUND.

### GET /organizers/me
Organizer's own profile with moderation fields.
Auth: ORGANIZER. 200. Errors: 404 ORGANIZER_PROFILE_NOT_FOUND.

### PATCH /organizers/me
Auth: ORGANIZER. Body: `{ "name"? }`. 200.

### GET /organizers/me/bazaars
All of the organizer's bazaars, any status.
Auth: ORGANIZER. Query: `page`, `limit`. 200 → `{ data, meta }`.

### POST /organizers/me/bazaars
Creates a bazaar in DRAFT (not visible yet). Organizer must be verified.
Auth: ORGANIZER.
Body: `{ "name", "description"?, "coverMedia"?: URL[], "lat", "lng", "scheduleType": ScheduleType, "recurrenceRule"? (required when RECURRING), "startDate": ISO, "endDate"?: ISO }`
201 → bazaar. Errors: 400 VALIDATION_ERROR · 400 RECURRENCE_RULE_REQUIRED · 400 BAZAAR_END_BEFORE_START (`endDate` earlier than `startDate`; equal is allowed, omitted = single-day) · 403 ORGANIZER_NOT_VERIFIED.

### GET /organizers/me/bazaars/:id
Auth: ORGANIZER (owner). 200. Errors: 404 BAZAAR_NOT_FOUND.

### PATCH /organizers/me/bazaars/:id
Partial update, same fields as create. Re-indexes for search. Dates are checked against the stored ones they leave unchanged (a new `endDate` against the stored `startDate`, and vice versa); the database enforces the same rule (`bazaars_end_date_not_before_start`).
Auth: ORGANIZER (owner). 200. Errors: 404 BAZAAR_NOT_FOUND · 400 RECURRENCE_RULE_REQUIRED · 400 BAZAAR_END_BEFORE_START.

### PATCH /organizers/me/bazaars/:id/publish
DRAFT → PUBLISHED: visible to shoppers, searchable, vendors can apply. Emits `bazaar.published`.
Auth: ORGANIZER (owner). 200. Errors: 404 · 400 BAZAAR_NOT_DRAFT.

### PATCH /organizers/me/bazaars/:id/cancel
Any status except COMPLETED → CANCELLED; removed from public reads and search. Applications and booths untouched.
Auth: ORGANIZER (owner). 200. Errors: 404 BAZAAR_NOT_FOUND · 400 BAZAAR_COMPLETED.
An already CANCELLED bazaar is a 200 no-op: nothing is written or re-indexed (same as the admin cancel).

### GET /organizers/me/bazaars/:id/applications
Vendor applications for one bazaar.
Auth: ORGANIZER (owner). Query: `status?` = PENDING|ACCEPTED|REJECTED, `page`, `limit`. 200 → `{ data, meta }`.

### PATCH /organizers/me/bazaars/:id/applications/:applicationId/accept
PENDING → ACCEPTED. Emits `booth_listing.accepted`. The vendor can then be assigned a booth.
The write is guarded (only a still-PENDING row moves), like the admin decision, so an organizer and an admin deciding at the same moment can't overwrite each other.
Auth: ORGANIZER (owner). 200 → application. Errors: 404 APPLICATION_NOT_FOUND · 400 APPLICATION_NOT_PENDING · 409 APPLICATION_STATE_CHANGED (decided by someone else while in flight).

### PATCH /organizers/me/bazaars/:id/applications/:applicationId/reject
PENDING → REJECTED, same guarded write. Auth: ORGANIZER (owner). 200 → application. Errors: 404 APPLICATION_NOT_FOUND · 400 APPLICATION_NOT_PENDING · 409 APPLICATION_STATE_CHANGED.

### POST /bazaars/:id/apply
Vendor applies to a public bazaar (see the visibility rule under `GET /bazaars`). One application per vendor per bazaar. Vendor must be verified.
Auth: VENDOR. Body: none. 201 → application (PENDING). Errors: 403 VENDOR_NOT_VERIFIED · 400 BAZAAR_NOT_ACCEPTING_APPLICATIONS (unknown id, not PUBLISHED, deleted, or organizer rejected/deleted — this route never answers 404) · 409 APPLICATION_EXISTS.

### DELETE /bazaars/:id/apply
Withdraws a PENDING application. Auth: VENDOR. 204. Errors: 404.

### GET /vendors/me/bazaar-applications
The vendor's applications across bazaars.
Auth: VENDOR. Query: `status?`, `page`, `limit`. 200 → `{ data, meta }`.

### GET /admin/organizers
Moderation queue. Auth: ADMIN. Query: `status?` = pending|verified|rejected, `search?`, `page`, `limit`. 200 → `{ data, meta }`.

### PATCH /admin/organizers/:id/verify
Organizer can now create/publish bazaars. Clears `rejectionReason`. Automatically restores the public visibility of their PUBLISHED bazaars that a reject had hidden (spec3 B8b). Idempotent (repeat = 200, no audit). Audit ORGANIZER_VERIFIED.
Auth: ADMIN. 200 → `{ id, verified, rejectionReason }`. Errors: 404 ORGANIZER_NOT_FOUND. `:id` is the organizer id, not the user id.

### PATCH /admin/organizers/:id/reject
Rejects a pending organizer or revokes a verified one, with a reason. **Hides all their bazaars** from public reads, discovery, search and vendor applications (spec3 B8b); the bazaars' own status is not changed, so a later verify restores them. Same state and same reason = 200 no-op, no audit. Audit ORGANIZER_REJECTED.
Auth: ADMIN. Body: `{ "reason" (1–1000) }`. 200 → `{ id, verified, rejectionReason }`. Errors: 400 · 404 ORGANIZER_NOT_FOUND.

### GET /admin/bazaars
Every bazaar of every organizer, in any status, **DRAFT included** (every other route shows a DRAFT to its owner only). Newest first.
Auth: ADMIN. Query: `status?` (DRAFT|PUBLISHED|CANCELLED|COMPLETED), `organizerId?` (uuid), `search?` (name, case-insensitive), `includeDeleted?` (default false), `page`, `limit`.
200 → `{ data: [bazaar + location {lat,lng}, organizer { id, name, verified }], meta }`. Errors: 400 (bad enum/uuid, unknown query field).

### GET /admin/bazaars/:id
Any bazaar regardless of status, owner or soft-delete.
Auth: ADMIN. 200 → bazaar + `location`, `organizer { id, name, verified }`, `applicationCounts { PENDING, ACCEPTED, REJECTED }`, `hasLayout`. Errors: 404 BAZAAR_NOT_FOUND.

### PATCH /admin/bazaars/:id/cancel
Cancels any organizer's bazaar under **the organizer's own rule** (spec3 B7): any status except COMPLETED. Already CANCELLED = 200 no-op. Removes it from public reads and search; applications and booths are untouched; nobody is notified (no notifications system yet). Audit BAZAAR_CANCELLED.
Auth: ADMIN. 200 → admin bazaar detail. Errors: 400 BAZAAR_COMPLETED · 404 BAZAAR_NOT_FOUND (also soft-deleted).

### GET /admin/applications
Every booth application on every bazaar, newest first — no organizer or vendor scope.
Auth: ADMIN. Query: `bazaarId?` (uuid), `vendorId?` (uuid), `status?` (PENDING|ACCEPTED|REJECTED), `page`, `limit`.
200 → `{ data: [{ id, bazaarId, vendorId, applicationStatus, appliedAt, decidedAt, bazaar { id, name, status, startDate }, vendor { id, name, verified }, booth { id, label } | null }], meta }`. Errors: 400 (bad enum/uuid, unknown query field).

### GET /admin/applications/:id
One application, same shape as a list row; includes applications on soft-deleted bazaars.
Auth: ADMIN. 200. Errors: 404 APPLICATION_NOT_FOUND.

### PATCH /admin/applications/:id/accept · PATCH /admin/applications/:id/reject
Admin decides a **PENDING** application (spec3 B5), for any organizer's bazaar. Allowed: PENDING → ACCEPTED, PENDING → REJECTED. **No reversals** (ACCEPTED ↔ REJECTED). Repeating the decision it already has = 200 no-op. Accept fires the same booth-listing-accepted event as the organizer's accept. Audit APPLICATION_ACCEPTED / APPLICATION_REJECTED.
Auth: ADMIN. Reject body: `{ "reason"? (1–1000) }` — stored in the audit log only. 200 → application.
Errors: 400 APPLICATION_NOT_PENDING (already decided the other way) · 404 APPLICATION_NOT_FOUND · 409 APPLICATION_STATE_CHANGED (the organizer decided it while in flight).

---

## 10. Booth layouts (`/admin/bazaars/:bazaarId/layout`, `/admin/booths`, public layout)

All layout editing is ADMIN-only today (organizer self-serve is an open product item).

### POST /admin/bazaars/:bazaarId/layout
Creates the isometric grid for a bazaar (one per bazaar).
Auth: ADMIN. Body: `{ "gridConfig": { "rows" >=1, "cols" >=1, "cellSize" >=1, "background"? } }`
201 → layout. Errors: 404 BAZAAR_NOT_FOUND · 409 LAYOUT_EXISTS.

### GET /admin/bazaars/:bazaarId/layout
Layout with all booths and their assignments. Auth: ADMIN. 200. Errors: 404 LAYOUT_NOT_FOUND.

### PATCH /admin/bazaars/:bazaarId/layout
Replaces `gridConfig`. Auth: ADMIN. Body: same as create. 200. Errors: 404.

### POST /admin/bazaars/:bazaarId/layout/booths
Adds a booth to the grid. `label` is unique within the layout.
Auth: ADMIN. Body: `{ "label", "positionX" >=0, "positionY" >=0, "width" >=1, "height" >=1 }`
201 → booth. Errors: 404 · 409 BOOTH_LABEL_TAKEN.

### PATCH /admin/booths/:id
Move/resize/rename a booth. Auth: ADMIN. Body: any subset of the create body. 200. Errors: 404 BOOTH_NOT_FOUND.

### DELETE /admin/booths/:id
Deletes an **unassigned** booth. Auth: ADMIN. 200. Errors: 404 BOOTH_NOT_FOUND · 400 BOOTH_ASSIGNED.

### PATCH /admin/booths/:id/assign
Puts an ACCEPTED vendor application into a booth.
Auth: ADMIN. Body: `{ "boothListingId": "<application id>" }`
200 → booth. Errors: 404 BOOTH_NOT_FOUND / APPLICATION_NOT_FOUND · 400 BOOTH_ASSIGNED · 400 APPLICATION_NOT_ACCEPTED · 400 APPLICATION_BAZAAR_MISMATCH · 409 APPLICATION_ALREADY_ASSIGNED (the application already has another booth).

### PATCH /admin/booths/:id/unassign
Frees the booth. Auth: ADMIN. 200. Errors: 404.

All booth-layout writes above are audited (spec3 B8c): layout create/update → BOOTH_LAYOUT_CREATED/UPDATED on the bazaar; booth create/update/delete/assign/unassign → BOOTH_* on the booth. Unassigning an already-free booth is a no-op with no audit.

### GET /bazaars/:bazaarId/layout
Public map for a PUBLISHED bazaar: every booth with `vendor: { vendorId, businessName, logo } | null` (revoked/deleted vendors show as empty).
Auth: none. 200. Errors: 404 BAZAAR_NOT_FOUND · 404 LAYOUT_NOT_FOUND.

---

## 11. Discovery (`/discovery`)

### GET /discovery/bazaars
"Bazaars near me" feed: PUBLISHED bazaars within `radiusKm` of a point, nearest first, keyset-paged. Send a Bearer token (optional) to get `isFavorite` per row.
Auth: optional.
Query: `lat`, `lng` (both or neither), `radiusKm` 1–150 (default 25), `scheduleType?`, `upcomingOnly?` (default true), `limit` 1–50, `cursor?`.
200 → `{ data: [{ id, name, coverMedia, scheduleType, startDate, endDate, location, distanceKm, isFavorite, organizer }], nextCursor }`
Errors: 400 VALIDATION_ERROR (lat without lng, radius out of range) · 400 INVALID_CURSOR (the cursor doesn't fit the query, e.g. after dropping lat/lng; restart the list).
Without `lat`/`lng` the results are ordered by start date, not distance; the location saved with `PATCH /users/me/location` isn't used.

---

## 12. Search (`/search`, `/admin/search`) — Meilisearch

All search routes: `q` (1–100 chars after trimming, required), optional `lat`/`lng` + `radiusKm` (1–150) for geo filtering, `page`, `limit` (<=50). Optional Bearer token adds `isFavorite`. Errors on every search route: 400 VALIDATION_ERROR · 400 SEARCH_QUERY_INVALID (the search engine rejected the query or filters) · 503 SEARCH_UNAVAILABLE (search is down; retry).

### GET /search
Federated overview: top hits for products, vendors and bazaars in one call.
Query: `q`, `types?` = comma list of `products,vendors,bazaars` (plural; omit = all three; anything else → 400 SEARCH_TYPE_INVALID), `limit` per type (1–20, default 10).
200 → `{ products: { hits, estimatedTotalHits, page, limit }, vendors: { … }, bazaars: { … } }` — each key has the same shape as its single-index route.

### GET /search/products
Query: `q`, `categoryId?`, `category?` (slug), `vendorId?`, `minPrice?`, `maxPrice?`, `size?`, `color?`, `sort?` (relevance | price_asc | price_desc | newest), `page`, `limit`.
200 → `{ hits: [...], estimatedTotalHits, page, limit }`. Only publicly visible products are indexed.

### GET /search/vendors
Query: `q`, `category?`: VendorCategory, `vendorType?`, geo, `page`, `limit`. 200 → `{ hits, estimatedTotalHits, page, limit }`. Verified vendors only.

### GET /search/bazaars
Query: `q`, `scheduleType?`, `upcomingOnly?` (default true), geo, `page`, `limit`. 200 → `{ hits, estimatedTotalHits, page, limit }`. PUBLISHED only.

### POST /admin/search/reindex
Queues a full rebuild of one or all indexes from Postgres.
Auth: ADMIN. Body: `{ "types"?: ["products","vendors","bazaars"] }` (omit = all).
202 → `{ enqueued: [...] }`. Audited: one SEARCH_REINDEX_REQUESTED row per index (spec3 B8c).

---

## 13. Social (`/social`)

### POST /social/favorites
Save a vendor, bazaar or product. Target must be publicly visible. Idempotent.
Auth: SHOPPER. Body: `{ "favorableType": VENDOR|BAZAAR|PRODUCT, "favorableId": UUID }`
200 → favorite. Errors: 404 TARGET_NOT_FOUND (also for EVENT — not available yet).

### DELETE /social/favorites
Body: `{ "favorableType", "favorableId" }`. Auth: SHOPPER. 200 → `{ success: true }`.

### GET /social/favorites
Auth: any role. Query: `favorableType?`, `limit` <=100, `cursor?`. 200 → `{ data, nextCursor }`.

### POST /social/follows
Follow a vendor or bazaar (for future notifications). Idempotent.
Auth: SHOPPER. Body: `{ "followableType": VENDOR|BAZAAR, "followableId" }`. 200. Errors: 404 TARGET_NOT_FOUND.

### DELETE /social/follows
Body: `{ "followableType", "followableId" }`. Auth: SHOPPER. 200 → `{ success: true }`.

### GET /social/follows
Auth: any role. Query: `followableType?`, `limit`, `cursor?`. 200 → `{ data, nextCursor }`.

### POST /social/ratings
One rating per user per target (upsert). VENDOR and PRODUCT ratings require `orderId` of a **DELIVERED** order that contains that vendor/product. BAZAAR ratings need no order but the bazaar must be PUBLISHED or COMPLETED.
Auth: SHOPPER. Body: `{ "targetType": VENDOR|BAZAAR|PRODUCT, "targetId", "score" 1–5, "comment"? (<=2000), "orderId"? }`
200 → rating. Errors: 400 ORDER_ID_REQUIRED · 403 NOT_VERIFIED_PURCHASE (no DELIVERED order of yours contains it) · 404 BAZAAR_NOT_FOUND (bazaar not PUBLISHED or COMPLETED) · 404 TARGET_NOT_FOUND (EVENT, not available yet).

### GET /social/ratings/summary
Public average and count. Query: `targetType`, `targetId`. 200 → `{ average, count }`.

### GET /social/ratings
Public list of ratings for a target. Query: `targetType`, `targetId`, `limit`, `cursor?`. 200 → `{ data: [{ id, targetType, targetId, score, comment, createdAt, reviewerName }], nextCursor }` — the reviewer's name only; no user id or email.

### GET /admin/ratings
Moderation queue over every rating, newest first. Page-based (not a cursor like the public list).
Auth: ADMIN. Query: `targetType?` (VENDOR|BAZAAR|PRODUCT|EVENT), `targetId?`, `userId?` (reviewer; uuids), `hasComment?` (true|false — an empty comment counts as none), `maxScore?` (1–5, inclusive: `maxScore=2` = the low ratings), `page`, `limit`.
200 → `{ data: [{ id, targetType, targetId, score, comment, orderId, createdAt, updatedAt, user { id, name, email, isActive } }], meta }`. Errors: 400 (bad enum/uuid/boolean, score out of range, unknown query field).
Useful view: `?hasComment=true&maxScore=2`.

### DELETE /admin/ratings/:id
Removes a fake rating entirely — score and comment (spec3 B3c). Hard delete (ratings have no soft delete); the rating summary recomputes on read. Audit RATING_DELETED.
Auth: ADMIN. 204. Errors: 404 RATING_NOT_FOUND.

### PATCH /admin/ratings/:id/clear-comment
Removes abusive text but **keeps the score** (spec3 B3c). A comment that's already empty is a 200 no-op. Audit RATING_COMMENT_CLEARED.
Auth: ADMIN. 200 → rating (`comment: null`). Errors: 404 RATING_NOT_FOUND.

---

## 14. Media (`/media`)

### POST /media/upload-url
Returns a presigned **PUT** URL for MinIO/S3. Upload the file to `uploadUrl` with the same `Content-Type`, then store `publicUrl` in the product/vendor/bazaar field. URL is valid for a few minutes. Size limit (10 MB) is client-enforced.
Auth: VENDOR or ORGANIZER.
Body: `{ "purpose": PRODUCT_IMAGE|VENDOR_LOGO|VENDOR_COVER|BAZAAR_COVER, "contentType": image/jpeg|image/png|image/webp }`
200 → `{ uploadUrl, publicUrl, key, expiresInSeconds }`
Errors: 400 VALIDATION_ERROR · 403.

---

## 15. Admin dashboard (`/admin/overview`, `/admin/audit-log`)

### GET /admin/overview
Home-screen counters: pending vendors/organizers (products have no approval gate — no `pending.products`), totals per role, orders by status.
Auth: ADMIN. 200 → `{ pending: { vendors, organizers }, totals: {...}, orders: {...} }`.

### GET /admin/audit-log
Who did what to whom. Newest first.
Auth: ADMIN. Query: `actorId?`, `targetType?`, `targetId?`, `action?`, `page`, `limit`.
- `targetType`: VENDOR · ORGANIZER · PRODUCT · USER · CATEGORY · RATING · APPLICATION · ORDER · BAZAAR · BOOTH · SEARCH_INDEX
- `action`: VENDOR_VERIFIED · VENDOR_REJECTED · VENDOR_EDITED · ORGANIZER_VERIFIED · ORGANIZER_REJECTED · PRODUCT_APPROVED (historical only, nothing writes it since 2026-09-27) · PRODUCT_REJECTED (historical only) · PRODUCT_EDITED · PRODUCT_DELETED · USER_DEACTIVATED · USER_REACTIVATED · CATEGORY_CREATED · CATEGORY_UPDATED · CATEGORY_DELETED · RATING_DELETED · RATING_COMMENT_CLEARED · APPLICATION_ACCEPTED · APPLICATION_REJECTED · ORDER_CANCELLED · BAZAAR_CANCELLED · BOOTH_LAYOUT_CREATED · BOOTH_LAYOUT_UPDATED · BOOTH_CREATED · BOOTH_UPDATED · BOOTH_DELETED · BOOTH_ASSIGNED · BOOTH_UNASSIGNED · SEARCH_REINDEX_REQUESTED

200 → `{ data: [{ id, actorId, action, targetType, targetId, reason, createdAt }], meta }`. Idempotent no-op repeats write no row.

---

## 16. Infra

### GET /health
Liveness. Auth: none. 200 → `{ "status": "ok" }`.

### POST /webhooks/paymob
Paymob calls this — not for Postman. Requires a valid HMAC (`?hmac=` or header); marks the order group PAID. Errors: 401 WEBHOOK_SIGNATURE_MISSING (no HMAC) · 401 WEBHOOK_SIGNATURE_INVALID (HMAC doesn't match).

---

## Not available (spec only)
Password reset · email verification · admin self-registration (promote a user in the DB) · GET /discovery/vendors · notifications · payments/subscriptions endpoints · organizer-side layout editing.
