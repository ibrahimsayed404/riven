# Social Module Specification — Follow, Favorite & Rating

**Status**: SPECIFICATION FOR REVIEW (REVISED)  
**Module**: Social Interaction (`apps/api/src/modules/social` or `follows`, `favorites`, `ratings`)  
**References**: `riven-spec.md` §3, §4, §7, §13 (Step 7); `riven-backend-architecture.md` §1, §2, §3; `specs/schema.prisma`

---

## 1. Overview & Objectives

The Social module implements lightweight community engagement for Riven:
1. **Follow**: Ongoing entity relationship for notification fan-out (e.g. alerts when a followed vendor joins a bazaar, or an organizer announces updates).
2. **Favorite**: Bookmark / save for later curation (e.g. saved vendors, bazaars, and events for personal wishlists/itineraries).
3. **Rating**: 1–5 score review system with optional text comment, providing social proof and dynamic average rating calculations across discovery feeds.

---

## 2. Data Model & Schema Verification

### 2.1 Actual Content of `specs/schema.prisma`

The exact schema definitions for `Follow`, `Favorite`, `Rating`, and their target enums in [schema.prisma](file:///d:/Dev/Projects/Riven/specs/schema.prisma#L63-L79):

```prisma
enum FollowableType {
  VENDOR
  BAZAAR
}

enum FavorableType {
  VENDOR
  BAZAAR
  EVENT
}

enum RatingTargetType {
  VENDOR
  BAZAAR
  EVENT
}

model Follow {
  id             String         @id @default(uuid())
  userId         String
  user           User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  // Polymorphic target — intentionally NOT a DB foreign key (followableId can
  // point at Vendor or Bazaar). Integrity is enforced in follows.service.ts:
  // verify the target exists before insert. See backend-architecture.md §1.
  followableType FollowableType
  followableId   String

  createdAt DateTime @default(now())

  @@unique([userId, followableType, followableId])
  @@index([followableType, followableId])
  @@map("follows")
}

model Favorite {
  id            String        @id @default(uuid())
  userId        String
  user          User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  favorableType FavorableType
  favorableId   String

  createdAt DateTime @default(now())

  @@unique([userId, favorableType, favorableId])
  @@index([favorableType, favorableId])
  @@map("favorites")
}

model Rating {
  id         String           @id @default(uuid())
  userId     String
  user       User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  targetType RatingTargetType
  targetId   String
  score      Int              // 1-5, enforce range via CHECK constraint below
  comment    String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([userId, targetType, targetId]) // one rating per user per target
  @@index([targetType, targetId])
  @@map("ratings")
}
```

### 2.2 Confirmation of `EVENT` Entity & Target Asymmetry

- **`Event` Model Exists**: The `Event` model is indeed defined in `schema.prisma` (lines 309–332), representing talks, meetups, screenings, or standalone market sub-events hosted by an `Organizer` (optionally tied to a `Bazaar`).
- **Why `FollowableType` excludes `EVENT` (Intentional Asymmetry)**:
  - **`Follow`** represents a subscription to an ongoing creator/producer entity that has future activity streams (`VENDOR` or `BAZAAR`). Following an organizer/bazaar or vendor generates push notifications when new bazaars or booth listings are posted.
  - **`EVENT`** is a discrete point-in-time happening (e.g. a specific 2-hour talk). A user does not "follow" a single session; they **`Favorite`** it to bookmark/save it on their schedule and receive an `EVENT_REMINDER` notification (§8 of `riven-spec.md`).
  - **`Rating`** supports `EVENT` so attendees can rate specific workshops or talks after they conclude.

---

## 3. Endpoints & API Contract

### 3.1 Follows Endpoints

#### `POST /social/follows`
- **Auth**: Authenticated (`SHOPPER`, `VENDOR`, `ORGANIZER`, `ADMIN`)
- **Body**:
  ```json
  {
    "type": "VENDOR" | "BAZAAR",
    "targetId": "string (UUID)"
  }
  ```
- **Behavior**: Idempotent upsert (if already following, returns 200 with existing record).
- **Errors**:
  - `404 Not Found` — `TARGET_NOT_FOUND` (invalid target or target soft-deleted)
  - `400 Bad Request` — `CANNOT_FOLLOW_SELF` (vendor/organizer attempting to follow their own profile)

#### `DELETE /social/follows`
- **Auth**: Authenticated
- **Query Params**: `?type=VENDOR|BAZAAR&targetId=UUID`
- **Behavior**: Removes the follow relation. Idempotent (succeeds even if relation didn't exist).
- **Response**: `200 { "unfollowed": true }`.

#### `GET /social/follows`
- **Auth**: Authenticated (lists current user's follows)
- **Query Params**: `?type=VENDOR|BAZAAR&limit=20&cursor=...`
- **Response**: List of followed entities with metadata (`id`, `name`, `logo`/`coverMedia`, `type`, `createdAt`).

---

### 3.2 Favorites Endpoints

#### `POST /social/favorites`
- **Auth**: Authenticated
- **Body**:
  ```json
  {
    "type": "VENDOR" | "BAZAAR" | "EVENT",
    "targetId": "string (UUID)"
  }
  ```
- **Behavior**: Idempotent upsert (if already favorited, returns 200 with existing record).
- **Errors**:
  - `404 Not Found` — `TARGET_NOT_FOUND` (invalid or soft-deleted)

#### `DELETE /social/favorites`
- **Auth**: Authenticated
- **Query Params**: `?type=VENDOR|BAZAAR|EVENT&targetId=UUID`
- **Behavior**: Removes the favorite bookmark. Idempotent.
- **Response**: `200 { "unfavorited": true }`.

#### `GET /social/favorites`
- **Auth**: Authenticated
- **Query Params**: `?type=VENDOR|BAZAAR|EVENT&limit=20&cursor=...`
- **Response**: List of user's favorited items grouped or filtered by type.

---

### 3.3 Ratings & Reviews Endpoints

#### `POST /social/ratings`
- **Auth**: Authenticated
- **Body**:
  ```json
  {
    "targetType": "VENDOR" | "BAZAAR" | "EVENT",
    "targetId": "string (UUID)",
    "score": 1 | 2 | 3 | 4 | 5,
    "comment": "string (optional, max 1000 chars)"
  }
  ```
- **Contract Rule (Strict 409 CONFLICT on duplicate)**:
  - If a rating already exists for `(userId, targetType, targetId)`, `POST` **rejects with `409 Conflict` (`RATING_ALREADY_EXISTS`)**.
  - **Rationale**: Enforcing 409 separates initial review creation from subsequent modification. The client must explicitly use `PATCH /social/ratings/:id` for edits. This avoids accidental overwrites, preserves intent, and aligns with RESTful semantics across the Riven API.
- **Errors**:
  - `400 Bad Request` — `INVALID_RATING_SCORE` (score not an integer in 1..5)
  - `400 Bad Request` — `CANNOT_RATE_SELF` (vendor rating own profile, organizer rating own bazaar/event)
  - `404 Not Found` — `TARGET_NOT_FOUND`
  - `409 Conflict` — `RATING_ALREADY_EXISTS` (rating already exists for this target)

#### `PATCH /social/ratings/:id`
- **Auth**: Authenticated (owner of the rating)
- **Body**: `{ "score"?: number, "comment"?: string | null }`
- **Behavior**: Updates the score and/or comment and updates `updatedAt = NOW()`.
- **Errors**:
  - `400 Bad Request` — `INVALID_RATING_SCORE`
  - `404 Not Found` — `RATING_NOT_FOUND`
  - `403 Forbidden` — `NOT_RATING_OWNER`

#### `DELETE /social/ratings/:id`
- **Auth**: Authenticated (owner of the rating or ADMIN)
- **Behavior**: Hard deletes the single rating record.
- **Response**: `200 { "deleted": true }`.
- **Errors**:
  - `404 Not Found` — `RATING_NOT_FOUND`
  - `403 Forbidden` — `NOT_RATING_OWNER`

#### `GET /social/ratings` (Public)
- **Auth**: Public
- **Query Params**: `?targetType=VENDOR|BAZAAR|EVENT&targetId=UUID&limit=20&cursor=...`
- **Response**:
  ```json
  {
    "summary": {
      "averageScore": 4.7,
      "totalReviews": 38,
      "scoreDistribution": { "1": 0, "2": 1, "3": 2, "4": 10, "5": 25 }
    },
    "items": [
      {
        "id": "uuid",
        "userId": "uuid",
        "userName": "Farah A.",
        "score": 5,
        "comment": "Loved the handmade pottery!",
        "createdAt": "2026-08-14T20:00:00.000Z",
        "updatedAt": "2026-08-14T20:00:00.000Z"
      }
    ],
    "pagination": { "hasMore": false, "nextCursor": null }
  }
  ```

---

## 4. Validation & Business Rules

1. **Rating Eligibility (Open Discovery vs. Purchase Gate)**:
   - In Riven v1, discovery is un-gated (no in-app cart/checkout; bazaar entry is largely unticketed). Shoppers can rate any active vendor, bazaar, or event without needing a purchase receipt.
   - Spam/abuse mitigation:
     - Strict 1-rating-per-user-per-target enforced via database unique constraint (`@@unique([userId, targetType, targetId])`).
     - Self-rating is strictly blocked (`CANNOT_RATE_SELF`).
2. **Target Deletion Policy**:
   - Soft-deleting a target (`deletedAt !== null`) blocks new follows, favorites, and ratings (`TARGET_NOT_FOUND`).
   - Existing ratings remain stored in the DB for historical record-keeping, but are excluded from active discovery aggregations.

---

## 5. Auth Module Work: Optional Authentication Guard

### 5.1 Current State Analysis
- `JwtAuthGuard` in `apps/api/src/modules/auth/guards/jwt-auth.guard.ts` currently extends `AuthGuard('jwt')` and unconditionally throws `UnauthorizedException` if `err || !user`.
- It does **not** support optional/anonymous auth.

### 5.2 Explicit Auth Work: `OptionalJwtAuthGuard`
To support endpoints that work for both anonymous visitors and authenticated users (like Discovery feeds), we will add an explicit `OptionalJwtAuthGuard`:

1. **Implementation (`apps/api/src/modules/auth/guards/optional-jwt-auth.guard.ts`)**:
   ```typescript
   import { Injectable, ExecutionContext } from '@nestjs/common';
   import { AuthGuard } from '@nestjs/passport';

   @Injectable()
   export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
     // Override handleRequest so missing token or bad token does NOT throw 401
     handleRequest<TUser = any>(_err: any, user: any, _info: any, _context: ExecutionContext): TUser | null {
       return user || null;
     }
   }
   ```
2. **Decorator & Controller Usage**:
   ```typescript
   @UseGuards(OptionalJwtAuthGuard)
   @Get('vendors')
   async discoverVendors(
     @Query() dto: DiscoverVendorsDto,
     @CurrentUser('userId') userId?: string,
   ) { ... }
   ```
   - If a valid `Bearer <token>` is present in the `Authorization` header, `req.user` (and `@CurrentUser('userId')`) is populated.
   - If the header is missing, expired, or invalid, `req.user` is `null` / `undefined`, and the request proceeds anonymously without error.

---

## 6. Retrofit into Discovery Module

1. **`GET /discovery/bazaars` and `GET /discovery/vendors`**:
   - Decorated with `@UseGuards(OptionalJwtAuthGuard)`.
   - Pass optional `userId` to `DiscoveryService` and `DiscoveryRepository`.
2. **Repository SQL Retrofit**:
   - When `userId` is provided:
     - `LEFT JOIN favorites fav ON fav."favorableType" = 'BAZAAR' AND fav."favorableId" = b."id" AND fav."userId" = ${userId}` (and analogous for vendors).
     - `COALESCE(fav."id" IS NOT NULL, false) AS "isFavorite"`.
   - When `userId` is not provided:
     - `false AS "isFavorite"` directly without extra joins.
3. **Live Ratings**:
   - Discovery repository's existing `LEFT JOIN LATERAL` against `"ratings"` will naturally aggregate real user scores from `POST /social/ratings`.

---

## 7. Error Codes

| Code | HTTP Status | Description |
|---|---|---|
| `TARGET_NOT_FOUND` | 404 | Follow/favorite/rating target does not exist or is soft-deleted |
| `CANNOT_FOLLOW_SELF` | 400 | User cannot follow their own vendor profile or bazaar |
| `CANNOT_RATE_SELF` | 400 | User cannot rate their own vendor profile or organized event/bazaar |
| `INVALID_RATING_SCORE` | 400 | Rating score must be an integer between 1 and 5 |
| `RATING_NOT_FOUND` | 404 | Rating does not exist |
| `RATING_ALREADY_EXISTS` | 409 | User has already submitted a rating for this target |
| `NOT_RATING_OWNER` | 403 | User does not have permission to modify this rating |
