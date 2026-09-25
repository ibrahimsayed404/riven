# Riven API — Postman endpoint reference

Generated from the controllers and DTOs in `apps/api/src` on 2026-09-19. Paste each block into the request's **Description** in Postman.

**Base URL:** `http://localhost:3000` (no prefix). Suggested Postman variable: `{{baseUrl}}`.

**Conventions that apply everywhere**
- Auth: `Authorization: Bearer <accessToken>` (15 min). Refresh with `POST /auth/refresh`.
- Bodies are JSON. Unknown fields are rejected (`400 VALIDATION_ERROR`).
- Errors are flat: `{ "code": "...", "message": "...", "details"?: {...} }`.
- Lists: `?page=` (>=1) and `?limit=` (1–100) → `{ data: [...], meta: { total, page, limit, totalPages } }`. Social/discovery lists use `?cursor=` instead → `{ data, nextCursor }`.
- Rate limits: 300 req/min per user or IP; 10/min on register/login; 30/min on refresh; 1/min on location updates → `429 RATE_LIMITED` + `Retry-After`.
- Money is a decimal string with 2 places (`"249.00"`).
- Visibility rule: vendors, organizers and products are invisible to shoppers until an admin approves them. Editing a product sends it back to `PENDING`.

Enums used below
- `Role`: SHOPPER · VENDOR · ORGANIZER · ADMIN
- `VendorCategory`: FASHION · FOOD · HOME_CRAFTS · BEAUTY · ACCESSORIES · KIDS · ART · OTHER
- `VendorType`: BAZAAR_ONLY · MARKETPLACE · BOTH
- `ApprovalStatus`: PENDING · APPROVED · REJECTED
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
Errors: 400 VALIDATION_ERROR · 409 EMAIL_ALREADY_EXISTS (case-insensitive).

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
200 → `{ id, email, role }`
Errors: 401.

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
Auth: VENDOR. 200 → vendor. Errors: 404 VENDOR_NOT_FOUND.

### PATCH /vendors/me
Update storefront info. Does **not** reset verification.
Auth: VENDOR.
Body (all optional): `{ "businessName" (<=120), "category": VendorCategory, "description" (<=2000), "logo" (URL), "coverMedia": URL[] (<=10), "brandStory" (<=5000), "logoUrl", "bannerUrl", "returnPolicy" (<=5000), "shippingPolicy" (<=5000), "vendorType": VendorType, "hasFixedLocation": boolean }`
200 → vendor. Errors: 400.

### PATCH /vendors/me/location
Sets the vendor's fixed home location. Limit 1/min.
Auth: VENDOR. Body: `{ "lat", "lng" }`. 204.

### GET /vendors/:id
Public storefront. Only verified, non-deleted vendors are returned; internal fields (ownerId, subscriptionStatus, rejectionReason, isActive, deletedAt) are stripped.
Auth: none. 200 → public vendor. Errors: 404 VENDOR_NOT_FOUND.

### GET /vendors/me/products
The vendor's own catalog, every approval status, soft-deleted ones excluded.
Auth: VENDOR. Query: `page`, `limit`. 200 → `{ data, meta }`.

### POST /vendors/me/products
Creates a product in `PENDING` approval. Prices are EGP with <=2 decimals. `images` must be URLs (use `/media/upload-url` first).
Auth: VENDOR.
Body: `{ "title", "description", "categoryId" (UUID from GET /categories), "basePrice", "images": URL[], "isActive"?: boolean }`
201 → product. Errors: 400 · 400 INVALID_REFERENCE (bad categoryId).

### GET /vendors/me/products/:id
One of the vendor's products with its live variants.
Auth: VENDOR. 200 → product. Errors: 404 PRODUCT_NOT_FOUND.

### PATCH /vendors/me/products/:id
Partial update. **Any edit resets `approvalStatus` to PENDING** and removes the product from public listings/search until re-approved.
Auth: VENDOR. Body: any subset of the create body. 200 → product. Errors: 404.

### DELETE /vendors/me/products/:id
Soft-delete (kept for order history). Removed from search.
Auth: VENDOR. 200/204. Errors: 404.

### POST /vendors/me/products/:id/variants
Adds a sellable variant. Stock lives on the variant, not the product.
Auth: VENDOR.
Body: `{ "sku" (<=64, unique per vendor), "size"?, "color"?, "priceOverride"? (replaces basePrice), "stockQuantity"? (int >=0) }`
201 → variant. Errors: 404 · 409 UNIQUE_VIOLATION (sku).

### PATCH /vendors/me/products/:id/variants/:variantId
Partial variant update (e.g. restock).
Auth: VENDOR. Body: subset of the create body. 200 → variant. Errors: 404.

### DELETE /vendors/me/products/:id/variants/:variantId
Soft-deletes the variant; it disappears from carts and public reads.
Auth: VENDOR. 200/204. Errors: 404.

### GET /admin/vendors
Moderation queue.
Auth: ADMIN. Query: `status?` = pending | verified | rejected, `search?`, `page`, `limit`.
200 → `{ data: [vendor incl. owner email, verified, rejectionReason], meta }`

### GET /admin/vendors/:id
Full vendor detail in **any** state (pending, rejected, soft-deleted); the public `GET /vendors/:id` 404s on those.
Auth: ADMIN. 200 → vendor profile + `rejectionReason`, `deletedAt`, `owner: { id, name, email, isActive }`, `location: {lat,lng} | null`, `productCounts: { PENDING, APPROVED, REJECTED }`. Errors: 404 VENDOR_NOT_FOUND (also for a malformed id).

### PATCH /admin/vendors/:id/verify
Marks the vendor verified → storefront and its APPROVED products become public and searchable. Clears `rejectionReason`. Idempotent. Audit VENDOR_VERIFIED.
Auth: ADMIN. 200 → vendor. Errors: 404.

### PATCH /admin/vendors/:id/reject
Rejects (or revokes a verified vendor). Products vanish from public reads.
Auth: ADMIN. Body: `{ "reason" (1–1000) }`. 200 → vendor. Errors: 400 · 404.

---

## 4. Products — public & admin (`/products`, `/admin/products`)

### GET /products
Public catalog: only APPROVED, active, non-deleted products of verified vendors.
Auth: none. Query: `categoryId?`, `vendorId?`, `search?` (<=200, title match), `page`, `limit`.
200 → `{ data: [public product + variants], meta }`

### GET /products/:id
Public product detail with live variants and public vendor summary.
Auth: none. 200. Errors: 404 PRODUCT_NOT_FOUND (also when pending/rejected/vendor unverified).

### GET /admin/products
Moderation queue for products.
Auth: ADMIN. Query: `approvalStatus?`, `vendorId?`, `page`, `limit`. 200 → `{ data, meta }`.

### GET /admin/products/:id
Full product detail in **any** state (pending, rejected, inactive, soft-deleted); the public `GET /products/:id` 404s on those.
Auth: ADMIN. 200 → product + `deletedAt`, `vendor: { id, name, verified }`, `category: { id, name, slug }`, `variants[]` (all of them; removed ones have `deletedAt` set). Errors: 404 PRODUCT_NOT_FOUND.

### PATCH /admin/products/:id/approve
Sets APPROVED and indexes the product for search (visible only if the vendor is verified). Idempotent. Audit PRODUCT_APPROVED.
Auth: ADMIN. 200 → product. Errors: 404.

### PATCH /admin/products/:id/reject
Sets REJECTED with a reason the vendor sees on `GET /vendors/me/products/:id`.
Auth: ADMIN. Body: `{ "reason" }`. 200. Errors: 400 · 404.

---

## 5. Categories

### GET /categories
Full category tree (roots with nested `children`). Use the `id` as `categoryId` when creating products.
Auth: none. 200 → `[{ id, name, slug, children: [...] }]`

---

## 6. Cart (`/cart`) — SHOPPER only

### GET /cart
The shopper's cart (created on first read). Lines carry public product/variant fields only.
Auth: SHOPPER. 200 → `{ id, userId, items: [{ id, productId, variantId, quantity, product, variant }] }`

### POST /cart/items
Adds a variant or increases its quantity. Product must be publicly visible; stock is checked.
Auth: SHOPPER. Body: `{ "productId", "variantId", "quantity" (>=1) }`
201 → cart item. Errors: 404 PRODUCT_NOT_FOUND · 400 INSUFFICIENT_STOCK (`details.inStock`).

### PATCH /cart/items/:itemId
Sets the exact quantity; `0` removes the line. Stock is re-checked.
Auth: SHOPPER. Body: `{ "quantity" (>=0) }`. 200. Errors: 404 CART_ITEM_NOT_FOUND · 400 INSUFFICIENT_STOCK.

### DELETE /cart/items/:itemId
Removes one line. Auth: SHOPPER. 200/204. Errors: 404.

### DELETE /cart
Empties the cart. Auth: SHOPPER. 200/204.

---

## 7. Checkout (`/checkout`) — SHOPPER only

### POST /checkout
Turns the cart into one **OrderGroup** with one **Order per vendor**, reserves stock, empties the cart, and asks Paymob for a payment intention. If Paymob is not configured (local dev) the orders are still created and `paymentSetupFailed: true` is returned — call retry-payment later.
Auth: SHOPPER. Body: none.
201 → the OrderGroup: `{ id (= orderGroupId), userId, totalAmount, paymobIntentId?, orders: [{ id, vendorId, status: "PENDING", subtotal, items }], paymentSetupFailed }`
Errors: 400 CART_EMPTY · 400 CHECKOUT_ITEM_UNAVAILABLE (`details.items` lists the bad lines: unavailable / insufficient stock).
Note: a PENDING group that is never paid is auto-cancelled after 60 min and its stock released.

### POST /checkout/:orderGroupId/retry-payment
Requests a fresh Paymob intention for a still-PENDING group (e.g. after `paymentSetupFailed`).
Auth: SHOPPER (owner). 201 → payment fields. Errors: 404 ORDER_GROUP_NOT_FOUND · 400 ORDER_GROUP_NOT_PENDING · 503 PAYMENTS_NOT_CONFIGURED.

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
Read-only: admin status changes, cancel and refund are not built (specs/admin-module-spec2.md B6; refunds need the Payments spec).

---

## 9. Bazaars — public (`/bazaars`), organizer (`/organizers/me`), vendor applications, admin organizers

### GET /bazaars
Published bazaars, optionally near a point.
Auth: none. Query: `lat?` (-90..90), `lng?` (-180..180), `radiusKm?` (0.1–150; all three together for proximity), `scheduleType?`, `page` (>=1), `limit` (1–100, default 20).
200 → `{ data: [bazaar + location {lat,lng}], meta }`

### GET /bazaars/:id
Published bazaar detail with `acceptedVendors` (verified vendors only).
Auth: none. 200. Errors: 404 BAZAAR_NOT_FOUND.

### GET /organizers/me
Organizer's own profile with moderation fields.
Auth: ORGANIZER. 200. Errors: 404 ORGANIZER_NOT_FOUND.

### PATCH /organizers/me
Auth: ORGANIZER. Body: `{ "name"? }`. 200.

### GET /organizers/me/bazaars
All of the organizer's bazaars, any status.
Auth: ORGANIZER. Query: `page`, `limit`. 200 → `{ data, meta }`.

### POST /organizers/me/bazaars
Creates a bazaar in DRAFT (not visible yet). Organizer must be verified.
Auth: ORGANIZER.
Body: `{ "name", "description"?, "coverMedia"?: URL[], "lat", "lng", "scheduleType": ScheduleType, "recurrenceRule"? (required when RECURRING), "startDate": ISO, "endDate"?: ISO }`
201 → bazaar. Errors: 400 · 403 ORGANIZER_NOT_VERIFIED.

### GET /organizers/me/bazaars/:id
Auth: ORGANIZER (owner). 200. Errors: 404 BAZAAR_NOT_FOUND.

### PATCH /organizers/me/bazaars/:id
Partial update, same fields as create. Re-indexes for search.
Auth: ORGANIZER (owner). 200. Errors: 404.

### PATCH /organizers/me/bazaars/:id/publish
DRAFT → PUBLISHED: visible to shoppers, searchable, vendors can apply. Emits `bazaar.published`.
Auth: ORGANIZER (owner). 200. Errors: 404 · 400 BAZAAR_NOT_DRAFT.

### PATCH /organizers/me/bazaars/:id/cancel
PUBLISHED/DRAFT → CANCELLED; removed from public reads and search.
Auth: ORGANIZER (owner). 200. Errors: 404 · 400.

### GET /organizers/me/bazaars/:id/applications
Vendor applications for one bazaar.
Auth: ORGANIZER (owner). Query: `status?` = PENDING|ACCEPTED|REJECTED, `page`, `limit`. 200 → `{ data, meta }`.

### PATCH /organizers/me/bazaars/:id/applications/:applicationId/accept
PENDING → ACCEPTED. Emits `booth_listing.accepted`. The vendor can then be assigned a booth.
Auth: ORGANIZER (owner). 200. Errors: 404 APPLICATION_NOT_FOUND · 400 APPLICATION_NOT_PENDING.

### PATCH /organizers/me/bazaars/:id/applications/:applicationId/reject
PENDING → REJECTED. Auth: ORGANIZER (owner). 200. Errors: 404 · 400 APPLICATION_NOT_PENDING.

### POST /bazaars/:id/apply
Vendor applies to a PUBLISHED bazaar. One application per vendor per bazaar. Vendor must be verified.
Auth: VENDOR. Body: none. 201 → application (PENDING). Errors: 403 VENDOR_NOT_VERIFIED · 404 BAZAAR_NOT_FOUND · 400 BAZAAR_NOT_ACCEPTING_APPLICATIONS (exists but not PUBLISHED) · 409 APPLICATION_EXISTS.

### DELETE /bazaars/:id/apply
Withdraws a PENDING application. Auth: VENDOR. 204. Errors: 404.

### GET /vendors/me/bazaar-applications
The vendor's applications across bazaars.
Auth: VENDOR. Query: `status?`, `page`, `limit`. 200 → `{ data, meta }`.

### GET /admin/organizers
Moderation queue. Auth: ADMIN. Query: `status?` = pending|verified|rejected, `search?`, `page`, `limit`. 200 → `{ data, meta }`.

### PATCH /admin/organizers/:id/verify
Organizer can now create/publish bazaars. Idempotent. Audit ORGANIZER_VERIFIED. Auth: ADMIN. 200. Errors: 404.

### PATCH /admin/organizers/:id/reject
Rejects/revokes with a reason. Existing PUBLISHED bazaars stay public (product decision pending).
Auth: ADMIN. Body: `{ "reason" (1–1000) }`. 200. Errors: 400 · 404.

### GET /admin/bazaars
Every bazaar of every organizer, in any status, **DRAFT included** (every other route shows a DRAFT to its owner only). Newest first.
Auth: ADMIN. Query: `status?` (DRAFT|PUBLISHED|CANCELLED|COMPLETED), `organizerId?` (uuid), `search?` (name, case-insensitive), `includeDeleted?` (default false), `page`, `limit`.
200 → `{ data: [bazaar + location {lat,lng}, organizer { id, name, verified }], meta }`. Errors: 400 (bad enum/uuid, unknown query field).

### GET /admin/bazaars/:id
Any bazaar regardless of status, owner or soft-delete.
Auth: ADMIN. 200 → bazaar + `location`, `organizer { id, name, verified }`, `applicationCounts { PENDING, ACCEPTED, REJECTED }`, `hasLayout`. Errors: 404 BAZAAR_NOT_FOUND.
Admin edit/cancel of a bazaar is not built yet (specs/admin-module-spec2.md B7).

### GET /admin/applications
Every booth application on every bazaar, newest first — no organizer or vendor scope.
Auth: ADMIN. Query: `bazaarId?` (uuid), `vendorId?` (uuid), `status?` (PENDING|ACCEPTED|REJECTED), `page`, `limit`.
200 → `{ data: [{ id, bazaarId, vendorId, applicationStatus, appliedAt, decidedAt, bazaar { id, name, status, startDate }, vendor { id, name, verified }, booth { id, label } | null }], meta }`. Errors: 400 (bad enum/uuid, unknown query field).

### GET /admin/applications/:id
One application, same shape as a list row; includes applications on soft-deleted bazaars.
Auth: ADMIN. 200. Errors: 404 APPLICATION_NOT_FOUND.
Read-only: accepting/rejecting stays with the organizer (`PATCH /organizers/me/bazaars/:id/applications/:applicationId/accept|reject`); admin decisions are specs/admin-module-spec2.md B5.

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
Deletes an **unassigned** booth. Auth: ADMIN. 200/204. Errors: 404 · 400 BOOTH_ASSIGNED.

### PATCH /admin/booths/:id/assign
Puts an ACCEPTED vendor application into a booth.
Auth: ADMIN. Body: `{ "boothListingId": "<application id>" }`
200 → booth. Errors: 404 BOOTH_NOT_FOUND / APPLICATION_NOT_FOUND · 400 BOOTH_ASSIGNED · 400 APPLICATION_NOT_ACCEPTED · 400 APPLICATION_BAZAAR_MISMATCH · 409 LISTING_ALREADY_ASSIGNED.

### PATCH /admin/booths/:id/unassign
Frees the booth. Auth: ADMIN. 200. Errors: 404.

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
Errors: 400 VALIDATION_ERROR (lat without lng, radius out of range).

---

## 12. Search (`/search`, `/admin/search`) — Meilisearch

All search routes: `q` (1–200 chars, required), optional `lat`/`lng` + `radiusKm` (1–150) for geo filtering, `page`, `limit` (<=50). Optional Bearer token adds `isFavorite`.

### GET /search
Federated overview: top hits for products, vendors and bazaars in one call.
Query: `q`, `types?` = comma list of product,vendor,bazaar, `limit` <=20.
200 → `{ products: [...], vendors: [...], bazaars: [...] }`

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
202 → `{ queued: [...] }`.

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
200 → rating. Errors: 400 ORDER_ID_REQUIRED · 403 NOT_VERIFIED_PURCHASE · 404 TARGET_NOT_FOUND · 400 BAZAAR_NOT_RATEABLE.

### GET /social/ratings/summary
Public average and count. Query: `targetType`, `targetId`. 200 → `{ average, count }`.

### GET /social/ratings
Public list of ratings for a target. Query: `targetType`, `targetId`, `limit`, `cursor?`. 200 → `{ data: [{ id, score, comment, userId, createdAt }], nextCursor }`.

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
Home-screen counters: pending vendors/organizers/products, totals per role, orders by status.
Auth: ADMIN. 200 → `{ pending: {...}, totals: {...}, orders: {...} }`.

### GET /admin/audit-log
Who did what to whom. Newest first.
Auth: ADMIN. Query: `actorId?`, `targetType?` VENDOR|ORGANIZER|PRODUCT|USER, `targetId?`, `action?` (VENDOR_VERIFIED, VENDOR_REJECTED, ORGANIZER_VERIFIED, ORGANIZER_REJECTED, PRODUCT_APPROVED, PRODUCT_REJECTED, USER_DEACTIVATED, USER_REACTIVATED), `page`, `limit`.
200 → `{ data: [{ id, actorId, action, targetType, targetId, reason, createdAt }], meta }`

---

## 16. Infra

### GET /health
Liveness. Auth: none. 200 → `{ "status": "ok" }`.

### POST /webhooks/paymob
Paymob calls this — not for Postman. Requires a valid HMAC (`?hmac=` or header); marks the order group PAID. Unsigned → 401.

---

## Not available (spec only)
Password reset · email verification · admin self-registration (promote a user in the DB) · GET /discovery/vendors · notifications · payments/subscriptions endpoints · organizer-side layout editing.
