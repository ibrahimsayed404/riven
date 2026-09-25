# Admin Module Spec — Pass 2 (management surface)

**Status:** Draft for review. **No code until approved.** Part B needs Ibrahim.
**Builds on:** `specs/admin-module-spec.md` (pass 1: moderation queues, audit log, overview). Nothing in pass 1 is changed here.
**Written against:** `apps/api/prisma/schema.prisma` on `main` @ `456a06f`.
**Scope:** Admin reads across every domain, and category management (Part A). Every other admin write is listed in Part B with options, and waits for a decision.
**Out of scope:** Refunds (no refund code exists, `payments-module-spec.md` isn't built, Paymob is unverified against a sandbox). Comments moderation as its own resource (there is no Comment model; `comment` is a column on `Rating`). Role changes (`role` is immutable by design). Any guard-level admin bypass.

---

## 0. Why this pass exists

Admins can moderate the approval queues (pass 1), but they can't *see* most of the system. There's no admin view of a single vendor or product in any state, and no admin view at all of bazaars, applications, orders or ratings. Categories exist only through `prisma/seed.ts`.

**Rejected approach:** `if (user.role === ADMIN) return true` in `modules/auth/guards/roles.guard.ts`.
- Owner routes (`/vendors/me/*`, `/cart`, `/organizers/me/*`, `/orders`) resolve the resource from `currentUser.id`, so an admin gets 404s or empty results from them.
- Admin would also inherit shopper writes: cart, checkout, ratings.
- It bypasses the audit contract (pass 1 §5).

`RolesGuard` is **not modified** by this pass.

## 1. Conventions (unchanged from pass 1, restated so the endpoints below are unambiguous)

- **Where controllers live.** Each `admin-*.controller.ts` goes in its **domain module**, not `modules/admin/`. Class-level `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`. `modules/admin/` stays cross-cutting reads only; putting domain writes there brings back the Vendors → Admin → Vendors cycle.
- **Where the logic lives.** Admin logic is new, `*ForAdmin`-named methods on the domain service. They are *not* the owner methods: owner methods scope by `ownerId`, and admin methods look up globally by id. Owner methods and their ownership checks are **not touched**.
- **Prisma.** All Prisma calls go in the module's `*.repository.ts`, as new `findManyForAdmin` / `findByIdForAdmin` methods.
- **Lists.** Page-based, `page` (≥1, default 1) and `limit` (1–100, default 20), matching `AdminListProductsQueryDto`. Response is `{ data, meta: { total, page, limit, totalPages } }`, and count + page are read in one `$transaction` (see `orders.repository.ts:21`). There is **no `success` envelope** (see `all-exceptions.filter.ts`).
- **Errors.** Coded payloads only: `throw new NotFoundException({ code, message })`. `:id` params are plain strings, matching the pass 1 admin routes, so an unknown or malformed id gives 404 (ids are `String` columns, and Prisma just finds nothing).
- **Audit.** Every admin **write** calls `auditService.record({ actorId, action, targetType, targetId, reason? })` *after* the domain write commits. It is best-effort (pass 1 §5.2). Idempotent no-ops write nothing and record nothing. `actorId` comes from `@CurrentUser()`. Reads are not audited.
- **Verbs.** State transitions use `PATCH /admin/<resource>/:id/<verb>`, same as the pass 1 routes. No `POST` aliases.

---

## Part A — Decided, buildable once this spec is approved

### A1. Vendors — `vendors/admin-vendors.controller.ts` (existing file, new route)

| Method | Path | Service |
|---|---|---|
| GET | `/admin/vendors/:id` | `VendorsService.getVendorForAdmin(id)` (new) |

- Returns the vendor in **any** moderation state, including soft-deleted ones (`deletedAt` is included so the admin can tell). The public `getVendorById` hides unverified vendors.
- Response: the vendor fields, plus `rejectionReason`, `deletedAt`, `location` (`{lat,lng} | null`, read via the existing `findVendorLocation`), `owner: { id, email, name, isActive }`, and `productCounts: { PENDING, APPROVED, REJECTED }`.
- Errors: 404 `VENDOR_NOT_FOUND`.

### A2. Products — `products/admin-products.controller.ts` (existing file, new route)

| Method | Path | Service |
|---|---|---|
| GET | `/admin/products/:id` | `ProductsService.getProductForAdmin(id)` (new) |

- Any `approvalStatus`, any `isActive` value, soft-deleted included.
- Response: the product, plus `variants` (including soft-deleted variants, flagged), `vendor: { id, name, verified }` and `category: { id, name, slug }`.
- Errors: 404 `PRODUCT_NOT_FOUND`.

### A3. Bazaars — `bazaars/admin-bazaars.controller.ts` (new)

| Method | Path | Service |
|---|---|---|
| GET | `/admin/bazaars` | `BazaarsService.listForAdmin(params)` (new) |
| GET | `/admin/bazaars/:id` | `BazaarsService.getBazaarForAdmin(id)` (new) |

- **Query** (`AdminListBazaarsQueryDto`): `status?: BazaarStatus`, `organizerId?: uuid`, `search?` (name, case-insensitive), `includeDeleted?` (default false), `page`, `limit`. Ordered by `createdAt desc`.
- **Any status and any organizer**, including `DRAFT`. This is the key difference from the organizer and public routes.
- **Detail:** the existing `BazaarWithLocation` shape (read through the repository's raw PostGIS query), plus `organizer: { id, name, verified }` (the `Organizer` column is `name`; `organizationName` is only the registration field), `applicationCounts: { PENDING, ACCEPTED, REJECTED }` and `hasLayout: boolean`.
- **Routing check:** `admin-booths.controller.ts` already owns `admin/bazaars/:bazaarId/layout…`. The new `GET admin/bazaars/:id` doesn't collide with it; verify this in the e2e test.
- Errors: 404 `BAZAAR_NOT_FOUND`.

### A4. Applications — `bazaars/admin-applications.controller.ts` (new)

| Method | Path | Service |
|---|---|---|
| GET | `/admin/applications` | `BazaarsService.listApplicationsForAdmin(params)` (new) |
| GET | `/admin/applications/:id` | `BazaarsService.getApplicationForAdmin(id)` (new) |

- **Query:** `bazaarId?`, `vendorId?`, `status?: ApplicationStatus`, `page`, `limit`. Ordered by `appliedAt desc`.
- **Item:** `BoothListing` fields, plus `bazaar: { id, name, status }`, `vendor: { id, name }` and `booth: { id, label } | null`.
- Read-only in this pass. Admin accept/reject is decision **B5**.
- Errors: 404 `APPLICATION_NOT_FOUND`.

### A5. Orders — `orders/admin-orders.controller.ts` (new)

| Method | Path | Service |
|---|---|---|
| GET | `/admin/orders` | `OrdersService.listForAdmin(params)` (new) |
| GET | `/admin/orders/:id` | `OrdersService.getOrderForAdmin(id)` (new) |

- **Query:** `status?: OrderStatus`, `vendorId?`, `userId?`, `orderGroupId?`, `page`, `limit`. Ordered by `createdAt desc`.
- **Detail:** the order, plus `items`, `vendor: { id, name }`, `user: { id, name, email }` and `orderGroup: { id, paidAt, paidAmountCents, paymobOrderId, paymobIntentId, paymobTransactionId }`. The Paymob ids are exposed **only** on this admin route, for payment support.
- Read-only in this pass. Admin status changes and cancel are decision **B6**.
- Errors: 404 `ORDER_NOT_FOUND`.

### A6. Ratings — `social/admin-ratings.controller.ts` (new)

| Method | Path | Service |
|---|---|---|
| GET | `/admin/ratings` | `SocialService.listRatingsForAdmin(params)` (new) |

- **Query:** `targetType?: RatingTargetType`, `targetId?`, `userId?`, `hasComment?: boolean`, `maxScore?: 1–5` (the "low ratings" view), `page`, `limit`. Ordered by `createdAt desc`.
- Page-based like the other admin lists, even though the public `GET /social/ratings` uses a cursor.
- **Item:** rating fields, plus `user: { id, name, email, isActive }`.
- Read-only in this pass. Delete or clearing the comment is decision **B4**.

### A7. Categories — `categories/admin-categories.controller.ts` (new)

| Method | Path | Service | Audit |
|---|---|---|---|
| GET | `/admin/categories` | `CategoriesService.listForAdmin()` | — |
| POST | `/admin/categories` | `CategoriesService.createCategory(adminId, dto)` | `CATEGORY_CREATED` |
| PATCH | `/admin/categories/:id` | `CategoriesService.updateCategory(adminId, id, dto)` | `CATEGORY_UPDATED` |

- **GET:** a flat list (not paginated; the tree is small), each item `{ id, name, slug, parentId, productCount, childCount }`. The public `GET /categories` tree is unchanged.
- **`CreateCategoryDto`:**
  - `name`: string, 1–60 characters, trimmed
  - `slug`: `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 60 characters
  - `parentId?`: uuid
- **`UpdateCategoryDto`:** all three fields optional, at least one required. `parentId: null` moves the category to the root.
- **Rules:**
  - A `slug` already in use gives **409 `CATEGORY_SLUG_TAKEN`**. The DB `@unique` is the guard: catch `P2002` and map it; don't pre-check and race.
  - An unknown `parentId` gives **404 `CATEGORY_PARENT_NOT_FOUND`**.
  - A `parentId` equal to the category itself or one of its descendants gives **400 `CATEGORY_CYCLE`**. Walk the ancestors of the new parent inside the same `$transaction` as the update.
  - A PATCH that changes nothing is a no-op: 200, no audit row.
- **Search side-effect:** product search documents embed `categorySlug` and `categoryPath` (`products.service.ts:129-140`). After a committed update that changes `slug`, `name` or `parentId`, enqueue a product re-index for every product in the category **and its descendants**, using the existing search-sync queue (`infra/search`). Enqueue after commit, never inside the transaction. Create doesn't need this, because a new category has no products.
- **Delete is not in Part A**; see **B3**.

### A8. Schema change — one migration

```prisma
enum AdminAction {
  // …existing values…
  CATEGORY_CREATED
  CATEGORY_UPDATED
}

enum AdminTargetType {
  // …existing values…
  CATEGORY
}
```

No new tables or columns. Part B decisions add their own enum values in their own migrations when they're approved. Check the generated SQL for stray `DROP INDEX` on the four GIST indexes.

### A9. Errors added in this pass

`BAZAAR_NOT_FOUND`, `APPLICATION_NOT_FOUND`, `ORDER_NOT_FOUND` (these reuse existing codes if the module already throws them; check first), `CATEGORY_NOT_FOUND`, `CATEGORY_PARENT_NOT_FOUND`, `CATEGORY_SLUG_TAKEN` (409), `CATEGORY_CYCLE` (400).

### A10. Tasks — each is one reviewed unit, with staged diffs (repository/service → controllers/DTOs → tests)

| # | Task | Migration |
|---|---|---|
| 1 | A8 enum migration | yes |
| 2 | A1 + A2: vendor and product detail for admin | — |
| 3 | A3: admin bazaars list and detail | — |
| 4 | A4: admin applications list and detail | — |
| 5 | A5: admin orders list and detail | — |
| 6 | A6: admin ratings list | — |
| 7 | A7: categories list, create and update, plus search re-index | — |
| 8 | Docs: `specs/postman-endpoints.md` and the CLAUDE.md module list | — |

### A11. Tests per task

- **Auth matrix on every new route:** ADMIN gets 200, VENDOR / ORGANIZER / SHOPPER get 403, no token gets 401.
- **404** on an unknown id, and **400** on a malformed UUID or a non-whitelisted query or body field.
- **Global reach:** admin can see a `DRAFT` bazaar of organizer X, an unverified vendor, a `PENDING` product, and another shopper's order.
- **Ownership still holds:** organizer Y still gets 404 on `GET /organizers/me/bazaars/:idOfX`, and vendor Y still can't read vendor X's orders. Owner routes are unchanged.
- **Categories:**
  - duplicate slug → 409
  - cycle → 400
  - unknown parent → 404
  - a no-op PATCH records no audit row
  - `auditService.record` is called with `{ actorId: admin.id, action: CATEGORY_UPDATED, targetType: CATEGORY, targetId }`
  - the re-index is enqueued for descendant products
- **Where to run:** unit tests with `test:unit`. E2e specs only against a database that's safe to wipe, because they `deleteMany()`.

---

## Part B — Open Items for Ibrahim (no code until decided)

Each item gives options and a **proposed default**. The default is a proposal, not a decision.

**B1. Vendor suspend / unsuspend.** `Vendor` has no suspended state; it has `verified`, `rejectionReason` and `deletedAt`.
- (a) Reuse `PATCH /admin/users/:ownerId/deactivate`. It already exists and is audited, but the storefront stays visible.
- (b) Add `PATCH /admin/vendors/:id/revoke`, which sets `verified=false` and hides the vendor and its products from shoppers. This needs a `VENDOR_REVOKED` action; pass 1 §3 already models revoke as the reject path.
- (c) Add a new `suspendedAt` column that is separate from verification.
- *Proposed:* (b). It uses no new column, and visibility already keys on `verified`.
- Sub-question: does revoke also hide the vendor's products in carts, and block checkout?

**B2. Admin edit of vendor profile or product.**
- Does an admin product edit reset `approvalStatus` to `PENDING`, the way a vendor edit does?
- Which fields can admin edit, when the vendor already owns the content?
- *Proposed:* admin edits limited to text and image fields; no reset, because admin is the approver; audited as `PRODUCT_EDITED` / `VENDOR_EDITED`.

**B3. Deletes.**
- **Product:** a soft delete is required (order items reference it). What happens to cart lines pointing at it: remove them, or leave them to fail at checkout? *Proposed:* soft delete plus removing its cart items in the same `$transaction`, audited as `PRODUCT_DELETED`.
- **Category:** `Product.categoryId` is `onDelete: Restrict` and categories have no `deletedAt`. *Proposed:* 409 `CATEGORY_IN_USE` if the category has products or children, otherwise a hard delete audited as `CATEGORY_DELETED`.
- **Rating:** there's no `deletedAt`, so a delete is hard and changes summaries. *Proposed:* a hard delete, plus a separate `PATCH /admin/ratings/:id/clear-comment` for abusive text that keeps the score; audited as `RATING_DELETED` / `RATING_COMMENT_CLEARED`, with a new `AdminTargetType.RATING`.

**B4. Product visibility toggle.**
- `isActive` is vendor-controlled today. If admin unpublishes a product, the vendor can turn it back on.
- *Proposed:* no admin toggle. Admin uses reject, which already hides the product and requires re-review. The alternative is a separate `hiddenByAdminAt` column.

**B5. Admin decision on applications.**
- The lifecycle is `PENDING → ACCEPTED | REJECTED`, decided by the organizer. Can admin decide on the organizer's behalf, or reverse a decision? Reversing an `ACCEPTED` application with an assigned booth would also need an unassign.
- *Proposed:* admin can decide `PENDING` only, reusing the organizer transition rules, with no reversal; audited as `APPLICATION_ACCEPTED` / `APPLICATION_REJECTED`.

**B6. Admin order status and cancel.**
- `PAID` is set only by the Paymob webhook. Cancelling a `PAID` order implies a refund, and refunds don't exist.
- *Proposed:* admin can cancel `PENDING` orders only (restocking the same way as the shopper cancel). Status overrides beyond the existing transition table wait for the payments module. `POST /admin/orders/:id/refund` waits for the payments spec.

**B7. Admin edit or cancel of a bazaar.**
- Can admin cancel a `PUBLISHED` bazaar that has `ACCEPTED` vendors? There's no notifications module to tell them.
- *Proposed:* admin cancel reuses the organizer rules (`DRAFT|PUBLISHED → CANCELLED`); audited as `BAZAAR_CANCELLED`. No admin field edits in this pass.

**B8. Carried from pass 1, still open:** #3 (revoking an organizer doesn't unpublish their bazaars), #4 (auditing booth-layout and reindex operations), #5 (audit is best-effort vs guaranteed), #6 (deactivation doesn't revoke refresh tokens).
