# Search Module Specification

**Status**: IMPLEMENTED (unit-tested; e2e written but not yet executed — see §8)  
**Module**: Full-text search over Products, Vendors and Bazaars (`apps/api/src/infra/search` + `apps/api/src/modules/search`)  
**References**: `riven-spec.md` §11 (Meilisearch, sync via queue), §12 (stack), §13 item 9; `fashion-marketplace-addendum.md` §2–3 (Category hierarchy, Product/Variant); `vendor-module-spec.md` §3 (visibility); `discovery-module-spec.md` (geo + optional-auth patterns); `riven-backend-architecture.md` §2 (`modules/search`, `jobs/search-sync.processor.ts`)

---

## 1. Overview, Scope & Governing Principle

### 1.1 Governing principle

**PostgreSQL is the source of truth. Meilisearch is a derived, disposable read model.**

- Nothing in Meilisearch is ever used to decide business state. No service reads from the index to make a write decision.
- If the index is wrong, stale or lost, the fix is always *reindex from Postgres* — never patch the index by hand.
- Every sync job is an **attempt** to synchronize one entity. The owning module's `getSearchDocument(id)` is the **single authority** on whether that entity is index-eligible: it returns a document (→ upsert) or `null` (→ delete from index). The search module never re-implements visibility rules.

### 1.2 In scope (v1)

1. Three Meilisearch indexes: `products`, `vendors`, `bazaars`.
2. Asynchronous sync from Postgres via BullMQ — never synchronous writes from the request path.
3. Public search endpoints: one grouped multi-index endpoint (`GET /search`) and three per-type endpoints with filters and pagination.
4. Admin backfill/recovery endpoint (`POST /admin/search/reindex`).
5. Degraded-mode behaviour when Meilisearch is unavailable.

### 1.3 Out of scope (v1)

- **Events**: `Event` model exists in `schema.prisma` but there is no events module; nothing writes events. Add an index when the module exists.
- **Personalized ranking** — listed as a later item in `riven-spec.md` §13 footer.
- **Replacing `GET /products?search=`** — the existing Prisma `contains`/ILIKE search (`products.repository.ts:40-44`) is left untouched. Deprecation is Open Item 2.
- **Rate limiting** — no throttler exists anywhere in the API yet. Open Item 3; explicitly *not* silently skipped.
- Search analytics, synonyms management UI, admin search over non-public entities.

---

## 2. Schema & Visibility Verification

Verified against `apps/api/prisma/schema.prisma` (the source of truth; `specs/schema.prisma` has drifted and must not be used).

### 2.1 Models and fields the index reads

| Model | Fields used | Notes |
|---|---|---|
| `Product` | `id, vendorId, title, description, categoryId, basePrice (Decimal @db.Money), images String[], approvalStatus, isActive, deletedAt` | `approvalStatus` enum `ApprovalStatus { PENDING, APPROVED, REJECTED }` |
| `ProductVariant` | `productId, size, color, priceOverride (Decimal?), stockQuantity` | `priceOverride = null` means "use `Product.basePrice`" |
| `Category` | `id, name, slug (unique), parentId` | self-referencing hierarchy; no depth limit in schema |
| `Vendor` | `id, name, category (String), description, brandStory, logoUrl, bannerUrl, vendorType, hasFixedLocation, homeLocation (geography, nullable), verified, deletedAt` | `homeLocation` is `Unsupported(...)` — must be read via `$queryRaw` in `vendors.repository.ts` (`findVendorLocation` already does this) |
| `Bazaar` | `id, organizerId, name, description, coverMedia, scheduleType, recurrenceRule, startDate, endDate, location (geography, NOT NULL), status, deletedAt` | `status` enum `BazaarStatus { DRAFT, PUBLISHED, CANCELLED, COMPLETED }`; `bazaars.repository.ts` already returns `{lat,lng}` via raw SQL |

No schema changes are required for v1.

### 2.2 Index membership = public visibility

An entity is in the index **if and only if** it would be returned by the existing public endpoints. These rules are implemented once, in `getSearchDocument(id)` on the owning module's service, by reusing the same repository filters the public endpoints already use.

| Index | Indexed iff | Where the rule already lives |
|---|---|---|
| `products` | `approvalStatus = APPROVED` ∧ `isActive = true` ∧ `deletedAt IS NULL` ∧ `vendor.verified = true` ∧ `vendor.deletedAt IS NULL` | `products.repository.ts:12-16` (`findManyPaginated` where clause) |
| `vendors` | `verified = true` ∧ `deletedAt IS NULL` | `vendors.service.ts` `getVendorById` (404 when `!verified`); `vendor-module-spec.md` §3 |
| `bazaars` | `status = PUBLISHED` ∧ `deletedAt IS NULL` | `bazaars.repository.ts` `findPublicPaginated` / `findNearby` conditions |

**Consequence that drives the sync design**: verifying a vendor (or soft-deleting one) changes the visibility of *every product of that vendor* without touching a single product row. This is handled by a fan-out job (§5.5), never by duplicating the rule.

---

## 3. Infrastructure & Dependencies

### 3.1 What already exists

- `docker-compose.yml`: `getmeili/meilisearch:v1.9` on `:7700`, master key `riven_dev_master_key`, healthcheck present.
- `infra/config/env.validation.ts`: `MEILISEARCH_HOST` (url) and `MEILISEARCH_API_KEY` (min 1) are already required at boot.
- `infra/queue/queue.module.ts`: global BullMQ root connection from `REDIS_URL`.
- Nothing in `apps/api/src` imports or calls Meilisearch. `meilisearch` is not in `package.json`.

### 3.2 Additions

| Item | Change |
|---|---|
| Dependency | `meilisearch@^0.56.0` (official JS SDK) added to `@riven/api` `dependencies`. **Pinned below 0.57 on purpose**: 0.57+ is ESM-only with no CommonJS build, and `apps/api` compiles to CommonJS with classic module resolution. Bumping past 0.56 requires a `moduleResolution` change first. |
| Env | `MEILISEARCH_INDEX_PREFIX` — optional string; default `riven_${NODE_ENV}_`. Added to `env.validation.ts` and `.env.example`. Effective index uids: `riven_development_products`, `riven_test_products`, … |
| Module | `infra/search/` — `@Global()` `SearchInfraModule` providing `SearchIndexRegistry` (Meilisearch client + logical-name → prefixed-uid mapping), `SearchIndexBootstrap` (index/settings bootstrap + the `ready` flag), `SearchIndexQueue` (producer), plus the shared `search-documents.ts` types and `search-sync.job.ts` contract. Same placement rationale as `infra/paymob/`: an external-system adapter that several domain modules need without importing each other. |
| Module | `modules/search/` — `SearchModule` with the query service, public + admin controllers, and `jobs/search-sync.processor.ts`. Imports `ProductsModule`, `VendorsModule`, `BazaarsModule`, `SocialModule` and uses **only their exported services**. |

### 3.3 Meilisearch version note

`v1.9` supports multi-index `POST /multi-search` (since v1.1) but **not** federated search (v1.10+). This spec uses **grouped multi-index search**: one `/multi-search` request carrying one query per index, returning **separate per-index result sets**. Results are never merged into a single ranked list. This matches a tabbed "Products / Vendors / Bazaars" mobile UI. Bumping to ≥1.10 for a blended list is Open Item 1.

### 3.4 Startup, availability and degraded mode

`SearchIndexBootstrap.onModuleInit()`:

1. For each of the three indexes: `getIndex` → if missing, `createIndex(uid, { primaryKey: 'id' })`.
2. `updateSettings(...)` with the settings in §4.5. Meilisearch treats identical settings as a no-op task, so this is idempotent.
3. `waitForTask` on each returned task, with a **bounded total timeout of 10 s**.
4. Log `search: indexes ready (<prefix>)` at `log` level.

**The API never blocks indefinitely on Meilisearch and never fails to start because of it.** On any error or timeout in steps 1–3:

- Log at `error` level with the cause.
- Set `SearchIndexBootstrap.ready = false`. Do not throw.
- While `ready === false`: every query endpoint returns `503 SEARCH_UNAVAILABLE`; every sync job throws (→ BullMQ retry with backoff, §5.3) after first re-running `ensureReady()`, so the first job that succeeds after Meilisearch comes back flips `ready = true` and applies settings. Concurrent `ensureReady()` calls share one in-flight bootstrap.

Rationale: search is a read model. A Meilisearch outage must not take down auth, cart or checkout.

### 3.5 Health

`GET /health` stays exactly as it is — cheap, no external calls. This spec **proposes** a separate `GET /health/ready` returning `{ postgres: 'ok'|'down', redis: 'ok'|'down', meilisearch: 'ok'|'down' }` with HTTP 200/503, as a readiness probe. Whether to build it in this module or as a later ops task is Open Item 5.

---

## 4. Index Design

Three indexes, one per entity type. They have different filterable/sortable attributes, so a single unified index would force a lowest-common-denominator schema. All documents use `id` (the Postgres UUID) as primary key.

**Allowlist rule**: a document contains only fields the corresponding public endpoint already exposes (same approach as the `DiscoveredBazaar` allowlist in `discovery.service.ts:11-27`). The following are **never** indexed: `ownerId`, `subscriptionStatus`, `verified`, `rejectionReason`, `approvalStatus`, `status`, `deletedAt`, `createdAt`, `updatedAt`, `returnPolicy`, `shippingPolicy`, variant `sku`, variant `stockQuantity`.

### 4.1 `products`

```jsonc
{
  "id": "uuid",
  "vendorId": "uuid",
  "vendorName": "Nour Atelier",
  "title": "Linen maxi dress",
  "description": "…",
  "categoryId": "uuid",
  "categorySlug": "maxi-dresses",
  "categoryPath": ["women", "dresses", "maxi-dresses"],
  "basePrice": 1200,
  "minPrice": 1200,
  "maxPrice": 1450,
  "image": "https://…/1.jpg",     // images[0] ?? null
  "sizes": ["S", "M", "L"],       // distinct non-null variant sizes
  "colors": ["Black", "Sand"]     // distinct non-null variant colors
}
```

**Price semantics** (defined here so the implementer never guesses):

- Effective price of a variant = `priceOverride ?? basePrice`.
- `minPrice = min(effective price over all variants)`, `maxPrice = max(...)`.
- A product with **no variants** has `minPrice = maxPrice = basePrice`.
- Stored as JSON numbers (EGP, 2 dp), converted from Prisma `Decimal` with `Number(decimal.toFixed(2))`.
- There is **no field named `price`**.
- Query → filter mapping:
  - `minPrice=X` → Meilisearch filter `maxPrice >= X`
  - `maxPrice=Y` → Meilisearch filter `minPrice <= Y`
  - Both → range overlap: "the product has at least one variant whose price could fall inside `[X, Y]`".
- `sort=price:asc|desc` → sorts on `minPrice` (the "from" price shown on product cards).

Worked example — variants priced 500 (Red/S), 800 (Blue/M), 1200 (Green/L) → `minPrice=500`, `maxPrice=1200`:

| Query | Filter | Result |
|---|---|---|
| `maxPrice=900` | `minPrice <= 900` | **included** (500 and 800 qualify) |
| `minPrice=1300` | `maxPrice >= 1300` | **excluded** (nothing ≥ 1300) |
| `minPrice=600&maxPrice=700` | `maxPrice >= 600 AND minPrice <= 700` | **included** — range overlap is deliberately permissive; the product *page* shows which variants fit. Tightening to "a variant strictly inside the range" would require indexing per-variant prices as an array and is not needed for v1. |

**`categoryPath` semantics**: array of slugs from the root category down to the product's own category, computed by walking `Category.parentId` upward (cycle-guarded, max depth 10). Meilisearch array filters match on **containment**, so:

- filter `categoryPath = "women"` matches `["women"]`, `["women","dresses"]`, `["women","dresses","maxi-dresses"]` — i.e. the whole subtree.
- `categoryId = <uuid>` remains an exact match on the leaf category only.

Querying with `category=<slug>` therefore means "this category and everything under it"; `categoryId=<uuid>` means "exactly this category".

Settings: searchable `["title", "vendorName", "categorySlug", "description"]` (attribute order = relevance weight); filterable `["vendorId", "categoryId", "categoryPath", "minPrice", "maxPrice", "sizes", "colors"]`; sortable `["minPrice"]`.

### 4.2 `vendors`

```jsonc
{
  "id": "uuid",
  "name": "Nour Atelier",
  "category": "fashion",
  "description": "…",
  "brandStory": "…",
  "logoUrl": "https://…",
  "bannerUrl": "https://…",
  "vendorType": "BOTH",           // VendorType enum: BAZAAR_ONLY | MARKETPLACE | BOTH
  "hasFixedLocation": true,
  "_geo": { "lat": 30.79, "lng": 31.00 }   // omitted entirely when homeLocation is null
}
```

Settings: searchable `["name", "category", "description", "brandStory"]`; filterable `["category", "vendorType", "_geo"]`; sortable `["_geo"]`.

### 4.3 `bazaars`

```jsonc
{
  "id": "uuid",
  "organizerId": "uuid",
  "name": "Tanta Winter Bazaar",
  "description": "…",
  "coverMedia": ["https://…"],
  "scheduleType": "ONE_OFF",      // ScheduleType enum: ONE_OFF | RECURRING
  "recurrenceRule": null,
  "startDate": 1767225600,        // unix seconds — Meilisearch filters/sorts numbers, not ISO strings
  "endDate": 1767398400,          // unix seconds | null
  "_geo": { "lat": 30.79, "lng": 31.00 }   // location is NOT NULL in schema, always present
}
```

Settings: searchable `["name", "description"]`; filterable `["scheduleType", "startDate", "endDate", "_geo"]`; sortable `["startDate", "_geo"]`.

### 4.4 Ranking rules

All indexes use the Meilisearch default ranking rules: `["words", "typo", "proximity", "attribute", "sort", "exactness"]`. `sort` sits *after* the relevance rules, so relevance always wins; an explicit `sort` (price, `_geoPoint`) only orders documents that tie on relevance. This is the intended behaviour for a search box. Typo tolerance stays at defaults. Meilisearch tokenizes Arabic natively; synonyms and stop-words (Arabic, Franco-Arabic) are Open Item 6.

### 4.5 Settings applied at bootstrap (per index)

```ts
{
  searchableAttributes, filterableAttributes, sortableAttributes,  // per §4.1–4.3
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  pagination: { maxTotalHits: 1000 },   // set explicitly — §6.5 depends on this number
}
```

---

## 5. Sync Architecture

```
domain service (vendors / products / bazaars)
        │  after $transaction commits
        ▼
SearchIndexQueue.enqueue({ type, id })          ← infra/search, @Global
        │  BullMQ queue "search-sync", jobId = `${type}:${id}`
        ▼
SearchSyncProcessor                             ← modules/search/jobs
        │  <OwningModule>Service.getSearchDocument(id)   (public service, never repository)
        ▼
doc ? index.addDocuments([doc]) : index.deleteDocument(id)
```

### 5.1 Why the producer lives in `infra/`, not in `modules/search/`

`SearchModule` must *read* from `ProductsModule`, `VendorsModule` and `BazaarsModule`. If those modules also had to import `SearchModule` to enqueue, NestJS would have a circular module import. Putting the producer in a `@Global()` infra module breaks the cycle: domain modules inject `SearchIndexQueue` without importing anything; `SearchModule` imports the domain modules. Direction of dependency: `modules/search → modules/{products,vendors,bazaars}`; domain modules → `infra/search` only.

### 5.2 Job contract

```ts
type SearchSyncJob =
  | { type: 'PRODUCT' | 'VENDOR' | 'BAZAAR'; id: string }   // sync one entity
  | { type: 'VENDOR_PRODUCTS'; vendorId: string }           // fan-out (§5.5)
  | { type: 'REINDEX'; index: 'products' | 'vendors' | 'bazaars' };  // backfill (§5.6)
```

- **Jobs carry no document snapshot.** The processor always reads *current* database state at execution time. Therefore collapsing N rapid updates of the same entity into one job is safe: whichever job runs, it indexes the final state.
- `jobId = ${type}:${id}` so BullMQ deduplicates a burst of updates while a job is still waiting.
- **BullMQ gotcha (must be implemented exactly)**: a `jobId` is only reusable once the previous job with that id has been *removed*. If completed jobs linger, every later `add` with the same id is a silent no-op and the entity never syncs again. Queue defaults therefore are:

```ts
defaultJobOptions: {
  removeOnComplete: true,
  removeOnFail: { count: 1000 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
}
```

- Failures are logged with `type`, `id` and the cause, then **re-thrown** so BullMQ retries. Never swallowed.

### 5.3 Processor behaviour

`modules/search/jobs/search-sync.processor.ts`, `@Processor('search-sync')`, same `WorkerHost` pattern as `bazaar-autocomplete.processor.ts`.

1. `await bootstrap.ensureReady()` — re-runs bootstrap if `ready === false`; throws if still unreachable (→ retry).
2. Dispatch on `job.data.type`:
   - `PRODUCT` → `productsService.getSearchDocument(id)`
   - `VENDOR` → `vendorsService.getSearchDocument(id)`
   - `BAZAAR` → `bazaarsService.getSearchDocument(id)`
   - `VENDOR_PRODUCTS` → §5.5
   - `REINDEX` → §5.6
3. `doc !== null` → `index.addDocuments([doc], { primaryKey: 'id' })`; `doc === null` → `index.deleteDocument(id)`. Both are idempotent in Meilisearch. Deleting a non-existent document succeeds.
4. Do **not** `waitForTask` in the processor — Meilisearch queues its own task; the sync is complete from the API's point of view once enqueued there. (Tests wait; the processor does not.)

### 5.4 `getSearchDocument(id)` — new public methods

| Module | Method | Returns `null` when |
|---|---|---|
| `ProductsService` | `getSearchDocument(id): Promise<ProductSearchDocument \| null>` | product not found, or fails any condition in §2.2 (uses the same where clause as `findManyPaginated`, plus `include: { vendor, category, variants }`). Also exposes `listProductIdsByVendor(vendorId, cursor?, take)` for §5.5 and `listPublicProductIds(cursor?, take)` for §5.6. |
| `VendorsService` | `getSearchDocument(id): Promise<VendorSearchDocument \| null>` | vendor not found, `!verified`, or soft-deleted. Reads `homeLocation` via the existing `findVendorLocation` raw query. Exposes `listPublicVendorIds`. |
| `BazaarsService` | `getSearchDocument(id): Promise<BazaarSearchDocument \| null>` | bazaar not found, `status !== PUBLISHED`, or soft-deleted. Reuses `findById` which already returns `{lat,lng}`. Exposes `listPublicBazaarIds`. |

Products are written by `VendorsModule` (`vendors.repository.ts`) but read publicly by `ProductsModule`; `getSearchDocument` for products belongs on **`ProductsService`** because public visibility is its responsibility and it already owns the join filter. `categoryPath` is computed there by walking `Category.parentId` in the products repository (one query fetching the ancestor chain; cycle-guarded, max depth 10).

### 5.5 Vendor → products fan-out (batch job, never a request-path loop)

Triggered by `verifyVendor` and by any future vendor soft-delete / un-verify. The HTTP request enqueues **exactly two jobs** regardless of catalog size:

1. `{ type: 'VENDOR', id }`
2. `{ type: 'VENDOR_PRODUCTS', vendorId: id }` — `jobId = VENDOR_PRODUCTS:<id>`

The `VENDOR_PRODUCTS` processor pages through the vendor's product ids (`productsService.listProductIdsByVendor`, **all** products of that vendor regardless of status — eligibility is decided per product by `getSearchDocument`) in batches of 500, keyset by `id`, and `queue.addBulk([...PRODUCT jobs])` per page. Expected v1 ceiling: low thousands of products per vendor; revisit if a vendor ever approaches 50k SKUs (Open Item 8).

### 5.6 Backfill / recovery — `POST /admin/search/reindex`

- `@UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN)`, controller `admin-search.controller.ts`.
- Body: `{ types?: ('products'|'vendors'|'bazaars')[] }` — default all three. `class-validator`: `@IsOptional() @IsArray() @IsIn([...], { each: true })`.
- Enqueues one `{ type: 'REINDEX', index }` job per requested type, `jobId = REINDEX:<index>` (a second reindex request while one is pending is deduplicated).
- Responds `202 { enqueued: ['products', 'vendors', 'bazaars'] }`. Never synchronous.
- The `REINDEX` processor pages public ids (batches of 500, keyset) and `addBulk`s per-entity jobs. It does **not** clear the index first — stale documents that no longer exist in Postgres are handled by Open Item 9; for v1 the documented recovery for a corrupted index is "delete the index in Meilisearch, restart the API (bootstrap recreates it), call reindex".
- **First-deploy step**: after the first deploy of stage 2, an admin must call `POST /admin/search/reindex` once. This is documented in the spec and in the stage-2 PR description.

### 5.7 Enqueue call sites (every one is an *attempt*; eligibility is decided by `getSearchDocument`)

All enqueues happen **after** the repository call resolves (i.e. after the `$transaction` commits where one exists). Never inside a transaction.

| File | Method | Enqueue | Note |
|---|---|---|---|
| `vendors.service.ts` | `updateMyProfile` | `VENDOR:id` | name/description/brandStory/vendorType/hasFixedLocation are indexed |
| | `updateMyLocation` | `VENDOR:id` | `_geo` changes |
| | `verifyVendor` | `VENDOR:id` + `VENDOR_PRODUCTS:id` | §5.5 |
| | `createProduct` | `PRODUCT:id` | **Will resolve to a no-op**: new products are `PENDING`, so `getSearchDocument` returns `null` and `deleteDocument` on a non-existent doc succeeds. This is correct and intentional — visibility logic is not duplicated at the call site. |
| | `updateProduct` | `PRODUCT:id` | edit resets to `PENDING` → the job *removes* the product from the index until re-approved. This is the addendum's rule applied to search. |
| | `deleteProduct` | `PRODUCT:id` | soft-delete → removed |
| | `createProductVariant` / `updateProductVariant` / `deleteProductVariant` | `PRODUCT:productId` | `minPrice`/`maxPrice`/`sizes`/`colors` derive from variants |
| `products.service.ts` | `approveProduct` | `PRODUCT:id` | becomes visible (if vendor verified) |
| | `rejectProduct` | `PRODUCT:id` | removed |
| `bazaars.service.ts` | `updateMyBazaar` | `BAZAAR:id` | |
| | `publishBazaar` | `BAZAAR:id` | becomes visible |
| | `cancelBazaar` | `BAZAAR:id` | removed |
| `bazaars.repository.ts` + `bazaar-autocomplete.processor.ts` | `transitionPastOneOffBazaars` | `BAZAAR:id` for each affected row | Currently `$executeRaw` returning a count. Change to `$queryRaw` with `UPDATE … RETURNING id` so the processor can `enqueueMany`. Without this, completed bazaars stay in the index. |

Not enqueued: `applyToBazaar`/`decideApplication` (booth listings are not indexed); user profile changes (users are not indexed); organizer profile changes (`organizerId` is indexed but organizer name is not — Open Item 7).

### 5.8 Consistency model

Eventual, sub-second in practice. A product approved at *t* appears in search at *t + queue latency + Meilisearch indexing time* — typically well under one second locally. The approval response does not wait for the index. The spec states this so clients do not assert immediate consistency.

---

## 6. Endpoints & API Contract

All public endpoints: `public-search.controller.ts`, `@UseGuards(OptionalJwtAuthGuard)` (same as `public-discovery.controller.ts`), so anonymous shoppers can search and authenticated shoppers get `isFavorite` via `SocialService.batchCheckFavorites` (reused from `discovery.service.ts:64-70`).

### 6.1 Response envelope (raw Meilisearch responses are never exposed)

Every per-type result has exactly this shape:

```ts
type SearchResult<T> = {
  hits: T[];
  estimatedTotalHits: number;   // from Meilisearch
  page: number;                 // echoes the validated query
  limit: number;                // echoes the validated query
};
```

Only `hits` and `estimatedTotalHits` are taken from the Meilisearch response. `processingTimeMs`, `query`, `facetDistribution`, `_rankingScore`, `_formatted` and every other field are dropped. Each hit = the document shape from §4 **minus** `_geo`, **plus**:

- `distanceMeters: number | null` and `distanceKm: number | null` (from `_geoDistance`, `distanceKm = Number((m / 1000).toFixed(2))`, same as `DiscoveredBazaar`) — present on vendor and bazaar hits when `lat`/`lng` were supplied, `null` otherwise.
- `isFavorite: boolean` on every hit (via `FavorableType.PRODUCT` / `VENDOR` / `BAZAAR` — all three exist in the schema), `false` when anonymous. One `batchCheckFavorites` call per result set, never per hit.
- Bazaar `startDate`/`endDate` are converted back to ISO strings in the hit, so the wire format matches `GET /discovery/bazaars`.

### 6.2 `GET /search` — grouped multi-index search

| Param | Rules |
|---|---|
| `q` | required, trimmed, 1–100 chars |
| `types` | optional, comma-separated subset of `products,vendors,bazaars`; default all three; unknown value → `400 SEARCH_TYPE_INVALID` |
| `limit` | optional int 1–20, default 10 — **per type** |
| `lat`, `lng`, `radiusKm` | §6.6 |

No `page`: this is the overview (page 1 per type). Deep paging uses the per-type endpoints.

Implementation: one `client.multiSearch({ queries: [...] })` call with one query per requested index. Response keys are present **only** for requested types:

```jsonc
{
  "products": { "hits": [...], "estimatedTotalHits": 42, "page": 1, "limit": 10 },
  "vendors":  { "hits": [...], "estimatedTotalHits": 3,  "page": 1, "limit": 10 },
  "bazaars":  { "hits": [...], "estimatedTotalHits": 1,  "page": 1, "limit": 10 }
}
```

The three result sets are independent; nothing is merged or re-ranked across types.

### 6.3 `GET /search/products`

| Param | Rules | Meilisearch |
|---|---|---|
| `q` | required, 1–100 | query |
| `categoryId` | optional uuid | `categoryId = "<id>"` (exact leaf) |
| `category` | optional slug | `categoryPath = "<slug>"` (subtree, §4.1) |
| `vendorId` | optional uuid | `vendorId = "<id>"` |
| `minPrice` | optional number ≥ 0 | `maxPrice >= X` |
| `maxPrice` | optional number ≥ 0, and ≥ `minPrice` if both given else `400 SEARCH_QUERY_INVALID` | `minPrice <= Y` |
| `size` | optional string | `sizes = "<v>"` |
| `color` | optional string | `colors = "<v>"` |
| `sort` | optional, `price:asc` \| `price:desc` | `sort: ["minPrice:asc"]` |
| `page`, `limit` | §6.5 | offset/limit |
| `lat`, `lng`, `radiusKm` | **accepted and ignored** in v1 (products have no `_geo`) — so a single client search bar can pass location to every endpoint. Documented, not an error. Open Item 7 covers adding `_geo`. | — |

Filters are AND-ed.

### 6.4 `GET /search/vendors` and `GET /search/bazaars`

`GET /search/vendors?q=&category=&vendorType=&lat=&lng=&radiusKm=&page=&limit=`

- `category` → `category = "<v>"`; `vendorType` → `@IsEnum(VendorType)` → `vendorType = "<v>"`.

`GET /search/bazaars?q=&scheduleType=&upcomingOnly=&lat=&lng=&radiusKm=&page=&limit=`

- `scheduleType` → `@IsEnum(ScheduleType)`.
- `upcomingOnly` boolean, default `true`, same `@Transform` as `discover-bazaars-query.dto.ts`. When true, the filter **mirrors `bazaars.repository.ts` `findNearby` exactly**, including its two deliberate quirks: RECURRING bazaars are always kept (no RRULE expansion exists), and one-offs without an `endDate` get a one-day grace period:

```
scheduleType = RECURRING
OR (endDate >= <now>)
OR (endDate IS NULL AND startDate >= <now - 86400>)
```

  Meilisearch has no `IS NULL`; `endDate` is indexed as `null` and filtered with `endDate IS NULL` (supported since v1.4). `<now>` is unix seconds computed per request.

### 6.5 Pagination (offset — precise)

- `page`: int ≥ 1, default 1. `limit`: int 1–50, default 20.
- `offset = (page - 1) * limit`.
- `maxTotalHits` is set to **1000** in index settings (§4.5).
- If `offset >= 1000` → `400 SEARCH_QUERY_INVALID`, message `"page is beyond the maximum reachable result window (1000 hits)."`. An empty `200` is **not** returned here, because it would be indistinguishable from "no more results".
- If `offset + limit > 1000`, `limit` is clamped to `1000 - offset` so the last window is reachable (e.g. page 50 at limit 20 → hits 980–999).
- Keyset pagination is deliberately **not** used: a ranked result set has no stable sort key. `estimatedTotalHits` is an estimate and is capped at 1000 by Meilisearch.

Examples: `page=1&limit=20` → offset 0; `page=2&limit=20` → offset 20; `page=51&limit=20` → offset 1000 → 400.

### 6.6 Geo (precise)

- `lat` (−90..90) and `lng` (−180..180) are validated pairwise with the `@ValidateIf` pattern from `discover-bazaars-query.dto.ts` — one without the other → 400 (class-validator message).
- `radiusKm` without both `lat` and `lng` → `400 SEARCH_QUERY_INVALID`, message `"radiusKm requires lat and lng."`.
- `lat` + `lng` without `radiusKm` → default **25** km (the discovery default). Range 1–150.
- When coordinates are present (vendors, bazaars): Meilisearch `filter` gets `_geoRadius(lat, lng, radiusKm * 1000)` **and** `sort` gets `["_geoPoint(lat, lng):asc"]`. Because `sort` ranks after relevance (§4.4) this yields *relevance, then distance*, and makes Meilisearch return `_geoDistance` (meters) on each hit → `distanceMeters`/`distanceKm`.
- Vendors with no `homeLocation` have no `_geo` field and are therefore **excluded** by `_geoRadius` — a vendor search with coordinates only returns vendors that have a location. This mirrors what a "near me" filter means; a search without coordinates returns all verified vendors.

### 6.7 `POST /admin/search/reindex`

See §5.6. `202 { enqueued: string[] }`.

---

## 7. Validation & Error Codes

All DTOs use `class-validator` under the global `whitelist: true, forbidNonWhitelisted: true` pipe. All errors use the coded-object form:

| Code | HTTP | When |
|---|---|---|
| `SEARCH_QUERY_INVALID` | 400 | `q` missing/empty/too long; `page` beyond window; `radiusKm` without coords; `maxPrice < minPrice`; malformed `sort` |
| `SEARCH_TYPE_INVALID` | 400 | unknown value in `types` |
| `SEARCH_UNAVAILABLE` | 503 | `SearchAvailability.ready === false`, or Meilisearch throws a connection error during a query. **Never a 500** for an infrastructure outage. |

Unknown query params → 400 from the global pipe (existing behaviour).

---

## 8. Testing & Evidence Required

`pnpm --filter @riven/api test` runs unit and e2e together against the configured DB and **wipes it** (existing gotcha). e2e search tests additionally require the docker Meilisearch and use the `riven_test_` prefix; they delete those three indexes in `beforeAll` and `afterAll` so dev data is never touched.

**Indexing is asynchronous** — every e2e assertion that reads the index must first `await client.waitForTask(taskUid)` (or poll `index.getDocument(id)` with a short timeout). A test that asserts immediately after the HTTP call is a race and must not be merged.

Unit tests mock `MeilisearchClient` and `SearchIndexQueue`; e2e tests use real ones.

### 8.1 Status at implementation time (2026-09-17)

Docker was not available on the implementing machine, so **no runtime evidence exists yet**. What has been verified:

- `pnpm --filter @riven/api typecheck` → exit 0.
- All unit suites: **20 suites, 192 tests passing** (`jest --testPathIgnorePatterns e2e`). Search-specific: `infra/search/*.spec.ts` (12), `modules/search/search.service.spec.ts` (23), `modules/search/jobs/search-sync.processor.spec.ts` (8), `modules/search/dto/search-query.dto.spec.ts` (9), plus new cases in the products/vendors/bazaars service specs and the bazaar autocomplete processor spec.
- `modules/search/search.e2e.spec.ts` is written against the docker stack (own `riven_test_` prefix, obliterates the queue, waits on the index) but **has not been executed**. It must be run and its output shown before this module is considered done.

Still owed (needs `docker compose up -d`): every row in the table below.

Evidence per stage (actual terminal / curl output, per `WORKFLOW.md`):

| Stage | Evidence |
|---|---|
| 1 | boot log line `search: indexes ready`; `curl -H "Authorization: Bearer riven_dev_master_key" :7700/indexes` listing the three prefixed uids with settings; **boot with Meilisearch stopped** showing the API still serves `GET /health` and logs the search error |
| 2 | approve a product via HTTP → `GET :7700/indexes/…/documents/<id>` shows it; verify a vendor with 3 products (2 approved, 1 pending) → exactly the 2 approved appear; soft-delete → 404 from Meilisearch documents endpoint; update the same product twice within 100 ms → `queue.getJobCounts()` shows one job, index shows final state; `POST /admin/search/reindex` → 202 and the index repopulates after deleting it manually |
| 3 | `curl` per endpoint: an Arabic query; a query with a typo returning the intended product; `minPrice`/`maxPrice` against the 500/800/1200 fixture matching the §4.1 table; `category=women` returning a `maxi-dresses` product; `page=51` → 400; `radiusKm=5` without coords → 400; `lat/lng` on bazaars returning `distanceKm` ascending among equal-relevance hits; Meilisearch stopped → 503 `SEARCH_UNAVAILABLE` |
| 4 | full `pnpm --filter @riven/api test` output, `pnpm typecheck` output |

---

## 9. Implementation Stages (each a separate staged diff, reviewed before the next)

1. **`infra/search/`** — `meilisearch` dependency; `MEILISEARCH_INDEX_PREFIX` in `env.validation.ts` + `.env.example`; `MeilisearchClient` provider; `SearchIndexBootstrap` with bounded timeout and `SearchAvailability` flag; `SearchIndexQueue` producer with the §5.2 job options; register in `app.module.ts`.
2. **Sync** — `modules/search/jobs/search-sync.processor.ts`; `getSearchDocument` + id-listing methods on `ProductsService`, `VendorsService`, `BazaarsService` (repository additions in their own `*.repository.ts`); `categoryPath` walker; all §5.7 enqueue call sites; `transitionPastOneOffBazaars` → `RETURNING id`; `VENDOR_PRODUCTS` and `REINDEX` handlers; `admin-search.controller.ts`.
3. **Query** — `SearchService`, `public-search.controller.ts`, four DTOs, response mapping, `isFavorite`/distance decoration, `SEARCH_UNAVAILABLE` handling.
4. **Tests** — unit (service mapping, DTO validation, processor dispatch, pagination/geo edge cases) and e2e (index lifecycle, sync on approve/verify/delete, each endpoint's happy path + the 400/503 cases).

No stage touches `git add`, `git commit` or `git push` — each ends with the diff and a proposed conventional commit message.

Deviations from the plan made during implementation: `meilisearch` pinned to `^0.56.0` (§3.2); `SearchAvailability` folded into `SearchIndexBootstrap.ready`; `MeilisearchClient` became `SearchIndexRegistry`; `ProductsModule` now exports `ProductsService` (it previously exported only its repository); `transitionPastOneOffBazaars` returns ids instead of a count.

---

## 10. Open Items (for Ibrahim — not resolved here)

1. **Meilisearch version**: keep v1.9 with grouped per-type results, or bump to ≥1.10 for federated search (a single blended "top results" list)? Spec assumes grouped.
2. **Deprecate `GET /products?search=`** (Prisma ILIKE) once `/search/products` ships, or keep both? Two search behaviours on one entity will confuse clients.
3. **Rate limiting**: no throttler exists platform-wide. Adopt `@nestjs/throttler` starting with `/search*`, or as a separate cross-cutting task? Search is the cheapest endpoint to abuse.
4. **Compounding gates**: an APPROVED product of an unverified vendor is *not* searchable (matches the `vendor-module-spec.md` §5 open item). Confirm this is intended.
5. **`GET /health/ready`**: build the readiness probe in this module or defer to an ops task?
6. **Arabic / Franco-Arabic synonyms and stop-words** (e.g. `fostan` / `فستان` / `dress`): who owns and maintains the list? Meilisearch supports per-index synonyms; the list is a product decision.
7. **Product `_geo`** (from the vendor's `homeLocation`) so product search can be "near me", and **organizer name** on bazaar documents (would require enqueueing bazaars on organizer profile edits). Both cheap; both product decisions.
8. **Fan-out ceiling**: spec assumes low thousands of products per vendor. Is there a realistic vendor size that would justify splitting `search-sync` into per-entity queues now?
9. **Orphan cleanup**: `REINDEX` upserts but does not remove documents whose rows were hard-deleted or that predate a visibility rule change. v1 recovery is "delete index, restart, reindex". Do we want a periodic reconciliation job that diffs index ids against Postgres?
10. **Search analytics** (log zero-hit queries, top queries) — in scope for v1 or later?
