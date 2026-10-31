# Architecture (SOLID, design patterns) and database query performance — plan

> **Status:** **APPROVED** v6 · 2026-10-31 — round 6: architecture **10**, performance **10**, safety/process **10** (three independent read-only reviewers). Implementation in progress (§7); review rounds 1–5 in §11.
> **Asked by:** Youssef — "apply the SOLID principles and design patterns in the best way, and improve the database queries to decrease the time".
> **Scope:** `apps/api` only. **No change to any route, request, response body, header, status code, error code or message, audit row, event, ledger row or search document.** Behaviour-preserving refactor plus measured performance work.
> **Not decided here:** no business rule is added, removed or changed (decision register `specs/commerce/08`). Operational values (pool size, `directUrl`) are proposals for Youssef.

---

## 0. Preconditions and working method

- **G0 — clean baseline (recommended, not blocking).** `main` carries a large uncommitted diff (R0–R4, barcode B1, commerce/25 S1–S4). Youssef is asked to commit it before S1. **Whether or not he does, Claude never runs `git add`/`stash`/`commit`/`push`.** Per-stage method:
  - Before stage *n*: **remove** then re-create `<scratchpad>/stages/S<n>-before/` as a copy of `apps/api/{src,prisma,scripts,test}`, `apps/api/{package.json,eslint.config.mjs,tsconfig*.json,nest-cli.json}`, the jest config, `.env.example`, `specs/`, `CLAUDE.md`, `.github/workflows/ci.yml`.
  - After the stage: `diff -ruN <copy> <current>` split into **four patch files** — `S<n>-1-repository-service.patch` (`*.repository.ts`, `*.service.ts`, helpers), `S<n>-2-controllers-dtos.patch` (`*.controller.ts`, `dto/`, `*.module.ts`), `S<n>-3-tests.patch` (`*.spec.ts`, smoke, bench scripts), `S<n>-4-schema-config-docs.patch` (`schema.prisma`, migrations, `hand-sql-objects.json`, `package.json`, `ci.yml`, `.env.example`, docs) — never one combined diff (CLAUDE.md). Check: applying the four patches to `S<n>-before` reproduces the current tree exactly (`diff -r` empty).
  - **Approval cadence:** CLAUDE.md asks for each stage to be approved before the next. For this task Youssef instructed (2026-10-31) to run the plan to the end without stopping, so stages proceed back to back; each stage's four patches, its checks and the final judges' review (§12) are the review record, and nothing is committed — Youssef reviews and commits per stage afterwards.
  - **Code rollback:** delete the current copies of those paths, then copy the snapshot back (so files a stage *added* disappear too). Excluded from the restore: `prisma/migrations/` (history) and `specs/perf/` (bench evidence survives a rollback).
  - **Indexes are decided before any migration is written:** each candidate is created and dropped as a throwaway on `riven_bench_test` only; **migration files are written only for indexes that pass the keep rule**, so production never builds and drops a rejected index.
  - **A stage that fails its own checks after writing a migration (S2–S5):** if that migration was never applied to any database, its file is deleted (it is not history yet) and the stage restored; if it was applied (`riven_test` / dev), a forward `DROP INDEX` migration is added instead — never a deleted applied migration, so `check:drift` stays consistent.
  - **Environment guard before every database-touching run** — one script `apps/api/scripts/env-guard.mjs <mode>` (modes `test`, `bench`, `migrate`) run immediately before each command, printing the parsed DB host / port / database name and the Redis and Meilisearch hosts; its output is kept with the stage evidence. It covers `prisma migrate *`, jest, `pnpm smoke`, the bench, **and the bench database's admin statements** (`CREATE DATABASE`, `ALTER DATABASE … SET`, `DROP DATABASE`), which must target exactly `riven_bench_test` on localhost:5433 and are refused for `riven`, `riven_test` or any non-local URL. Rules: the database URL must be host `localhost`/`127.0.0.1`, port `5433` (and database `riven_test` for jest/smoke, `*_bench_test` for the bench); `REDIS_URL` and the Meilisearch host must be localhost. Production uses Supabase, Redis Cloud and a hosted Meilisearch — none can be reached by a run that passes the guard.
  - **Allowed `prisma migrate` commands:** `migrate deploy`, `migrate diff --script` (to generate the SQL of schema-declared indexes), `migrate status`, and `migrate resolve` — all under the guard. **`migrate dev` and `migrate reset` are not used** (dev offers a reset on drift; reset was declined in this project).
  - **Production steps are Youssef's only:** Claude never connects to Supabase or any production service. The Supabase extension-schema check (§2.5), production row counts (§2.7), `migrate deploy` to production and any `migrate resolve --rolled-back` recovery there are run by Youssef from the deploy notes.
  - **Per-stage patches are cumulative:** each stage's four `S<n>-*.patch` files apply on top of `S<n>-before`, stages in order, so Youssef can rebuild one commit per stage.
  - **One test run at a time:** jest and `pnpm smoke` never run concurrently (both use `riven_test`).
  - **Database rollback (S2–S5, for an index regressed after acceptance):** applied migrations are **never** deleted or edited and `prisma migrate reset` is **not** used (it was declined earlier in this project). A rollback is a new forward migration (`DROP INDEX IF EXISTS …`, and `DROP EXTENSION IF EXISTS pg_trgm` only if no index uses it), applied with `migrate deploy` to `riven_test` and dev alike, its file kept as history.
- **G1 — database available.** Docker (PostgreSQL :5433, Redis, Meilisearch) running.
- **After every code stage:** `tsc`; lint (0 errors, repository rules); full `jest --runInBand --forceExit` on `riven_test`; `check:drift`; `pnpm smoke` + behaviour-snapshot comparison (§5). A failing stage is fixed or rolled back before the next starts.

## 1. Ground rules

1. No observable behaviour change (§5 proves it).
2. CLAUDE.md rules stay enforced: Prisma only in `*.repository.ts`/`infra/`; no cross-module repository import; owner checks in services; explicit `onDelete`; multi-table writes in `$transaction`; Prisma **6.x**; raw SQL only through `Prisma.sql`.
3. Every performance change is measured before and after on the same seeded data and kept only under the keep rule (§2.3).
4. No speculative abstraction (§3.9 lists what is deliberately not done).
5. No new `forwardRef`; module graph changes only as in §3.10.

---

## 2. Part A — database query performance

### 2.0 Findings (verified in code, 2026-10-31)

| # | Finding | Where |
|---|---|---|
| Q1 | `COUNT` + page run inside an **interactive** `$transaction(async tx => …)` (public products, vendor own products, admin vendor/bazaar/application lists), as **two sequential** `$queryRaw` (public and organizer bazaar lists, `bazaars.repository.ts:202, 257`), or as **batch** `$transaction([…])` (orders, ratings admin — fix ROBUST-02 "so meta.total matches the page"). At READ COMMITTED each statement has its own snapshot, so no form makes `total` consistent with the page; the interactive form only adds Node↔engine round trips and holds a connection longer. | products, vendors, bazaars, organizers, orders, social repositories |
| Q2 | **Unindexed foreign keys on hot paths:** `order_items("orderId")` (every `include: { items }`, status transition, cancel, `hasDeliveredProductOrder`), `orders("orderGroupId")` (webhook PENDING→PAID `updateMany` `checkout.repository.ts:352`, `cancelPendingGroup`), `order_groups("userId")`. | `schema.prisma` |
| Q3 | Public products sort by `createdAt DESC` under `isActive AND deletedAt IS NULL AND "vendorId" IN (verified, not deleted vendors)` (+ optional `categoryId` / `vendorId`); its **COUNT** scans every live product per request; only single-column `vendorId`, `categoryId` indexes exist. | `products.repository.ts findManyPaginated` |
| Q4 | Public bazaars sort by `createdAt DESC`, discovery without location by `(startDate, id)`, both under literal `status = 'PUBLISHED' AND "deletedAt" IS NULL`; only `status`, `organizerId`, GIST location indexes. | `bazaars.repository.ts` |
| Q5 | Shopper / vendor order lists sort by `createdAt DESC` under `userId` / `vendorId` (+ optional `status`); indexes `(userId)`, `(vendorId, status)`. | `orders.repository.ts` |
| Q6 | **Expiry candidate scan:** `STALE_PENDING_GROUP_WHERE` = `createdAt < cutoff AND paymobTransactionId IS NULL AND orders some PENDING AND none non-PENDING`; Prisma renders `none` as `id NOT IN (SELECT "orderGroupId" FROM orders WHERE status <> …)`, which degrades to a per-row subplan when the hash no longer fits `work_mem`. Expired (cancelled) groups keep `paymobTransactionId IS NULL` forever, so a partial index on that predicate never shrinks and the scan walks every abandoned group in history. | `orders.repository.ts:23-27, 279` |
| Q7 | **Keyset cursors** are written `OR [{ createdAt < x }, { createdAt = x, id < y }]` (ratings, favourites, follows, expiry `>`): an OR is not an index range condition, so deep cursors cost like OFFSET. | social, orders repositories |
| Q8 | `contains … mode: 'insensitive'` → `ILIKE` (Prisma 6, with a no-op `::text` cast): public product `search` (title OR description), admin users (name/email/phone), vendors and organizers (name OR owner email), bazaars (name). | 5 repositories |
| Q9 | Ratings list + aggregate filter `(targetType, targetId)`; the index has no sort columns. | `social.repository.ts` |
| Q10 | Existence checks use full public reads: social target checks (e.g. `getVendorById` = 2 queries); "my vendor" lookups use `getMyProfile` (2 queries, the second a raw PostGIS location read) where only `{ id, verified }` is used (`vendor-orders.controller.ts:23`; `bazaars.service.ts:227, 254, 269`). The catalogue methods already use `vendorsRepository.findByOwnerId` (1 query, wide select). | social, vendors, orders, bazaars |
| Q11 | Category move: one query per ancestor level (≈ 60 categories, rare admin write — small gain). | `categories.repository.ts:82` |
| Q12 | Admin order cancel: one audit insert per cancelled order. | `orders.service.ts` |
| Q13 | No N+1 on read paths (favourites batch-checked, search enriches in one query). | — |
| Q14 | Prisma pool at default size; no `connection_limit`/`pool_timeout`; no `directUrl` (Supabase migrations need a direct connection). | `.env*`, `schema.prisma` |

### 2.1 A0 — benchmark harness (first)

- `apps/api/scripts/bench-queries.mjs`, `pnpm --filter @riven/api bench`. **Guard:** database name ends in `_bench_test` **and** host `localhost`/`127.0.0.1` **and** port `5433`, else it exits.
- **Seed** `riven_bench_test` (`prisma migrate deploy`; set-based `INSERT … SELECT generate_series` with `setseed`), two volumes:
  - **base:** 300 vendors (90 % verified, 2 % deleted), 50k products (85 % active, 3 % soft-deleted, spread over 60 categories in a 3-level tree, Zipf-like per vendor), 120k variants, 3k bazaars (70 % PUBLISHED, 20 % COMPLETED/CANCELLED, 10 % DRAFT; RECURRING 15 %), 20k users, 100k order groups / 150k orders / 300k items. **Statuses are assigned per group, coherently:** 60 % paid groups (`paymobTransactionId` set; their orders DELIVERED/SHIPPED/FULFILLED/PAID in realistic proportions), **20 % expired groups** (unpaid, every order CANCELLED), 5 % cancelled-by-shopper groups, **4 % PENDING groups** (every order PENDING; one quarter of them older than the expiry cutoff, the rest younger), 11 % mixed post-payment (one vendor order cancelled after payment). 40k ratings (skewed to 5 % of targets), favourites and follows ≈ 3 per user with a long tail (some users > 500) so deep cursors exist; favourite types **70 % PRODUCT / 20 % VENDOR / 10 % BAZAAR**, follow types **60 % VENDOR / 40 % BAZAAR** (the filtered-vs-unfiltered and type-leading comparisons depend on this mix).
  - **10×** of the above (data not fully cache-resident) for the index decisions; plus a run at **50 % verified vendors**.
  - Search terms from a fixed list: 1–2-character, common 3+-character (in ~20 % of titles), rare (in < 0.1 %).
  - `VACUUM ANALYZE` after seeding.
- **FK report:** catalog query listing every foreign key without an index whose leading columns are the FK columns.
- **Timing:** through the real repository methods; parameters from a fixed-seed list; 20 warm-up + 200 timed runs × **3 repetitions**; p50 / p95 / max + spread. COUNT and page timed **separately** and together; page 1 and a deep page (OFFSET ≈ 2,000); **deep cursor** pages for keyset lists.
- **Concurrency:** 50 clients × 30 s on the list methods, default pool and `connection_limit=5`; throughput, p95, `P2024` count.
- **Plans:** `auto_explain` (`log_analyze`, `log_buffers`, `log_min_duration = 0`) **on the bench database only**, set with `ALTER DATABASE riven_bench_test SET …` (never `ALTER SYSTEM` or the container configuration) and the database dropped in S14, so the logged plans are those of Prisma's actual prepared statements; every query also run under `plan_cache_mode = force_generic_plan` (including the 1–2-character search terms).
- **Write cost:** product insert, variant stock adjustment (+ ledger row), checkout-shaped order-group insert, webhook PAID update, cancel, rating insert.
- **Target queries:** public products (none / category / vendor / search terms), product detail, public bazaars, discovery (± location), shopper orders, vendor orders (± status), order detail, webhook PAID update, cancel, expiry candidate scan, ratings list (deep cursor) + aggregate, favourites/follows lists (deep cursor), social existence checks, "my vendor" lookup, admin user/vendor/organizer/bazaar search, category move, admin cancel of a 5-vendor group.
- **Captured SQL:** S0 records the exact SQL Prisma 6 generates for every target query (query log) into the report; index candidates (in particular the COUNT one, §2.3) are designed from that SQL, not from assumptions about how Prisma renders relation filters.
- **Heap fetches:** index-only candidates are measured once **without** the final `VACUUM` (visibility map as in production) and once after it; `Heap Fetches` from `auto_explain` reported for both.
- **Output:** `specs/perf/bench-<date>-<stage>.md`. Baseline in S0; **re-baselined after S1** before any index decision.

### 2.2 A1 — count + page (Q1)

- Helper `src/common/pagination.ts`: `paginate({ count: () => …, page: () => … })` → `{ data, total }`; the repository passes both Prisma calls (Prisma stays in the repository).
- Default: **batch** `$transaction([count, page])` (one connection, no Node round trips between them; also accepts the bazaar `$queryRaw` calls). `Promise.all` only if the concurrency bench shows a better p95 **and** zero `P2024` at `connection_limit=5`.
- Neither form gives snapshot consistency at READ COMMITTED; the ROBUST-02 comment is corrected to say so (behaviour unchanged — it never had that guarantee).
- `ORDER BY` clauses unchanged (no tiebreaker added). Unit test: `count` and `page` receive the identical `where`.
- Not done: estimated counts or dropping `total` (response change → product decision).

### 2.3 A2 — indexes (Q2–Q5, Q9) and the keep rule

**Keep rule — read-path indexes:** kept only if (a) p95 improves **≥ 30 %** at 10× volume, **and** (b) `auto_explain` shows the index used with no `Sort` node and no large "rows removed by filter", also under `force_generic_plan`, **and** (c) write cost regresses **< 10 %**.
**Keep rule — FK / write-path indexes** (webhook update, cancel, `include: { items }`): kept when the plan changes from a `Seq Scan` to an index scan for the FK lookup **or** lock-hold time of the write transaction drops, even below a 30 % p95 gain, with the same write-cost bound.
Rejected candidates are listed in the report with their numbers.
**Cumulative check:** after the individual decisions, one final bench run with the accepted set applied through the real migrations confirms the planner still picks the intended index among the product partial indexes, and applies the **< 10 % write-cost bound per table to the total** of that table's new indexes (not per index).

| Candidate | Declared | Serves |
|---|---|---|
| `order_items("orderId")` | `@@index([orderId])` | Q2 |
| `orders("orderGroupId")` | `@@index([orderGroupId])` | Q2 (webhook update, cancel) |
| `order_groups("userId")` | `@@index([userId])` | Q2 |
| `orders("userId", "createdAt")` replacing `(userId)` | `@@index([userId, createdAt])` | Q5 (backward scan) |
| `orders("vendorId", "status", "createdAt")` replacing `(vendorId, status)`; candidate `("vendorId", "createdAt")` for the unfiltered list | schema | Q5 |
| `ratings("targetType", "targetId", "createdAt", id)` replacing `(targetType, targetId)` | schema | Q9 |
| `favorites("userId", "createdAt", id)`, `follows("userId", "createdAt", id)`; alternatives `("userId", "favorableType" / "followableType", "createdAt", id)` — both benched with the type-filtered **and** unfiltered calls | schema | Q7 deep cursors |
| `orders("orderGroupId") WHERE status = 'PENDING'` (shrinks as orders leave PENDING) | hand SQL `orders_pending_group_idx` | Q6 expiry (drives the `EXISTS` query) |
| `products("createdAt") WHERE "deletedAt" IS NULL` | hand SQL `products_live_created_idx` | Q3 |
| `products("categoryId", "createdAt") WHERE "deletedAt" IS NULL` | hand SQL `products_live_category_created_idx` | Q3 |
| `products("vendorId", "createdAt") WHERE "deletedAt" IS NULL` | hand SQL `products_live_vendor_created_idx` | Q3 + vendor own list |
| COUNT support for the public product list — **shape decided from the captured SQL** (if Prisma renders the vendor filter as a self-join on `products.id`, the index must carry `id`; e.g. `products("vendorId") INCLUDE (id, "isActive", "categoryId") WHERE "deletedAt" IS NULL`) | hand SQL `products_live_count_idx` | Q3 COUNT (index-only) |
| `bazaars("createdAt") WHERE status = 'PUBLISHED' AND "deletedAt" IS NULL` | hand SQL `bazaars_public_created_idx` | Q4 |
| `bazaars("startDate", id) WHERE status = 'PUBLISHED' AND "deletedAt" IS NULL` | hand SQL `bazaars_public_start_idx` | Q4 |

- **Partial predicates contain only literal conditions** (`IS NULL`, string literals in raw SQL). Prisma binds `isActive = $1`, which a generic plan cannot match to a partial predicate.
- **No `DESC`** in any index: single-key and same-direction multi-key orders are served by a backward scan.
- Hand-SQL indexes carry explicit names equal to their `prisma/hand-sql-objects.json` entries (TD-02 e2e + `check:drift` keep passing). The registry gains each hand index's **`indexdef`** (columns, `INCLUDE`, predicate) and the TD-02 e2e compares `pg_indexes.indexdef` with it, so an index changed under the same name fails. Schema-declared indexes need no registry entry.

### 2.4 A3 — expiry scan and keyset cursors (Q6, Q7)

- **Expiry:** one shared raw SQL fragment in `orders.repository.ts` — `EXISTS (… status = 'PENDING')` and `NOT EXISTS (… status <> 'PENDING')` (equivalent to Prisma's `some`/`none` because `orderGroupId` and `status` are `NOT NULL`; a group with no orders fails both forms) with the cutoff **and** the cursor's `after.createdAt` bound as `(${x}::timestamptz AT TIME ZONE 'UTC')` (correct whether Prisma 6 sends the `Date` as text or as `timestamptz`, so the session time zone cannot shift the 1 ms boundaries) — used by **both** the candidate scan and `staleBacklog` (one statement `SELECT count(*)::int AS count, min("createdAt") AS "oldestCreatedAt"` — `::int` because `count(*)` is `bigint` — returning the same `{ count, oldestCreatedAt }` the callers and spec mocks use; callers `reservation-expiry.service.ts:102` and `maintenance-health.service.ts:48`), keeping their "one definition" rule. Kept only if (i) the existing **candidate-parity e2e** (`reservation-expiry.e2e:157`, 1 ms boundaries, ties) passes unchanged **and** is also run on a second client with `options=-c TimeZone=Asia/Tokyo` (new — today's non-UTC test at `:483` only covers `create`), plus new parity assertions that the backlog `count` equals the candidate count and `oldestCreatedAt` equals the first candidate's `createdAt` at the same cutoff, and (ii) the bench (20 % expired groups, PENDING backlog) meets the read keep rule. The two expiry indexes are **benched together**: `orders("orderGroupId") WHERE status = 'PENDING'` for the `EXISTS` side and the plain `orders("orderGroupId")` (S2) for the per-group `NOT EXISTS (status <> 'PENDING')`; `order_groups` has no `createdAt` index, so the report states which side drives the plan under `ORDER BY "createdAt", id LIMIT n`. The earlier claim that the plain `orders(orderGroupId)` index serves the `some/none` sub-queries is withdrawn.
- **Keyset cursors:** add the redundant conjunct (`createdAt <= x` for descending, `createdAt >= x` for the ascending expiry cursor) in front of the existing `OR` — identical result set, lets the index provide a range. Covered by the existing cursor tests + a deep-cursor bench.

### 2.5 A4 — trigram search (Q8)

- Datasource: `extensions = [postgis, pg_trgm]` (otherwise `migrate diff` proposes `DROP EXTENSION` and `check:drift` fails), created by the migration in the **same schema as postgis** (the datasource does not pin a schema today; on Supabase both live in `extensions` — verified there before deploy and, if needed, declared as `pg_trgm(schema: "extensions")` together with `postgis`).
- Indexes in the schema: `@@index([title(ops: raw("gin_trgm_ops"))], type: Gin)` and `description`; candidates `users(name, email, phone)`, `vendors(name)`, `organizers(name)`, `bazaars(name)`.
- Bench: 1–2-character terms (must not regress; also under `force_generic_plan`), common and rare terms; GIN size and write cost (`description`) reported; read keep rule.
- Admin vendor/organizer search ORs a column with `owner.email` (join): if the plan cannot combine both sides, the report says so and the query is not rewritten.

### 2.6 A5 — narrow reads and fewer writes (Q10–Q12)

- **`assertPublic(id): Promise<void>`** on `VendorsService`, `BazaarsService`, `ProductsService`: one `SELECT id` with the entity's public-visibility rule, throwing **exactly** the exception (code and message) the full public read throws for a missing/hidden row. Social target checks use it; rating rules (BAZAAR rateable, VENDOR/PRODUCT delivered order, EVENT unavailable) unchanged; the `switch`es stay (compile-time exhaustive).
- **`findOwnVendor(ownerId): Promise<{ id: string; verified: boolean }>`** on `VendorsService`: exactly today's lookup (`vendor.findUnique({ where: { ownerId } })` — **no** `deletedAt` filter, as `getMyProfile`/`findByOwnerId` today) with `select: { id: true, verified: true }`, throwing the same `vendorProfileNotFound()`. Used by `vendor-orders.controller.ts:23` and `bazaars.service.ts:227, 254, 269` (which use only `id`/`verified`) instead of `getMyProfile`, and by the moved catalogue methods instead of `findByOwnerId` (narrower select only). S6 moves the `getMyProfile` calls unchanged; **S7** introduces `findOwnVendor`, switches the callers and updates their spec mocks (`vendor-orders.controller.spec`, `bazaars.service.spec` / the applications spec).
- **Category move:** one recursive CTE reusing the `findCategoryPath` pattern; outcomes kept exactly (`parent_not_found` for a missing new parent, `cycle` when the walk meets the category, a dangling link higher up is **not** a cycle, same depth limit); unit + e2e tests for each.
- **Admin cancel audit:** `AuditService.recordMany()` with one `createMany`; **no automatic per-row fallback** (a fallback after a commit-but-lost-reply would write duplicates). On error it logs once, exactly like `record()` does per row. Audit after commit for an inventory-affecting admin action is an **existing, known TD-03 gap** (the recorded C-d position says audit-after-commit does *not* satisfy TD-03; TD-04 is the follow-up) — this change neither fixes nor widens it: same rows, same timing (after the cancel transaction), still best-effort. The only difference — all rows of one cancel succeed or fail together instead of individually — is stated here for Youssef's review; if he prefers per-row, `recordMany` is not adopted and the loop stays.

### 2.7 A6 — pool, deploy and migrations (documentation; proposals)

- **Proposals for Youssef** (not applied): `connection_limit` / `pool_timeout` per hosting tier from the concurrency bench; `directUrl` for Supabase migrations. Comments in `.env.example` + deploy notes. No change to `.env`, `render.yaml` or production.
- **Index deploy:** production row counts come from **production** (`SELECT relname, reltuples FROM pg_class …`, read-only, run by Youssef). A plain `CREATE INDEX` blocks writes to its table for the build; build time per million rows is measured on the 10× bench. If the estimated production build exceeds **5 s** for a table, that index goes into its own single-statement migration with `CREATE INDEX CONCURRENTLY` (a multi-statement Prisma migration runs as one implicit transaction, where `CONCURRENTLY` fails). Failed concurrent build → INVALID index → `DROP INDEX IF EXISTS …` + `prisma migrate resolve --rolled-back`. GIST `DROP INDEX` check (CLAUDE.md) on every migration.

---

## 3. Part B — SOLID and design patterns

### 3.0 Findings (verified in code)

| # | Finding | Principle |
|---|---|---|
| D1 | `BazaarsService`: **28** public methods; 9 are the application workflow. `bazaars.repository.ts` (689 lines) covers both. Outside caller: `booths.service.ts:265` (`findApplicationById`). | SRP |
| D2 | `VendorsService`: **23** public methods; 10 are the vendor catalogue, writing `products`, `product_variants`, `inventory_movements` — tables the **products** module owns (with `inventory-ledger.ts`). | SRP / table ownership |
| D3 | Search: `search-sync.processor.ts load()` switches on the entity type and `search.service.ts` switches on the index for result mapping; `reindex()` keeps per-index maps. (The processor's job-kind dispatch — `VENDOR_PRODUCTS`, `CATEGORY_PRODUCTS`, `ORGANIZER_BAZAARS`, `REINDEX` — is legitimate and stays.) | OCP |
| D4 | Public-product visibility exists as `PUBLIC_PRODUCT_WHERE` and a SQL copy in `checkout.repository.ts:240-243`. | single source of truth |
| D5 | `ORDER_STATUS_TRANSITIONS` + `validateTransition` live inside `orders.service.ts` (2 callers); the vendor's allowed targets are an inline rule. The real guards are the repositories' `WHERE status = <observed status>` updates (fix PAY-05), as `specs/commerce/03` prescribes. | cohesion |
| D6 | Moderation: `moderateVendor` / `moderateOrganizer` share the decision logic ("same state → no-op; verified flipped?") with different side effects (jobs, error codes); `IdPage` declared 4 times. | DRY |
| D7 | Count + page duplication (Q1). | DRY |

### 3.1 B1 — bazaar applications (D1)

- `BazaarApplicationsService` + `BazaarApplicationsRepository` (bazaars module) with the 9 application methods; organizer ownership via `BazaarsService.getMyBazaarById` (one-way: applications → bazaars). `applyToBazaar`'s acceptance check (today `bazaars.service.ts:233-241`: the bazaar exists, is PUBLISHED, has no `deletedAt`, and `hasPublicOrganizer` → else 400 `BAZAAR_NOT_ACCEPTING_APPLICATIONS`) becomes one read in `BazaarApplicationsRepository`: `prisma.bazaar.count({ where: { id, ...PUBLIC_BAZAAR_WHERE } })` — exactly those conditions (CLAUDE.md: "use `PUBLIC_BAZAAR_WHERE` in any new public bazaar read"); no other condition is added. The order of checks stays: `VENDOR_NOT_VERIFIED` (403) first, then this 400, then the create with `P2002` → 409 `APPLICATION_EXISTS`. Not `assertPublic` (a 404, and later). `booths.service.ts:265` switches to the new service (exported by `BazaarsModule`). `vendor-bazaar-applications.controller` and `admin-applications.controller` inject it; `organizer-bazaars.controller` injects both. Routes and controller files unchanged; events and audit rows move with their methods.
- Result: `BazaarsService` 28 − 9 + `assertPublic` = **20** public methods (search reads stay in the service, consistent with products and vendors).

### 3.2 B2 — vendor catalogue → products module (D2)

- The 10 catalogue methods move to `VendorProductsService` + methods in the products repository layer; routes stay `vendors/me/products/...` through a new `products/vendor-products.controller.ts` with class-level `JwtAuthGuard, RolesGuard` + `@Roles(VENDOR)` (equivalent to today's per-method guards; no `@Throttle` exists on these routes today and none is added). Product DTOs and `StockAdjustmentDto` move to `products/dto`. The `productNotFound` ("Product not found or does not belong to you.") and `variantNotFound` (`VARIANT_NOT_FOUND`, "Variant not found.") helpers (`vendors.service.ts:21-23`) move **verbatim**, each keeping its own code and message — not replaced by `ProductsService`'s own "Product not found." message — together with `skuTaken()` (409 `SKU_TAKEN`, "SKU must be unique.", `vendors.service.ts:24`) and the `P2002` → `skuTaken` handling of the variant methods (`:339, :358`).
- "My vendor" via `VendorsService.findOwnVendor` (A5). ProductsModule imports VendorsModule (VendorsModule imports only AuditModule → no cycle). Search fan-out and ledger writes move unchanged.
- Route paths and guards identical; `vendors/:id` cannot shadow the 2+-segment paths. Controller files 38 → 39 (route-coverage uses `>=`; routes stay 145).
- Result: `VendorsService` 23 − 10 + `assertPublic` + `findOwnVendor` = **15** public methods; catalogue writes to `products` / `product_variants` happen only in `modules/products`. **Deliberate exceptions** (stock reservation and release inside their own transactions): `checkout.repository.ts` (RESERVE) and `orders.repository.ts` (RELEASE).

### 3.3 B3 — search sources as a typed map (D3)

- **Sync side:** `SearchSource` per index `{ index, entityType, loadDocument(id), listPublicIds(cursor, take) }`, built in the **search** module by a `useFactory` provider returning a typed `Record<SearchIndexName, SearchSource>` from `ProductsService`, `VendorsService`, `BazaarsService` (already imported by the search module); used by `reindex()` by index name and by `load()` through an exhaustive `ENTITY_INDEX: Record<SearchSyncEntityType, SearchIndexName>` (no `Object.values().find()`, which would lose exhaustiveness).
- **Read side:** inside `SearchService`, a mapped-type map `{ [K in SearchIndexName]: (hits: unknown[], total: number, page: Page, userId?: string | null) => Promise<NonNullable<SearchOverview[K]>> }` (the existing private `Page` type and the `userId?: string | null` the mappers take today, `search.service.ts:55, 77, 290, 305, 324`) over its existing private mappers (`productResult` / `vendorResult` / `bazaarResult`, which depend on `SocialService` for favourites); each entry casts the untyped `multiSearch` hits inside, as today. The assignment goes through a generic helper `<K extends SearchIndexName>(k: K, …) => { overview[k] = await map[k](…) }` (no `as any`); the sequential `await` loop stays.
- A missing index is a compile error on both maps; double registration is impossible; owning modules contribute nothing (no cycles). A new index still also needs its job type, index settings and DTO enum — the gain is one place per concern, not one class.

### 3.4 B4 — one visibility rule per entity (D4)

- `PUBLIC_PRODUCT_SQL(productAlias, vendorAlias)` beside `PUBLIC_PRODUCT_WHERE` in `products/product-visibility.ts`; the checkout decrement uses it. Parity e2e: both forms over the same rows (active/inactive, deleted, unverified/deleted vendor) return the same set.

### 3.5 B5 — order transitions module (D5)

- Move `ORDER_STATUS_TRANSITIONS` and `validateTransition` **unchanged** into `orders/order-transitions.ts`, plus a `VENDOR_TARGETS` constant for the vendor's allowed targets (today an inline rule). The repositories are **not** touched: their guarded updates keep `WHERE status = <the status the caller observed>` (PAY-05); nothing becomes `status IN (…)`. Messages ("Allowed next states: …"), check order (`VENDOR_TRANSITION_NOT_ALLOWED` before `INVALID_ORDER_TRANSITION`, `ORDER_NOT_SHIPPED`, admin cancel of CANCELLED = 200 no-op) and the map's content — including its `PAID → CANCELLED` entry — are identical. Unit tests pin each message.

### 3.6 B6 — moderation decision helper and shared types (D6)

- Pure `moderationDecision(current, target)` → `{ noop: true } | { noop: false; verifiedFlipped: boolean }` (discriminated union) in `common/moderation.ts`, used by vendor and organizer moderation; side effects (jobs, error codes, audit actions) stay in each service. `moderationStatusWhere` copies stay in their repositories (they return Prisma where-types). `IdPage` declared once in `common/`.

### 3.7 B7 — pagination helper (D7)

- A1's `paginate()`; `paginationMeta()` (exists) builds `meta`.

### 3.8 Characterization tests first

- **S0 adds e2e ownership tests** for the 10 `vendors/me/products*` routes (another vendor's product/variant → today's status and code) and for the moved bazaar-application owner checks where missing, **before** B1/B2 move anything.

### 3.9 Explicitly not done (reasons)

- **Payment gateway port:** speculative — the designed payment methods decide *when* checkout calls the payments layer and never call `createIntention` (`specs/commerce/01`); the seam is a `PaymentMethod` strategy in the commerce phases (pending decisions).
- **`checkout.repository.ts`** (507 lines): cohesive transactional unit just reviewed to 10/10 for correctness and security.
- **`booths.service.ts`, `auth.service.ts`:** single responsibility already; `auth` is security-sensitive.
- **Bazaar search reader split:** rejected — products and vendors keep their search reads in their services; a split only for bazaars would be count-driven.
- Generic `BaseRepository<T>`, CQRS, caching (freshness = product decision), micro-modules, route renames, DTO rule changes, changing the transition map's content.

### 3.10 Module graph changes (complete)

- `ProductsModule` imports `VendorsModule`. Nothing else; no `forwardRef`.

---

## 4. Security constraints

- Owner checks move with their methods; the characterization tests (§3.8) prove the same responses before and after.
- Guards: `@Roles(VENDOR)` on the new vendor-products controller, `@Roles(ADMIN)` on admin controllers, same routes; no guard logic in services.
- Raw SQL (expiry query, CTE, visibility fragment, hand indexes) only through `Prisma.sql`.
- Bench guard pinned to name + host + port. No change to authentication, throttling, webhook verification, idempotency, payment decisions, audit actions or env/production.

## 5. Behaviour snapshot

- **Recorder:** in `smoke-live.mjs`'s single `call()` path. Baseline written before S1 to `<scratchpad>/stages/snapshot-baseline.json` (and kept in `specs/perf/` as a reviewable artifact); compared after every code stage.
- Per request: status code (multi-status steps such as `[200, 503]` compare membership), error `code` and `message` (the run token and generated ids masked), body key paths **and value types**, headers `Content-Type` and `Location` by value, `Retry-After` / `X-RateLimit-*` **by presence** (values vary).
- Fixtures make every asserted list non-empty; list **order** compared where the sort key is unique in the fixtures (ties are unordered today too; `ORDER BY` unchanged by rule).
- **Side effects**, selected by the run's actor and entity ids (audit rows do not carry the run id): audit rows (action, targetType, count), outbox rows, inventory-movement rows (type, delta, source), payment events/exceptions, Meilisearch document key sets.
- Existing suites (1,383 tests) and route coverage (145 routes) stay green.

## 6. Tests per stage

- **S0:** ownership characterization e2e (§3.8); snapshot recorder + baseline; bench seed self-check; captured-SQL report.
- **S1:** `paginate` unit test (same `where`; batch vs parallel).
- **S2–S5:** bench reports (plan checks on the **bench database** under `force_generic_plan` — not on `riven_test`, whose tiny tables make seq scans the right plan); TD-02 e2e incl. `indexdef`; S4: expiry candidate-parity e2e unchanged **plus** a run on a second client with `TimeZone=Asia/Tokyo` (candidate scan and `staleBacklog`), an assertion of the candidate **sequence** (not only the set — raw `ORDER BY "createdAt", id` replaces Prisma's `orderBy`), backlog `count` = candidate count and `oldestCreatedAt` = first candidate's `createdAt`; cursor tests unchanged; S5: trigram bench incl. short terms.
- **S6:** applications split — unit specs split (`bazaars.service`, applications service, `booths.service`, `organizer-bazaars.controller`, `vendor-bazaar-applications.controller`, `admin-applications.controller`); e2e unchanged.
- **S7:** catalogue move + `findOwnVendor` — `vendors.service`, `vendors.controller`, new `vendor-products.controller` / service specs; `findOwnVendor` same-error tests; `vendor-orders.controller.spec` and applications-spec mocks updated.
- **S8:** both search maps exhaustive at compile time + a unit test that every `SearchIndexName` has exactly one source **and** `ENTITY_INDEX[sources[k].entityType] === k` for every index (so the entity→index map and the sources cannot disagree). **S9:** visibility parity e2e. **S10:** transition message tests. **S11:** `assertPublic` same-error tests. **S12:** moderation helper unit tests + existing vendor/organizer suites. **S13:** CTE outcome tests; `recordMany` test (if adopted).

## 7. Stages (one small unit each)

| Stage | Content |
|---|---|
| S0 | Bench harness + seed + FK report + baseline; snapshot recorder + baseline; ownership characterization tests |
| S1 | `paginate()` everywhere (A1, B7); bench re-baseline |
| S2 | Schema-declared indexes (FK, orders, ratings) + bench decision |
| S3 | Hand partial indexes (products, bazaars) + COUNT covering index + bench decision |
| S4 | Expiry `EXISTS` query + keyset conjuncts (A3) + bench decision |
| S5 | `pg_trgm` + trigram indexes (A4) + bench decision |
| S6 | Bazaar applications split (B1) |
| S7 | Vendor catalogue → products module + `findOwnVendor` (B2, A5) |
| S8 | Search source map (B3) |
| S9 | Product visibility SQL fragment (B4) |
| S10 | Order transitions module (B5) |
| S11 | `assertPublic` existence reads (A5) |
| S12 | Moderation helper + `IdPage` (B6) |
| S13 | Category CTE + `recordMany` (A5) |
| S14 | Docs: CLAUDE.md, `specs/riven-backend-architecture.md`, RIVEN-WORK-FLOW (architecture note), `.env.example` comments, `hand-sql-objects.json`, final bench report, this file's status; **drop `riven_bench_test`** and confirm no `ALTER DATABASE` setting remains on any other database |

Each code stage ends with the §0 checks. S2–S5 decide indexes on the bench database first and write migrations only for accepted ones.

## 8. Acceptance criteria (measurable; `scripts/arch-metrics.mjs` prints them in S14)

- §0 checks green after every stage; final snapshot diff empty.
- Bench: every kept index meets its keep rule; rejected ones listed; write regression **< 10 % per table with all of that table's new indexes together** (cumulative run); list endpoints' p95 at 10× reported before/after.
- `BazaarsService` ≤ **20**, `VendorsService` ≤ **15** public methods.
- No `switch` in `search-sync.processor.ts load()` or in `search.service.ts` result mapping (`rg` on those functions); the job-kind dispatch remains.
- The SQL form of product visibility appears only in `product-visibility.ts`.
- `IdPage` declared once; no new `forwardRef`; module graph as §3.10.
- Catalogue writes (`product.create/update`, `productVariant.create/update`, VENDOR_ADJUSTMENT / initial-stock movements) only under `modules/products`; RESERVE/RELEASE stay in checkout/orders (deliberate).
- No business decision changed; nothing committed.

## 9. Open items

- **Youssef:** G0 (commit pending work); pool values and `directUrl` (A6); whether `recordMany`'s all-or-nothing audit batch is acceptable (A5) — default if no answer: keep the per-row loop.
- **Ibrahim:** none (every behaviour preserved).

## 10. Risks

| Risk | Mitigation |
|---|---|
| Hidden behaviour change in a move | characterization tests first; snapshot after every stage |
| Index helps reads, hurts writes | write-cost bench; keep rule |
| Plan differs in production (data shape) | 10× and 50 %-verified runs; generic-plan runs; production row counts before deploy |
| Long index build locks a table | CONCURRENTLY rule with recovery |
| Large uncommitted baseline makes review hard | G0 + per-stage patches |

## 11. Changes

- **v2** (round 1): FK indexes; literal-only partial predicates; schema-declared non-partial indexes; `pg_trgm` in `extensions`; batch default + P2024 check; bench methodology (10×, 3 reps, deep pages, separate COUNT, auto_explain + generic plans, write cost, host-pinned guard); CONCURRENTLY recovery; B1 wiring; catalogue to products; typed factory maps; payment port dropped; moderation/`IdPage`; extended snapshot; per-stage patches.
- **v3** (round 2): expiry `EXISTS` candidate + withdrawn FK claim + expired-group seeding; keyset redundant conjunct; plan checks on the bench DB; generic-plan runs for short trigram terms; second keep criterion for FK/write indexes; COUNT covering index; no `DESC`; seed distributions pinned; extension schema note; TD-03 wording corrected (known gap, unchanged) and no duplicate-prone fallback; B5 reduced to moving the map unchanged (guards stay `= observed status`); `findOwnVendor` + DTO move; `assertPublic` throwing the exact exception; bazaar search reader split rejected; pure moderation decision helper; stages split one unit each; ownership characterization tests in S0; copy/restore covers config files and added files; database rollback by forward migration only (no `migrate reset`); production row counts and write-blocking note; snapshot masking, presence-only rate headers, multi-status, baseline location, actor/entity filtering; corrected §8 criteria and counts (38 controller files).
- **v4** (round 3): migrations written only for indexes that passed the bench (throwaway builds on the bench DB first); three patch files per stage and the approval cadence under Youssef's run-to-the-end instruction; `specs/perf/` excluded from rollback; rollback scope S2–S5; COUNT index designed from the captured Prisma SQL (+ heap-fetch runs without the final VACUUM); expiry fragment shared with the backlog count + parity assertion + `::timestamp` cast; new candidates `favorites/follows(userId, createdAt, id)` and `orders(orderGroupId) WHERE status = 'PENDING'`; per-group coherent seed statuses and pinned backlog; `indexdef` checked by the TD-02 e2e; `applyToBazaar` check placed in the applications repository with the same 400; search maps split into a sync-source map and a read-side mapped-type map; `findOwnVendor` pinned to today's lookup and select; stage-numbered tests fixed; discriminated-union moderation decision.

- **v5** (round 4): failed-stage migration handling (delete if never applied, forward drop if applied); every `prisma migrate` call host/port-guarded; `auto_explain` via `ALTER DATABASE` on the bench DB only, dropped in S14; cumulative patches; one test run at a time; expiry casts `(x::timestamptz AT TIME ZONE 'UTC')` for cutoff and cursor + a non-UTC parity run + `oldestCreatedAt` parity, both callers named; expiry indexes benched together and the driving side reported; favourites/follows filtered/unfiltered + type-leading alternatives; cumulative final bench with per-table write budget; B1 check = `PUBLIC_BAZAAR_WHERE` exactly (no start-date condition), check order kept; B2 error helpers verbatim; B3 entity→index map and `NonNullable` / generic-helper typing.

- **v6** (round 5): environment guard widened to jest, smoke and the bench (DB, Redis, Meilisearch on localhost); allowed `migrate` commands listed (`dev`/`reset` excluded); production steps Youssef-only; four patch buckets + reproduction check; S14 drops the bench DB; favourite/follow type mix pinned; `staleBacklog` single statement with `::int`; S4 adds the Tokyo run and sequence assertion; §8 per-table cumulative write budget; B3 `Page` / `string | null` signature and entity↔index consistency test; B2 `skuTaken` + `P2002` handling moved verbatim.

## 12. After implementation

Three independent reviewers (security, correctness/architecture, docs) review the finished work — code, migrations, bench report and every updated document — and the loop continues until each scores 10/10.
