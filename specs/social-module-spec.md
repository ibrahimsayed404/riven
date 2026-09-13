# Social Module — Spec

## Scope
One new `social` module covering three features:
1. **Favorites** — Shoppers can favorite/unfavorite: Bazaars, Products, Vendors (follow).
2. **Ratings** — Shoppers can rate (1–5 + optional text review): Vendors and Products.
3. Wire `DiscoveryService.discoverBazaars`'s stubbed `isFavorite: false` to real data.

Out of scope for this pass: notifications on new followers/ratings (belongs to the
Notifications module later), rating moderation/reporting, vendor replies to reviews.

## Module boundaries (follow the existing pattern)
- New `apps/api/src/modules/social/` module. Owns its own tables — does NOT reach
  into Vendors/Products/Bazaars repositories directly for writes.
- Needs read access to Orders to verify purchase — call through `OrdersService`
  (exported method), never query the Order/OrderItem tables directly from Social.
- `DiscoveryModule` will import `SocialModule` (or its exported service) the same
  way it imports `BazaarsModule` today — thin passthrough, no direct repo access.
- All endpoints require `JwtAuthGuard` + Shopper role, except read-only aggregate
  endpoints (e.g. "get a vendor's average rating") which can be public.

## Data model (Prisma — new models, review field names against actual schema first)

```prisma
enum FavoriteTargetType {
  BAZAAR
  PRODUCT
  VENDOR
}

model Favorite {
  id         String             @id @default(uuid())
  userId     String
  targetType FavoriteTargetType
  targetId   String
  createdAt  DateTime           @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, targetType, targetId])
  @@index([targetType, targetId])
}

enum RatingTargetType {
  VENDOR
  PRODUCT
}

model Rating {
  id         String           @id @default(uuid())
  userId     String
  targetType RatingTargetType
  targetId   String
  score      Int              // 1-5, enforced at DB (check constraint) + DTO
  review     String?
  orderId    String           // the verified order that unlocked this rating
  createdAt  DateTime         @default(now())
  updatedAt  DateTime         @updatedAt

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  order Order @relation(fields: [orderId], references: [id])

  @@unique([userId, targetType, targetId]) // one rating per user per target; edit via update, not re-create
  @@index([targetType, targetId])
}
```

Add a raw-SQL migration step (like the existing GiST-index pattern) for the
`score BETWEEN 1 AND 5` check constraint, since Prisma can't express it declaratively.

**Confirm before implementing:** exact existing model/field names for `Order`,
`OrderItem`, `Vendor`, `Product`, `User` — pull these from `schema.prisma` rather
than assuming. If `Order` doesn't have a direct `vendorId`/`productId` link (e.g.
it's only on `OrderItem`), the "verified purchase" check needs to join through
`OrderItem`.

## Verified-purchase rule (rating gate)
A user may rate a Vendor or Product only if they have at least one Order:
- containing an OrderItem from that Vendor/Product, AND
- in a completed/fulfilled state (not PENDING/CANCELLED — confirm exact enum
  value from OrderStatus, e.g. `DELIVERED` or `COMPLETED`).

If no qualifying order exists → `403 Forbidden` with a clear error code
(`NOT_VERIFIED_PURCHASE`), not a silent empty result.

Rating is `@@unique([userId, targetType, targetId])` — a second rate attempt
should **update** the existing rating (PATCH semantics), not throw a conflict,
so shoppers can revise their review.

## Endpoints

### Favorites
- `POST /social/favorites` — body: `{ targetType, targetId }`. Idempotent
  (favoriting an already-favorited item returns 200, not 409).
- `DELETE /social/favorites` — body: `{ targetType, targetId }`. Idempotent
  (unfavoriting something not favorited returns 200, not 404).
- `GET /social/favorites?targetType=BAZAAR&cursor=...&limit=...` — the user's
  own favorites, keyset paginated (same cursor pattern as `discoverBazaars`).

### Ratings
- `POST /social/ratings` — body: `{ targetType, targetId, score, review? }`.
  Enforces verified-purchase gate. Upserts (see above).
- `GET /social/ratings/summary?targetType=VENDOR&targetId=...` — public,
  returns `{ average: number, count: number }`. This is what Vendor/Product
  detail pages will call — keep it cheap (aggregate query, no N+1).
- `GET /social/ratings?targetType=PRODUCT&targetId=...&cursor=...&limit=...` —
  public, paginated list of reviews for a target (for a reviews section).

## Wiring isFavorite into Discovery
In `DiscoveryService.discoverBazaars`, replace the hardcoded `isFavorite: false`
with a real lookup:
- Only do this lookup when the request is authenticated (anonymous shoppers get
  `isFavorite: false` without a query — don't force auth on a currently-public
  endpoint just for this).
- **Must not introduce N+1**: batch-check favorite status for all bazaar IDs in
  the current page with a single `findMany` (`targetType: BAZAAR, targetId: { in: [...] }`),
  not one query per bazaar.
- This means `PublicDiscoveryController` needs an *optional* auth context (user
  may or may not be logged in). Confirm how the existing auth guard pattern
  handles optional auth in this codebase (there may already be an
  `OptionalJwtAuthGuard` — check before writing a new one).

## Testing (match existing suite conventions)
- Unit tests (`social.service.spec.ts`): verified-purchase gate (pass/fail
  cases), upsert-not-conflict behavior, idempotent favorite/unfavorite.
- E2E (`social.e2e.spec.ts`): seed a real Order via raw SQL or existing
  checkout flow test helpers, confirm rating is rejected without one, confirm
  it succeeds with one, confirm average/count aggregate is correct, confirm
  favorites round-trip and paginate.
- E2E addition to `discovery.e2e.spec.ts` (or new test in it): confirm
  `isFavorite: true` shows up correctly for an authenticated request with an
  existing favorite, and `false` for anonymous requests.

## Known pitfalls to avoid (per project history)
- Raw SQL PostGIS casts: N/A here, no geo columns.
- **Owner ID leaks**: `GET /social/ratings` is public — make sure it returns
  reviewer display name/handle if that's the design, not raw `userId` unless
  intentional and confirmed.
- **N+1 in admin/list views**: the isFavorite batch-check above; also the
  ratings summary must not loop per-item.
- **DI wiring**: Social must not import Vendors/Products repositories directly;
  go through their exported services.
- Rate-limit consideration: `POST /social/ratings` and `/favorites` are
  write endpoints — confirm they sit behind whatever global rate-limiting
  exists (silent rate-limit returns must throw 429, not fail silently, per
  existing pattern).
