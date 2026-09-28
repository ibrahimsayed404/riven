# Vendor Module Spec — Pass 2 (product approval removed)

**Status:** Implemented, not yet merged. Code + docs in one PR (see below); this file is the decision record.
**Decision:** Product approval is removed. Ibrahim decided; Youssef relayed the approval on 2026-09-27. Scope is products only — vendor and organizer approval-gating are unchanged.
**Builds on:** `specs/vendor-module-spec.md` (pass 1) and `specs/fashion-marketplace-addendum.md`. Neither file is modified; this pass supersedes their product-approval sections (vendor-module-spec.md §"POST /vendors/me/products" and §"PATCH /admin/products/:id/approve|reject"; addendum's "Approval-gated visibility applies to Products").
**Written against:** `apps/api/prisma/schema.prisma` on `main` @ `3c26f0a`.

---

## 1. What changes

A vendor's product is now public as soon as it's created — subject only to the same conditions that already applied on top of approval (`isActive: true`, `deletedAt: null`, and its vendor `verified: true, deletedAt: null`). There is no `PENDING`/`APPROVED`/`REJECTED` state for products, and no vendor-facing rejection reason.

**Why now, not just "leave it PENDING and auto-approve on write":** a dead approval column that's always `APPROVED` is worse than no column — it keeps a fake moderation queue, a fake admin decision, and a fake `pending.products` counter alive for nothing. Ibrahim's call was to remove the concept, not paper over it.

This does **not** touch vendor or organizer approval. Storefronts and bazaars still need an admin `verify` before they're public, per CLAUDE.md's "Approval-gated visibility" rule — that rule now says "vendors and organizers only."

## 2. Schema

`Product.approvalStatus` and `Product.rejectionReason` are dropped. The `ApprovalStatus` enum was Product-only (Vendor and Organizer moderation uses a plain `verified: Boolean` + `rejectionReason: String?`, never this enum), so it's dropped too, in migration `20260927000000_remove_product_approval`.

`AdminAction.PRODUCT_APPROVED` / `PRODUCT_REJECTED` stay in the enum — existing `admin_audit_logs` rows reference them by value, and Postgres enum values aren't cheaply droppable. Nothing writes them anymore; they're dead going forward, same treatment as any other historical audit action.

## 3. Behavior changes

| Before | Now |
|---|---|
| `POST /vendors/me/products` created `approvalStatus: PENDING`, invisible until approved | Created product is immediately visible, subject to `isActive` + vendor verified |
| `PATCH /vendors/me/products/:id` reset `approvalStatus` to `PENDING`, dropping it from public reads and search until re-approved | Edit only changes the given fields; the product stays visible and searchable throughout |
| `PATCH /admin/products/:id/approve`, `PATCH /admin/products/:id/reject` | **Removed.** Admin has no product moderation decision to make |
| `GET /admin/products?approvalStatus=` | Query param removed; the list is unfiltered by state, `vendorId` only |
| `PATCH /admin/products/:id` (B2, text/images) | Unchanged — still never touches anything but title/description/images |
| `DELETE /admin/products/:id` (B3a, soft delete) | Unchanged — still the only way an admin hides a bad product (there is no separate hide switch, same as before, but now for a different reason: there's no state to flip to) |
| `GET /admin/vendors/:id` → `productCounts: { PENDING, APPROVED, REJECTED }` | → `productCount: number` (a plain count of the vendor's non-deleted products) |
| `GET /admin/overview` → `pending: { vendors, organizers, products }` | → `pending: { vendors, organizers }` — no pending-products tile |
| Search eligibility (`PUBLIC_PRODUCT_WHERE`, `products.repository.ts`) | Drops the `approvalStatus: 'APPROVED'` clause; unchanged otherwise (`isActive`, `deletedAt`, `vendor.verified`) |

## 4. Not touched

- Vendor verify/reject (`admin-vendors.controller.ts`) and its `rejectionReason`.
- Organizer verify/reject and bazaar visibility (`bazaar-visibility.ts`).
- `ProductsService.updateProductForAdmin` / `deleteProductForAdmin` (B2/B3a) — same rules, just without an approval state to preserve or ignore.

## 5. Docs updated in the same change

`CLAUDE.md` ("Approval-gated visibility" paragraph, `/admin/products` row, "Still not built" list), `specs/postman-endpoints.md`, `specs/web-dashboard-endpoints.md`.
