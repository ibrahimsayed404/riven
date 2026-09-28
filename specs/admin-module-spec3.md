# Admin Module Spec — Pass 3 (Part B: admin writes)

**Status:** **Implemented and merged to `main`** (PR #16, 2026-09-26), all of §2–§3, with the full suite green (43/43 suites, 660/660 tests). This spec is the decisions record. Code lands in one PR, one commit per section (§4).
**Decisions:** Ibrahim approved every recommendation in the decision doc [Riven admin — Part B decisions](https://claude.ai/code/artifact/2c12bc77-6f4d-4abc-b6a5-8ffeb3b7b2d7); Youssef relayed the approval on 2026-09-25. Youssef settled the remaining details the same day (§1: B3c, B8b, delivery).
**Builds on:** `specs/admin-module-spec.md` (pass 1) and `specs/admin-module-spec2.md` (pass 2, Part A merged in PRs #8–#15). Neither file is modified; Part B lives here.
**Written against:** `apps/api/prisma/schema.prisma` on `main` @ `4d6e978`, with every rule below checked in the code.

> **Superseded (B4):** "Product reject is the moderation tool" no longer applies — product reject was removed along with the rest of product approval, product decision 2026-09-27 (`specs/vendor-module-spec2.md`). Soft-delete (B3a) is now the only way an admin removes a product from public view. B1–B3, B5–B8 (vendor/organizer/application/order moderation) are unaffected.

---

## 0. Conventions (unchanged from pass 2 §1)

- **Where things live.**
  - Admin routes go in the domain module's `admin-*.controller.ts`, with class-level `@UseGuards(JwtAuthGuard, RolesGuard)` and `@Roles(Role.ADMIN)`.
  - Logic goes in `*ForAdmin` service methods, and Prisma calls only in repositories.
  - Owner routes, `RolesGuard` and `JwtAuthGuard` are **untouched**. There is no admin bypass.
- **Actor.** Always from `@CurrentUser()`, never from the body.
- **Errors and ids.**
  - Coded payloads only.
  - `:id` params are plain strings (no `ParseUUIDPipe`), matching every admin route, so a malformed id returns 404.
- **Audit.**
  - `auditService.record({ actorId, action, targetType, targetId, reason? })` runs **after** the domain write commits, and it's best-effort.
  - **A no-op writes nothing, audits nothing and enqueues nothing.**
- **Search.** Only through `SearchIndexQueue`, enqueued after the commit.
- **Verbs.** State transitions use `PATCH /admin/<resource>/:id/<verb>`. Content edits use `PATCH /admin/<resource>/:id`, and removals use `DELETE /admin/<resource>/:id`.

## 1. Decisions

| # | Decision | Exact rule |
|---|---|---|
| B1 | **Closed, no code.** Suspending a vendor = the existing `PATCH /admin/vendors/:id/reject` on a verified vendor; `PATCH /admin/vendors/:id/verify` lifts it | It already clears `verified`, hides the storefront and products, and enqueues `VENDOR` + `VENDOR_PRODUCTS`. Checkout refuses the products through `PUBLIC_PRODUCT_WHERE` |
| B2 | Admin edits **text and images only**; **no status reset** | Vendor fields (from `UpdateVendorProfileDto`): `businessName` (stored as `name`), `description`, `brandStory`, `returnPolicy`, `shippingPolicy`, `logo`, `logoUrl`, `bannerUrl`, `coverMedia`. Product fields (from `UpdateProductDto`): `title`, `description`, `images`. **Not editable by admin:** `category`, `vendorType`, `hasFixedLocation`, `basePrice`, `categoryId`, `isActive`, `approvalStatus`, `rejectionReason`, `verified`, ownership, variants |
| B3a | Product delete = **soft delete** | Sets `deletedAt`. Variants are untouched, the same as the vendor's own delete. **Cart lines stay, and the existing checkout check refuses them (`PRODUCT_UNAVAILABLE`); nothing is removed from carts.** Orders are untouched |
| B3b | Category delete **only if unused** | Unused = **0 products referencing it, soft-deleted ones included** (`Product.categoryId` is `onDelete: Restrict`) **and 0 sub-categories**. Otherwise 409 `CATEGORY_IN_USE`. No auto-move, no cascade |
| B3c | Rating moderation = **two separate actions** | Delete = hard delete (`Rating` has no `deletedAt`; the average is computed on read). Clear comment = `comment → null`, score kept |
| B4 | **Closed, no code.** No separate hide switch | Product reject is the moderation tool |
| B5 | Admin decides **PENDING applications only** | Allowed: PENDING→ACCEPTED, PENDING→REJECTED. Forbidden: ACCEPTED→REJECTED, REJECTED→ACCEPTED. On accept, emit `BoothListingAcceptedEvent`, as the organizer path does |
| B6 | Admin cancels **unpaid orders only**; **no refunds** | Same rule as the shopper cancel: PENDING only. Reuses `OrdersRepository.cancelPendingGroup`, which is **group-level** (every PENDING order of that checkout, across vendors, fix.js PAY-01) and restores stock |
| B7 | Admin cancels a bazaar under **exactly** the organizer rule | From `BazaarsService.cancelBazaar`: every status except `COMPLETED`. Applications and booths are untouched. There are no notifications (none exist) |
| B8a | The first admin stays a manual DB insert | No seed or bootstrap credentials; public ADMIN registration stays refused (already enforced) |
| B8b | Organizer visibility | A bazaar is public only if `status = PUBLISHED` ∧ `deletedAt IS NULL` ∧ `organizer.verified` ∧ `organizer.deletedAt IS NULL`. Rejecting or deleting an organizer hides their bazaars; **re-verifying restores them automatically**. The bazaar's own status is never changed |
| B8c | Booth-layout and search-reindex admin actions are audited | §3 |
| B8d | Audit stays best-effort | `AuditService.record` catches its own failures (`audit.service.spec.ts`) |
| B8e | Admin rate limiting | Already covered by the global `ThrottlerModule` (300 requests/min per user); nothing to build |

## 2. Endpoints

| Method | Path | Body | Success | Errors | Audit |
|---|---|---|---|---|---|
| PATCH | `/admin/vendors/:id` | `AdminUpdateVendorDto` (the B2 vendor fields, all optional, same validators as the owner DTO) | 200 vendor | 404 `VENDOR_NOT_FOUND` (also soft-deleted) · 400 validation | `VENDOR_EDITED` / `VENDOR` |
| PATCH | `/admin/products/:id` | `AdminUpdateProductDto` (`title`, `description`, `images`) | 200 product | 404 `PRODUCT_NOT_FOUND` · 400 | `PRODUCT_EDITED` / `PRODUCT` |
| DELETE | `/admin/products/:id` | — | 204 (also when already deleted: no-op) | 404 `PRODUCT_NOT_FOUND` | `PRODUCT_DELETED` / `PRODUCT` |
| DELETE | `/admin/categories/:id` | — | 204 | 404 `CATEGORY_NOT_FOUND` · 409 `CATEGORY_IN_USE` (`details: { productCount, childCount }`) | `CATEGORY_DELETED` / `CATEGORY` |
| DELETE | `/admin/ratings/:id` | — | 204 | 404 `RATING_NOT_FOUND` | `RATING_DELETED` / `RATING` |
| PATCH | `/admin/ratings/:id/clear-comment` | — | 200 rating | 404 `RATING_NOT_FOUND` | `RATING_COMMENT_CLEARED` / `RATING` |
| PATCH | `/admin/applications/:id/accept` | — | 200 application | 404 `APPLICATION_NOT_FOUND` · 400 `APPLICATION_NOT_PENDING` · 409 `APPLICATION_STATE_CHANGED` | `APPLICATION_ACCEPTED` / `APPLICATION` |
| PATCH | `/admin/applications/:id/reject` | `{ reason?: string (1–1000) }` | 200 application | same | `APPLICATION_REJECTED` / `APPLICATION` (`reason` is kept in the audit only; `BoothListing` has no reason column) |
| PATCH | `/admin/orders/:id/cancel` | — | 200 `{ ...order, cancelledOrderIds }` | 404 `ORDER_NOT_FOUND` · 400 `ORDER_NOT_CANCELLABLE` · 409 `ORDER_STATE_CHANGED` | `ORDER_CANCELLED` / `ORDER`, **one row per cancelled order** |
| PATCH | `/admin/bazaars/:id/cancel` | — | 200 bazaar | 404 `BAZAAR_NOT_FOUND` (also soft-deleted) · 400 `BAZAAR_COMPLETED` | `BAZAAR_CANCELLED` / `BAZAAR` |

**Idempotent no-ops** return 2xx with no write, audit or enqueue:
- a PATCH edit whose fields all equal the current values
- deleting an already-deleted product
- clearing a null or empty comment
- repeating the same application decision
- cancelling a `CANCELLED` order or bazaar

**Search side effects** (after the commit):
- vendor edit → `VENDOR`, plus `VENDOR_PRODUCTS` when `name` changes (product documents carry `vendorName`)
- product edit or delete → `PRODUCT`
- bazaar cancel → `BAZAAR`
- organizer verify, reject or delete → the new `ORGANIZER_BAZAARS { organizerId }` fan-out (B8b)

## 3. Audit actions and targets (migration `20260926000000_admin_part_b_audit_actions`)

- `AdminAction` (new values): `VENDOR_EDITED, PRODUCT_EDITED, PRODUCT_DELETED, CATEGORY_DELETED, RATING_DELETED, RATING_COMMENT_CLEARED, APPLICATION_ACCEPTED, APPLICATION_REJECTED, ORDER_CANCELLED, BAZAAR_CANCELLED, BOOTH_LAYOUT_CREATED, BOOTH_LAYOUT_UPDATED, BOOTH_CREATED, BOOTH_UPDATED, BOOTH_DELETED, BOOTH_ASSIGNED, BOOTH_UNASSIGNED, SEARCH_REINDEX_REQUESTED`
- `AdminTargetType` (new values): `RATING, APPLICATION, ORDER, BAZAAR, BOOTH, SEARCH_INDEX`

**B8c mapping:**
- The booth-layout create and update actions use `targetType BAZAAR` (targetId = bazaarId).
- The booth create, update, delete, assign and unassign actions use `targetType BOOTH`. Unassigning an already-unassigned booth is a no-op.
- Reindex writes one `SEARCH_REINDEX_REQUESTED` row per index, with `targetType SEARCH_INDEX` and `targetId` the index name (`products`, `vendors`, `bazaars`).

## 4. Delivery: one PR, `feature/admin-part-b`, one commit per section

Youssef chose a single Part B PR (2026-09-26). Each section is built and checked (typecheck, lint, unit tests, relevant e2e) before the next, and gets its own commit, so the history stays reviewable:

| # | Commit | Scope |
|---|---|---|
| 1 | `feat(admin): Part B spec3 and audit enum values` | This spec and the enum migration |
| 2 | `feat(admin): admin edits for vendor and product text/images` | B2 |
| 3 | `feat(admin): admin deletes for products, categories and ratings` | B3a–c |
| 4 | `feat(admin): admin decisions on pending booth applications` | B5 (guarded `PENDING → X` transition in the repository) |
| 5 | `feat(admin): admin cancel of unpaid orders` | B6 |
| 6 | `feat(admin): admin bazaar cancel` | B7 |
| 7 | `feat(bazaars): hide bazaars of rejected or deleted organizers` | B8b: one visibility rule at all seven places (`findPublicPaginated`, `findNearby`, `listPublicIds`, `isRateable`, `findPublicById`, `getSearchDocument`, `applyToBazaar`) plus the `ORGANIZER_BAZAARS` fan-out; e2e fixtures seed verified organizers |
| 8 | `feat(admin): audit booth-layout and search-reindex actions` | B8c |
| 9 | `docs(admin): Part B endpoints, Postman and report` | Postman, `postman-endpoints.md`, the CLAUDE.md admin table, the WORKFLOW/CONTRIBUTING CI wording, a report |

The full suite (unit + all e2e on a throwaway database) must be green before the PR opens.

## 5. Tests (every PR)

- **Unit:** exact write args, the audit entry, search jobs, audit after the write, and no-ops doing nothing. Every coded error. For B2, status fields never appear in the write.
- **E2E** (`admin-management.e2e.spec.ts`, plus the domain suites for PR 7):
  - The auth check: ADMIN 200/204; VENDOR, ORGANIZER and SHOPPER 403; no token 401.
  - Audit rows asserted in the DB.
  - Owner routes still refuse non-owners.
- **Real Meilisearch** (`search.e2e`): a vendor rename updates the product document's `vendorName` (PR 2); an organizer reject removes the bazaar document, and verify restores it (PR 7).

## 6. Out of scope (follow-ups, each its own `fix/` branch)

1. The owner `updateMyProfile` enqueues only `VENDOR`, so a vendor rename leaves product documents' `vendorName` stale (`vendors.service.ts:61`).
2. The organizer `decideApplication` has an unguarded `PENDING → X` update (a race) and doesn't check the bazaar's status.
3. The organizer `cancelBazaar` re-writes an already `CANCELLED` bazaar instead of treating it as a no-op.
4. Refunds need a Payments spec (who triggers them, full or partial, restock); see the decision doc, B6.
