# Notifications Module Specification

**Status**: DRAFT FOR REVIEW (FINALIZED)  
**Module**: Notifications (`apps/api/src/modules/notifications`) & User Location (`PATCH /users/me/location`)  
**References**: `riven-spec.md` §8, §11, §13 (Step 8); `riven-backend-architecture.md` §1, §2, §3; `specs/schema.prisma`

---

## 1. Overview & Scope

The Notifications module provides event-driven and scheduled alert fan-out to shoppers and vendors across Riven:
1. **Trigger 1: `BAZAAR_NEARBY`**: Fired when a new bazaar is published (`bazaar.published`). Alerts users whose stored location (`User.location`) is within a defined radius (25km) of the bazaar's PostGIS coordinate.
2. **Trigger 2: `FOLLOWED_VENDOR_NEW_BAZAAR`**: Fired when an organizer accepts a vendor's application (`booth_listing.accepted`). Fan-outs to all users who `Follow` that vendor (`followableType = 'VENDOR'`).
3. **Trigger 3: `EVENT_REMINDER`**: Scheduled reminder for favorited upcoming bazaars and events (`favorite.favorableType IN ('BAZAAR', 'EVENT')`). Fired ~24 hours prior to `startDate` / `startsAt` via an hourly cron job.
4. **User Location Management**:
   - Introduces `PATCH /users/me/location` to allow authenticated users to set/update their home/preferred discovery coordinates (`User.location`), enabling `BAZAAR_NEARBY` queries to reach them.
5. **Push Provider & Delivery Model**:
   - Stores in-app notification records in PostgreSQL (`Notification` model) for inbox / history queries (`GET /notifications`).
   - Push delivery abstraction interface (`PushNotificationService`) designed for FCM / Expo Push Notifications with mock/console delivery in test/dev environments.
   - Decoupled domain event emission (`EventEmitter2` / `@nestjs/event-emitter`) ensuring transactional mutations (e.g. bazaar publish, booth assignment) are never blocked by push fan-out.

---

## 2. Data Model & Schema Verification

### 2.1 Actual `User` Model & Location Endpoint

From `specs/schema.prisma`:

```prisma
model User {
  id           String   @id @default(uuid())
  name         String
  email        String   @unique
  phone        String?  @unique
  passwordHash String
  role         Role
  // GIST index required: CREATE INDEX user_location_gist ON "User" USING GIST (location);
  location  Unsupported("geography(Point, 4326)")?
  interests String[] @default([])

  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  vendor        Vendor?
  organizer     Organizer?
  follows       Follow[]
  favorites     Favorite[]
  ratings       Rating[]
  notifications Notification[]
  refreshTokens RefreshToken[]

  @@index([role])
  @@map("users")
}
```

#### New User Location Endpoint: `PATCH /users/me/location`
- **Auth**: Authenticated (`SHOPPER`, `VENDOR`, `ORGANIZER`, `ADMIN`)
- **Body**:
  ```json
  {
    "latitude": 30.0444,
    "longitude": 31.2357
  }
  ```
- **Behavior**: Updates `User.location` using PostGIS `ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography`.
- **Response**: `200 { "updated": true, "location": { "latitude": 30.0444, "longitude": 31.2357 } }`.
- **Validation**: Latitude `[-90, 90]`, Longitude `[-180, 180]`.

---

### 2.2 `Notification` Model & Idempotency Key Design

```prisma
enum NotificationType {
  BAZAAR_NEARBY
  FOLLOWED_VENDOR_NEW_BAZAAR
  EVENT_REMINDER
}

model Notification {
  id             String           @id @default(uuid())
  userId         String
  user           User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  type           NotificationType
  idempotencyKey String?          @unique // e.g. "EVENT_REMINDER:<userId>:<targetType>:<targetId>:<dateYMD>"
  payload        Json             // Structured metadata: title, body, entity IDs, deep link route
  readAt         DateTime?
  createdAt      DateTime         @default(now())

  @@index([userId, readAt])
  @@map("notifications")
}
```

#### Idempotency Key Formats (DB-enforced Unique Constraint):
- `EVENT_REMINDER`: `EVENT_REMINDER:<userId>:<targetType>:<targetId>:<dateYMD>` (prevents duplicate reminder notifications for the same event).
- `FOLLOWED_VENDOR_NEW_BAZAAR`: `FOLLOWED_VENDOR_NEW_BAZAAR:<userId>:<vendorId>:<bazaarId>` (prevents duplicate alerts if an application acceptance is retried).
- `BAZAAR_NEARBY`: `BAZAAR_NEARBY:<userId>:<bazaarId>`.

---

## 3. Package Dependencies & Infrastructure

We will add and configure:
1. **`@nestjs/event-emitter`**:
   - Registered in `AppModule` via `EventEmitterModule.forRoot()`.
   - Used for publishing domain events (`bazaar.published`, `booth_listing.accepted`).
2. **`@nestjs/schedule`**:
   - Registered in `AppModule` via `ScheduleModule.forRoot()`.
   - Used for the hourly cron runner `EventReminderJob`.

---

## 4. Trigger Mechanics & Cron Schedule

### 4.1 Trigger 1: `BAZAAR_NEARBY` (Event-Driven)
- Emitted on event `bazaar.published`.
- Query:
  ```sql
  SELECT u.id AS "userId"
  FROM "users" u
  WHERE u."deletedAt" IS NULL
    AND u."location" IS NOT NULL
    AND ST_DWithin(u."location", ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, 25000)
  ```
- Creates notifications with `type = 'BAZAAR_NEARBY'` and `idempotencyKey = 'BAZAAR_NEARBY:<userId>:<bazaarId>'`.

### 4.2 Trigger 2: `FOLLOWED_VENDOR_NEW_BAZAAR` (Event-Driven)
- Emitted on event `booth_listing.accepted`.
- Queries all active followers of `vendorId` from `follows`.
- Creates notifications with `type = 'FOLLOWED_VENDOR_NEW_BAZAAR'` and `idempotencyKey = 'FOLLOWED_VENDOR_NEW_BAZAAR:<userId>:<vendorId>:<bazaarId>'`.

### 4.3 Trigger 3: `EVENT_REMINDER` (Cron Scheduled)
- **Schedule**: `@Cron(CronExpression.EVERY_HOUR)` (Runs at minute 0 of every hour, e.g. `0 * * * *`).
- **Lookahead Window**: Finds upcoming favorited Bazaars/Events starting between `NOW() + INTERVAL '23 hours'` and `NOW() + INTERVAL '25 hours'` (centered on the 24-hour mark).
- **Idempotency**: Insert uses `idempotencyKey = 'EVENT_REMINDER:<userId>:<targetType>:<targetId>:<dateYMD>'`. Even if the job overlaps or retries, duplicate inserts are caught by the DB unique constraint and safely ignored.

---

## 5. Endpoints & API Contract

### 5.1 `GET /notifications`
- **Auth**: Authenticated (`SHOPPER`, `VENDOR`, `ORGANIZER`, `ADMIN`)
- **Query Params**: `unreadOnly?: boolean`, `limit?: number`, `cursor?: string`
- **Response**:
  ```json
  {
    "items": [
      {
        "id": "uuid",
        "type": "FOLLOWED_VENDOR_NEW_BAZAAR",
        "payload": {
          "vendorId": "uuid",
          "vendorName": "Artisan Leather",
          "bazaarId": "uuid",
          "bazaarName": "Zamalek Spring Bazaar",
          "boothLabel": "A-12",
          "startDate": "2026-10-01T10:00:00.000Z"
        },
        "readAt": null,
        "createdAt": "2026-08-14T20:00:00.000Z"
      }
    ],
    "unreadCount": 3,
    "pagination": { "hasMore": false, "nextCursor": null }
  }
  ```

### 5.2 `PATCH /notifications/:id/read`
- **Auth**: Authenticated (owner only)
- **Response**: `200 { "id": "uuid", "readAt": "2026-08-14T20:05:00.000Z" }`.

### 5.3 `POST /notifications/read-all`
- **Auth**: Authenticated
- **Response**: `200 { "markedCount": 3 }`.

### 5.4 `PATCH /users/me/location`
- **Auth**: Authenticated
- **Body**: `{ "latitude": number, "longitude": number }`
- **Response**: `200 { "updated": true, "location": { "latitude": 30.0444, "longitude": 31.2357 } }`.

---

## 6. Push Delivery Abstraction

```typescript
export interface PushMessage {
  toUserId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushNotificationService {
  sendPush(message: PushMessage): Promise<void>;
  sendPushBatch(messages: PushMessage[]): Promise<void>;
}
```

---

## 7. Error Codes

| Code | HTTP Status | Description |
|---|---|---|
| `NOTIFICATION_NOT_FOUND` | 404 | Notification does not exist |
| `NOT_NOTIFICATION_OWNER` | 403 | User does not own this notification |
| `INVALID_LOCATION_PAYLOAD` | 400 | Latitude or longitude is invalid |
