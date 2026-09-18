# Dashboard Gaps Spec

Four small backend additions the vendor / organizer web dashboards need before the frontend can start. Identified while writing `specs/web-dashboard-endpoints.md`. Each is its own task and its own commit.

Branch: `feature/dashboard-gaps` (from `main`).

---

## Task 1 — `GET /categories`

**Problem:** `POST /vendors/me/products` requires `categoryId`, but nothing exposes categories.

**Endpoint:** `GET /categories` — public, no auth.

**Response:** the full tree, roots first, children nested. No pagination (taxonomy is small by design — see addendum §2b).

```json
[
  { "id": "…", "name": "Women", "slug": "women", "children": [
      { "id": "…", "name": "Dresses", "slug": "women-dresses", "children": [] }
  ]}
]
```

**Seed:** `prisma/seed.ts` wired to `prisma db seed`. Idempotent (`upsert` on `slug`). Initial tree is a placeholder — Women / Men / Kids with a few subcategories each. The real list is still open item #4 in the fashion addendum; changing it is a seed edit, not a code change.

**Verify:** e2e — seed 2 roots + 1 child via Prisma, `GET /categories` returns nested shape, child appears under its parent and not at the root.

## Task 2 — Embed bazaar in vendor's applications

**Problem:** `GET /vendors/me/bazaar-applications` returns only `bazaarId`; the dashboard would need N+1 fetches to show a list.

**Change:** each row gains `bazaar: { id, name, coverMedia, startDate, endDate, status, location: {lat,lng} | null }`. Location comes from one raw query for the page's bazaar ids (Prisma can't read `geography`), merged in memory.

No change to the organizer-side list (already embeds `vendor`).

**Verify:** e2e — vendor applies to a seeded bazaar, list row has `bazaar.name` and `bazaar.location.lat` matching the seed.

## Task 3 — Shopper contact on vendor orders

**Problem:** vendor orders carry `userId` only.

**Change:** `GET /vendors/me/orders` and `GET /vendors/me/orders/:id` include `user: { id, name, email, phone }`. Shopper-side endpoints untouched.

No delivery address: the schema has none. Separate decision.

**Verify:** e2e — seeded order for vendor, `GET /vendors/me/orders` row has `user.name`; shopper's `GET /orders` does not gain a `user` field.

## Task 4 — Signed upload URLs for media

**Decision (spec §riven-spec.md:105):** S3-compatible storage, presigned PUT, the API never proxies bytes. Local dev: MinIO in `docker-compose.yml`. Production: point the same env vars at R2/S3.

**Endpoint:** `POST /media/upload-url` — auth: `VENDOR` or `ORGANIZER`.

Body:
```json
{ "purpose": "PRODUCT_IMAGE" | "VENDOR_LOGO" | "VENDOR_COVER" | "BAZAAR_COVER", "contentType": "image/jpeg" }
```
`contentType` allowlist: `image/jpeg`, `image/png`, `image/webp`.

Response:
```json
{ "uploadUrl": "https://…presigned PUT…", "publicUrl": "http://localhost:9000/riven-media/product-image/<userId>/<uuid>.jpg", "key": "product-image/<userId>/<uuid>.jpg", "expiresInSeconds": 300 }
```

Client flow: `PUT uploadUrl` with the file bytes and the same `Content-Type`, then send `publicUrl` in `images[]` / `logoUrl` / `coverMedia[]` as today. Object key is namespaced by purpose and user id so one user can't guess or overwrite another's path.

**Infra:**
- `docker-compose.yml`: `minio` service (ports 9000 API / 9001 console) + a one-shot `minio-init` that creates the bucket and sets anonymous **read** (download only).
- `.env.example` + `env.validation.ts`: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL` — all required (app fails at boot without them, same as the other infra vars).
- `src/infra/storage/` — `StorageService` wrapping `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `forcePathStyle: true` (needed for MinIO, harmless for R2).

**Size limit:** a presigned PUT can't enforce `Content-Length`; document 10 MB as a client-side rule for now. Enforcing server-side needs a POST-policy upload — flagged as follow-up.

**Verify:**
- unit: `StorageService.createUploadUrl` returns a URL containing the bucket, key and `X-Amz-Signature`; contentType outside the allowlist → 400.
- manual: `curl` the endpoint, `curl -X PUT` a real PNG to `uploadUrl`, `curl -I publicUrl` → 200 with `Content-Type: image/png`.

---

## Out of scope

- Delivery address on orders (no schema field).
- Server-side upload size enforcement.
- Deleting uploaded objects when a product/vendor is deleted (orphan cleanup).
- Organizer booth-layout editing (product decision).
