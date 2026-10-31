# Query benchmark — S0-baseline (2026-10-31)

Database `riven_bench_test` on localhost:5433; volume ×1; verified vendors 90 %; 20 warm-up + 200 timed runs × 3 repetitions (median of the repetitions; spread = max − min p95). Plan: `specs/architecture-and-query-performance-plan.md` §2.1.

Row counts: bazaars 3,000 · favorites 89,346 · follows 81,725 · order_groups 100,626 · order_items 301,252 · orders 150,626 · product_variants 120,000 · products 50,626 · ratings 40,000 · users 20,400 · vendors 300

## Reads (ms)

| Query | p50 | p95 | max | p95 spread |
|---|---:|---:|---:|---:|
| products list (page 1) | 100.70 | 199.47 | 510.11 | 82.52 |
| products list (deep page 100) | 109.77 | 194.68 | 1047.99 | 317.52 |
| products by category | 30.16 | 83.21 | 548.70 | 53.28 |
| products by vendor | 16.99 | 68.79 | 682.83 | 29.56 |
| products search 2-char "sh" | 419.35 | 1155.95 | 2079.51 | 787.70 |
| products search common "linen" | 243.98 | 369.40 | 674.35 | 115.50 |
| products search rare "zircon" | 284.67 | 1071.55 | 2917.65 | 749.71 |
| product detail | 5.42 | 15.88 | 47.84 | 6.14 |
| public bazaars | 10.46 | 37.73 | 138.05 | 7.05 |
| discovery with location | 12.90 | 38.13 | 72.53 | 4.93 |
| discovery without location | 6.08 | 20.79 | 61.18 | 9.73 |
| shopper orders | 6.91 | 23.30 | 89.78 | 23.01 |
| vendor orders | 13.94 | 37.59 | 105.08 | 4.66 |
| vendor orders (status PAID) | 10.72 | 27.21 | 71.82 | 16.91 |
| expiry candidate scan | 179.77 | 282.21 | 518.37 | 53.12 |
| expiry backlog | 324.94 | 504.25 | 1099.44 | 121.55 |
| ratings list | 5.56 | 15.10 | 52.25 | 3.03 |
| ratings aggregate | 1.90 | 7.56 | 47.37 | 3.12 |
| favorites (deep cursor) | 4.00 | 14.54 | 39.70 | 2.27 |
| favorites PRODUCT (deep cursor) | 4.06 | 14.62 | 48.08 | 4.09 |
| follows (deep cursor) | 3.67 | 13.48 | 197.45 | 30.02 |
| admin user search | 136.03 | 247.53 | 658.05 | 246.00 |
| admin vendor search | 34.23 | 95.63 | 561.84 | 12.87 |

## Writes (ms)

| Write | p50 | p95 |
|---|---:|---:|
| product insert | 5.12 | 45.51 |
| order group + 1 order + 2 items insert | 14.47 | 59.49 |
| favorite insert | 4.24 | 37.34 |

## Concurrency (50 clients × 15 s)

| Pool | Query | req/s | p95 ms | errors | P2024 |
|---|---|---:|---:|---:|---:|
| default | products list | 16 | 2465.22 | 149 | 0 |
| default | vendor orders | 89 | 1004.23 | 0 | 0 |
| 5 | products list | 8 | 3206.12 | 228 | 0 |
| 5 | vendor orders | 83 | 1084.26 | 0 | 0 |

## Foreign keys without a supporting index

| Table | FK | Columns |
|---|---|---|
| cart_items | cart_items_productId_fkey | productId |
| cart_items | cart_items_variantId_fkey | variantId |
| categories | categories_parentId_fkey | parentId |
| inventory_movements | inventory_movements_actorUserId_fkey | actorUserId |
| order_groups | order_groups_userId_fkey | userId |
| order_items | order_items_orderId_fkey | orderId |
| order_items | order_items_productId_fkey | productId |
| order_items | order_items_variantId_fkey | variantId |
| orders | orders_orderGroupId_fkey | orderGroupId |
| payment_exceptions | payment_exceptions_resolvedById_fkey | resolvedById |
| processed_events | processed_events_eventId_fkey | eventId |

## Captured SQL (Prisma 6, one call per target)

### products list (page 1)

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."products"."id" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL))) OFFSET $3) AS "sub";  -- params [true,true,0]
SELECT "public"."products"."id", "public"."products"."vendorId", "public"."products"."title", "public"."products"."description", "public"."products"."categoryId", "public"."products"."basePrice", "public"."products"."images", "public"."products"."createdAt", "public"."products"."updatedAt" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL))) ORDER BY "public"."products"."createdAt" DESC LIMIT $3 OFFSET $4;  -- params [true,true,20,0]
COMMIT;  -- params []
```

### products list (deep page 100)

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."products"."id" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL))) OFFSET $3) AS "sub";  -- params [true,true,0]
SELECT "public"."products"."id", "public"."products"."vendorId", "public"."products"."title", "public"."products"."description", "public"."products"."categoryId", "public"."products"."basePrice", "public"."products"."images", "public"."products"."createdAt", "public"."products"."updatedAt" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL))) ORDER BY "public"."products"."createdAt" DESC LIMIT $3 OFFSET $4;  -- params [true,true,20,1980]
COMMIT;  -- params []
```

### products by category

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."products"."id" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND "public"."products"."categoryId" = $3) OFFSET $4) AS "sub";  -- params [true,true,"0fe197f2-ce4d-d36d-6139-a893a43a8acd",0]
SELECT "public"."products"."id", "public"."products"."vendorId", "public"."products"."title", "public"."products"."description", "public"."products"."categoryId", "public"."products"."basePrice", "public"."products"."images", "public"."products"."createdAt", "public"."products"."updatedAt" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND "public"."products"."categoryId" = $3) ORDER BY "public"."products"."createdAt" DESC LIMIT $4 OFFSET $5;  -- params [true,true,"0fe197f2-ce4d-d36d-6139-a893a43a8acd",20,0]
COMMIT;  -- params []
```

### products by vendor

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."products"."id" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND "public"."products"."vendorId" = $3) OFFSET $4) AS "sub";  -- params [true,true,"b183fa1c-8507-7c78-429a-d7aa592f2ddc",0]
SELECT "public"."products"."id", "public"."products"."vendorId", "public"."products"."title", "public"."products"."description", "public"."products"."categoryId", "public"."products"."basePrice", "public"."products"."images", "public"."products"."createdAt", "public"."products"."updatedAt" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND "public"."products"."vendorId" = $3) ORDER BY "public"."products"."createdAt" DESC LIMIT $4 OFFSET $5;  -- params [true,true,"b183fa1c-8507-7c78-429a-d7aa592f2ddc",20,0]
COMMIT;  -- params []
```

### products search 2-char "sh"

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."products"."id" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND ("public"."products"."title" ILIKE $3 OR "public"."products"."description" ILIKE $4)) OFFSET $5) AS "sub";  -- params [true,true,"%sh%","%sh%",0]
SELECT "public"."products"."id", "public"."products"."vendorId", "public"."products"."title", "public"."products"."description", "public"."products"."categoryId", "public"."products"."basePrice", "public"."products"."images", "public"."products"."createdAt", "public"."products"."updatedAt" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND ("public"."products"."title" ILIKE $3 OR "public"."products"."description" ILIKE $4)) ORDER BY "public"."products"."createdAt" DESC LIMIT $5 OFFSET $6;  -- params [true,true,"%sh%","%sh%",20,0]
COMMIT;  -- params []
```

### products search common "linen"

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."products"."id" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND ("public"."products"."title" ILIKE $3 OR "public"."products"."description" ILIKE $4)) OFFSET $5) AS "sub";  -- params [true,true,"%linen%","%linen%",0]
SELECT "public"."products"."id", "public"."products"."vendorId", "public"."products"."title", "public"."products"."description", "public"."products"."categoryId", "public"."products"."basePrice", "public"."products"."images", "public"."products"."createdAt", "public"."products"."updatedAt" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND ("public"."products"."title" ILIKE $3 OR "public"."products"."description" ILIKE $4)) ORDER BY "public"."products"."createdAt" DESC LIMIT $5 OFFSET $6;  -- params [true,true,"%linen%","%linen%",20,0]
COMMIT;  -- params []
```

### products search rare "zircon"

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."products"."id" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND ("public"."products"."title" ILIKE $3 OR "public"."products"."description" ILIKE $4)) OFFSET $5) AS "sub";  -- params [true,true,"%zircon%","%zircon%",0]
SELECT "public"."products"."id", "public"."products"."vendorId", "public"."products"."title", "public"."products"."description", "public"."products"."categoryId", "public"."products"."basePrice", "public"."products"."images", "public"."products"."createdAt", "public"."products"."updatedAt" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."isActive" = $1 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $2 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND ("public"."products"."title" ILIKE $3 OR "public"."products"."description" ILIKE $4)) ORDER BY "public"."products"."createdAt" DESC LIMIT $5 OFFSET $6;  -- params [true,true,"%zircon%","%zircon%",20,0]
COMMIT;  -- params []
```

### product detail

```sql
SELECT "public"."products"."id", "public"."products"."vendorId", "public"."products"."title", "public"."products"."description", "public"."products"."categoryId", "public"."products"."basePrice", "public"."products"."images", "public"."products"."createdAt", "public"."products"."updatedAt" FROM "public"."products" LEFT JOIN "public"."vendors" AS "j0" ON ("j0"."id") = ("public"."products"."vendorId") WHERE ("public"."products"."id" = $1 AND "public"."products"."isActive" = $2 AND "public"."products"."deletedAt" IS NULL AND ("j0"."verified" = $3 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL))) LIMIT $4 OFFSET $5;  -- params ["397aadfb-d7e8-9a27-0233-2b677d3bcc7d",true,true,1,0]
SELECT "public"."product_variants"."id", "public"."product_variants"."sku", "public"."product_variants"."size", "public"."product_variants"."color", "public"."product_variants"."priceOverride", "public"."product_variants"."stockQuantity", "public"."product_variants"."productId" FROM "public"."product_variants" WHERE ("public"."product_variants"."deletedAt" IS NULL AND "public"."product_variants"."productId" IN ($1)) OFFSET $2;  -- params ["397aadfb-d7e8-9a27-0233-2b677d3bcc7d",0]
```

### public bazaars

```sql

      SELECT COUNT(*) as count FROM "bazaars" WHERE "status" = 'PUBLISHED'::"BazaarStatus" AND "deletedAt" IS NULL AND EXISTS (
  SELECT 1 FROM "organizers" o
  WHERE o."id" = "bazaars"."organizerId" AND o."verified" = true AND o."deletedAt" IS NULL
)
    ;  -- params []

      SELECT
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "deletedAt",
        ST_Y("location"::geometry) AS "lat",
        ST_X("location"::geometry) AS "lng"
      FROM "bazaars"
      WHERE "status" = 'PUBLISHED'::"BazaarStatus" AND "deletedAt" IS NULL AND EXISTS (
  SELECT 1 FROM "organizers" o
  WHERE o."id" = "bazaars"."organizerId" AND o."verified" = true AND o."deletedAt" IS NULL
)
      ORDER BY "createdAt" DESC
      LIMIT $1 OFFSET $2
    ;  -- params [20,0]
```

### discovery with location

```sql

      SELECT
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "deletedAt",
        ST_Y("location"::geometry) AS "lat",
        ST_X("location"::geometry) AS "lng",
        ST_Distance("location", ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS "distanceMeters"
      FROM "bazaars"
      WHERE "status" = 'PUBLISHED'::"BazaarStatus" AND "deletedAt" IS NULL AND EXISTS (
  SELECT 1 FROM "organizers" o
  WHERE o."id" = "bazaars"."organizerId" AND o."verified" = true AND o."deletedAt" IS NULL
) AND ST_DWithin("location", ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5) AND (
        "scheduleType" = 'RECURRING'::"ScheduleType"
        OR ("endDate" IS NOT NULL AND "endDate" >= NOW())
        OR ("endDate" IS NULL AND "startDate" >= NOW() - INTERVAL '1 day')
      )
      ORDER BY ST_Distance("location", ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography) ASC, "id" ASC
      LIMIT $8
    ;  -- params [31.2357,30.0444,31.2357,30.0444,25000,31.2357,30.0444,21]
```

### discovery without location

```sql

      SELECT
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "deletedAt",
        ST_Y("location"::geometry) AS "lat",
        ST_X("location"::geometry) AS "lng",
        NULL::double precision AS "distanceMeters"
      FROM "bazaars"
      WHERE "status" = 'PUBLISHED'::"BazaarStatus" AND "deletedAt" IS NULL AND EXISTS (
  SELECT 1 FROM "organizers" o
  WHERE o."id" = "bazaars"."organizerId" AND o."verified" = true AND o."deletedAt" IS NULL
) AND (
        "scheduleType" = 'RECURRING'::"ScheduleType"
        OR ("endDate" IS NOT NULL AND "endDate" >= NOW())
        OR ("endDate" IS NULL AND "startDate" >= NOW() - INTERVAL '1 day')
      )
      ORDER BY "startDate" ASC, "id" ASC
      LIMIT $1
    ;  -- params [21]
```

### shopper orders

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."orders"."id" FROM "public"."orders" WHERE "public"."orders"."userId" = $1 OFFSET $2) AS "sub";  -- params ["000411e2-3b2f-81a4-ca82-7d1a9a9b99e4",0]
SELECT "public"."orders"."id", "public"."orders"."orderGroupId", "public"."orders"."vendorId", "public"."orders"."userId", "public"."orders"."status"::text, "public"."orders"."subtotal", "public"."orders"."createdAt", "public"."orders"."updatedAt" FROM "public"."orders" WHERE "public"."orders"."userId" = $1 ORDER BY "public"."orders"."createdAt" DESC LIMIT $2 OFFSET $3;  -- params ["000411e2-3b2f-81a4-ca82-7d1a9a9b99e4",20,0]
COMMIT;  -- params []
```

### vendor orders

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."orders"."id" FROM "public"."orders" WHERE "public"."orders"."vendorId" = $1 OFFSET $2) AS "sub";  -- params ["6654c734-ccab-8f44-0ff0-825eb443dc7f",0]
SELECT "public"."orders"."id", "public"."orders"."orderGroupId", "public"."orders"."vendorId", "public"."orders"."userId", "public"."orders"."status"::text, "public"."orders"."subtotal", "public"."orders"."createdAt", "public"."orders"."updatedAt" FROM "public"."orders" WHERE "public"."orders"."vendorId" = $1 ORDER BY "public"."orders"."createdAt" DESC LIMIT $2 OFFSET $3;  -- params ["6654c734-ccab-8f44-0ff0-825eb443dc7f",20,0]
SELECT "public"."users"."id", "public"."users"."name", "public"."users"."email", "public"."users"."phone" FROM "public"."users" WHERE "public"."users"."id" IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) OFFSET $20;  -- params ["5bef2534-962a-8da4-6ee1-6970dea745e7","6f6f7b93-2807-f090-e317-19a2a5769454","8be2c8b5-49c9-e82b-eece-815a633b280f","4d499e6e-76de-6320-4ccb-b8c76d76dc8c","4c7c01bd-95ad-c83f-1687-5d02e754357c","90bfe127-e25b-e6a0-a0a5-dec078415ac7","f5836325-2b30-eea2-d84a-b1343394a78a","1121e997-2254-97a0-5690-be52eb7b1669","a4e21d43-ceea-74f6-4789-8ae456192912","787a869a-17e0-1890-4a7a-0743d8916d9e","64b2fd3a-6f78-3a21-ad08-b9b99dd11a4d","46aeae03-0c16-b047-be3d-ce53b27f4f41","c101f407-ae6c-f7b5-45fd-a202ebfa3152","ac963469-b60e-e4fd-84e1-c454bd818965","30b9ecc7-d5c5-f10c-50a9-8362eacbc498","42a7fdf1-086e-e555-635d-042076ba5f35","fdc9c775-dd3a-9635-b029-ede000f698e3","dce3bef9-e20c-a7b4-5bb2-3936ee9becd7","a4be6fd3-0084-5d79-64b4-134dae6b56ca",0]
COMMIT;  -- params []
```

### vendor orders (status PAID)

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."orders"."id" FROM "public"."orders" WHERE ("public"."orders"."vendorId" = $1 AND "public"."orders"."status" = CAST($2::text AS "public"."OrderStatus")) OFFSET $3) AS "sub";  -- params ["6654c734-ccab-8f44-0ff0-825eb443dc7f","PAID",0]
SELECT "public"."orders"."id", "public"."orders"."orderGroupId", "public"."orders"."vendorId", "public"."orders"."userId", "public"."orders"."status"::text, "public"."orders"."subtotal", "public"."orders"."createdAt", "public"."orders"."updatedAt" FROM "public"."orders" WHERE ("public"."orders"."vendorId" = $1 AND "public"."orders"."status" = CAST($2::text AS "public"."OrderStatus")) ORDER BY "public"."orders"."createdAt" DESC LIMIT $3 OFFSET $4;  -- params ["6654c734-ccab-8f44-0ff0-825eb443dc7f","PAID",20,0]
SELECT "public"."users"."id", "public"."users"."name", "public"."users"."email", "public"."users"."phone" FROM "public"."users" WHERE "public"."users"."id" IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) OFFSET $21;  -- params ["c2e9f8d5-0589-9364-9a64-cf41de0fe830","43103aad-74ca-bd73-4b09-c359d76811d5","0ba792a2-a5b0-d449-651a-e8cb8d6653e1","2c92a276-9f94-1bdc-b6bc-02df252b2488","4c64341a-e500-02c4-41a9-eaf7181ff2b8","19a1e92b-af1f-f730-a400-e389fd1aa333","10c34672-95ba-7bce-a601-ad7e68c2df53","5ae72b61-a6c2-13e9-69e8-cdfbd4e0b481","832884cf-e9cc-51ad-1304-f87df36a37ff","f8668af4-5908-1231-8fb7-4763ff404a71","d51183c1-ec2e-c722-f104-dcc7e4113328","a040b060-2eb1-2e72-3bd9-3dae0ed9a8e8","f448871b-71fe-aad9-b71b-2734afe08107","117149c3-b06f-1905-9141-c74d3f4a8675","77b8c99e-73d1-7d68-73b5-63313c51b887","470dd45f-31f4-8777-8494-ece7f46199c2","d1f9732d-1d38-1642-1e96-5cc3f23c1eef","835e3bb0-0449-b38c-8957-2fb44e1f2ac4","ee007d91-8527-3309-03a0-86dde1212b44","440bb2f1-d85e-3103-ba5c-9f7b534e7174",0]
COMMIT;  -- params []
```

### expiry candidate scan

```sql
SELECT "public"."order_groups"."id", "public"."order_groups"."createdAt" FROM "public"."order_groups" WHERE ("public"."order_groups"."createdAt" < $1 AND "public"."order_groups"."paymobTransactionId" IS NULL AND EXISTS(SELECT "t0"."orderGroupId" FROM "public"."orders" AS "t0" WHERE ("t0"."status" = CAST($2::text AS "public"."OrderStatus") AND ("public"."order_groups"."id") = ("t0"."orderGroupId") AND "t0"."orderGroupId" IS NOT NULL)) AND NOT EXISTS(SELECT "t1"."orderGroupId" FROM "public"."orders" AS "t1" WHERE ("t1"."status" <> CAST($3::text AS "public"."OrderStatus") AND ("public"."order_groups"."id") = ("t1"."orderGroupId") AND "t1"."orderGroupId" IS NOT NULL))) ORDER BY "public"."order_groups"."createdAt" ASC, "public"."order_groups"."id" ASC LIMIT $4 OFFSET $5;  -- params ["2026-10-31 14:12:06.140 UTC","PENDING","PENDING",100,0]
```

### expiry backlog

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."order_groups"."id" FROM "public"."order_groups" WHERE ("public"."order_groups"."createdAt" < $1 AND "public"."order_groups"."paymobTransactionId" IS NULL AND EXISTS(SELECT "t0"."orderGroupId" FROM "public"."orders" AS "t0" WHERE ("t0"."status" = CAST($2::text AS "public"."OrderStatus") AND ("public"."order_groups"."id") = ("t0"."orderGroupId") AND "t0"."orderGroupId" IS NOT NULL)) AND NOT EXISTS(SELECT "t1"."orderGroupId" FROM "public"."orders" AS "t1" WHERE ("t1"."status" <> CAST($3::text AS "public"."OrderStatus") AND ("public"."order_groups"."id") = ("t1"."orderGroupId") AND "t1"."orderGroupId" IS NOT NULL))) OFFSET $4) AS "sub";  -- params ["2026-10-31 14:12:06.140 UTC","PENDING","PENDING",0]
SELECT "public"."order_groups"."id", "public"."order_groups"."createdAt" FROM "public"."order_groups" WHERE ("public"."order_groups"."createdAt" < $1 AND "public"."order_groups"."paymobTransactionId" IS NULL AND EXISTS(SELECT "t0"."orderGroupId" FROM "public"."orders" AS "t0" WHERE ("t0"."status" = CAST($2::text AS "public"."OrderStatus") AND ("public"."order_groups"."id") = ("t0"."orderGroupId") AND "t0"."orderGroupId" IS NOT NULL)) AND NOT EXISTS(SELECT "t1"."orderGroupId" FROM "public"."orders" AS "t1" WHERE ("t1"."status" <> CAST($3::text AS "public"."OrderStatus") AND ("public"."order_groups"."id") = ("t1"."orderGroupId") AND "t1"."orderGroupId" IS NOT NULL))) ORDER BY "public"."order_groups"."createdAt" ASC, "public"."order_groups"."id" ASC LIMIT $4 OFFSET $5;  -- params ["2026-10-31 14:12:06.140 UTC","PENDING","PENDING",1,0]
COMMIT;  -- params []
```

### ratings list

```sql
SELECT "public"."ratings"."id", "public"."ratings"."targetType"::text, "public"."ratings"."targetId", "public"."ratings"."score", "public"."ratings"."comment", "public"."ratings"."createdAt", "public"."ratings"."userId" FROM "public"."ratings" WHERE ("public"."ratings"."targetType" = CAST($1::text AS "public"."RatingTargetType") AND "public"."ratings"."targetId" = $2) ORDER BY "public"."ratings"."createdAt" DESC, "public"."ratings"."id" DESC LIMIT $3 OFFSET $4;  -- params ["PRODUCT","ec6ef230-f182-8039-ee79-4566b9c58adc",21,0]
SELECT "public"."users"."id", "public"."users"."name" FROM "public"."users" WHERE "public"."users"."id" IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) OFFSET $22;  -- params ["694626a8-99b8-86de-bdb8-03cc4e9e220c","136f0ee9-da7c-4f0a-20ac-e874369ad6ff","bb354172-989d-a8cf-c4b6-de41210a858d","fa5f0a23-3bee-e071-344d-60184a3ecb7e","82015b82-bab2-f688-b128-ace33191f880","40b5607e-6190-c752-58c1-3ad01a728297","d03536d2-0c6b-5255-1e49-b28c315f1f7f","bffb0637-df3e-ec2f-d93e-f8a153ce0a7a","9200ed3e-2590-3ef0-7cb0-597326e2f041","62da6280-ddfb-74d2-fa6f-18986599c2d5","4ffc80a1-41a2-4a37-2571-0723098d8345","4285124e-b86b-c8c9-bf25-e6282ba692fe","ce927547-df13-b405-27d2-c7ce3575e1b5","2aa345da-e572-5c19-69b0-93de6d5afa18","fca8f6ef-1279-e7cf-614c-c1d73d0b500c","9d701052-63e6-0fc3-97b4-d01e69b07149","b86c9a2e-d815-29c0-6edf-1a845a1c9776","18d15e3b-5f5b-325c-2adc-8bc986944995","61bafe26-04e8-086b-680b-a0848562ff97","2d6dd8cf-b214-8e7d-16bf-2b1126f5c95a","1d7e50fe-812f-675a-743c-5eed40caf707",0]
```

### ratings aggregate

```sql
SELECT AVG("score"), COUNT(*) AS "_count._all" FROM (SELECT "public"."ratings"."score", "public"."ratings"."id" FROM "public"."ratings" WHERE ("public"."ratings"."targetType" = CAST($1::text AS "public"."RatingTargetType") AND "public"."ratings"."targetId" = $2) OFFSET $3) AS "sub";  -- params ["PRODUCT","ec6ef230-f182-8039-ee79-4566b9c58adc",0]
```

### favorites (deep cursor)

```sql
SELECT "public"."favorites"."id", "public"."favorites"."userId", "public"."favorites"."favorableType"::text, "public"."favorites"."favorableId", "public"."favorites"."createdAt" FROM "public"."favorites" WHERE ("public"."favorites"."userId" = $1 AND ("public"."favorites"."createdAt" < $2 OR ("public"."favorites"."createdAt" = $3 AND "public"."favorites"."id" < $4))) ORDER BY "public"."favorites"."createdAt" DESC, "public"."favorites"."id" DESC LIMIT $5 OFFSET $6;  -- params ["aea4fa2f-74b6-81d4-327c-fc178d6cbcaa","2026-10-17 10:10:34.904 UTC","2026-10-17 10:10:34.904 UTC","3c4881e2-c072-4669-a002-90983e43465a",21,0]
```

### favorites PRODUCT (deep cursor)

```sql
SELECT "public"."favorites"."id", "public"."favorites"."userId", "public"."favorites"."favorableType"::text, "public"."favorites"."favorableId", "public"."favorites"."createdAt" FROM "public"."favorites" WHERE ("public"."favorites"."userId" = $1 AND "public"."favorites"."favorableType" = CAST($2::text AS "public"."FavorableType") AND ("public"."favorites"."createdAt" < $3 OR ("public"."favorites"."createdAt" = $4 AND "public"."favorites"."id" < $5))) ORDER BY "public"."favorites"."createdAt" DESC, "public"."favorites"."id" DESC LIMIT $6 OFFSET $7;  -- params ["aea4fa2f-74b6-81d4-327c-fc178d6cbcaa","PRODUCT","2026-10-17 10:10:34.904 UTC","2026-10-17 10:10:34.904 UTC","3c4881e2-c072-4669-a002-90983e43465a",21,0]
```

### follows (deep cursor)

```sql
SELECT "public"."follows"."id", "public"."follows"."userId", "public"."follows"."followableType"::text, "public"."follows"."followableId", "public"."follows"."createdAt" FROM "public"."follows" WHERE ("public"."follows"."userId" = $1 AND ("public"."follows"."createdAt" < $2 OR ("public"."follows"."createdAt" = $3 AND "public"."follows"."id" < $4))) ORDER BY "public"."follows"."createdAt" DESC, "public"."follows"."id" DESC LIMIT $5 OFFSET $6;  -- params ["aea4fa2f-74b6-81d4-327c-fc178d6cbcaa","2026-10-13 04:10:47.009 UTC","2026-10-13 04:10:47.009 UTC","64c85360-0781-a0b9-19ae-cc27629a58de",21,0]
```

### admin user search

```sql
BEGIN;  -- params []
SELECT "public"."users"."id", "public"."users"."name", "public"."users"."email", "public"."users"."phone", "public"."users"."role"::text, "public"."users"."interests", "public"."users"."isActive", "public"."users"."createdAt", "public"."users"."updatedAt", "public"."users"."deletedAt" FROM "public"."users" WHERE ("public"."users"."deletedAt" IS NULL AND ("public"."users"."name" ILIKE $1 OR "public"."users"."email" ILIKE $2 OR "public"."users"."phone" ILIKE $3)) ORDER BY "public"."users"."createdAt" DESC LIMIT $4 OFFSET $5;  -- params ["%shopper12%","%shopper12%","%shopper12%",20,0]
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."users"."id" FROM "public"."users" WHERE ("public"."users"."deletedAt" IS NULL AND ("public"."users"."name" ILIKE $1 OR "public"."users"."email" ILIKE $2 OR "public"."users"."phone" ILIKE $3)) OFFSET $4) AS "sub";  -- params ["%shopper12%","%shopper12%","%shopper12%",0]
COMMIT;  -- params []
```

### admin vendor search

```sql
BEGIN;  -- params []
SELECT COUNT(*) AS "_count._all" FROM (SELECT "public"."vendors"."id" FROM "public"."vendors" LEFT JOIN "public"."users" AS "j0" ON ("j0"."id") = ("public"."vendors"."ownerId") WHERE ("public"."vendors"."deletedAt" IS NULL AND ("public"."vendors"."name" ILIKE $1 OR ("j0"."email" ILIKE $2 AND ("j0"."id" IS NOT NULL)))) OFFSET $3) AS "sub";  -- params ["%vendor 1%","%vendor 1%",0]
SELECT "public"."vendors"."id", "public"."vendors"."ownerId", "public"."vendors"."name", "public"."vendors"."category"::text, "public"."vendors"."vendorType"::text, "public"."vendors"."verified", "public"."vendors"."rejectionReason", "public"."vendors"."subscriptionStatus"::text, "public"."vendors"."createdAt" FROM "public"."vendors" LEFT JOIN "public"."users" AS "j0" ON ("j0"."id") = ("public"."vendors"."ownerId") WHERE ("public"."vendors"."deletedAt" IS NULL AND ("public"."vendors"."name" ILIKE $1 OR ("j0"."email" ILIKE $2 AND ("j0"."id" IS NOT NULL)))) ORDER BY "public"."vendors"."createdAt" ASC LIMIT $3 OFFSET $4;  -- params ["%vendor 1%","%vendor 1%",20,0]
SELECT "public"."users"."id", "public"."users"."name", "public"."users"."email" FROM "public"."users" WHERE "public"."users"."id" IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) OFFSET $21;  -- params ["335641ae-e94b-ac92-42e2-0b535790a582","0fa75d89-add1-ca50-0603-1be3ca4b3872","38041002-31b4-6455-ee4d-3a0c36880840","32690930-335a-93ef-9dbb-79eb7a646616","6c7c84aa-a206-7bfc-699d-913b90d31f95","32690291-e992-fc04-01d1-5efe601153eb","ff07ccac-f965-be29-4f53-64a7cc241b17","30e20377-aeb5-f34c-22da-0f1deb403ed4","aa7a1b06-8beb-fd7e-6b1f-571d648e4cbd","49e0d7b6-6948-5e75-21ff-ab1d92ac7b04","5066b983-18ac-84ab-c455-eab0f63503f1","9e89a48c-df56-ebfd-6482-2f89e740dca3","24b02547-2d28-871a-ab01-bdceb0bfcb26","c379da6e-be57-777a-cd1b-40a6fde4195a","624db36b-db55-3337-e0fc-8905c40e124a","0b555501-be85-93b0-25f4-cadb251f04ed","35bf1dd8-d538-6048-6392-96d2df5a971d","011f9534-caf5-5255-eb68-5d7e9e931374","1059d854-c028-134a-24eb-7f90040b25f8","f5d9066f-3626-7677-33d7-323043442a23",0]
COMMIT;  -- params []
```

## Findings and caveats (S0)

- **Concurrency failures are `P2028`, not `P2024`.** An ad-hoc rerun (50 clients × 6 calls of `ProductsRepository.findManyPaginated`) failed **141 of 300** calls with `P2028: Transaction API error: Unable to start a transaction in the given time` — the interactive count + page transaction waits at most Prisma's default 2 s for a connection. This is what A1 (S1) removes; vendor orders (batch transaction form) had **0** errors under the same load.
- **Hot spots at base volume (p50):** product search 244–419 ms (ILIKE scans), product list 101–110 ms (COUNT over live products + sort), expiry backlog 325 ms and candidate scan 180 ms, admin user search 136 ms.
- **Unindexed foreign keys** (table above) confirm the plan's Q2: `order_items.orderId`, `orders.orderGroupId`, `order_groups.userId`; the others are lower-traffic and are listed for the bench decision.
- **Noise:** this is a laptop with other processes; p95 spread between repetitions reaches several hundred ms for the slowest queries. Index decisions use the 10× run and `auto_explain` plans (plan §2.3), not these numbers alone.
- Row counts include the rows written by the write benchmark (+626 products / order groups).
