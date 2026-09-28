# Riven Web Dashboard — Vendor & Organizer Endpoints

Reference for the vendor dashboard and bazaar-organizer dashboard. Generated from the controllers in `apps/api/src/modules` on the `feature/dashboard-gaps` branch (2026-09-18). Everything listed here is implemented and covered by e2e tests unless marked otherwise.

Local dev: `docker compose up -d` (Postgres, Redis, Meilisearch, MinIO), then `pnpm prisma db seed` once for categories.

## Conventions

- **Base URL:** `http://localhost:3000` (no `/api` prefix, no versioning). Env var `PORT`.
- **Auth:** `Authorization: Bearer <accessToken>`. Access tokens are short-lived JWTs; use `POST /auth/refresh` to rotate. Refresh tokens are single-use — every refresh returns a new pair.
- **Roles:** `SHOPPER | VENDOR | ORGANIZER | ADMIN`. Vendor routes require `VENDOR`; organizer routes require `ORGANIZER`. Wrong role → `403`.
- **IDs** are UUIDs. **Dates** are ISO-8601 strings. **Money** fields (`basePrice`, `priceOverride`, `subtotal`, `priceSnapshot`) come back as decimal strings, e.g. `"249.00"`.
- **Pagination:** `?page=1&limit=10` (defaults shown). Responses are `{ "data": [...], "total": <count> }` — compute page count client-side.
- **Validation:** unknown body fields are rejected. Strip anything not listed below before sending.
- **Success bodies** are returned bare (no envelope). `204` responses have no body.
- **Errors** always have this shape:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": ["title must be a string"] } }
```

`code` is `VALIDATION_ERROR` (400, `message` is an array), a domain code like `LOCATION_RATE_LIMITED`, or `HTTP_ERROR` for generic 401/403/404/409 (`message` is a string).

---

## 0. Image upload (both roles)

The API never receives file bytes. Ask for a signed URL, `PUT` the file straight to storage, then send the returned `publicUrl` wherever an image URL is expected (`images[]`, `logoUrl`, `bannerUrl`, `coverMedia[]`).

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/media/upload-url` | `{ purpose, contentType }` | `{ uploadUrl, publicUrl, key, expiresInSeconds: 300 }` |

- `purpose`: `PRODUCT_IMAGE | VENDOR_LOGO | VENDOR_COVER | BAZAAR_COVER`
- `contentType`: `image/jpeg | image/png | image/webp` — anything else → `400 VALIDATION_ERROR`
- Roles: `VENDOR` or `ORGANIZER`. Shoppers → `403`.

```ts
const { uploadUrl, publicUrl } = await api.post('/media/upload-url', { purpose: 'PRODUCT_IMAGE', contentType: file.type });
await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file }); // must be the SAME content type
await api.post('/vendors/me/products', { ..., images: [publicUrl] });
```

- The `Content-Type` on the `PUT` must match what you asked for — it's part of the signature; a mismatch is `403 SignatureDoesNotMatch` from storage.
- URL expires after 5 minutes; request a fresh one per file.
- No server-side size limit yet — enforce **10 MB max** client-side.
- `publicUrl` is readable without auth (local: `http://localhost:9000/riven-media/…`).

---

## 1. Auth (both roles)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/register/vendor` | `{ email, password (≥8), name, businessName, category, vendorType, description? }` | `{ accessToken, refreshToken, user: { id, email, name, role } }` |
| POST | `/auth/register/organizer` | `{ email, password (≥8), name, organizationName }` | same as above |
| POST | `/auth/login` | `{ email, password }` | same as above |
| POST | `/auth/refresh` | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| POST | `/auth/logout` | `{ refreshToken }` | `204` |
| GET | `/auth/me` | — | `{ id, email, name, role }` |

`vendorType`: `BAZAAR_ONLY | MARKETPLACE | BOTH`. `category` is an enum: `FASHION | FOOD | HOME_CRAFTS | BEAUTY | ACCESSORIES | KIDS | ART | OTHER` (was free text). Registration creates the user **and** the vendor/organizer profile in one call, logged in on return. New vendors and organizers start with `verified: false` — an admin flips it. Several actions below are gated on that flag.

## 2. Account (both roles)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/users/me` | — | `{ id, name, email, phone, role, interests[], location: {lat,lng}\|null, createdAt, updatedAt }` |
| PATCH | `/users/me` | `{ name?, phone? (Egyptian format), interests?[] (≤20) }` | updated profile |
| PATCH | `/users/me/location` | `{ lat, lng }` | `204` |
| DELETE | `/users/me` | `{ password }` | `204` — soft-deletes the account |

---

## 3. Vendor dashboard (`role: VENDOR`)

### 3.1 Business profile

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/vendors/me` | — | Vendor object (below) |
| PATCH | `/vendors/me` | any of: `businessName, category, description, logo, coverMedia[], brandStory, logoUrl, bannerUrl, returnPolicy, shippingPolicy, vendorType, hasFixedLocation` | Vendor object |
| PATCH | `/vendors/me/location` | `{ lat, lng }` | `204`. Limited to once per 60 s → `429 LOCATION_RATE_LIMITED` with retry hint in `message` |
| GET | `/vendors/:id` | — | Public profile (no `ownerId`). `404` unless vendor is verified |

**Vendor object**

```json
{
  "id": "uuid", "ownerId": "uuid",
  "name": "Nour Textiles", "category": "fashion", "description": null,
  "logo": null, "coverMedia": [], "hasFixedLocation": false,
  "verified": false, "rejectionReason": null, "subscriptionStatus": "TRIALING",
  "vendorType": "BAZAAR_ONLY", "brandStory": null,
  "logoUrl": null, "bannerUrl": null, "returnPolicy": null, "shippingPolicy": null,
  "createdAt": "...", "updatedAt": "...", "deletedAt": null,
  "location": { "lat": 30.78, "lng": 31.0 }
}
```

Note the request field is `businessName` but the response field is `name`. `rejectionReason` is non-null only while an admin has rejected (or revoked) the account — show it on the dashboard with a "contact support" path; a later `verify` clears it. `subscriptionStatus`: `TRIALING | ACTIVE | PAST_DUE | CANCELED` (read-only for now — no payments endpoints yet).

### 3.2 Products

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/vendors/me/products?page&limit` | — | `{ data: Product[], total }` — active and inactive, soft-deleted excluded |
| POST | `/vendors/me/products` | `{ title, description, categoryId, basePrice, images[] (URLs), isActive? }` | Product — immediately public, no approval gate |
| GET | `/vendors/me/products/:id` | — | Product **with `variants[]`** |
| PATCH | `/vendors/me/products/:id` | any of the POST fields | Product |
| DELETE | `/vendors/me/products/:id` | — | soft-delete |
| POST | `/vendors/me/products/:id/variants` | `{ sku, size?, color?, priceOverride?, stockQuantity? }` | Variant |
| PATCH | `/vendors/me/products/:id/variants/:variantId` | any of those fields | Variant |
| DELETE | `/vendors/me/products/:id/variants/:variantId` | — | — |

**Product**

```json
{
  "id": "uuid", "vendorId": "uuid",
  "title": "Linen shirt", "description": "…", "categoryId": "uuid",
  "basePrice": "450.00", "images": ["https://…"],
  "isActive": true,
  "createdAt": "…", "updatedAt": "…", "deletedAt": null
}
```

**Variant:** `{ id, productId, sku (globally unique), size, color, priceOverride (null = use basePrice), stockQuantity }`

- No approval gate: a product is publicly visible as soon as it's created, as long as `isActive` and the vendor is `verified` (product decision, 2026-09-27).
- Images are URL strings — get them from `POST /media/upload-url` (section 0).
- `categoryId` comes from `GET /categories` (section 5). Any node is valid, parent or leaf.

### 3.3 Orders

| Method | Path | Query / Body | Returns |
|---|---|---|---|
| GET | `/vendors/me/orders` | `?page&limit&status=` | `{ data: Order[], total }` — each with `user`, no `items` |
| GET | `/vendors/me/orders/:id` | — | Order **with `items[]`** and `user` |
| PATCH | `/vendors/me/orders/:id/status` | `{ status: "FULFILLED" \| "SHIPPED" }` | Order |

**Order**

```json
{
  "id": "uuid", "orderGroupId": "uuid", "vendorId": "uuid", "userId": "uuid",
  "status": "PAID", "subtotal": "900.00",
  "createdAt": "…", "updatedAt": "…",
  "user": { "id": "uuid", "name": "Mona Adel", "email": "mona@example.com", "phone": "+201001234567" },
  "items": [
    { "id": "uuid", "orderId": "uuid", "productId": "uuid", "variantId": "uuid",
      "titleSnapshot": "Linen shirt — M / white", "priceSnapshot": "450.00", "quantity": 2 }
  ]
}
```

**Status lifecycle:** `PENDING → PAID → FULFILLED → SHIPPED → DELIVERED`, or `CANCELLED` from `PENDING`/`PAID`.
The vendor may only move `PAID → FULFILLED` and `FULFILLED → SHIPPED`. Anything else → `400`. `PAID` is set by the payment webhook, `DELIVERED` by the shopper confirming, `CANCELLED` by the shopper (before payment) or admin. Use `?status=PAID` for the "needs fulfilment" queue.

`user` is the shopper's contact (`phone` may be `null`). There is no delivery address — the schema has none yet.

### 3.4 Bazaar applications

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/bazaars?page&limit&lat&lng&radiusKm&scheduleType` | public | `{ data: Bazaar[], total }` — `PUBLISHED` only |
| GET | `/bazaars/:id` | public | Bazaar + `acceptedVendors: [{ vendorId, businessName, logo }]` |
| POST | `/bazaars/:id/apply` | — | Application. `403` if vendor unverified; `400` if bazaar not `PUBLISHED`; `409` if already applied |
| DELETE | `/bazaars/:id/apply` | — | `204`. Only while `PENDING` |
| GET | `/vendors/me/bazaar-applications` | `?page&limit&status=` | `{ data: Application[], total }` |

**Application (BoothListing):** `{ id, bazaarId, vendorId, applicationStatus: "PENDING"|"ACCEPTED"|"REJECTED", appliedAt, decidedAt, bazaar }`

The vendor's list embeds a bazaar summary per row — enough to render the list without extra requests:

```json
"bazaar": { "id": "uuid", "name": "Tanta Spring Market", "coverMedia": [], "startDate": "…", "endDate": "…", "status": "PUBLISHED", "location": { "lat": 30.78, "lng": 31.0 } }
```

---

## 4. Organizer dashboard (`role: ORGANIZER`)

All routes under `/organizers/me`.

### 4.1 Profile

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/organizers/me` | — | `{ id, ownerId, name, verified, rejectionReason }`. `rejectionReason` is non-null only while an admin has rejected/revoked the account — surface it in the UI. |
| PATCH | `/organizers/me` | `{ name? }` | Organizer |

### 4.2 Bazaars

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/organizers/me/bazaars?page&limit` | — | `{ data: Bazaar[], total }` — every status incl. `DRAFT` |
| POST | `/organizers/me/bazaars` | `{ name, description?, coverMedia?[], lat, lng, scheduleType, recurrenceRule?, startDate, endDate? }` | Bazaar (`status: "DRAFT"`). `403` if organizer unverified |
| GET | `/organizers/me/bazaars/:id` | — | Bazaar |
| PATCH | `/organizers/me/bazaars/:id` | any of the POST fields | Bazaar |
| PATCH | `/organizers/me/bazaars/:id/publish` | — | Bazaar. Only from `DRAFT` |
| PATCH | `/organizers/me/bazaars/:id/cancel` | — | Bazaar. Any status except `COMPLETED` |

**Bazaar**

```json
{
  "id": "uuid", "organizerId": "uuid",
  "name": "Tanta Spring Market", "description": null, "coverMedia": [],
  "location": { "lat": 30.78, "lng": 31.0 },
  "scheduleType": "ONE_OFF", "recurrenceRule": null,
  "startDate": "2026-10-03T09:00:00.000Z", "endDate": "2026-10-03T18:00:00.000Z",
  "status": "DRAFT",
  "createdAt": "…", "updatedAt": "…", "deletedAt": null
}
```

- `scheduleType`: `ONE_OFF | RECURRING`. When `RECURRING`, `recurrenceRule` (an iCal RRULE string, e.g. `FREQ=WEEKLY;BYDAY=FR`) is required → `400` otherwise.
- `status`: `DRAFT → PUBLISHED → COMPLETED`, or `CANCELLED`. Only `PUBLISHED` bazaars appear publicly and accept vendor applications. `COMPLETED` is set by the system, not the organizer.

### 4.3 Vendor applications

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/organizers/me/bazaars/:id/applications` | `?page&limit&status=` | `{ data: Application[], total }` — each with `vendor: { name, logo }` |
| PATCH | `/organizers/me/bazaars/:id/applications/:applicationId/accept` | — | Application. `PENDING` only |
| PATCH | `/organizers/me/bazaars/:id/applications/:applicationId/reject` | — | Application. `PENDING` only |

Accept/reject is final — there's no un-decide. Confirm in the UI before sending.

---

## 5. Public reads useful to both dashboards

| Method | Path | Notes |
|---|---|---|
| GET | `/categories` | Full tree for the product category picker: `[{ id, name, slug, children: [...] }]`. No pagination. |
| GET | `/products?…` | Public catalogue (approved + active + verified vendor only) |
| GET | `/products/:id` | |
| GET | `/bazaars/:bazaarId/layout` | Booth grid + booths for a `PUBLISHED` bazaar (read-only) |
| GET | `/search?q=` , `/search/products`, `/search/vendors`, `/search/bazaars` | Meilisearch-backed; may return degraded results if the index is down |
| GET | `/discovery/bazaars?lat&lng&radiusKm` | Nearby bazaars |

---

## 5a. Ratings (shopper app; listed here because the gate changed)

`POST /social/ratings` `{ targetType, targetId, score, comment?, orderId? }`:
- `VENDOR` / `PRODUCT`: `orderId` **required** — a DELIVERED order of this shopper containing the target, else `403 NOT_VERIFIED_PURCHASE` (missing → `400 ORDER_ID_REQUIRED`).
- `BAZAAR`: no `orderId`; any shopper may rate a bazaar that is `PUBLISHED` or `COMPLETED` (`404 BAZAAR_NOT_FOUND` otherwise).
- `EVENT`: `404 TARGET_NOT_FOUND` until an events module exists.
Follows and favorites likewise `404` when the target is not publicly visible.

## 5b. Errors, pagination and rate limits (apply everywhere)

- **Error body** (every non-2xx): `{ code, message, details? }` — flat, no envelope. `code` is stable and meant for branching (`VENDOR_NOT_FOUND`, `INSUFFICIENT_STOCK`, `ORDER_STATE_CHANGED`, …); `message` is for humans; `details` is optional structured context (e.g. `CHECKOUT_ITEM_UNAVAILABLE` carries `details.items[]`). Validation failures are `400 VALIDATION_ERROR` with `message: string[]`.
- **Lists** return `{ data, meta: { total, page, limit, totalPages } }`. `?page=` ≥ 1, `?limit=` 1–100 (default 20); anything else is a `400`. Enum filters (`?status=`) are validated — an unknown value is a `400`, not a `500`.
- **Rate limits:** 300 requests/minute per user (per IP when anonymous), 10/minute on login and register, 1/minute on location updates. Over the limit → `429 RATE_LIMITED` with a `Retry-After` header.
- **CORS:** only origins listed in `CORS_ORIGINS` (defaults to `http://localhost:3000,3001`) may call the API from a browser.

## 6. Admin dashboard (`role: ADMIN`)

Every route requires an `ADMIN` token; other roles get `403`. There is no self-service admin registration — the first admin is created out of band (open item in `specs/admin-module-spec.md`).

### 6.1 Home

| Method | Path | Returns |
|---|---|---|
| GET | `/admin/overview` | `{ pending: { vendors, organizers }, users: { SHOPPER, VENDOR, ORGANIZER, ADMIN }, orders: { PENDING, PAID, FULFILLED, SHIPPED, DELIVERED, CANCELLED }, bazaars: { DRAFT, PUBLISHED, CANCELLED, COMPLETED } }`. Every enum key is always present (0 when empty). `pending` = awaiting a first decision; rejected items are not pending. No `products` key — products have no approval gate (product decision, 2026-09-27). |

### 6.2 Moderation queues and decisions

Vendors and organizers share one state model: `verified: true` → verified; `verified: false, rejectionReason: null` → pending; `verified: false, rejectionReason: "…"` → rejected (or revoked, if it was verified before). Decisions are idempotent: repeating one returns `200` with the same body and writes nothing.

| Method | Path | Query / Body | Returns |
|---|---|---|---|
| GET | `/admin/vendors` | `?status=pending\|verified\|rejected&search=&page=&limit=` | `{ data: [{ id, ownerId, name, category, vendorType, verified, rejectionReason, subscriptionStatus, createdAt, owner: { id, name, email } }], meta }` |
| PATCH | `/admin/vendors/:id/verify` | — | `{ id, verified: true, rejectionReason: null }` |
| PATCH | `/admin/vendors/:id/reject` | `{ reason }` (1–1000 chars) | `{ id, verified: false, rejectionReason }`. On a verified vendor this is a revoke: their products leave the public catalogue and search. |
| GET | `/admin/organizers` | same as vendors | `{ data: [{ id, ownerId, name, verified, rejectionReason, createdAt, owner }], meta }` |
| PATCH | `/admin/organizers/:id/verify` | — | `{ id, verified, rejectionReason }` |
| PATCH | `/admin/organizers/:id/reject` | `{ reason }` | Revoking does **not** un-publish the organizer's bazaars (open item). |
| GET | `/admin/products` | `?vendorId=&page=&limit=` | `{ data: [{ …product, vendor: { id, name, verified } }], meta }`. Soft-deleted products never appear; `isActive` is not filtered. No approval gate — this is not a moderation queue, just a list. |
| GET | `/admin/users` | `?role=&search=&includeDeleted=&page=&limit=` | `{ data: [User], meta }` |
| GET | `/admin/users/:id` | — | User |
| PATCH | `/admin/users/:id/deactivate` | — | `204`. Soft-delete. `400 CANNOT_DEACTIVATE_SELF` on your own id. Does not revoke existing tokens (open item). |
| PATCH | `/admin/users/:id/reactivate` | — | `204` |

Errors use stable codes: `VENDOR_NOT_FOUND`, `ORGANIZER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `USER_NOT_FOUND` (all `404`, also for soft-deleted rows).

### 6.3 Audit log

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/admin/audit-log` | `?actorId=&targetType=VENDOR\|ORGANIZER\|PRODUCT\|USER&targetId=&action=&page=&limit=` | `{ data: [{ id, action, targetType, targetId, reason, createdAt, actor: { id, name, email } }], meta }`, newest first. |

`action` is one of `VENDOR_VERIFIED, VENDOR_REJECTED, ORGANIZER_VERIFIED, ORGANIZER_REJECTED, USER_DEACTIVATED, USER_REACTIVATED` (plus `PRODUCT_APPROVED`/`PRODUCT_REJECTED` on historical rows only — nothing writes them since products lost their approval gate on 2026-09-27). Only real state changes produce a row; a repeated identical decision does not. Booth-layout edits and search reindexes are **not** audited yet.

### 6.4 Other admin routes (pre-existing)

| Method | Path | Notes |
|---|---|---|
| POST/GET/PATCH | `/admin/bazaars/:bazaarId/layout` | Booth grid create/read/update |
| POST | `/admin/bazaars/:bazaarId/layout/booths` | Add a booth |
| PATCH/DELETE | `/admin/booths/:id` | Edit / remove a booth |
| PATCH | `/admin/booths/:id/assign`, `/unassign` | `{ boothListingId }` |
| POST | `/admin/search/reindex` | `{ types? }` → `202`, work happens on the queue |

## 7. Not built yet — don't design against these as live

- **Booth layout editing.** Grid + booth CRUD and vendor→booth assignment are spec'd (`specs/booth-layout-module-spec.md`) as **admin** routes; organizers have read-only access via the public layout endpoint. Organizer-side editing is an open question.
- **Payments / subscriptions** (`subscriptionStatus`, bazaar fees) — model exists, no endpoints.
- **Notifications** — no endpoints.
- **Vendor analytics / sales summaries** — none. Aggregate on the client from `/vendors/me/orders` for now.
- **Delivery address on orders** — no schema field yet; `user.phone` is the only contact channel.
- **Server-side upload size limit** — client enforces 10 MB for now.
- **Deleting uploaded images** — no endpoint; replaced images are orphaned in storage.
- **Password reset / email verification** — none.
