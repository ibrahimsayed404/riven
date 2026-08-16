# Riven — Vendor & Product Catalog Module Specification

## 1. Overview & Scope
The Vendor module governs:
- **Vendor Profiles**: Initial profile onboarding (`POST /vendors`), profile updates (`PATCH /vendors/me`), soft-deletion (`DELETE /vendors/me`), and public discovery views (`GET /vendors/:id`, `GET /vendors`).
- **Product Catalog**: Landing-page catalog management (`POST /vendors/me/products`, `PATCH /vendors/me/products/:id`, `DELETE /vendors/me/products/:id`, `GET /vendors/:id/products`).
- Note: Per `riven-spec.md §1 & §4`, products are discovery/showcase items only — **not purchasable in-app**, no cart/checkout.

---

## 2. Data Model & Relationships

```
User (Role: VENDOR)
  │ (1:1)
  ▼
Vendor
  ├── id (UUID)
  ├── ownerId (UUID, Unique -> User.id, onDelete: Cascade)
  ├── name (String)
  ├── category (String, indexed)
  ├── description (String, nullable)
  ├── logo (String, nullable)
  ├── coverMedia (String[])
  ├── hasFixedLocation (Boolean, default: false)
  ├── homeLocation (PostGIS Point, 4326, nullable, GIST indexed)
  ├── verified (Boolean, default: false, indexed)
  ├── subscriptionStatus (Enum: TRIALING, ACTIVE, PAST_DUE, CANCELED)
  ├── createdAt / updatedAt / deletedAt (DateTime, nullable)
  │
  ├── Product[] (1:N, onDelete: Cascade)
  │     ├── id (UUID)
  │     ├── vendorId (UUID -> Vendor.id)
  │     ├── name (String)
  │     ├── price (Decimal 10,2)
  │     ├── images (String[])
  │     ├── description (String, nullable)
  │     └── createdAt / updatedAt / deletedAt (DateTime, nullable)
  │
  └── BoothListing[] (1:N join with Bazaar for applications)
```

---

## 3. State Transitions, Lifecycle & Business Rules

### 3.1 Subscription Status & Discovery Visibility Rule
- **Subscription Lifecycle**: `TRIALING` (initial 14-day free trial upon profile creation) → `ACTIVE` (active paying subscriber via Paymob) → `PAST_DUE` (failed renewal with 3-day grace period) → `CANCELED` (unpaid / revoked).
- **Scheduled Transition Dependency**: Note that the automatic `PAST_DUE → CANCELED` transition after the 3-day grace period requires a scheduled recurring job on BullMQ/Redis (`specs/riven-spec.md §11`), which will be implemented in the Background Workers / Queue milestone.
- **Explicit Visibility Rule**:
  - `TRIALING` and `ACTIVE`: Full visibility on all public discovery endpoints (`GET /vendors`, `GET /vendors/:id`, product listings, search).
  - `PAST_DUE`: Visible for a 3-day grace period, but with warning banner displayed on their vendor portal.
  - `CANCELED`: **Hidden from public discovery feeds (`GET /vendors`) and map view**. Public direct lookups (`GET /vendors/:id`) return a `403 Forbidden` (`VENDOR_SUBSCRIPTION_INACTIVE`).
  - **Self-Access Exemption**: The `VENDOR_SUBSCRIPTION_INACTIVE` restriction applies **only to public discovery lookups**. A vendor accessing their own profile (`GET /vendors/me`, `PATCH /vendors/me`, `POST /vendors/me/products`) is **exempt** from this gate so they can always log in, manage their catalog, and reactivate/renew their subscription.

### 3.2 Soft Deletion, Re-Registration & Reactivation
- **Soft Deletion (`DELETE /vendors/me`)**: Sets `deletedAt = NOW()`.
- **Re-Registration Behavior (`POST /vendors`)**:
  - `User.id` (where `role = VENDOR`) can only ever have one Vendor profile row.
  - If a user calls `POST /vendors` and an active row exists (`deletedAt === null`), throw `409 Conflict` (`VENDOR_PROFILE_ALREADY_EXISTS`).
  - If a user calls `POST /vendors` and a soft-deleted row exists (`deletedAt !== null`), the system **restores and reactivates** the existing row: resets `deletedAt = null`, updates the profile fields with the new payload, and sets `subscriptionStatus = TRIALING` (or preserves previous billing record).

### 3.3 Integrity Guard: Vendor Soft-Deletion vs. Accepted Booth Listings
- **Rule**: A vendor is **blocked from soft-deleting their profile** (`DELETE /vendors/me`) if they hold any `ACCEPTED` `BoothListing` in an upcoming or active bazaar (i.e. where the bazaar's `endDate >= NOW()` or status is `PUBLISHED`/`DRAFT`).
  - Throws `400 Bad Request` (`CANNOT_DELETE_VENDOR_WITH_ACTIVE_LISTINGS`).
- **If no accepted listings exist**: Soft-deleting the profile cancels any `PENDING` `BoothListing` applications by transitioning them to `REJECTED` and soft-deletes associated products.

### 3.4 Location Toggle
- If `hasFixedLocation === true`: `homeLocation` (latitude & longitude) is mandatory. The vendor is indexed with PostGIS GIST and appears permanently on the main map.
- If `hasFixedLocation === false`: `homeLocation` is set to null. The vendor only appears on maps at the locations of active bazaars where they hold an accepted booth.

---

## 4. Product Catalog Rules

### 4.1 Live Catalog vs. Snapshot
- Products belong to the `Vendor` aggregate.
- Vendors may add, edit, or soft-delete products at any time, including when they have pending or accepted bazaar applications.
- Organizers review live brand profiles rather than frozen inventory snapshots.

### 4.2 Product Soft-Deletion
- Product deletion performs a soft delete (`deletedAt = NOW()`).
- Direct queries (`GET /vendors/:id/products`, `GET /vendors/:id`) only return active products (`where: { deletedAt: null }`).

---

## 5. Endpoints & API Contract

### `POST /vendors`
- **Auth**: `Role.VENDOR`
- **Behavior**: Creates profile or reactivates an existing soft-deleted profile.
- **Body**:
  ```json
  {
    "name": "string (required, 1-100 chars)",
    "category": "string (required)",
    "description": "string (optional)",
    "logo": "string URL (optional)",
    "coverMedia": ["string URL"],
    "hasFixedLocation": "boolean (default false)",
    "homeLocation": {
      "latitude": "number (-90 to 90)",
      "longitude": "number (-180 to 180)"
    }
  }
  ```
- **Errors**:
  - `400 Bad Request` — `INVALID_LOCATION_PAYLOAD` (missing coordinates when `hasFixedLocation: true`)
  - `409 Conflict` — `VENDOR_PROFILE_ALREADY_EXISTS` (active profile already exists)

### `PATCH /vendors/me`
- **Auth**: `Role.VENDOR`
- **Body**: Partial vendor fields.
- **Errors**:
  - `404 Not Found` — `VENDOR_NOT_FOUND`

### `DELETE /vendors/me`
- **Auth**: `Role.VENDOR`
- **Errors**:
  - `400 Bad Request` — `CANNOT_DELETE_VENDOR_WITH_ACTIVE_LISTINGS` (holds accepted booth in active/upcoming bazaar)
  - `404 Not Found` — `VENDOR_NOT_FOUND`

### `GET /vendors/:id`
- **Auth**: Public
- **Errors**:
  - `404 Not Found` — `VENDOR_NOT_FOUND` (soft-deleted or non-existent)
  - `403 Forbidden` — `VENDOR_SUBSCRIPTION_INACTIVE` (subscription status is `CANCELED`)

### `GET /vendors`
- **Auth**: Public
- **Query Params**: `?category=&near=lat,lng&radius=`
- **Filter**: Only returns vendors where `deletedAt IS NULL` AND `subscriptionStatus IN ('TRIALING', 'ACTIVE', 'PAST_DUE')`.

### `POST /vendors/me/products`
- **Auth**: `Role.VENDOR`
- **Body**: `{ name, price, images?, description? }`
- **Errors**:
  - `404 Not Found` — `VENDOR_NOT_FOUND`

### `PATCH /vendors/me/products/:id`
- **Auth**: `Role.VENDOR`
- **Body**: Partial product fields.
- **Errors**:
  - `404 Not Found` — `PRODUCT_NOT_FOUND`

### `DELETE /vendors/me/products/:id`
- **Auth**: `Role.VENDOR`
- **Behavior**: Sets `deletedAt = NOW()`.
- **Errors**:
  - `404 Not Found` — `PRODUCT_NOT_FOUND`

---

## 6. Error Codes

| Code | HTTP Status | Description |
|---|---|---|
| `VENDOR_NOT_FOUND` | 404 | Vendor profile does not exist or is soft-deleted |
| `VENDOR_PROFILE_ALREADY_EXISTS` | 409 | User already has an active vendor profile |
| `VENDOR_SUBSCRIPTION_INACTIVE` | 403 | Brand profile is hidden because subscription is CANCELED |
| `CANNOT_DELETE_VENDOR_WITH_ACTIVE_LISTINGS` | 400 | Cannot soft-delete vendor holding accepted booth assignments |
| `PRODUCT_NOT_FOUND` | 404 | Product does not exist, is soft-deleted, or belongs to another vendor |
| `INVALID_LOCATION_PAYLOAD` | 400 | `homeLocation` coordinates required when `hasFixedLocation` is true |
| `FORBIDDEN_ROLE` | 403 | User does not have VENDOR role |
