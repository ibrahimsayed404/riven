# Discovery Module Specification

**Status**: DRAFT  
**Module**: Discovery Feed & Spatial Search (`apps/api/src/modules/discovery`)  
**References**: `riven-spec.md` §3 (Visitor Experience), `specs/api-contract.md` §Discovery, `specs/vendor-module-spec.md` §4 (Visibility Rules)

---

## 1. Overview & Objectives
The Discovery module provides public exploration and proximity querying for Bazaars and Vendors. It enables:
1. **Bazaars Discovery**: Finding upcoming, active, and nearby bazaars with spatial radius filtering, schedule type filtering, and date windows.
2. **Vendors Discovery**: Finding nearby craft vendors and artisans filtered by category, rating, and location.
3. **Strict Visibility Gating**: Enforces established business rules prohibiting draft/unpaid bazaars and soft-deleted or subscription-canceled vendors from appearing in any discovery results.

---

## 2. Spatial Query Architecture & PostGIS

### 2.1 PostGIS Distance Calculations
- Uses PostGIS `geography(Point, 4326)` for geodesic (great-circle) distance calculations on the WGS 84 ellipsoid in meters.
- Distance calculation query pattern:
  ```sql
  ST_Distance(
    location,
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
  ) AS distance_meters
  ```
- Spatial indexing: Queries utilize the existing `GIST` indexes (`idx_bazaars_location`, `idx_vendors_home_location`).
- Radius bounding filter:
  ```sql
  ST_DWithin(
    location,
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
    radius_meters
  )
  ```

### 2.2 Location Handling & "Near Me" Fallback
- **When Location is Provided** (`lat` & `lng` query params):
  - Results are filtered within the specified `radiusKm` (default: 25 km, max: 150 km) if radius is requested, or ordered strictly by `distance_meters ASC`.
  - Returned objects include calculated `distanceMeters` and `distanceKm` fields.
  - **Paging Stability Note**: Cursor-based pagination for distance-sorted results assumes the client sends consistent `lat`/`lng` across pages of the same paging session; results are not guaranteed stable if coordinates change between page fetches.
- **When Location is NOT Provided** (e.g. user denied location permissions or web visitor):
  - **Bazaars**: Sorted by `startDate ASC` (soonest upcoming first).
  - **Vendors**: Sorted by `verified DESC, createdAt DESC` (or average rating aggregate once ratings exist; see §3.2).
  - `distanceMeters` and `distanceKm` are returned as `null`.

---

## 3. Endpoints & Filter Semantics

### 3.1 `GET /discovery/bazaars`
Public endpoint to discover published bazaars.

#### Query Parameters:
| Param | Type | Default | Constraints / Semantics |
|---|---|---|---|
| `lat` | `number` | optional | Latitude (-90 to 90) |
| `lng` | `number` | optional | Longitude (-180 to 180) |
| `radiusKm` | `number` | `25` | 1 to 150 km (only applied when `lat`/`lng` present) |
| `scheduleType` | `enum` | optional | `ONE_OFF`, `RECURRING_WEEKLY`, `RECURRING_MONTHLY` |
| `upcomingOnly` | `boolean` | `true` | When true (default): excludes past bazaars where `endDate < NOW()`. When false: includes past bazaars. |
| `limit` | `integer` | `20` | Max: 50 |
| `cursor` | `string` | optional | Keyset pagination cursor |

#### Default Lifecycle & Status Filter Rules:
- **Status Filter**: `WHERE status = 'PUBLISHED' AND deletedAt IS NULL` (DRAFT, canceled, or soft-deleted bazaars are strictly excluded).
- **Default Date Window (`upcomingOnly = true`)**:
  - Excludes completed bazaars where `endDate < NOW()` (or `startDate < NOW() - INTERVAL '1 day'` if `endDate` is null).
  - Past bazaars whose `endDate` has passed are **excluded by default**, even if their DB status is `PUBLISHED`. To retrieve past bazaars, the client must explicitly pass `upcomingOnly=false`.
- **Vendor & Booth Aggregations**:
  - Response includes `boothCount` (total booths) and `occupiedBoothCount` (assigned booths).
- **Placeholder Note on `isFavorite`**:
  - Until the Social/Follow module lands, `isFavorite` is stubbed as `false` universally.

---

### 3.2 `GET /discovery/vendors`
Public endpoint to discover active craft vendors.

#### Query Parameters:
| Param | Type | Default | Constraints / Semantics |
|---|---|---|---|
| `lat` | `number` | optional | Latitude (-90 to 90) |
| `lng` | `number` | optional | Longitude (-180 to 180) |
| `radiusKm` | `number` | `25` | 1 to 150 km (only applied when `lat`/`lng` present) |
| `category` | `string` | optional | Exact category filter (e.g. `Leather`, `Ceramics`, `Jewelry`) |
| `limit` | `integer` | `20` | Max: 50 |
| `cursor` | `string` | optional | Keyset pagination cursor |

#### Ratings & Placeholder Note:
- `ratingScore` is **not** a denormalized column on the `Vendor` table in `schema.prisma`. Dynamic average rating aggregation `COALESCE(AVG(ratings.score), 0)` from the polymorphic `ratings` table (`targetType = 'VENDOR'`) is computed live in SQL.
  > **Note on Performance**: Rating scores are calculated via live aggregation (`AVG(ratings.score) WHERE targetType = 'VENDOR' AND targetId = vendor.id`). If vendor review volume grows significantly, this query should be migrated to a materialized/cached score column on the `vendors` table.
- Non-location fallback sort orders by `verified DESC, createdAt DESC`.
- `isFavorite` is stubbed as `false` universally until the Follow/Favorite module lands.

#### Business & Visibility Rules (§4 of `vendor-module-spec.md`):
- **Soft Deletion Gate**: `WHERE deletedAt IS NULL`.
- **Subscription Gate**: `WHERE subscriptionStatus != 'CANCELED'`. (`TRIALING`, `ACTIVE`, and `PAST_DUE` vendors within grace period remain discoverable).
- **Active Products Preview**: Response includes up to 3 preview product items (id, name, price, images) from active products (`deletedAt IS NULL`).

---

## 4. Keyset / Cursor Pagination

### 4.1 Pagination Encoding & Stability
- Composed of Base64-encoded JSON: `{"s": sortValue, "id": entityId}`.
- Sort strategy:
  - **Distance Sort**: `(distance_meters ASC, id ASC)`.
  - **Date Sort**: `(startDate ASC, id ASC)`.
  - **Fallback Vendor Sort**: `(createdAt DESC, id DESC)`.
- Client consistency requirement:
  > **Note**: Cursor pagination for distance-sorted feeds assumes consistent client coordinates (`lat`/`lng`) across successive page requests within the same browsing session.

---

## 5. Validation & Error Codes
- `INVALID_LOCATION_PAYLOAD` (400): Latitude or longitude missing when the other is provided, or values outside `[-90, 90]` / `[-180, 180]`.
- `INVALID_RADIUS` (400): `radiusKm` is `< 1` or `> 150`.
