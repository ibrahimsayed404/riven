# Riven API: Postman coverage audit

**Generated:** 2026-09-25T22:58:07Z
**Scope:** every HTTP route in `apps/api/src` compared with every request in the Postman workspace "Riven" (15 collections).
**Code changes:** none. The Postman workspace was edited, plus three docs: `specs/postman-endpoints.md`, and the status lines of `specs/admin-module-spec2.md` and `specs/admin-module-spec3.md`. Also this report.

## 1. Outcome

**All 120 routes have a Postman request. None were missing, so none were added.**

| | Count |
|---|---|
| Routes in code | 120 (119 in `*.controller.ts`, plus `GET /health` in `app.module.ts`) |
| Routes with no Postman request | **0** |
| Postman requests updated | 19 in the first pass (18 descriptions, 1 broken body) + 26 in the second pass (§5) |
| Duplicates found | 3 (see §4) |
| Docs fixed | `specs/postman-endpoints.md` (15 spots), the status lines of `admin-module-spec2.md` and `spec3.md` (§5) |

**How the routes were found:**
- A script parsed every `@Controller('prefix')` together with its `@Get/@Post/@Patch/@Put/@Delete('sub')` decorators.
- A grep found no other decorator forms: no `@All`, no `@Put`, and no non-literal paths.
- There's no `setGlobalPrefix`, so `{{URL}}` + path is the full route.

**How the requests were matched:** by method and path, with `:param` names ignored.

## 2. Coverage by collection

| Collection | Routes covered |
|---|---|
| Auth | 7: register ×3, login, refresh, logout, me |
| User | 4: `users/me` GET/PATCH/DELETE, `users/me/location` |
| Vendor | 5: `vendors/me` GET/PATCH, `vendors/me/location`, `vendors/:id`, POST `vendors/me/products`. It also holds 2 misplaced admin copies (§4) |
| Vendor-Products | 7: product GET list/one, PATCH, DELETE; variant POST/PATCH/DELETE |
| Products | 13: public catalog and categories, plus admin product and category routes |
| Cart-Checkout | 7 |
| Orders | 10: shopper, vendor and admin |
| Organizer | 11 |
| Bazaars | 16: public reads, vendor applications, admin organizers, bazaars and applications |
| Admin-Booths | 8 |
| Admin | 5: users list/one/deactivate/reactivate, audit-log |
| Admin-Vendor | 5 routes (6 requests, one duplicate) |
| Social | 12: favorites, follows, ratings, admin ratings |
| Discovery-Search | 6 |
| Media-AdminDashboard-Health | 5: upload-url, overview, audit-log, health, Paymob webhook |

## 3. Fixed in Postman

**A broken request:**
- **Vendor → Update Me** sent `"category": "fashion"`. The DTO is `@IsEnum(VendorCategory)`, so the request always failed with **400**. The body now sends `"FASHION"`.
- Its description listed `vendorType` as `ONLINE | PHYSICAL | BOTH`. The real values are `BAZAAR_ONLY | MARKETPLACE | BOTH`. The description now lists all 12 DTO fields.

**Outdated descriptions, rewritten from the code:**

| Request | Was | Now |
|---|---|---|
| Bazaars → Admin - Reject Organizer | "Existing PUBLISHED bazaars stay public (open product decision)" | Rejecting hides every bazaar of the organizer; verifying again restores them (spec3 B8b) |
| Bazaars → Admin - Verify Organizer | No mention of bazaars | Automatically restores the hidden bazaars |
| Bazaars → Admin - Get Bazaar By Id | "Admin edit/cancel not built yet" | Cancel is `PATCH admin/bazaars/:id/cancel`; there's no admin edit |
| Bazaars → Admin - Get All Applications | "Read-only: accept/reject stays with the organizer" | Admin accept/reject routes (spec3 B5) |
| Bazaars → Get All / Get By Id (public) | Status-only rule | Also requires the organizer to be verified and not deleted |
| Orders → Admin - Get All Orders | "cancel / refund not built" | Admin cancel of unpaid orders exists; no refund route |
| Discovery-Search → Admin - Reindex | `202 -> { queued }` | `202 -> { enqueued }`, with one `SEARCH_REINDEX_REQUESTED` audit row per index |
| Discovery-Search → Discover Near Me, Search Bazaars | Status-only rule | Organizer rule added |
| Media… → Admin - Audit Log | 4 target types, 8 actions | All 11 target types and 28 actions, from `schema.prisma` |
| Auth → Get Me | Copy of the Logout description | `GET /auth/me` → `{ id, email, name, role }` |
| Organizer → Cancel Bazaar | "400 (already cancelled/completed)" | Only COMPLETED gives 400 `BAZAAR_COMPLETED`; an already-cancelled bazaar returns 200 (follow-up #3) |
| Organizer → Get Me | 404 `ORGANIZER_NOT_FOUND` | 404 `ORGANIZER_PROFILE_NOT_FOUND` (the code's actual error code) |
| Products → Admin - Update Category | "Delete not built" | Points to `DELETE admin/categories/:id` |
| Social → Admin - Get All Ratings | "Read-only: delete / clear-comment is spec2 B3" | Points to the delete and clear-comment routes |
| Vendor → Get Vendor By Id | "Requires a Bearer token" | Public; 404 for unverified, rejected or deleted vendors |
| Vendor → Update Location | 200 implied | 204, throttled to once a minute (429) |

Every update was a PATCH of the description, or of the body for Update Me. The responses show headers, query params and saved path-variable values unchanged.

## 4. Left for Youssef (manual)

The Postman connector has **no delete-request tool**. The only alternative is `putCollection`, which rewrites the whole collection and can't carry saved path-variable values, so it would lose the vendor id saved on "Reject Vendor" and "Verify Vendor". Delete these by hand instead (right-click → Delete):

1. **Admin-Vendor → "Update Vendor (admin)"**: two identical copies. Delete either one. The duplicate came from the agent's retry after a false "session expired" error during Part B.
2. **Vendor → "Audit"** (`GET admin/audit-log?targetType=USER`) and **Vendor → "Reactivate By Id"**: admin requests misplaced in the Vendor collection. The same routes are in Admin and in Media-AdminDashboard-Health. Delete them, or move them if you want to keep the saved USER filter or user id.

**Minor, left alone:** Admin-Vendor → "Verify Vendor" sends a `{ "reason": "Missing tax card" }` body. The verify route has no `@Body()`, so it's ignored and harmless.

## 5. Second pass: descriptions compared against the doc and the code

The first pass checked **coverage**. The second compared every Postman description with `specs/postman-endpoints.md`, and checked every place they disagreed against the code. Errors turned up on both sides.

**Postman was wrong:**

| Request | Was | Code says |
|---|---|---|
| Bazaars → Vendor - Apply To Bazaar | 404 BAZAAR_NOT_FOUND, 409 ALREADY_APPLIED | 400 BAZAAR_NOT_ACCEPTING_APPLICATIONS (also for an unknown id or a hidden organizer), 409 APPLICATION_EXISTS |
| Social → Get Ratings (public) | rows carry `userId` | rows carry `reviewerName`; no user id is exposed |
| Orders → Shopper - Confirm Delivery | 400 INVALID_TRANSITION | 400 ORDER_NOT_SHIPPED |
| Orders → Vendor - Update Order Status | 400 INVALID_TRANSITION | 400 INVALID_ORDER_TRANSITION |
| Cart-Checkout → Checkout | `{ orderGroupId, … }` | the OrderGroup (`id`) + `paymobIntentId`, `clientUrl`, `paymentSetupFailed` |
| Auth → Login, Refresh Token | no 403 | 403 ACCOUNT_DEACTIVATED |
| **Auth → Login test script** | asserted **status 200** | login returns **201** (no `@HttpCode`). The test failed on every successful login; the assertion is now 201. The token was always saved; that part is unchanged |

**Added:**
- Audit notes on the 7 Admin-Booths writes.
- Descriptions for the 12 requests that had none: Admin ×5, User ×4, and Admin-Vendor Get All / Reject / Verify.

Saved ids and bodies are unchanged.

**`specs/postman-endpoints.md` was wrong or stale:**
- **Base-URL note:** it said `{{baseUrl}}`; the workspace uses `{{URL}}` with a trailing slash.
- **Product-edit rule:** it said editing resets to PENDING; that's only true of vendor edits.
- **`GET /auth/me`:** the response also has `name`, and the 401 code is `INVALID_ACCESS_TOKEN`.
- **`/vendors/me` and `/vendors/me/location` 404s:** the code is `VENDOR_PROFILE_NOT_FOUND`.
- **Variant SKU conflict:** the code is `SKU_TAKEN`, not `UNIQUE_VIOLATION`.
- **Vendor product and variant deletes:** they return 200 with the row, not "200/204".
- **Product `search`:** it also matches the description, not just the title.
- **Checkout response shape:** corrected as in the Postman table above.
- **`/organizers/me` 404:** the code is `ORGANIZER_PROFILE_NOT_FOUND`.
- **Organizer cancel:** only COMPLETED gives 400 `BAZAAR_COMPLETED`, and an already-cancelled bazaar is re-written.
- **Apply errors:** corrected as in the Postman table above.
- **Admin verify and reject organizer:** now describe the spec3 B8b hide and restore.
- **Audit-log enums:** all 11 target types and 28 actions.

**Spec status lines:**
- `admin-module-spec2.md` still said "Part B … nothing in it is built". It now points to spec3 and PR #16; the rest of spec2 is untouched.
- `admin-module-spec3.md` status now says "merged to main (PR #16)".

**Checked and correct, no change needed:** the public booth layout (`GET /bazaars/:bazaarId/layout`) goes through `BazaarsService.findPublicById`, so it also hides the bazaars of a rejected organizer.
