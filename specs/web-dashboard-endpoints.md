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

`vendorType`: `BAZAAR_ONLY | MARKETPLACE | BOTH`. Registration creates the user **and** the vendor/organizer profile in one call, logged in on return. New vendors and organizers start with `verified: false` — an admin flips it. Several actions below are gated on that flag.

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
  "verified": false, "subscriptionStatus": "TRIALING",
  "vendorType": "BAZAAR_ONLY", "brandStory": null,
  "logoUrl": null, "bannerUrl": null, "returnPolicy": null, "shippingPolicy": null,
  "createdAt": "...", "updatedAt": "...", "deletedAt": null,
  "location": { "lat": 30.78, "lng": 31.0 }
}
```

Note the request field is `businessName` but the response field is `name`. `subscriptionStatus`: `TRIALING | ACTIVE | PAST_DUE | CANCELED` (read-only for now — no payments endpoints yet).

### 3.2 Products

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/vendors/me/products?page&limit` | — | `{ data: Product[], total }` — all approval statuses, active and inactive |
| POST | `/vendors/me/products` | `{ title, description, categoryId, basePrice, images[] (URLs), isActive? }` | Product (`approvalStatus: "PENDING"`) |
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
  "approvalStatus": "PENDING", "rejectionReason": null, "isActive": true,
  "createdAt": "…", "updatedAt": "…", "deletedAt": null
}
```

**Variant:** `{ id, productId, sku (globally unique), size, color, priceOverride (null = use basePrice), stockQuantity }`

- `approvalStatus`: `PENDING | APPROVED | REJECTED`. Admin decides; on reject, `rejectionReason` is filled — surface it in the UI.
- A product is only publicly visible when `APPROVED`, `isActive`, and the vendor is `verified`.
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
| GET | `/organizers/me` | — | `{ id, ownerId, name, verified, createdAt, updatedAt, deletedAt }` |
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

## 6. Not built yet — don't design against these as live

- **Booth layout editing.** Grid + booth CRUD and vendor→booth assignment are spec'd (`specs/booth-layout-module-spec.md`) as **admin** routes; organizers have read-only access via the public layout endpoint. Organizer-side editing is an open question.
- **Payments / subscriptions** (`subscriptionStatus`, bazaar fees) — model exists, no endpoints.
- **Notifications** — no endpoints.
- **Vendor analytics / sales summaries** — none. Aggregate on the client from `/vendors/me/orders` for now.
- **Delivery address on orders** — no schema field yet; `user.phone` is the only contact channel.
- **Server-side upload size limit** — client enforces 10 MB for now.
- **Deleting uploaded images** — no endpoint; replaced images are orphaned in storage.
- **Password reset / email verification** — none.
