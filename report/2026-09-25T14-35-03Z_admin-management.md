# Riven API — Admin management (pass 2) report

**Generated:** 2026-09-25T14:35:03Z
**Spec:** `specs/admin-module-spec2.md` (new). It builds on `specs/admin-module-spec.md` without changing it.
**Baseline:** `main` @ `2271747` (merge of PR #8 `feature/admin-management`, which contains Tasks 1–2)
**Working tree:** Task 3 is **uncommitted on `main`**. It is 7 modified files and 2 new files, 283 insertions and 3 deletions. Nothing has been pushed by the agent.

## 1. Summary

An admin used to see only the moderation queues. They couldn't open a single vendor or product in a non-public state, and they couldn't see bazaars, applications, orders or ratings at all.

This pass adds a dedicated admin layer: `/admin/*` routes in each domain module, backed by new `*ForAdmin` service and repository methods. **`RolesGuard` isn't changed, and owner routes and their ownership checks aren't touched.**

Every admin action that needs a product decision is written up as an Open Item for Ibrahim (spec Part B) and not built.

| Task | Scope | State |
|---|---|---|
| Spec | `specs/admin-module-spec2.md`: Part A (clear) and Part B (decisions) | written; Part A approved by Youssef |
| 1 | Migration: `AdminAction.CATEGORY_CREATED`, `CATEGORY_UPDATED`; `AdminTargetType.CATEGORY` | **merged** (PR #8) |
| 2 | `GET /admin/vendors/:id`, `GET /admin/products/:id` | **merged** (PR #8) |
| 3 | `GET /admin/bazaars`, `GET /admin/bazaars/:id` | done, **uncommitted** |
| 4 | `GET /admin/applications`, `GET /admin/applications/:id` | next |
| 5 | `GET /admin/orders`, `GET /admin/orders/:id` | todo |
| 6 | `GET /admin/ratings` | todo |
| 7 | Categories: list, create, update, plus search re-index | todo |
| 8 | Docs (CLAUDE.md module list) | todo |

## 2. Why not an admin bypass in the guard

Adding `if (user.role === ADMIN) return true` to `RolesGuard` was considered and rejected:

- Owner routes (`/vendors/me/*`, `/cart`, `/organizers/me/*`, `/orders`) look up data by `currentUser.id`. An admin has no vendor profile, cart or bazaars, so these would just return 404 or nothing.
- Admin would also be able to do shopper writes (cart, checkout, ratings).
- It skips the audit contract.

The alternative (global reads by id, `*ForAdmin` methods, audit on writes) is spec §1.

## 3. Endpoints added

| Method | Path | Returns | Errors |
|---|---|---|---|
| GET | `/admin/vendors/:id` | Vendor in **any** state, soft-deleted included, plus `owner { id, name, email, isActive }`, `location`, `productCounts { PENDING, APPROVED, REJECTED }` | 404 `VENDOR_NOT_FOUND` |
| GET | `/admin/products/:id` | Product in any approval state, inactive and soft-deleted included, plus `vendor`, `category`, and **all** variants (removed ones flagged by `deletedAt`) | 404 `PRODUCT_NOT_FOUND` |
| GET | `/admin/bazaars` | Every organizer's bazaars in any status, **DRAFT included**, as `{ data, meta }`. Filters: `status`, `organizerId`, `search`, `includeDeleted`, `page`, `limit` | 400 on a bad enum, a non-uuid id or an unknown query field |
| GET | `/admin/bazaars/:id` | Any bazaar, plus `organizer { id, name, verified }`, `location`, `applicationCounts`, `hasLayout` | 404 `BAZAAR_NOT_FOUND` |

All four have `@UseGuards(JwtAuthGuard, RolesGuard)` and `@Roles(Role.ADMIN)` at class level. They are reads, so no audit rows are written. They use the shared `pageMeta()`, coded errors, and no `success` envelope, same as the existing routes.

## 4. Files

**Task 1–2 (merged in PR #8)**
- `apps/api/prisma/schema.prisma`: 3 enum values
- `apps/api/prisma/migrations/20260925000000_admin_category_audit_actions/migration.sql`: hand-written, enum-only (`ALTER TYPE … ADD VALUE`); no tables, columns or indexes
- `modules/vendors/{vendors.repository,vendors.service,admin-vendors.controller}.ts`: `findByIdForAdmin`, `countProductsByApprovalStatus`, `getVendorForAdmin`, `GET :id`
- `modules/products/{products.repository,products.service,admin-products.controller}.ts`: `findByIdForAdmin`, `getProductForAdmin`, `GET :id`
- `modules/{vendors,products}/*.service.spec.ts`: 4 unit tests
- `modules/admin/admin-management.e2e.spec.ts`: new e2e suite, which grows with each task
- `specs/admin-module-spec2.md`, `specs/postman-endpoints.md`

**Task 3 (uncommitted)**
- `modules/bazaars/admin-bazaars.controller.ts`: **new**
- `modules/bazaars/dto/admin-list-bazaars-query.dto.ts`: **new**, extends the shared `PaginationQueryDto`
- `modules/bazaars/bazaars.repository.ts`: `adminBazaarRowSelect`, `findManyForAdmin`, `findByIdForAdmin`. Locations for a page come from one raw query through the existing `findLocationsByIds`, so there's no N+1.
- `modules/bazaars/bazaars.service.ts`: `listForAdmin`, `getBazaarForAdmin`
- `modules/bazaars/bazaars.module.ts`: registers the controller
- `modules/bazaars/bazaars.service.spec.ts`: 3 unit tests
- `modules/admin/admin-management.e2e.spec.ts`: bazaar fixtures and A3 tests
- `specs/admin-module-spec2.md`: the organizer field is `name`, not `organizationName`
- `specs/postman-endpoints.md`: A3 routes

## 5. Verification (as run on the dev machine, 2026-09-25)

| Check | Command | Result |
|---|---|---|
| Migration applied | `prisma migrate deploy` on `riven` and on `riven_test` | "All migrations have been successfully applied" |
| Schema drift | `prisma migrate diff --from-schema-datasource … --to-schema-datamodel …` | Only the 4 GIST location indexes show up, which Prisma can never see; there is no enum drift. The new migration doesn't drop them. |
| Typecheck | `pnpm typecheck` (app + seed tsconfig) | exit 0 |
| Lint | `pnpm lint` | **0 errors**. The warnings are all `no-explicit-any`, and none come from the new code. |
| Unit | `pnpm test:unit` | **29 suites, 302 tests passing**, 7 of them new |
| E2E | `jest --testPathPatterns "admin\|bazaars.e2e\|booths"` against **`riven_test`** | **71 / 72 passing.** The 1 failure is outdated test code that was already on `main` (§7.1). |

**E2E coverage for every new route:**
- ADMIN gets 200; VENDOR, ORGANIZER and SHOPPER get 403; no token gets 401.
- Admin sees non-public state that the public route 404s on (pending or unverified vendor, PENDING or inactive product, DRAFT bazaar).
- Soft-deleted rows are visible to admin.
- Unknown and malformed ids return the coded 404.
- Bad filters return 400.
- `GET /admin/bazaars/:id` doesn't shadow `GET /admin/bazaars/:id/layout`.
- **Ownership still holds:** a second organizer is still refused on `GET /organizers/me/bazaars/:idOfAnother`.

**Test database:** the e2e suites run `deleteMany()`. They were run against a separate `riven_test` database in the same Postgres container, so the `riven` database Youssef uses for manual Postman testing was **not wiped**. To reproduce, from the repo root:

```bash
set -a && . ./.env && set +a
export DATABASE_URL=$(echo "$DATABASE_URL" | sed 's#/riven?#/riven_test?#')
cd apps/api && npx prisma migrate deploy && npx jest --runInBand --testPathPatterns admin
```

## 6. Postman (workspace "Riven")

All 15 collections were compared against every `@Controller` route. Before this pass nothing was missing except the new routes. Added:

| Collection | Request |
|---|---|
| Admin-Vendor | `Get Vendor By Id (admin)`: `GET {{URL}}admin/vendors/:id` |
| Products | `Admin - Get Product By Id`: `GET {{URL}}admin/products/:id` |
| Bazaars | `Admin - Get All Bazaars` (filters included but disabled), `Admin - Get Bazaar By Id` |

Every request uses the existing `{{URL}}` and `Bearer {{token}}` variables, and each has a description of its response and errors.

## 7. Findings

1. **An existing e2e test is outdated.** `bazaars.e2e.spec.ts:193` ("7b") asserts `res.body.total`, but `GET /vendors/me/bazaar-applications` returns `{ data, meta: { total } }`. This was already on `main`; the Task 3 diff doesn't touch that endpoint. Now that CI runs e2e, it will probably fail there. The fix is to read `res.body.meta.total`. It should be its own `fix(test)` change and is **not** done here.
2. **Two corrections to spec2.** A malformed `:id` returns 404, not 400: the existing admin routes don't use `ParseUUIDPipe`, and this pass matches them. And the organizer's field is `name`.
3. **Category writes need a search re-index.** Product search documents store `categorySlug` and `categoryPath` (`products.service.ts`). Renaming, re-slugging or moving a category will leave search results stale unless products in that category and its sub-categories are re-indexed. This is in spec A7 and will be built in Task 7.
4. **Postman tidy-up, not changed.** The *Vendor* collection holds "Audit" and "Reactivate By Id", which look like copies of the *Admin* collection's requests. "Verify Vendor" sends a `reason` body that the route ignores.
5. **Refunds don't exist.** A double charge, or a payment for a cancelled group, is only logged ("refund manually", `order-payment.handler.ts`). The `REFUNDED` enum value is never set. `cart-checkout-orders-spec.md` and the fashion addendum both defer refunds to a Payments spec, and Paymob is still unverified against a sandbox.

## 8. Open items for Ibrahim (spec2 Part B, nothing built)

| # | Question | Proposed default |
|---|---|---|
| B1 | Vendor suspend: there's no field for it | `PATCH /admin/vendors/:id/revoke` sets `verified=false` (no new column) |
| B2 | Admin edits a product or vendor: reset to PENDING? | No reset; text and image fields only; audited |
| B3 | Deletes of products, categories, ratings | Product: soft delete plus clearing its cart lines. Category: 409 if in use. Rating: hard delete, plus a separate "clear comment" |
| B4 | Admin product unpublish (vendor controls `isActive`) | Don't build; admin uses reject |
| B5 | Admin decides applications | Decide PENDING only, with organizer rules, no reversal |
| B6 | Admin order status, cancel, refund | Cancel `PENDING` only; refund waits for the Payments spec |
| B7 | Admin cancels a PUBLISHED bazaar that has accepted vendors | Reuse organizer rules; audited; no notifications module yet |
| B8 | Still open from pass 1: #3, #4, #5, #6 | Unchanged |

## 9. Next steps

1. **Commit Task 3 on a branch, not `main`.** CONTRIBUTING.md treats `main` as protected. For example: `git switch -c feature/admin-bazaars` (the uncommitted changes come along), then commit and open a PR.
2. Task 4 (admin applications).
3. A separate `fix(test)` for §7.1.
4. Send spec2 Part B to Ibrahim.
